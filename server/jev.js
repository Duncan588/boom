'use strict';
/**
 * Jev 客户端 —— 起飞时刻决定这一局落在哪个倍率段
 *
 * 形态（与 engine.js 现有流程完全对齐，下游一行不改）：
 *   decideRate() → rate → 广播 takeoff → flightMs(rate) → 广播 over { boom: rate }
 *   逃跑倍率仍是 rateAt(已飞时间)，爆点仍是一个全场共享的 rate。
 *
 * 【三条硬约束，都是踩过坑换来的】
 *
 * 1) 起飞绝不 await。engine.js:161 之后每一毫秒都是玩家盯着火箭等结果。
 *    本模块只提供 pickBand()（同步、含缓存、含降级），网络调用由调用方
 *    在【上一局结算后】异步预热，结果落盘给下一局用。
 *    这同时满足「可选的外部副作用不能有能力搞死游戏」——
 *    本文件所有 fetch 都带 AbortController + try/catch，且不 unhandled。
 *
 * 2) 没人不下注 → 不调用 API。空房间每局都会走 decideRate，
 *    若在这里拉 Jev，一个没人玩的服会持续烧钱。所以入口先判 pot/seated。
 *
 * 3) 分布复用不损失随机性。Jev 一次返回的是【完整概率分布】，
 *    而段内取值本来就是 Math.random() —— 每局调用拿到的也只是
 *    「从同一个分布里采一个样」。把分布复用 N 局 = 同一个分布采样 N 次。
 */

const { buildQuestions, PERSONA_EDGE_SCALE } = require('./jev-personas');
const { buildBands, rateInBand, fallbackBand } = require('./jev-bands');

const API = 'https://api.typesafe.ai/v1/systemone';
const PRICE_PER_MTOK_INPUT = 42;   // 官方 models.md：$42 / Btok，只按 input 计费，output 免费

const state = {
  enabled: false,
  apiKey: '',
  timeoutMs: 800,
  cacheRounds: 4,       // 强制每 N 局至少重问一次
  persona: 'standard',
  sampleRate: 100,      // 0-100，管理员可降采样省钱
  act: { active: false, roundsLeft: 0, maxRate: 0, instantPct: 0 },
  cache: new Map(),     // `${persona}|${bandSig}` -> { probs, confidence, round }
  roundNo: 0,
  usage: { calls: 0, fails: 0, inTok: 0, outTok: 0, reused: 0, lastLatency: 0, lastError: '' },
  lastProbs: null,
  lastConfidence: null,
  lastSource: 'none',   // jev | cache | fallback
};

/** 从 settings 读取配置（后台保存后 refreshSettings 即可生效） */
function configure(cfg) {
  state.enabled = String(cfg.jev_enabled ?? '0') === '1';
  state.apiKey = String(cfg.jev_api_key || process.env.TYPESAFE_API_KEY || '');
  state.timeoutMs = Math.max(200, Number(cfg.jev_timeout_ms) || 800);
  state.cacheRounds = Math.max(1, Number(cfg.jev_cache_rounds) || 4);
  state.persona = (cfg.jev_persona === 'bodhisattva') ? 'bodhisattva' : 'standard';
  state.sampleRate = Math.max(0, Math.min(100, Number(cfg.jev_sample_rate ?? 100)));
  state.act = {
    active: String(cfg.jev_act_enabled ?? '0') === '1',
    roundsLeft: Math.max(0, Number(cfg.jev_act_rounds) || 0),
    maxRate: Math.max(0, Number(cfg.jev_act_max) || 0),
    instantPct: Math.max(0, Math.min(100, Number(cfg.jev_act_instant) || 0)),
  };
}

/**
 * 活动段是否生效 —— **纯查询，不扣减**。
 *
 * ⚠️ 这里必须是纯函数：pickBand() 和 prefetch() 都会调它，
 *    早先版本在这里 roundsLeft--，结果一局游戏把活动额度消耗两次，
 *    实测「设置 2 局活动」只生效 1 局就自动关闭。
 *    扣减只发生在 engine 起飞那一处（consumeActivity），一个局扣一次。
 */
function activity() {
  const a = state.act;
  return {
    active: a.active && a.roundsLeft > 0,
    roundsLeft: Math.max(0, a.roundsLeft),
    maxRate: a.maxRate,
    instantPct: a.instantPct,
  };
}

/** 起飞时扣减活动局数。一个局扣一次，扣完自动关闭。 */
function consumeActivity() {
  const a = state.act;
  if (!a.active || a.roundsLeft <= 0) return { active: false, roundsLeft: 0, maxRate: a.maxRate, instantPct: a.instantPct };
  a.roundsLeft -= 1;
  const left = a.roundsLeft;
  if (left <= 0) { a.active = false; }
  return { active: left > 0, roundsLeft: Math.max(0, left), maxRate: a.maxRate, instantPct: a.instantPct };
}

/**
 * 房间快照 —— token 优化版。
 * 实测：逐人明细版 1919 tok/次 → 聚合版 714 tok/次。
 * 三处压缩：10 人明细→3 组聚合 / 删每局一字不变的静态映射 / 删可推出的字段。
 */
function buildState(seated, lastBoom, bands, act) {
  const thr = seated.map((p) => p.thr).sort((a, b) => a - b);
  const q = (x) => thr[Math.min(thr.length - 1, Math.floor(thr.length * x))];
  const p50 = q(0.50), p80 = q(0.80);
  const groups = [
    { type: '低阈值', test: (t) => t <= p50 },
    { type: '中阈值', test: (t) => t > p50 && t <= p80 },
    { type: '高阈值', test: (t) => t > p80 },
  ].map((g) => {
    const m = seated.filter((p) => g.test(p.thr));
    return {
      type: g.type,
      count: m.length,
      target_range: m.length
        ? `${Math.min(...m.map((p) => p.thr)).toFixed(1)}-${Math.max(...m.map((p) => p.thr)).toFixed(1)}x`
        : '-',
      losing_streaks: m.map((p) => p.lossStreak),
    };
  });

  const s = {
    round: state.roundNo,
    last_round_boom: lastBoom == null ? '无' : `${lastBoom}x`,
    bands: bands.map((b) => b.key),
    room: { seated: seated.length, median_escape_target: `${p50.toFixed(1)}x`, groups },
  };
  // 活动段只【告知】，不授权 —— 真正的钳制在 buildBands() 里由代码执行。
  if (act && act.active) {
    s.active_campaign = {
      rounds_remaining: act.roundsLeft,
      max_multiplier_allowed: `${act.maxRate}x`,
      note: `本段内爆点不超过 ${act.maxRate}x，更高的段实际不可用；策划要求其中约 ${act.instantPct}% 的局是瞬爆`,
    };
  }
  return s;
}

/**
 * 活动段秒爆配额调度器。
 *
 * ⚠️ 秒爆比例【不能交给 Jev】——它只返回段权重，无法保证「100 局里恰好 15 局瞬爆」。
 *   早先版本只把 instantPct 写进 state 的 note 里让 Jev「注意」，
 *   实测配 30% 实际只有 2-4%：Jev 字面理解了「这一段要有人亏」，但它不数局。
 *
 * 所以改成确定性配额：活动段一共 actRounds 局，按 instantPct 决定其中
 * 恰好多少局必须是瞬爆，用「每几局一次」均匀铺开。
 * 这样配 30% / 5 局 = 恰好 1.5 局 → 交错成 2 局；配 15% / 100 局 = 15 局。
 * 额度用满后自动关掉强制，剩下的局交给 Jev 自由判断（若 Jev 自己选 instant 也算入）。
 */
const actPlan = { key: '', quota: 0, done: 0, everyN: 0, remaining: 0 };

/**
 * 规划活动段：算出这一段里有多少局必须是瞬爆、怎么铺开。
 * @returns {number} 每几局强制一次（0 = 本段无强制秒爆）
 */
function planActivity(act) {
  const total = state.act.roundsLeft;         // 本段还剩多少局
  const pct = act.instantPct || 0;
  const quota = Math.round(total * pct / 100);
  const key = `${state.persona}|${total}|${pct}|${act.maxRate}`;
  if (actPlan.key !== key) {
    actPlan.key = key;
    actPlan.quota = quota;
    actPlan.done = 0;
    // everyN = 每几局出现一次。quota=0 → 0（不强制）
    actPlan.everyN = quota > 0 ? Math.max(1, Math.round(total / quota)) : 0;
  }
  actPlan.remaining = quota - actPlan.done;
  return actPlan.everyN;
}

/**
 * 本局是否必须秒爆。配额铺开，不改随机性 —— 只在配额轮次强制 instant。
 */
function mustInstant() {
  const everyN = actPlan.everyN;
  if (!everyN || actPlan.done >= actPlan.quota) return false;
  // 用局号取模而不是计数器，这样即使某一局走了 fallback 也不会错位
  const phase = state.roundNo % everyN;
  if (phase !== 0) return false;
  actPlan.done++;
  return true;
}

function cacheKey(personaKey, bands) {
  // 分段边界参与 key：活动段压过上限后 high/top 语义已变，复用旧分布就是错的
  return personaKey + '|' + bands.map((b) => `${b.key}:${b.min}-${b.max}`).join(',');
}

/** 指纹命中：构成人数不变 + 中位阈值变化在 ±8% 内 → 算同一类房间 */
function fpMatch(a, b) {
  if (!a || !b) return false;
  if (a.groups.length !== b.groups.length) return false;
  for (let i = 0; i < a.groups.length; i++) {
    if (a.groups[i].count !== b.groups[i].count) return false;
  }
  const ma = parseFloat(a.median_escape_target) || 0;
  const mb = parseFloat(b.median_escape_target) || 0;
  if (!ma || !mb) return ma === mb;
  return Math.abs(ma - mb) / Math.max(ma, mb) <= 0.08;
}

function sampleFromProbs(probs) {
  const keys = ['instant', 'low', 'mid', 'high', 'top'].filter((k) => (probs?.[k] ?? 0) > 0);
  const total = keys.reduce((s, k) => s + probs[k], 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const k of keys) { r -= probs[k]; if (r <= 0) return k; }
  return keys[keys.length - 1];
}

/**
 * 同步选段：缓存命中 → 直接用；否则降级。**永不阻塞。**
 * @returns {{band, bands, persona, source, confidence, probs}}
 */
function pickBand(seated, lastBoom, actCfg) {
  const act = activity();   // 纯查询：不扣局数，扣减在 engine 起飞时
  // 【硬约束 2】没人 → 不调用 API。空房间也走 decideRate，
  // 在这里拉 Jev 会让一个没人玩的服持续烧钱。
  if (!state.enabled || !state.apiKey || !seated || !seated.length) {
    const persona = act.active ? 'bodhisattva' : state.persona;
    const bands = buildBands(seated.length ? seated.map((p) => p.thr) : [2], act, PERSONA_EDGE_SCALE[persona] || 1);
    if (act.active) planActivity(act);
    const forced = act.active && seated.length && mustInstant();
    const band = seated.length ? (forced ? 'instant' : fallbackBand(seated, persona)) : 'low';
    const rate = rateInBand(bands, band) ?? 2;
    return { band, bands, rate, persona, source: 'fallback', confidence: null, probs: null };
  }

  const persona = act.active ? 'bodhisattva' : state.persona;
  const bands = buildBands(seated.map((p) => p.thr), act, PERSONA_EDGE_SCALE[persona] || 1);
  const key = cacheKey(persona, bands);
  const hit = state.cache.get(key);
  if (act.active) planActivity(act);

  if (hit && state.roundNo - hit.round < state.cacheRounds && fpMatch(hit.room, buildState(seated, lastBoom, bands, act).room)) {
    const forced = act.active && mustInstant();
    const band = forced ? 'instant' : (sampleFromProbs(hit.probs) || 'low');
    state.usage.reused++;
    state.lastSource = 'cache';
    state.lastProbs = hit.probs;
    state.lastConfidence = hit.confidence;
    const rate = rateInBand(bands, band);
    if (rate == null) return fallback(seated, bands, persona);
    return { band, bands, rate, persona, source: 'cache', confidence: hit.confidence, probs: hit.probs };
  }

  // 未命中：这一局先降级，下一局预热后就能命中
  // ⚠️ 强制秒爆已在上方 mustInstant() 消费过，这里不能再调一次 ——
  //    否则一个局扣两次配额，配 30% 会变成 60%。
  if (act.active && mustInstant()) {
    const r = rateInBand(bands, 'instant');
    if (r != null) { state.lastSource = 'fallback'; return { band: 'instant', bands, rate: r, persona, source: 'fallback', confidence: null, probs: null }; }
  }
  return fallback(seated, bands, persona);
}

function fallback(seated, bands, persona) {
  const band = fallbackBand(seated, persona);
  const rate = rateInBand(bands, band);
  if (rate == null) return { band: 'low', bands, rate: 2, persona, source: 'fallback', confidence: null, probs: null };
  state.lastSource = 'fallback';
  return { band, bands, rate, persona, source: 'fallback', confidence: null, probs: null };
}

/**
 * 异步预热下一局的分布。**调用方 fire-and-forget，绝不 await。**
 * 内部三重保护：sampleRate / 空房间 / 超时 abort，且永不 reject。
 */
async function prefetch(seated, lastBoom, actCfg) {
  const act = activity();   // 纯查询：同上
  if (!state.enabled || !state.apiKey || !seated || !seated.length) return;
  if (state.sampleRate <= 0) return;
  if (Math.random() * 100 >= state.sampleRate) return;

  const persona = act.active ? 'bodhisattva' : state.persona;
  const bands = buildBands(seated.map((p) => p.thr), act, PERSONA_EDGE_SCALE[persona] || 1);
  const key = cacheKey(persona, bands);
  const payload = buildState(seated, lastBoom, bands, act);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), state.timeoutMs);
  try {
    const res = await fetch(API, {
      method: 'POST', signal: ac.signal,
      headers: { Authorization: `Bearer ${state.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state: payload, questions: buildQuestions(persona) }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const a = j?.answers?.band;
    if (!a?.probabilities) throw new Error('bad answer');
    state.usage.calls++;
    state.usage.lastLatency = Date.now() - (payload.__t0 || Date.now());
    state.usage.inTok += Number(j.usage?.input_tokens) || 0;
    state.usage.outTok += Number(j.usage?.output_tokens) || 0;
    state.cache.set(key, { probs: a.probabilities, confidence: a.confidence, round: state.roundNo, room: payload.room });
  } catch (e) {
    state.usage.fails++;
    state.usage.lastError = String(e && e.message || e).slice(0, 120);
    // 不 rethrow：调用方是 fire-and-forget，一个 unhandled rejection 能杀掉引擎进程
  } finally {
    clearTimeout(timer);
  }
}

function tickRound(n) { state.roundNo = n; }

function status() {
  const u = state.usage;
  const perCall = u.calls ? Math.round(u.inTok / u.calls) : 0;
  return {
    enabled: state.enabled,
    hasKey: !!state.apiKey,
    persona: state.persona,
    personaLabel: require('./jev-personas').getPersona(state.persona).label,
    sampleRate: state.sampleRate,
    timeoutMs: state.timeoutMs,
    cacheRounds: state.cacheRounds,
    cacheSize: state.cache.size,
    activity: { ...state.act },
    usage: {
      ...u,
      perCallTokens: perCall,
      costUsd: +((u.inTok / 1e6) * (PRICE_PER_MTOK_INPUT / 1000)).toFixed(5),
    },
    last: { source: state.lastSource, confidence: state.lastConfidence, probs: state.lastProbs },
  };
}

/** 后台预览：用当前配置跑 N 局，**绝不调用 Jev**（否则管理员点一次预览烧一次钱） */
function preview(roundCount, seatedSample) {
  const persona = state.persona;
  const N = Math.max(1, Math.min(2000, Number(roundCount) || 200));
  const seats = seatedSample && seatedSample.length ? seatedSample : [
    { ar: 'steady', thr: 2.4, lossStreak: 0 }, { ar: 'greedy', thr: 1.8, lossStreak: 1 },
    { ar: 'greedy', thr: 2.1, lossStreak: 0 }, { ar: 'high_chaser', thr: 18, lossStreak: 3 },
    { ar: 'all_in', thr: 3.2, lossStreak: 0 }, { ar: 'late_bomber', thr: 6.5, lossStreak: 2 },
    { ar: 'slow_hand', thr: 4.1, lossStreak: 0 }, { ar: 'steady', thr: 2.8, lossStreak: 1 },
    { ar: 'greedy', thr: 1.9, lossStreak: 0 }, { ar: 'late_bomber', thr: 7.2, lossStreak: 4 },
  ];
  const bands0 = buildBands(seats.map((p) => p.thr), { active: false }, PERSONA_EDGE_SCALE[persona] || 1);
  const count = {};
  for (const b of bands0) count[b.key] = 0;
  let win = 0, rounds = 0, inst = 0;
  for (let i = 0; i < N; i++) {
    const band = fallbackBand(seats, persona);
    count[band]++;
    if (band === 'instant') inst++;
    const rate = rateInBand(bands0, band) ?? 2;
    const w = seats.filter((p) => rate >= p.thr).length;
    win += w / seats.length;
    rounds++;
  }
  return {
    rounds, persona, note: '这是【纯代码降级路径】的分布，不含 Jev 判断。Jev 生效后会按房间动态调整选段。',
    bands: bands0.map((b) => ({ ...b, count: count[b.key], pct: +((count[b.key] / rounds) * 100).toFixed(1) })),
    avgWinShare: +((win / rounds) * 100).toFixed(1),
    instantPct: +((inst / rounds) * 100).toFixed(1),
  };
}

module.exports = { configure, pickBand, prefetch, consumeActivity, tickRound, status, preview, buildBands, buildState, activity, state };
