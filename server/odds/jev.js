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
  // ⚠️ 没有 act 字段：活动状态由调用方每次传入（见 normAct）
  lastActivity: null,    // 仅供后台显示「上一次是否在活动时段」
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
  // ⚠️ 这里【没有】活动配置。活动参数由 decideRate 从 activeEvent() 拿到的
  //    ev 事件传入（见 server/odds/decide.js）。
  //    早先这里读 jev_act_enabled / jev_act_rounds / jev_act_max / jev_act_instant
  //    四个 setting，结果与「每日高倍活动」那套 events_json 打架：
  //    同一时刻两套活动上限，谁生效说不清。已删除，配置只留「每日高倍活动」一处。
}

/**
 * 活动段状态 —— **由调用方传入，不存 state**。
 *
 * ⚠️ 早先版本把活动做成 setting（jev_act_enabled / jev_act_rounds /
 *    jev_act_max / jev_act_instant）+ state.act + consumeActivity() 扣减，
 *    结果与「每日高倍活动（自动）」那套 events_json 打架 ——
 *    同一时刻存在两套活动上限，谁生效说不清；而且 roundsLeft 那个扣减机制
 *    还引入了「一局扣两次」的真 bug。
 *
 * 现在活动只有一个来源：decideRate 拿到的 ev 事件（见 server/odds/decide.js）。
 * 活动时段本身由 daily-activity.js 调度，Jev 只在那一小时里切菩萨 + 限倍率。
 */

/** 归一化调用方传入的活动对象；没有活动就返回 null（不是 {active:false}） */
function normAct(act) {
  if (!act || act.active !== true) return null;
  const maxRate = Number(act.maxRate) || 0;
  if (maxRate <= 0) return null;
  return { active: true, roundsLeft: 0, maxRate, instantPct: Number(act.instantPct) || 0 };
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
  if (act) {
    s.active_campaign = {
      rounds_remaining: act.roundsLeft,
      max_multiplier_allowed: `${act.maxRate}x`,
      note: `本段内爆点不超过 ${act.maxRate}x，更高的段实际不可用；策划要求其中约 ${act.instantPct}% 的局是瞬爆`,
    };
  }
  return s;
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
  const act = normAct(actCfg);   // 活动状态由调用方传入（每日高倍活动那一小时）
  // 【硬约束 2】没人 → 不调用 API。空房间也走 decideRate，
  // 在这里拉 Jev 会让一个没人玩的服持续烧钱。
  if (!state.enabled || !state.apiKey || !seated || !seated.length) {
    const persona = (act && act.active) ? 'bodhisattva' : state.persona;
    const bands = buildBands(seated.length ? seated.map((p) => p.thr) : [2], act, PERSONA_EDGE_SCALE[persona] || 1);
    const band = seated.length ? fallbackBand(seated, persona) : 'low';
    const rate = rateInBand(bands, band) ?? 2;
    return { band, bands, rate, persona, source: 'fallback', confidence: null, probs: null };
  }

  const persona = (act && act.active) ? 'bodhisattva' : state.persona;
  const bands = buildBands(seated.map((p) => p.thr), act, PERSONA_EDGE_SCALE[persona] || 1);
  const key = cacheKey(persona, bands);
  const hit = state.cache.get(key);

  if (hit && state.roundNo - hit.round < state.cacheRounds && fpMatch(hit.room, buildState(seated, lastBoom, bands, act).room)) {
    const band = sampleFromProbs(hit.probs) || 'low';
    state.usage.reused++;
    state.lastSource = 'cache';
    state.lastProbs = hit.probs;
    state.lastConfidence = hit.confidence;
    const rate = rateInBand(bands, band);
    if (rate == null) return fallback(seated, bands, persona);
    return { band, bands, rate, persona, source: 'cache', confidence: hit.confidence, probs: hit.probs };
  }

  // 未命中：这一局先降级，下一局预热后就能命中
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
  const act = normAct(actCfg);
  if (!state.enabled || !state.apiKey || !seated || !seated.length) return;
  if (state.sampleRate <= 0) return;
  if (Math.random() * 100 >= state.sampleRate) return;

  const persona = (act && act.active) ? 'bodhisattva' : state.persona;
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
    activity: { source: 'events_json（每日高倍活动）', note: '活动参数不再单独配置' },
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

module.exports = { configure, pickBand, prefetch, tickRound, status, preview, buildBands, buildState, normAct, state };
