'use strict';
/**
 * build-no-arb.js —— 构造「高倍率观感 + 零套利」的可行方案
 *
 * 【前两轮的实测结论】
 *  ① 「50% 的局 ≥ 5x」与「玩家不套利」数学矛盾：m=5 处要求
 *     P(X>5) < 1.0309/5 = 20.62%，客户要 50%，差 29.4pp。8 种候选形状
 *     实测全部出现 300~490 个正期望点。这与形状无关，约束只作用在 m 一点上。
 *  ② 「倾斜幂律 G(m)=rtp(1+β·ln m)」也不行：G 在 m≈8 处就越过 1.0309，
 *     因为红线是【绝对值】上限，而 β·ln m 随 m 无限增长。
 *
 * 【可行方案：显式指定毛赔付曲线，逐点压在红线下】
 *  不再用参数化公式去「调」，而是直接把毛赔付 G(m) 设计成一条
 *  在整个 [1, cap] 上都 < 1.0309 的曲线。这样无套利是【构造保证】的，
 *  不依赖事后检查。
 *
 *  G(m) = A · m^(-δ) · (1 + k)  +  B · (1 - m^(-γ))    ——两项都是递减的
 *  第一项提供幂律骨架，第二项提供「中段抬升」但封顶。
 *
 *  真正的自由参数只有三个：把中位数放在哪、中段有多平、尾部有多厚。
 *  全部以静态常数落进生产，无网络、无模型调用。
 *
 * 用法：node scripts/build-no-arb.js --n=500000
 */
const crypto = require('crypto');
const path = require('path');
const GL = require(path.join(__dirname, '..', 'server', 'odds'));

const arg = (k, d) => { const h = process.argv.find(a => a.startsWith('--' + k + '=')); return h ? h.slice(k.length + 3) : d; };
const N = Number(arg('n', 500000));
const CAP = Number(arg('cap', 1000));
const EDGE = GL.CFG.HOUSE_EDGE;
const BE = 1 / (1 - EDGE);          // 1.0309 毛赔付红线
const HARD = BE * 0.98;             // 设计上限，留 2% 余量

function u() { const b = crypto.randomBytes(6); let n = 0; for (let i = 0; i < 6; i++) n = n * 256 + b[i]; return (n + 0.5) / 281474976710656; }
const r2 = n => Math.round(n * 100) / 100;

function makeSampler(pdf, lo, hi, gridN) {
  gridN = gridN || 12000;
  const edges = new Float64Array(gridN + 1);
  for (let i = 0; i <= gridN; i++) edges[i] = lo * Math.pow(hi / lo, i / gridN);
  const cdf = new Float64Array(gridN + 1);
  let acc = 0;
  for (let i = 0; i < gridN; i++) {
    acc += pdf(Math.sqrt(edges[i] * edges[i + 1])) * (edges[i + 1] - edges[i]);
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

/**
 * 构造一个「构造上就无套利」的采样器。
 *
 * 做法：先设计毛赔付曲线 G(m)（保证处处 < HARD），再反推密度。
 *   S(m) = G(m)/m  必须单调递减才合法。
 *   f(m) = −dS/dm = S(m)/m − G'(m)/m²
 *
 * @param {object} p
 *   p.A     第一项系数（幂律骨架的强度）
 *   p.delta 第一项的衰减指数（越大 ⇒ 骨架越陡）
 *   p.B     第二项系数（中段抬升幅度）
 *   p.gamma 第二项的饱和速度（越大 ⇒ 抬升越早封顶）
 *   p.tail  高倍率额外幂律尾（保证 cap 附近仍可达）
 */
function buildSampler(p) {
  const G = m => {
    const base = p.A * Math.pow(m, -p.delta) * (1 + p.B);
    const lift = p.B * (1 - Math.pow(m, -p.gamma));
    const g = base + lift;
    return Math.min(HARD, g);
  };
  const dG = m => {
    const h = m * 1e-7;
    return (G(m + h) - G(m - h)) / (2 * h);
  };
  const pdf = m => {
    const S = G(m) / m;
    if (S <= 0) return 0;
    const f = S / m - dG(m) / (m * m);
    return f > 0 ? f : 0;
  };
  return makeSampler(pdf, 1, CAP, 12000);
}

function audit(smp, label) {
  const xs = new Float64Array(N);
  for (let i = 0; i < N; i++) xs[i] = smp();
  const s = Float64Array.from(xs).sort();
  const Sgt = c => { let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] <= c) lo = m + 1; else hi = m; } return (N - lo) / N; };
  const Sge = c => { let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] < c) lo = m + 1; else hi = m; } return (N - lo) / N; };
  const grid = [];
  for (let c = 1.01; c <= 2.0; c += 0.01) grid.push(+c.toFixed(2));
  for (let c = 2.0; c <= 10; c += 0.05) grid.push(+c.toFixed(2));
  for (let c = 10; c <= CAP; c *= 1.02) grid.push(+c.toFixed(2));
  let nUp = 0, worst = null, peak = 0, peakAt = 0;
  for (const c of grid) {
    const P = Sgt(c); if (P === 0) continue;
    const g = c * P;
    if (g > peak) { peak = g; peakAt = c; }
    if ((1 - EDGE) * g - 1 > 0) { nUp++; if (worst === null || (1 - EDGE) * g - 1 > worst.ev) worst = { c, ev: (1 - EDGE) * g - 1 }; }
  }
  const pct = p => s[Math.min(N - 1, Math.floor(p * N))];
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
  // 空档扫描
  const g2 = [];
  for (let c = 1.01; c <= 3.0; c += 0.01) g2.push(+c.toFixed(2));
  for (let c = 3.05; c <= 12; c += 0.05) g2.push(+c.toFixed(2));
  for (let c = 12; c <= CAP; c *= 1.05) g2.push(+c.toFixed(2));
  let holes = 0, prev = Sge(g2[0]);
  for (let i = 1; i < g2.length; i++) { const P = Sge(g2[i]); if (P === prev) holes++; else prev = P; }
  return {
    label, nUp, worst, peak, peakAt, r, bSd, holes, dupPct: dup / (N - 1),
    p50: pct(0.5), p75: pct(0.75), p90: pct(0.9), p99: pct(0.99), max: s[N - 1],
    s5_30: Sge(5) - Sge(30), s5: Sge(5), s30: Sge(30), s2: Sge(2),
    t500: Sgt(500), t1000: Sgt(1000), Sgt,
  };
}

const line = t => console.log('\n' + '='.repeat(84) + '\n' + t + '\n' + '='.repeat(84));

line('§0 设计原理：把「无套利」变成构造保证，而不是事后检查');
console.log('  红线：任一逃跑点 m 的毛赔付 m·P(X>m) 必须 < ' + BE.toFixed(4));
console.log('  做法：直接设计 G(m)（毛赔付曲线）并让它处处 ≤ ' + HARD.toFixed(4) + '（留 2% 余量），');
console.log('        再由 S(m)=G(m)/m 反推密度 f(m)=S(m)/m − G\'(m)/m²。');
console.log('        这样「无套利」是【构造出来的】，不依赖参数搜索是否命中。');
console.log('');
console.log('  G(m) = A·m^(-δ)·(1+B)  +  B·(1 − m^(-γ))');
console.log('        第一项：幂律骨架（尾部形态）    第二项：中段抬升且饱和');
console.log('');

line('§1 参数扫描（目标：把 5x 以上占比尽量推高，同时零正期望点）');
console.log('  ' + 'A'.padStart(6) + 'delta'.padStart(7) + 'B'.padStart(7) + 'gamma'.padStart(7) +
  '中位数'.padStart(9) + '5x以上'.padStart(9) + '5-30x'.padStart(9) + '峰值毛赔付'.padStart(12) + '正期望点'.padStart(10) + '判定');
const rows = [];
for (const A of [0.55, 0.65, 0.75]) {
  for (const delta of [0.35, 0.5, 0.7]) {
    for (const B of [1.5, 2.5, 4.0]) {
      for (const gamma of [0.5, 0.9]) {
        rows.push({ A, delta, B, gamma });
      }
    }
  }
}
const results = [];
for (const p of rows) {
  const smp = buildSampler(p);
  const a = audit(smp, `A=${p.A} δ=${p.delta} B=${p.B} γ=${p.gamma}`);
  a.p = p;
  results.push(a);
  const ok = a.nUp === 0 && Math.abs(a.r) < 0.01 && a.bSd > 1.5 && a.holes === 0;
  if (ok || a.s5 > 0.15) {
    console.log('  ' + String(p.A).padStart(6) + String(p.delta).padStart(7) + String(p.B).padStart(7) + String(p.gamma).padStart(7) +
      (a.p50.toFixed(2) + 'x').padStart(9) + (a.s5 * 100).toFixed(1).padStart(8) + '%' + (a.s5_30 * 100).toFixed(1).padStart(8) + '%' +
      (a.peak.toFixed(4) + '@' + a.peakAt.toFixed(1)).padStart(12) + String(a.nUp).padStart(10) +
      (ok ? '  ✅' : (a.nUp === 0 ? '  (无套利但有空档/可预测)' : '')));
  }
}

line('§2 零套利候选（正期望点 = 0）按 5x 以上占比排序');
const clean = results.filter(a => a.nUp === 0).sort((x, y) => y.s5 - x.s5);
if (!clean.length) {
  console.log('  本轮 54 组参数没有一个做到零正期望点。');
  console.log('  诊断：G 在 m 较大处仍可能超过 HARD —— 因为 min(HARD,·) 制造了折角，');
  console.log('        折角处密度为 0，之后 S 停止下降但没有质量，采样器被迫归一化，');
  console.log('        归一化会把毛赔付整体抬高。');
  console.log('  ⇒ 这是构造方法的缺陷，需要换一条不产生折角的 G（见 §4）。');
} else {
  console.log('  ' + '参数'.padEnd(30) + '中位数'.padStart(9) + '5x以上'.padStart(9) + '5-30x'.padStart(9) + '峰值'.padStart(10) + '|r|'.padStart(9) + '配额σ'.padStart(8) + '空档'.padStart(7));
  for (const a of clean.slice(0, 12)) {
    console.log('  ' + (`A=${a.p.A} δ=${a.p.delta} B=${a.p.B} γ=${a.p.gamma}`).padEnd(30) +
      (a.p50.toFixed(2) + 'x').padStart(9) + (a.s5 * 100).toFixed(1).padStart(8) + '%' + (a.s5_30 * 100).toFixed(1).padStart(8) + '%' +
      a.peak.toFixed(4).padStart(10) + a.r.toFixed(4).padStart(9) + a.bSd.toFixed(2).padStart(8) + String(a.holes).padStart(7));
  }
}

line('§3 硬边界复述（这是客户必须知道的数字）');
console.log('  「50% 的局 ≥ 5x」 ⇒  m=5 处 P(X>5) ≥ 50% ⇒ 毛赔付 5×0.50 = 2.50');
console.log('  玩家净 EV = 0.97 × 2.50 − 1 = +142.5%/注  ← 稳定暴利，任何形状都无解。');
console.log('  要 m=5 处负期望，P(X>5) 必须 < 1.0309/5 = 20.62%。');
console.log('');
console.log('  ⇒ 5x 以上占比的【数学上限是 20.6%】，客户目标 50% 超出 29.4 个百分点。');
console.log('    若把档位降到「50% 的局 ≥ 2x」：约束 P(X>2) < 51.55% ⇒ 50% 可行 ✅');
console.log('    这是唯一能让「50%」这个数字成立的档位。');
