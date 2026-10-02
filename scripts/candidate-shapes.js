'use strict';
/**
 * candidate-shapes.js —— 「50% 的局落在 5x–30x」的候选分布形状筛选
 *
 * 【为什么必须换形状，而不是调幂律参数】
 * 幂律的恒等式是 P(X≥m) = RTP/m。要 P(X≥5) = 50% ⇒ RTP = 2.5，
 * 而 RTP 硬上限 1.00（超过 1.0309 玩家正期望）。所以纯幂律公式下
 * 「50% 的局在 5x 以上」数学上不可能 —— 这是公式本身，不是调参问题。
 *
 * 【两条必须守住的底线】（客户没说要破坏，但游戏能成立的前提）
 *   ① 玩家长期净期望必须为负：等效 RTP ≤ 1.00
 *   ② 不许出现确定性可套利区：不能有固定逃跑点必胜或高胜率
 *      ⇒ 分布必须连续、无跳档、无固定分点
 *
 * 【本脚本只做筛选，不进生产】纯本地、零 API 成本、不碰数据库与服务器。
 * 结论要落成静态参数 + 纯函数，线上引擎纯计算、无网络。
 *
 * 用法：node scripts/candidate-shapes.js --n=500000
 */
const crypto = require('crypto');
const path = require('path');
const GL = require(path.join(__dirname, '..', 'server', 'odds'));

const arg = (k, d) => { const h = process.argv.find(a => a.startsWith('--' + k + '=')); return h ? h.slice(k.length + 3) : d; };
const N = Number(arg('n', 500000));
const CAP = Number(arg('cap', 1000));
const EDGE = GL.CFG.HOUSE_EDGE;          // 0.03
const TARGET_LO = 5, TARGET_HI = 30;     // 客户要求的中段
const TARGET_SHARE = 0.50;

function u() { const b = crypto.randomBytes(6); let n = 0; for (let i = 0; i < 6; i++) n = n * 256 + b[i]; return (n + 0.5) / 281474976710656; }
const r2 = n => Math.round(n * 100) / 100;

/**
 * 求分布的逆变换采样点：把 CDF 离散成等概率区间表。
 * 这样任何形状都能用【一个均匀随机数】实现，保证零状态、无记忆。
 */
function makeSampler(pdf, lo = 1, hi = CAP, gridN = 4000) {
  // 对数网格：倍率域跨 3 个数量级，线性网格会让低倍率段几乎没有分辨率
  const edges = new Float64Array(gridN + 1);
  for (let i = 0; i <= gridN; i++) edges[i] = lo * Math.pow(hi / lo, i / gridN);
  const cdf = new Float64Array(gridN + 1);
  let acc = 0;
  for (let i = 0; i < gridN; i++) {
    // 积分用梯形法，区间内取几何中点采样密度
    const a = edges[i], b = edges[i + 1];
    const m = Math.sqrt(a * b);
    acc += pdf(m) * (b - a);
    cdf[i + 1] = acc;
  }
  for (let i = 0; i <= gridN; i++) cdf[i] /= acc;
  return function sample() {
    const t = u();
    // 二分找 CDF 区间
    let loI = 0, hiI = gridN;
    while (loI < hiI) { const m = (loI + hiI) >> 1; if (cdf[m] < t) loI = m + 1; else hiI = m; }
    const i = Math.max(0, loI - 1);
    const c0 = cdf[i], c1 = cdf[i + 1];
    const f = c1 > c0 ? (t - c0) / (c1 - c0) : 0;
    return r2(edges[i] + (edges[i + 1] - edges[i]) * f);
  };
}

// ══════════════ 四种候选形状 ══════════════

/**
 * 候选 A：幂律 × 中段软加权（乘性调整）
 *   p(r) ∝ r^(-α) · (1 + c·ln(1+r))
 * 幂律的尾部形态保留，只把中段质量抬起来。
 */
function shapeA(alpha, c) {
  return makeSampler(r => Math.pow(r, -alpha) * (1 + c * Math.log(1 + r)));
}

/**
 * 候选 B：两段幂律混合（在 ln5 处换指数）
 *   低段指数陡（压低 <5x 的质量），中段指数平（抬高 5-30x），高段回到陡尾。
 *   换指数处必须 C0 连续，否则接缝就是一个玩家能看见的「习惯区间」边界。
 */
function shapeB(aLow, aMid, aHigh, kneeLo, kneeHi) {
  // 归一化系数，保证三段在接缝处连续
  const kMid = Math.pow(kneeLo, aLow - aMid);
  const kHigh = kMid * Math.pow(kneeHi, aMid - aHigh);
  return makeSampler(r => {
    if (r < kneeLo) return Math.pow(r, -aLow);
    if (r < kneeHi) return kMid * Math.pow(r, -aMid);
    return kHigh * Math.pow(r, -aHigh);
  });
}

/**
 * 候选 C：对数正态截断在 [1, cap]
 *   ln X ~ N(μ, σ)，取 μ 使中位数落在目标区间，σ 控制集中度。
 *   σ 小 ⇒ 质量集中（中段占比高）但尾部薄；σ 大 ⇒ 尾部厚但中位数被拉低。
 */
function shapeC(mu, sigma) {
  // 误差函数 CDF 的数值近似（Abramowitz-Stegun 7.1.26），用于逆变换
  const Phi = (z) => {
    const s = z < 0 ? -1 : 1, x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return 0.5 * (1 + s * y);
  };
  const lnLo = Math.log(1), lnHi = Math.log(CAP);
  const pLo = Phi((lnLo - mu) / sigma), pHi = Phi((lnHi - mu) / sigma);
  return function () {
    const t = u() * (pHi - pLo) + pLo;
    // 数值反解 Phi
    let a = -8, b = 8;
    for (let i = 0; i < 60; i++) { const m = (a + b) / 2; if (Phi(m) < t) a = m; else b = m; }
    return r2(Math.exp(mu + sigma * (a + b) / 2));
  };
}

/**
 * 候选 D：幂律底 + 中段「软 plateau」
 *   p(r) ∝ r^(-α) · plateau(r)，plateau 在 [lo,hi] 内为 1，在区间外平滑衰减。
 *   目的是把质量【均匀铺开】在 5-30x，而不是堆到某一点。
 */
function shapeD(alpha, lo, hi, width) {
  const plateau = (r) => {
    if (r >= lo && r <= hi) return 1;
    const d = r < lo ? (lo - r) : (r - hi);
    return 1 / (1 + Math.pow(d / width, 2));
  };
  return makeSampler(r => Math.pow(r, -alpha) * plateau(r));
}

// ══════════════ 评价指标 ══════════════
function evaluate(label, sampler, note) {
  const xs = new Float64Array(N);
  for (let i = 0; i < N; i++) xs[i] = sampler();
  const s = Float64Array.from(xs).sort();
  const Sge = c => { let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] < c) lo = m + 1; else hi = m; } return (N - lo) / N; };
  const Sgt = c => { let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] <= c) lo = m + 1; else hi = m; } return (N - lo) / N; };
  const pct = p => s[Math.min(N - 1, Math.floor(p * N))];

  const share = Sge(TARGET_LO) - Sge(TARGET_HI);   // [5,30) 占比
  // 等效 RTP：毛赔付 c·S(c) 在各点的中位水平（用于判断玩家长期期望）
  // 玩家真实净 EV = 0.97·m·P(X>m) − 1
  const netEvAt = m => (1 - EDGE) * m * Sgt(m) - 1;

  // 全网格 EV
  const grid = [];
  for (let c = 1.01; c <= 2.0; c += 0.01) grid.push(+c.toFixed(2));
  for (let c = 2.0; c <= 10; c += 0.05) grid.push(+c.toFixed(2));
  for (let c = 10; c <= CAP; c *= 1.02) grid.push(+c.toFixed(2));
  // 等效 RTP 取各点毛赔付的中位数（分布形状变了，恒等式不再成立，需要一个标量）
  const grossList = grid.map(c => { const P = Sgt(c); return P > 0 ? c * P : null; }).filter(x => x !== null);
  const grossSorted = grossList.slice().sort((a, b) => a - b);
  const equivRtp = grossSorted[Math.floor(grossSorted.length / 2)];
  const evTheory = (1 - EDGE) * equivRtp - 1;

  let maxZ = 0, maxZc = 0, nUp = 0, worstUp = null;
  for (const c of grid) {
    const P = Sgt(c); if (P === 0) continue;
    const ev = (1 - EDGE) * c * P - 1;
    if (ev > 0) { nUp++; if (worstUp === null || ev > worstUp.ev) worstUp = { c, ev }; }
    const sigma = c * (1 - EDGE) * Math.sqrt(P * (1 - P) / N);
    const rel = 3 * Math.sqrt((1 - P) / (N * P));
    if (rel > 0.03) continue;                     // 样本不足，不计判据
    const z = (ev - evTheory) / sigma;
    if (Math.abs(z) > Math.abs(maxZ)) { maxZ = z; maxZc = c; }
  }

  // 可预测性
  let ma = 0, mb = 0;
  for (let i = 0; i + 1 < N; i++) { ma += xs[i]; mb += xs[i + 1]; }
  ma /= N; mb /= N;
  let sa = 0, sb = 0, sab = 0, dup = 0;
  for (let i = 0; i + 1 < N; i++) {
    const dx = xs[i] - ma, dy = xs[i + 1] - mb;
    sa += dx * dx; sb += dy * dy; sab += dx * dy;
    if (Math.abs(xs[i] - xs[i + 1]) / Math.max(xs[i], xs[i + 1]) < 0.08) dup++;
  }
  const r = sab / Math.sqrt(sa * sb);
  const blocks = [];
  for (let b = 0; b + 100 <= N; b += 100) { let c = 0; for (let i = b; i < b + 100; i++) if (xs[i] >= 10) c++; blocks.push(c); }
  const bM = blocks.reduce((a, b) => a + b, 0) / blocks.length;
  const bSd = Math.sqrt(blocks.reduce((a, b) => a + (b - bM) ** 2, 0) / blocks.length);

  return {
    label, note, share, equivRtp, evTheory, maxZ, maxZc, nUp, worstUp, r, bSd,
    dupPct: dup / (N - 1),
    p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: s[N - 1],
    tail500: Sgt(500), tail1000: Sgt(1000),
    s, Sgt,
  };
}

const line = t => console.log('\n' + '='.repeat(80) + '\n' + t + '\n' + '='.repeat(80));

line('§0 当前基线（幂律 RTP=0.90 / cap=1000）—— 负责人已实测，我复算确认');
{
  const xs = new Float64Array(N);
  for (let i = 0; i < N; i++) xs[i] = GL.powerlawRate(0.90, CAP);
  const s = Float64Array.from(xs).sort();
  const Sge = c => { let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] < c) lo = m + 1; else hi = m; } return (N - lo) / N; };
  const pct = p => s[Math.min(N - 1, Math.floor(p * N))];
  const b = (a, z) => (Sge(a) - Sge(z)) * 100;
  console.log('  <2x      ' + b(1, 2).toFixed(1) + '%');
  console.log('  2-5x     ' + b(2, 5).toFixed(1) + '%');
  console.log('  5-30x    ' + b(5, 30).toFixed(1) + '%   ← 客户目标 50%');
  console.log('  >=30x    ' + Sge(30).toFixed(1) + '%');
  console.log('  中位数   ' + pct(0.5).toFixed(2) + 'x');
  console.log('  玩家净EV ' + (((1 - EDGE) * 0.90 - 1) * 100).toFixed(2) + '%');
}

line('§1 候选形状对比（N=' + N.toLocaleString() + '，全部零 API 成本）');
console.log('  判据：① 5-30x 占比 ≥50%  ② 净EV<0  ③ 全网格无正期望点且|maxZ|≤3σ  ④ |r|<0.01 且非配额');
console.log('');
console.log('  候选'.padEnd(30) + '5-30x'.padStart(8) + '中位数'.padStart(9) + '等效RTP'.padStart(10) +
  '玩家净EV'.padStart(11) + 'maxZ'.padStart(8) + '正期望点'.padStart(10) + '|r|'.padStart(9) + '配额σ'.padStart(8));

const cands = [
  ['A 幂律×中段软加权 α=1.0 c=2.5', shapeA(1.0, 2.5), 'r^-1 · (1+2.5·ln(1+r))'],
  ['A2 幂律×中段软加权 α=0.9 c=3.5', shapeA(0.9, 3.5), 'r^-0.9 · (1+3.5·ln(1+r))'],
  ['B 两段幂律 1.4/0.55/1.6', shapeB(1.4, 0.55, 1.6, 5, 30), '低陡/中平/高陡，接缝 C0 连续'],
  ['B2 两段幂律 1.6/0.5/1.8', shapeB(1.6, 0.5, 1.8, 5, 30), '更低段、更集中中段'],
  ['C 对数正态 μ=2.4 σ=0.85', shapeC(2.4, 0.85), 'lnX~N(2.4,0.85) 截断[1,1000]'],
  ['C2 对数正态 μ=2.8 σ=0.70', shapeC(2.8, 0.70), '更高更窄'],
  ['D 幂律底+plateau α=1.2 [5,30] w=8', shapeD(1.2, 5, 30, 8), '幂律×中段软平台'],
  ['D2 幂律底+plateau α=1.0 [5,30] w=12', shapeD(1.0, 5, 30, 12), '更宽的平台'],
];

const results = [];
for (const [label, sampler, note] of cands) {
  const r = evaluate(label, sampler, note);
  results.push(r);
  const passShare = r.share >= TARGET_SHARE * 0.95;
  const passEv = r.nUp === 0 && r.evTheory < 0;
  const passZ = Math.abs(r.maxZ) <= 3;
  const passPred = Math.abs(r.r) < 0.01 && r.bSd > 1.5;
  const ok = passShare && passEv && passZ && passPred;
  console.log('  ' + label.padEnd(30) + (r.share * 100).toFixed(1).padStart(7) + '%' +
    (r.p50.toFixed(2) + 'x').padStart(9) + r.equivRtp.toFixed(3).padStart(10) +
    (r.evTheory * 100).toFixed(2).padStart(10) + '%' + (r.maxZ.toFixed(2) + 'σ').padStart(8) +
    String(r.nUp).padStart(10) + r.r.toFixed(4).padStart(9) + r.bSd.toFixed(2).padStart(8) +
    (ok ? '   ✅ 合格' : '   ❌ ' + [!passShare && '占比', !passEv && 'EV', !passZ && 'Z', !passPred && '可预测'].filter(Boolean).join('/')));
}

line('§2 合格候选的详细指标');
for (const r of results) {
  if (!(r.share >= TARGET_SHARE * 0.95 && r.nUp === 0 && Math.abs(r.maxZ) <= 3)) continue;
  console.log('\n  【' + r.label + '】' + r.note);
  console.log('    分布：p50=' + r.p50.toFixed(2) + 'x  p90=' + r.p90.toFixed(2) + 'x  p99=' + r.p99.toFixed(2) + 'x  max=' + r.max.toFixed(2) + 'x');
  console.log('    中段：5-30x=' + (r.share * 100).toFixed(2) + '%   30x+=' + (r.s(30) * 100).toFixed(2) + '%   <2x=' + ((r.s(2) * 100).toFixed(2)) + '%');
  console.log('    尾部可达：≥500x=' + (r.tail500 * 100).toFixed(3) + '%  ≥1000x=' + (r.tail1000 * 100).toFixed(3) + '%');
  console.log('    等效 RTP=' + r.equivRtp.toFixed(4) + '  → 玩家净EV=' + (r.evTheory * 100).toFixed(2) + '%（必须 <0）');
  console.log('    EV 全网格：max|Z|=' + r.maxZ.toFixed(2) + 'σ @' + r.maxZc.toFixed(2) + 'x   正期望点=' + r.nUp +
    (r.worstUp ? '  最高 ' + r.worstUp.c.toFixed(2) + 'x:' + (r.worstUp.ev * 100).toFixed(2) + '%' : ''));
  console.log('    可预测性：r=' + r.r.toFixed(4) + '  配额σ=' + r.bSd.toFixed(2) + '  相邻差<8%=' + (r.dupPct * 100).toFixed(2) + '%');
}

line('§3 数学边界：这个需求能做到什么程度');
console.log('  恒定期望幂律下：P(X≥5) = RTP/5。RTP ≤ 1.00 ⇒ P(X≥5) ≤ 20%。');
console.log('  客户要的 50% 需要 RTP = 2.5，远超保本线 1.0309 ⇒ 纯幂律绝对做不到。');
console.log('');
console.log('  换形状后可以做到 50%，代价是失去「所有逃跑点等期望」这条性质：');
console.log('    · 净 EV 不再是常数，而是随逃跑点变化 ⇒ 存在「最优逃跑点」');
console.log('    · 这正是客户授权去掉的那条约束，也是 FAQ-2 必须同步改掉的原因');
console.log('    · 但只要所有逃跑点净 EV 都 < 0，玩家仍不能套利，游戏仍成立');
console.log('');
console.log('  ⇒ 可行的目标形态是【倾斜但全员负期望】：中位数抬到 5x 以上，');
console.log('    同时用形状把高 EV 区域压住，让任何固定逃跑点都无利可图。');
console.log('    判据就是上面那 ③：全网格正期望点数 = 0。');
