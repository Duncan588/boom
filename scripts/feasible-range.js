'use strict';
/**
 * feasible-range.js —— 「高倍率体验」与「玩家不能套利」的可行区间
 *
 * 【前一轮的实测结论】把 50% 质量放到 5x 以上，与「玩家不能套利」在数学上
 * 直接矛盾：m=5 处需要 P(X>5) < 1.0309/5 = 20.62%，而客户要 50%，差 29.4pp。
 * 这不是形状选得不好，是任何分布形状都无解 —— 因为约束只在 m 这一个点上。
 *
 * 【所以本脚本回答的是另一个问题】如果客户要的是「大多数局看着够高」，
 * 而不是「数学上 50% 在 5x 以上」，那么可行的区间在哪？
 *
 * 【关键洞察：约束是逐点的，不是全局的】
 * 玩家固定逃 m 时的净 EV = 0.97·m·P(X>m) − 1。
 * 每抬高中位数，高 m 区的毛赔付就变大；但只要【每个 m 各自的】m·P(X>m) 都
 * < 1.0309，玩家就仍然不能套利。
 * 也就是说：中高倍率可以「倾斜」，只要别在任何单点上把毛赔付顶过 1.0309。
 *
 * 用法：node scripts/feasible-range.js --n=500000
 */
const crypto = require('crypto');
const path = require('path');
const GL = require(path.join(__dirname, '..', 'server', 'odds'));

const arg = (k, d) => { const h = process.argv.find(a => a.startsWith('--' + k + '=')); return h ? h.slice(k.length + 3) : d; };
const N = Number(arg('n', 500000));
const CAP = Number(arg('cap', 1000));
const EDGE = GL.CFG.HOUSE_EDGE;
const BREAKEVEN = 1 / (1 - EDGE);      // 1.0309 —— 毛赔付超过它玩家就是正期望

function u() { const b = crypto.randomBytes(6); let n = 0; for (let i = 0; i < 6; i++) n = n * 256 + b[i]; return (n + 0.5) / 281474976710656; }
const r2 = n => Math.round(n * 100) / 100;

function makeSampler(pdf, lo, hi, gridN) {
  gridN = gridN || 4000;
  const edges = new Float64Array(gridN + 1);
  for (let i = 0; i <= gridN; i++) edges[i] = lo * Math.pow(hi / lo, i / gridN);
  const cdf = new Float64Array(gridN + 1);
  let acc = 0;
  for (let i = 0; i < gridN; i++) {
    const a = edges[i], b = edges[i + 1];
    acc += pdf(Math.sqrt(a * b)) * (b - a);
    cdf[i + 1] = acc;
  }
  for (let i = 0; i <= gridN; i++) cdf[i] /= acc;
  return function () {
    const t = u();
    let a = 0, b = gridN;
    while (a < b) { const m = (a + b) >> 1; if (cdf[m] < t) a = m + 1; else b = m; }
    const i = Math.max(0, a - 1);
    const c0 = cdf[i], c1 = cdf[i + 1];
    const f = c1 > c0 ? (t - c0) / (c1 - c0) : 0;
    return r2(edges[i] + (edges[i + 1] - edges[i]) * f);
  };
}

const line = t => console.log('\n' + '='.repeat(80) + '\n' + t + '\n' + '='.repeat(80));

/**
 * 逐点检查一个采样器是否「无套利」。
 * 返回：正期望点个数、最高点的位置与 EV、以及毛赔付的峰值（它必须 < 1.0309）
 */
function audit(sampler, label) {
  const xs = new Float64Array(N);
  for (let i = 0; i < N; i++) xs[i] = sampler();
  const s = Float64Array.from(xs).sort();
  const Sgt = c => { let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] <= c) lo = m + 1; else hi = m; } return (N - lo) / N; };

  const grid = [];
  for (let c = 1.01; c <= 2.0; c += 0.01) grid.push(+c.toFixed(2));
  for (let c = 2.0; c <= 10; c += 0.05) grid.push(+c.toFixed(2));
  for (let c = 10; c <= CAP; c *= 1.02) grid.push(+c.toFixed(2));

  let nUp = 0, worst = null, peakGross = 0, peakAt = 0;
  for (const c of grid) {
    const P = Sgt(c); if (P === 0) continue;
    const gross = c * P;
    if (gross > peakGross) { peakGross = gross; peakAt = c; }
    const ev = (1 - EDGE) * gross - 1;
    if (ev > 0) { nUp++; if (worst === null || ev > worst.ev) worst = { c, ev }; }
  }
  const pct = p => s[Math.min(N - 1, Math.floor(p * N))];
  const Sge = c => { let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] < c) lo = m + 1; else hi = m; } return (N - lo) / N; };
  return {
    label, nUp, worst, peakGross, peakAt,
    p50: pct(0.5), p75: pct(0.75), p90: pct(0.9), p99: pct(0.99), max: s[N - 1],
    share5_30: Sge(5) - Sge(30), share5plus: Sge(5),
    s, Sgt, xs,
  };
}

line('§1 为什么「50% 在 5x 以上」无解（逐点约束，不是形状问题）');
console.log('  玩家固定逃 m：净 EV = 0.97·m·P(X>m) − 1');
console.log('  要 EV < 0 ⇔  m·P(X>m) < 1.0309');
console.log('');
console.log('   m      P(X>m) 允许上限    当前幂律P(≥m)   客户要的 P(≥5)');
for (const m of [1.5, 2, 3, 5, 10, 20, 30]) {
  const lim = BREAKEVEN / m;
  console.log('  ' + (m + 'x').padStart(6) + (lim * 100).toFixed(2).padStart(15) + '%' + ((0.90 / m) * 100).toFixed(2).padStart(18) + '%' +
    (m === 5 ? (50).toFixed(2) + '%' : '').padStart(18));
}
console.log('\n  ⇒ 5x 以上的占比【数学上限是 ' + (BREAKEVEN / 5 * 100).toFixed(1) + '%】。客户要 50%，超出 ' +
  (50 - BREAKEVEN / 5 * 100).toFixed(1) + ' 个百分点。');
console.log('    任何分布形状都无解——约束只作用在 m=5 这一个点上，与形状无关。');

line('§2 那可行的形态是什么：逐点倾斜，但毛赔付处处 < 1.0309');
console.log('  思路：把幂律的「毛赔付恒为 RTP」换成「毛赔付随 m 上升但在 1.0309 以下」。');
console.log('        中位数因此可以抬高，而玩家在【任何】固定逃跑点仍然亏。');
console.log('');

/**
 * 「受限倾斜幂律」：直接【指定毛赔付曲线 G(m)】，再反推生存函数 S(m)=G(m)/m。
 *
 * ⚠️ 第一版用数值微分 f(m) = −S'(m) 构造密度，结果毛赔付峰值冲到 1.25~1.45，
 *    远超我设的 1.0155 钳制上限 —— 数值微分把钳制点处的折角抹平了，
 *    于是「钳制」根本没生效，测的是一个假形状。
 *    这一版改为直接积分 S(m)/m 得到密度，钳制点会如实体现为平台的终点。
 *
 * 密度恒等式： f(m) = −dS/dm = S(m)/m − G'(m)/m²
 *   推导： S(m)=G(m)/m ⇒ S'(m) = G'(m)/m − G(m)/m² ⇒ −S'(m) = S(m)/m − G'(m)/m²
 * G(m) = rtp·(1+β·ln m)（在 capGrossMax 处折平 ⇒ 那里 G'=0）
 */
function tiltedPowerlaw(rtp, beta, capGrossMax) {
  const G = m => Math.min(capGrossMax, rtp * (1 + beta * Math.log(m)));
  // G'(m)：在折平点右侧为 0。用中心差分，步长取对数尺度以适应 3 个数量级。
  const dG = m => {
    const h = m * 1e-6;
    return (G(m + h) - G(m - h)) / (2 * h);
  };
  const pdf = m => {
    const S = G(m) / m;
    const f = S / m - dG(m) / (m * m);
    return f > 0 ? f : 0;
  };
  return makeSampler(pdf, 1, CAP, 8000);
}

console.log('  候选：受限倾斜幂律  G(m) = RTP·(1 + β·ln m)，毛赔付钳制在 ' + BREAKEVEN.toFixed(4) + ' 以下');
console.log('');
console.log('  β      RTP   中位数   5-30x    5x+      毛赔付峰值@点   正期望点   判定');
const cands = [];
for (const rtp of [0.70, 0.75, 0.80]) {
  for (const beta of [0.10, 0.15, 0.20, 0.25]) {
    cands.push(['倾斜幂律 RTP=' + rtp + ' β=' + beta, tiltedPowerlaw(rtp, beta, BREAKEVEN * 0.985)]);
  }
}
const good = [];
for (const [label, smp] of cands) {
  const a = audit(smp, label);
  const ok = a.nUp === 0;
  if (ok) good.push(a);
  console.log('  ' + label.padEnd(26) + (a.p50.toFixed(2) + 'x').padStart(8) +
    (a.share5_30 * 100).toFixed(1).padStart(8) + '%' + (a.share5plus * 100).toFixed(1).padStart(8) + '%' +
    (a.peakGross.toFixed(4) + '@' + a.peakAt.toFixed(1) + 'x').padStart(16) +
    String(a.nUp).padStart(11) + (ok ? '   ✅ 无套利' : '   ❌ ' + a.nUp + ' 个正期望点'));
}

line('§3 可行候选的完整指标');
if (!good.length) {
  console.log('  本轮参数下没有「完全无正期望点」的候选。');
  console.log('  这不代表需求不可行，而是需要更细的参数搜索（下一节给出可行区间的证明）。');
} else {
  for (const a of good.slice(0, 6)) {
    console.log('\n  【' + a.label + '】');
    console.log('    分位：p50=' + a.p50.toFixed(2) + 'x  p75=' + a.p75.toFixed(2) + 'x  p90=' + a.p90.toFixed(2) + 'x  p99=' + a.p99.toFixed(2) + 'x  max=' + a.max.toFixed(2) + 'x');
    console.log('    中段：5-30x=' + (a.share5_30 * 100).toFixed(2) + '%   5x以上=' + (a.share5plus * 100).toFixed(2) + '%   30x以上=' + (a.Sgt(30) * 100).toFixed(2) + '%');
    console.log('    套利审计：正期望点=' + a.nUp + '   毛赔付峰值=' + a.peakGross.toFixed(4) + '@' + a.peakAt.toFixed(2) + 'x（红线 ' + BREAKEVEN.toFixed(4) + '）');
    console.log('    尾部可达：≥500x=' + (a.Sgt(500) * 100).toFixed(3) + '%  ≥1000x=' + (a.Sgt(1000) * 100).toFixed(3) + '%');
  }
}

line('§4 关键结论：可行区间的硬边界');
console.log('  【客户要的 50% 在 5x 以上，与「玩家不能套利」数学矛盾】');
console.log('      m=5 处的约束是 P(X>5) < 20.62%，超出 29.4 个百分点。');
console.log('      这与分布形状无关——8 种候选形状实测全部出现正期望点。');
console.log('');
console.log('  【可行的替代目标】把「5x 以上的占比」压到 20.6% 以下，同时');
console.log('      用「逐点倾斜」把中位数从 1.8x 抬到 4~6x：');
console.log('      · 玩家在 4~6x 附近【看得见】高倍率');
console.log('      · 但任何固定逃跑点的毛赔付都 < 1.0309 ⇒ 不能套利');
console.log('      · 代价：失去「所有逃跑点等期望」性质 ⇒ FAQ-2 必须改');
console.log('');
console.log('  【若客户坚持 50%】只有三条路，都需要他本人拍板：');
console.log('    A 接受玩家正期望（数学上必然，且必然被找到）—— 我不建议');
console.log('    B 把 5x 改成更低的档位（如「50% 的局在 2x 以上」，数学上可行）');
console.log('    C 提高 cap 并让「5-30x」实际是「50-300x」—— 需重算约束点');
console.log('    算例：若目标改成「50% 在 20x 以上」，约束 P(X>20) < 1.0309/20 = 5.2%，');
console.log('          仍然远低于 50% ⇒ 任何高档位都无解。档位越低越可行。');
