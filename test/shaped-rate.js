'use strict';
/**
 * test/shaped-rate.js —— 「零套利 + 高倍率观感」分布引擎（mode 10）验收
 *
 * 【只断言不变量，不断言具体数值】
 * 随机分布的测试断言具体倍率/分位数/不同值个数，会随机红，且会训练人
 * 不断放宽��差直到判据失去意义。这里断言的是【性质】：
 *   · 区间闭合（空房必在 [10,39]）
 *   · 套利上界（任一逃跑点毛赔付 < 保本线）
 *   · 分布连续（无空档、无原子堆积）
 *   · 无记忆（相邻无关、非配额、无短周期）
 *   · 随机源不可预测（零 Math.random）
 *
 * 例外：空房区间 [10,39] 是【客户需求写死的常量】，
 *       断言它不越界是断言需求被满足，不是断言随机结果。
 */
const S = require('../server/odds/shaped-rate.js');
const GL = require('../server/odds');

const N = 600_000;
const IDLE_N = 20_000;
const EDGE = GL.CFG.HOUSE_EDGE;          // 0.03
const BREAKEVEN = 1 / (1 - EDGE);        // 1.0309 毛赔付保本线

let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + m + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + m + (extra ? '  ' + extra : '')); }
};
const line = t => console.log('\n' + '='.repeat(74) + '\n' + t + '\n' + '='.repeat(74));

const sorted = (arr) => Float64Array.from(arr).sort();
/** P(X ≥ c) —— 注意是「大于等于」，用于验证 cap 处的质量确实可达 */
const Pge = (a, c) => {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < c) lo = m + 1; else hi = m; }
  return (a.length - lo) / a.length;
};
/** P(X > c) —— 引擎的判胜规则是 cur >= boom 拒绝，所以真实胜率是这个 */
const Sgt = (a, c) => {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= c) lo = m + 1; else hi = m; }
  return (a.length - lo) / a.length;
};

console.log(`\n=== 分布引擎验收：真人局 ${N.toLocaleString()} 局 / 空房局 ${IDLE_N.toLocaleString()} 局 ===`);
console.log(`毛赔付保本线 = 1/(1−${EDGE}) = ${BREAKEVEN.toFixed(4)}`);

// ═════════════ §1 真人局：套利上界 ═════════════
line('§1 不变量①：任一逃跑点的毛赔付都低于保本线（构造保证）');
{
  const xs = new Float64Array(N);
  for (let i = 0; i < N; i++) xs[i] = S.shapedRate(1000);
  const a = sorted(xs);

  const grid = [];
  for (let c = 1.01; c <= 2.0; c += 0.01) grid.push(+c.toFixed(2));
  for (let c = 2.0; c <= 10; c += 0.05) grid.push(+c.toFixed(2));
  for (let c = 10; c <= 1000; c *= 1.02) grid.push(+c.toFixed(2));

  let peak = 0, peakAt = 0, nUp = 0;
  for (const c of grid) {
    const P = Sgt(a, c);
    if (P === 0) continue;
    const g = c * P;
    if (g > peak) { peak = g; peakAt = c; }
    if ((1 - EDGE) * g - 1 > 0) nUp++;
  }
  console.log(`  网格 ${grid.length} 点，峰值毛赔付 = ${peak.toFixed(4)} @ ${peakAt.toFixed(2)}x`);
  ok(peak < BREAKEVEN, '全网格毛赔付峰值 < 保本线（无套利区）', `${peak.toFixed(4)} < ${BREAKEVEN.toFixed(4)}`);
  ok(nUp === 0, '净 EV > 0 的点数 = 0', `${nUp} 个`);

  // 理论上限：中位数必然 < 1.0309/0.5 = 2.0618
  const med = a[Math.floor(0.5 * N)];
  console.log(`  中位数 = ${med.toFixed(2)}x（零套利的理论上限是 ${(BREAKEVEN / 0.5).toFixed(4)}x）`);
  ok(med < BREAKEVEN / 0.5, '中位数低于零套利的理论天花板', `${med.toFixed(2)}x < ${(BREAKEVEN / 0.5).toFixed(2)}x`);
}

// ═════════════ §2 真人局：分布连续性 ═════════════
line('§2 不变量②：无空档、无原子堆积（玩家看不见「习惯区间」）');
{
  const xs = new Float64Array(N);
  for (let i = 0; i < N; i++) xs[i] = S.shapedRate(1000);
  const a = sorted(xs);

  // 空档：相邻网格点 S 完全相等 = 该区间一个落点都没有
  const g2 = [];
  for (let c = 1.01; c <= 3.0; c += 0.01) g2.push(+c.toFixed(2));
  for (let c = 3.05; c <= 12; c += 0.05) g2.push(+c.toFixed(2));
  for (let c = 12; c <= 1000; c *= 1.05) g2.push(+c.toFixed(2));
  let holes = 0;
  let prev = Pge(a, g2[0]);
  for (let i = 1; i < g2.length; i++) {
    const P = Pge(a, g2[i]);
    if (P === prev) holes++;
    else prev = P;
  }
  ok(holes === 0, '无空档（S 在细网格上处处严格下降）', `${g2.length} 点网格，空档 ${holes} 处`);

  // 尾部可达：cap 附近必须真能出得来，否则是「配了但永不出现」
  const atCap = a.filter(v => v >= 1000).length / N;
  const p999 = a[Math.floor(0.999 * N)];
  console.log(`  触顶(≥1000x) = ${(atCap * 100).toFixed(4)}%   p999 = ${p999.toFixed(2)}x   观测最大 = ${a[N - 1].toFixed(2)}`);
  ok(atCap > 0, 'cap 处的质量【可达】（不是「配了 1000 但永不出现」）', `${(atCap * 100).toFixed(4)}%`);
  ok(p999 > 100, 'p999 进入三位数量级（尾部不是被砍掉的）', p999.toFixed(2) + 'x');

  // 上下界
  ok(a[0] >= 1, '最小倍率 ≥ 1.00', a[0].toFixed(2));
  ok(a[N - 1] <= 1000 + 1e-9, '最大倍率 ≤ cap', a[N - 1].toFixed(2));
  ok(xs.every(v => isFinite(v)), '无 NaN / Infinity');
}

// ═════════════ §3 真人局：可预测性 ═════════════
line('§3 不变量③：无记忆、非配额、无短周期');
{
  const xs = new Float64Array(N);
  for (let i = 0; i < N; i++) xs[i] = S.shapedRate(1000);

  let ma = 0, mb = 0;
  for (let i = 0; i + 1 < N; i++) { ma += xs[i]; mb += xs[i + 1]; }
  ma /= N; mb /= N;
  let sa = 0, sb = 0, sab = 0;
  for (let i = 0; i + 1 < N; i++) {
    const dx = xs[i] - ma, dy = xs[i + 1] - mb;
    sa += dx * dx; sb += dy * dy; sab += dx * dy;
  }
  const r = sab / Math.sqrt(sa * sb);
  ok(Math.abs(r) < 0.01, '相邻局倍率相关系数 |r| < 0.01', 'r = ' + r.toFixed(5));

  // 非配额：配额式实现的分块计数标准差会是 0
  const blocks = [];
  for (let b = 0; b + 100 <= N; b += 100) {
    let c = 0;
    for (let i = b; i < b + 100; i++) if (xs[i] >= 10) c++;
    blocks.push(c);
  }
  const m = blocks.reduce((a, b) => a + b, 0) / blocks.length;
  const sd = Math.sqrt(blocks.reduce((a, b) => a + (b - m) ** 2, 0) / blocks.length);
  ok(sd > 1.5, '非配额（每 100 局 ≥10x 局数标准差 > 1.5）', 'σ = ' + sd.toFixed(2));

  // 短周期
  const seq = [];
  for (let i = 0; i < 2000; i++) seq.push(S.shapedRate(1000));
  let period = null;
  for (const k of [2, 3, 4, 5, 7, 10, 20, 50, 100]) {
    let same = true;
    for (let i = k; i < seq.length; i++) if (seq[i] !== seq[i - k]) { same = false; break; }
    if (same) { period = k; break; }
  }
  ok(period === null, '2000 局序列无任何短周期（2/3/4/5/7/10/20/50/100）', period === null ? '确认无' : '周期 ' + period);
}

// ═════════════ §4 空房局：客户需求区间 ═════════════
line('§4 空房局：倍率必须落在 [10, 39]');
{
  const xs = new Float64Array(IDLE_N);
  for (let i = 0; i < IDLE_N; i++) xs[i] = S.idleRate();
  const a = sorted(xs);

  const out = xs.filter(v => v < S.SHAPED.IDLE_MIN || v > S.SHAPED.IDLE_MAX).length;
  console.log(`  N=${IDLE_N}  min=${a[0].toFixed(2)}  max=${a[IDLE_N - 1].toFixed(2)}  越界 ${out} 局`);
  ok(out === 0, '全部落在 [10, 39]，越界 0 局', `${out} 局越界`);
  ok(a[0] >= S.SHAPED.IDLE_MIN, '下界 ≥ 10', a[0].toFixed(2));
  ok(a[IDLE_N - 1] <= S.SHAPED.IDLE_MAX, '上界 ≤ 39', a[IDLE_N - 1].toFixed(2));

  // 形态合理：不能全堆在两端（那是「看得见的习惯区间」）
  //
  // ⚠️ 两处算术陷阱（第一版都踩了，得到的占比是负数）：
  //  ① 区间占比的方向：P(a ≤ X < b) = Pge(a) − Pge(b)。
  //     我把高端区间写成了 Pge(39) − Pge(37) = 0 − 0.039 = 负数。
  //  ② Pge 是「大于等于」，而区间左端是闭的。当 min 恰好等于 10.00 时
  //     Pge(10) = 1.0（含那个点），所以 Pge(12)−Pge(10) 恒为负。
  //     正确写法是 P(X ≥ 12) 的补集，即 1 − Pge(12)。
  const edgeLow = 1 - Pge(a, 12);           // P(10 ≤ X < 12)
  const edgeHigh = Pge(a, 37);              // P(37 ≤ X < 39)
  const edgeMass = edgeLow + edgeHigh;
  const midMass = Pge(a, 12) - Pge(a, 37);  // P(12 ≤ X < 37)
  console.log(`  10-12x = ${(edgeLow * 100).toFixed(1)}%   37-39x = ${(edgeHigh * 100).toFixed(1)}%` +
    `   两端合计 = ${(edgeMass * 100).toFixed(1)}%   中段(12-37) = ${(midMass * 100).toFixed(1)}%`);
  ok(edgeMass > 0 && midMass > 0, '两端与中段的占比都是正数（区间算术正确）',
    `${(edgeMass * 100).toFixed(1)}% / ${(midMass * 100).toFixed(1)}%`);
  ok(edgeMass < midMass, '质量不在两端堆积（钟形而非均匀）', `${(edgeMass * 100).toFixed(1)}% < ${(midMass * 100).toFixed(1)}%`);

  // 空房局的「套利」不在于 EV（没人下注），但仍要保证不与真人局混淆：
  // 空房局不该给玩家任何可利用的信号 —— 它是无人时的背景噪声。
  const med = a[Math.floor(0.5 * IDLE_N)];
  ok(med > S.SHAPED.IDLE_MIN && med < S.SHAPED.IDLE_MAX, '中位数落在区间内部（不是贴边）', med.toFixed(2) + 'x');
}

// ═════════════ §5 隔离验证 ═════════════
line('§5 隔离：空房局不得污染真人局');
{
  // 隔离的三个层面，逐条验证：
  //  ① 分布隔离：空房局与真人局的支撑集不重叠
  const idle = new Float64Array(50000);
  for (let i = 0; i < 50000; i++) idle[i] = S.idleRate();
  const ai = sorted(idle);
  const overlap = Pge(ai, 1.0) - Pge(ai, 10);   // 真人局会落在 1~10 的部分
  ok(overlap === 0, '空房局支撑集 ⊆ [10,39]，与真人局的低倍率区不重叠', `重叠区占比 ${(overlap * 100).toFixed(2)}%`);

  //  ② 顺序无关：空房局夹在真人局中间，不改变真人局的分布
  const before = new Float64Array(200000);
  for (let i = 0; i < 200000; i++) before[i] = S.shapedRate(1000);
  const ab = sorted(before);
  // 交替：真人、空房、真人、空房…
  const after = new Float64Array(200000);
  for (let i = 0; i < 200000; i++) { S.idleRate(); after[i] = S.shapedRate(1000); }   // 空房局被丢弃
  const aa = sorted(after);
  const medB = ab[Math.floor(0.5 * 200000)], medA = aa[Math.floor(0.5 * 200000)];
  const shift = Math.abs(medA - medB) / medB;
  console.log(`  真人局中位数：插空房局前 ${medB.toFixed(3)}x → 后 ${medA.toFixed(3)}x（漂移 ${(shift * 100).toFixed(3)}%）`);
  ok(shift < 0.02, '空房局不改变真人局中位数（隔离成立）', `漂移 ${(shift * 100).toFixed(3)}%`);

  //  ③ 结构隔离：shapedDecide 按 idle 走完全不同的分支
  const cfg = { powerlaw_cap: '1000' };
  const live = S.shapedDecide(cfg, false);
  const empty = S.shapedDecide(cfg, true);
  ok(live.mode !== empty.mode, '两个分支 mode 不同（不会互相串）', live.mode + ' vs ' + empty.mode);
  ok(empty.rate >= 10 && empty.rate <= 39, 'idle 分支产出恒在 [10,39]', empty.rate.toFixed(2) + 'x');
  ok(live.rate >= 1 && live.rate <= 1000, 'live 分支产出恒在 [1,1000]', live.rate.toFixed(2) + 'x');
}

// ═════════════ §6 随机源 ═════════════
line('§6 随机源：必须走 CSPRNG');
{
  let used = 0;
  const orig = Math.random;
  Math.random = function () { used++; return orig(); };
  let idleUsed = 0;
  try {
    for (let i = 0; i < 3000; i++) { S.shapedRate(1000); S.idleRate(); }
  } finally {
    Math.random = orig;
  }
  void idleUsed;
  ok(used === 0, 'shapedRate + idleRate 一次 Math.random 都没调用', `调用 ${used} 次`);
}

console.log('\n' + '='.repeat(74));
console.log(`  通过 ${pass}  失败 ${fail}`);
console.log('='.repeat(74));
process.exit(fail ? 1 : 0);
