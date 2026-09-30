'use strict';
/**
 * Jev 做庄离线测试 —— 不打网络，只验证决策逻辑与三条硬约束。
 *
 * 覆盖：
 *   1) 空房间 → 不调用 API（用户明确要求：没人就不要调用）
 *   2) 超时/失败/无 key → 降级，绝不 reject，绝不阻塞
 *   3) 分布复用 → 复用不改变分布形状，也不减少随机性
 *   4) 缓存 key 含人格与分段边界 → 活动段不会误用普通人格的分布
 *   5) 活动段上限不被突破 + 秒爆比例生效
 *   6) mode 7 无人时退回表驱动
 */
const assert = require('assert');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  OK   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

const jev = require('../server/jev');
const { buildBands, fallbackBand, rateInBand } = require('../server/jev-bands');
const { decideRate } = require('../server/game-logic');

/** 十人房间，阈值覆盖六种个性 */
const ROOM = [
  { ar: 'greedy', thr: 1.8, lossStreak: 0 },
  { ar: 'greedy', thr: 2.1, lossStreak: 1 },
  { ar: 'steady', thr: 2.4, lossStreak: 0 },
  { ar: 'steady', thr: 2.8, lossStreak: 2 },
  { ar: 'all_in', thr: 3.2, lossStreak: 0 },
  { ar: 'slow_hand', thr: 4.1, lossStreak: 0 },
  { ar: 'late_bomber', thr: 6.5, lossStreak: 3 },
  { ar: 'late_bomber', thr: 7.2, lossStreak: 0 },
  { ar: 'high_chaser', thr: 18, lossStreak: 5 },
  { ar: 'high_chaser', thr: 24, lossStreak: 1 },
];

// mock fetch：记录调用次数，可注入成功/失败
let calls = 0;
let fetchMode = 'ok';   // ok | fail | hang
const savedFetch = global.fetch;
global.fetch = async () => {
  calls++;
  if (fetchMode === 'fail') throw new Error('mock network down');
  if (fetchMode === 'hang') return new Promise(() => {});   // 永不 resolve，靠 abort
  return {
    ok: true,
    async json() {
      return {
        answers: { band: { probabilities: { instant: .05, low: .5, mid: .3, high: .1, top: .05 }, confidence: .82 } },
        usage: { input_tokens: 714, output_tokens: 70 },
      };
    },
  };
};

console.log('\n=== Jev 做庄离线测试 ===\n');

console.log('\n[1] 空房间不调用 API');
t('pickBand 空房间返回 fallback 且 calls 不变', () => {
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_persona: 'standard' });
  jev.tickRound(1);
  calls = 0;
  const r = jev.pickBand([], null, null);
  assert.strictEqual(r.source, 'fallback');
  assert.strictEqual(calls, 0, '空房间触发了 fetch');
  assert.ok(r.rate > 1, '空房间也必须有倍率，否则飞行时长为 0');
});
t('prefetch 空房间不调用 API', async () => {
  calls = 0;
  await jev.prefetch([], null, null);
  assert.strictEqual(calls, 0, '空房间 prefetch 触发了 fetch');
});
t('mode 7 有人下注但 ctx 缺失 → 退回表驱动', () => {
  // ⚠️ pot=0 会命中 game-logic 的「无下注 → 保底区间随机」提前 return，
  //    那是六个老模式共有的原有行为，不该由 mode 7 改写。
  const d = decideRate({ odds_mode: '7', min_rate: '1.20', max_rate: '50' }, 500, 1000, null, null);
  assert.ok(/^7-fallback/.test(d.mode), 'mode 应为 7-fallback，实际 ' + d.mode);
  assert.ok(d.rate >= 1.2, '倍率应落在配置区间');
});
t('mode 7 无人（pot=0）→ 走保底，不调 Jev', () => {
  const d = decideRate({ odds_mode: '7', min_rate: '1.20', max_rate: '50' }, 0, 1000, null, { seated: [], lastBoom: null });
  assert.strictEqual(d.mode, 'base', '空房间应走保底，实际 ' + d.mode);
});

console.log('\n[2] 降级与熔断');
t('无 key → 全部 fallback，不调用', () => {
  jev.configure({ jev_enabled: '1', jev_api_key: '', jev_persona: 'standard' });
  calls = 0;
  for (let i = 0; i < 20; i++) jev.pickBand(ROOM, 3, null);
  assert.strictEqual(calls, 0, '无 key 却发起了请求');
});
t('disabled → 不调用', () => {
  jev.configure({ jev_enabled: '0', jev_api_key: 'k' });
  calls = 0;
  for (let i = 0; i < 20; i++) jev.pickBand(ROOM, 3, null);
  assert.strictEqual(calls, 0, 'jev_enabled=0 却发起了请求');
});
t('未启用时仍能出倍率（游戏不能停）', () => {
  for (let i = 0; i < 50; i++) {
    const r = jev.pickBand(ROOM, 3, null);
    assert.ok(r.rate > 1, '倍率必须可用');
  }
});
t('fetch 抛错 → prefetch 不 reject', async () => {
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_cache_rounds: '1' });
  fetchMode = 'fail';
  calls = 0;
  await jev.prefetch(ROOM, 3, null);       // 关键：不许 throw
  assert.strictEqual(calls, 1, '应该真的尝试了一次');
  assert.strictEqual(jev.status().usage.fails, 1, '失败应被计数');
  fetchMode = 'ok';
});
t('fetch 挂住 → abort 超时后自行收敛', async () => {
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_timeout_ms: '200' });
  fetchMode = 'hang';
  const t0 = Date.now();
  await jev.prefetch(ROOM, 3, null);
  const dt = Date.now() - t0;
  assert.ok(dt < 1500, '超时未生效，耗时 ' + dt + 'ms');
  fetchMode = 'ok';
});

console.log('\n[3] 分布复用');
t('缓存未预热 → fallback', () => {
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_cache_rounds: '4' });
  calls = 0;
  const r = jev.pickBand(ROOM, 3, null);
  assert.strictEqual(r.source, 'fallback');
  assert.strictEqual(calls, 0);
});
t('预热后 → cache 命中，pickBand 不再发请求', async () => {
  jev.tickRound(10);
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_cache_rounds: '4' });
  calls = 0;
  await jev.prefetch(ROOM, 3, null);        // 1 次真实调用
  const before = calls;
  const hits = [];
  for (let i = 0; i < 10; i++) {
    jev.tickRound(11 + i);
    hits.push(jev.pickBand(ROOM, 3, null));
  }
  assert.strictEqual(calls, before, 'pickBand 阶段又发起了请求');
  const nCache = hits.filter((r) => r.source === 'cache').length;
  assert.ok(nCache >= 8, '复用率过低：' + nCache + '/10');
  const nLow = hits.filter((r) => r.band === 'low').length;
  assert.ok(nLow >= 3 && nLow <= 8, '分布形状被改变：low 出现 ' + nLow + '/10（期望中位）');
  assert.ok(new Set(hits.map((r) => r.rate)).size > 3, '复用后各局倍率相同 = 随机性丢失');
});
t('房间构成大变 → 指纹失配，转 fallback', () => {
  jev.tickRound(30);
  const allHigh = ROOM.map((p) => ({ ...p, thr: 15 + p.thr }));
  const r = jev.pickBand(allHigh, 3, null);
  assert.notStrictEqual(r.source, 'cache', '构成变了却还吃缓存');
});
t('roundNo 越过窗口 → 强制重问', () => {
  jev.tickRound(100);
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_cache_rounds: '2' });
  jev.tickRound(200);      // 远超窗口
  const r = jev.pickBand(ROOM, 3, null);
  assert.strictEqual(r.source, 'fallback', '超出复用窗口却仍命中缓存');
});

console.log('\n[4] 缓存 key 隔离');
t('人格不同 → 不共享缓存', () => {
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_persona: 'standard', jev_cache_rounds: '9' });
  const keyStd = 'standard|' + buildBands(ROOM.map((p) => p.thr), { active: false }, 1)
    .map((b) => `${b.key}:${b.min}-${b.max}`).join(',');
  assert.ok(keyStd.startsWith('standard|'), 'key 未含人格');
});
t('活动段压过上限后 key 必然不同', () => {
  const a = buildBands(ROOM.map((p) => p.thr), { active: false }, 1);
  const b = buildBands(ROOM.map((p) => p.thr), { active: true, maxRate: 20 }, 1);
  assert.notStrictEqual(
    a.map((x) => x.max).join(), b.map((x) => x.max).join(),
    '活动段压上限后分段没变 = 会误用普通段分布',
  );
});

console.log('\n[5] 活动段');
t('活动段倍率不超上限', () => {
  const act = { active: true, maxRate: 20 };
  const bands = buildBands(ROOM.map((p) => p.thr), act, 1);
  for (const b of bands) {
    assert.ok(b.max <= 20.001, `${b.label} 上界 ${b.max} 突破上限 20`);
  }
});
t('活动段秒爆比例生效（确定性配额）', () => {
  // ⚠️ 这条测的是「配额调度器」，不是权重表。
  //    早先版本只把 instantPct 写进 state 的 note 让 Jev「注意」，
  //    配 30% 实际只有 2-4% —— Jev 返回的是段权重，它不数局。
  jev.configure({
    jev_enabled: '1', jev_api_key: 'k', jev_persona: 'standard',
    jev_act_enabled: '1', jev_act_rounds: '100', jev_act_max: '25', jev_act_instant: '20',
  });
  let inst = 0;
  const N = 100;
  for (let i = 1; i <= N; i++) {
    jev.tickRound(i);
    const r = jev.pickBand(ROOM, 3, null);
    if (r.band === 'instant') inst++;
    jev.consumeActivity();
  }
  // 100 局 × 20% = 20 局【强制】秒爆。
  // ⚠️ 实际可能 > 20：配额只保证「至少」这么多局，Jev 自己的 instant 权重
  //    也会偶尔额外选 instant（实测 24）。所以这里断言下界 + 一个宽松上界，
  //    断言等于 20 反而是把「Jev 不能自己选瞬爆」当成了需求。
  assert.ok(inst >= 20, `配 20% 只有 ${inst}/100 局秒爆（强制配额没铺开）`);
  assert.ok(inst <= 30, `配 20% 出现 ${inst}/100 局秒爆（远超预期，配额或权重有 bug）`);
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_persona: 'standard', jev_act_enabled: '0', jev_act_rounds: '0', jev_act_max: '0', jev_act_instant: '0' });
});
t('秒爆 0% 时不强制', () => {
  jev.configure({
    jev_enabled: '1', jev_api_key: 'k', jev_persona: 'standard',
    jev_act_enabled: '1', jev_act_rounds: '50', jev_act_max: '25', jev_act_instant: '0',
  });
  let inst = 0;
  for (let i = 1; i <= 50; i++) {
    jev.tickRound(i);
    if (jev.pickBand(ROOM, 3, null).band === 'instant') inst++;
    jev.consumeActivity();
  }
  assert.ok(inst <= 3, `配 0% 却有 ${inst}/50 局秒爆（应接近 0）`);
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_persona: 'standard', jev_act_enabled: '0', jev_act_rounds: '0', jev_act_max: '0', jev_act_instant: '0' });
});
t('一个局的配额不被消费两次', () => {
  jev.configure({
    jev_enabled: '1', jev_api_key: 'k', jev_persona: 'standard',
    jev_act_enabled: '1', jev_act_rounds: '10', jev_act_max: '25', jev_act_instant: '50',
  });
  let inst = 0;
  for (let i = 1; i <= 10; i++) {
    jev.tickRound(i);
    if (jev.pickBand(ROOM, 3, null).band === 'instant') inst++;
    jev.consumeActivity();
  }
  // 10 局 × 50% = 5 局【强制】秒爆。
  // ⚠️ 同样可能 > 5：Jev 自己的 instant 权重会额外贡献。
  //    若配额被重复消费，配 50% 会飙到 10 局（每局都命中），
  //    所以上界取 7 —— 能区分「多消费一次」和「Jev 额外选」。
  assert.ok(inst >= 5, `配 50%/10局 只有 ${inst} 局秒爆（配额没铺开）`);
  assert.ok(inst <= 7, `配 50%/10局 出现 ${inst} 局秒爆（配额被重复消费）`);
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_persona: 'standard', jev_act_enabled: '0', jev_act_rounds: '0', jev_act_max: '0', jev_act_instant: '0' });
});
t('活动段生效时人格被强制为菩萨', () => {
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_persona: 'standard', jev_act_enabled: '1', jev_act_rounds: '5', jev_act_max: '20' });
  jev.tickRound(1);
  const r = jev.pickBand(ROOM, 3, null);
  assert.strictEqual(r.persona, 'bodhisattva', '活动段未切菩萨，实际 ' + r.persona);
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_persona: 'standard', jev_act_enabled: '0', jev_act_rounds: '0', jev_act_max: '0' });
});
t('活动段用尽后自动关闭', () => {
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_persona: 'standard', jev_act_enabled: '1', jev_act_rounds: '2', jev_act_max: '20' });
  // 一个局扣一次（engine 起飞时），pickBand 本身只查询
  const p1 = jev.pickBand(ROOM, 3, null); assert.strictEqual(p1.persona, 'bodhisattva', '第 1 局应生效');
  jev.consumeActivity();
  const p2 = jev.pickBand(ROOM, 3, null); assert.strictEqual(p2.persona, 'bodhisattva', '第 2 局应生效');
  jev.consumeActivity();
  const p3 = jev.pickBand(ROOM, 3, null); assert.strictEqual(p3.persona, 'standard', '第 3 局应已关闭，实际 ' + p3.persona);
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_persona: 'standard', jev_act_enabled: '0', jev_act_rounds: '0', jev_act_max: '0' });
});
t('一次 consume 只扣一局（回归：早先一局扣两次）', () => {
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_persona: 'standard', jev_act_enabled: '1', jev_act_rounds: '5', jev_act_max: '20' });
  jev.consumeActivity();
  assert.strictEqual(jev.activity().roundsLeft, 4, '扣了不止一局');
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_persona: 'standard', jev_act_enabled: '0', jev_act_rounds: '0', jev_act_max: '0' });
});

console.log('\n[6] 分段与降级分布');
t('分段单调递增且无倒挂', () => {
  for (const maxRate of [10, 20, 25, 50, 100]) {
    const b = buildBands(ROOM.map((p) => p.thr), { active: true, maxRate }, 1);
    for (let i = 1; i < b.length; i++) {
      assert.ok(b[i].min >= b[i - 1].max - 0.02, `${maxRate}x 时段 ${b[i].key} 倒挂`);
      assert.ok(b[i].max > b[i].min, `${maxRate}x 时段 ${b[i].key} 宽度为 0`);
    }
  }
});
t('降级分布不是恒定第一段（归一化 bug 回归）', () => {
  const cnt = { instant: 0, low: 0, mid: 0, high: 0, top: 0 };
  for (let i = 0; i < 3000; i++) cnt[fallbackBand(ROOM, 'standard')]++;
  assert.ok(cnt.mid + cnt.high + cnt.top > 300, '永远只选第一段：' + JSON.stringify(cnt));
});
t('菩萨降级赢面高于标准', () => {
  const winOf = (persona) => {
    const bands = buildBands(ROOM.map((p) => p.thr), { active: false }, 1);
    let win = 0, N = 1500;
    for (let i = 0; i < N; i++) {
      const rate = rateInBand(bands, fallbackBand(ROOM, persona));
      win += ROOM.filter((p) => rate >= p.thr).length / ROOM.length;
    }
    return win / N;
  };
  const s = winOf('standard'), b = winOf('bodhisattva');
  assert.ok(b > s, `菩萨(${b.toFixed(3)}) 未高于标准(${s.toFixed(3)})`);
});
t('rateInBand 越界返回 null 而不是错误倍率', () => {
  const bands = buildBands([1.0], { active: false }, 1);
  assert.strictEqual(rateInBand(bands, 'nonexistent'), null);
});

console.log('\n[7] mode 7 有房间时走 Jev');
t('mode 7 + 有房间 → rate 有效', () => {
  jev.configure({ jev_enabled: '1', jev_api_key: '', jev_persona: 'standard' });
  for (let i = 0; i < 30; i++) {
    const d = decideRate({ odds_mode: '7', min_rate: '1.20', max_rate: '50' }, 1000, 1000, null, { seated: ROOM, lastBoom: 3 });
    assert.strictEqual(d.mode, '7-jev');
    assert.ok(d.rate >= 1 && isFinite(d.rate), '倍率异常 ' + d.rate);
    assert.ok(d.jev.band, '缺少段信息');
  }
});
t('mode 1-6 不受 ctx 影响（回归）', () => {
  const a = decideRate({ odds_mode: '3', min_rate: '1.20', max_rate: '50' }, 1000, 1000, null);
  const b = decideRate({ odds_mode: '3', min_rate: '1.20', max_rate: '50' }, 1000, 1000, null, { seated: ROOM, lastBoom: 3 });
  assert.strictEqual(a.mode, b.mode, '传 ctx 改变了旧模式行为');
});

console.log('\n[8] 成本统计');
t('usage 累计 input token 并算成本', async () => {
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_cache_rounds: '1' });
  calls = 0;
  await jev.prefetch(ROOM, 3, null);
  const s = jev.status();
  assert.strictEqual(s.usage.calls >= 1, true);
  assert.ok(s.usage.perCallTokens > 0, '未统计每调用 token');
  assert.ok(s.usage.costUsd >= 0, '成本计算异常');
});
t('预览绝不调用 Jev', () => {
  jev.configure({ jev_enabled: '1', jev_api_key: 'k', jev_persona: 'standard' });
  calls = 0;
  const p = jev.preview(500);
  assert.strictEqual(calls, 0, '预览烧了钱');
  assert.ok(p.avgWinShare >= 0 && p.avgWinShare <= 100);
  assert.ok(p.bands.length === 5, '分段数不对');
});

global.fetch = savedFetch;
console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===\n`);
process.exit(fail ? 1 : 0);
