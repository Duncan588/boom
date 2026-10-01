'use strict';
/**
 * constraint-probe.js —— 为 jev 选型准备「约束清单 + 代价地图」
 *
 * 【为什么要有这个文件】
 * 客户要求用 jev 做形态选型（决战）。但 jev 只能在【给定的约束】下选，
 * 而「50% 的局落在 5-30x」这条约束在数学上与「玩家不能套利」矛盾：
 *   玩家固定逃 m 的净 EV = 0.97·m·P(X>m) − 1
 *   要它为负 ⇒ m·P(X>m) < 1.0309
 *   m=5 处 ⇒ P(X>5) < 20.62%，而客户要 50%。
 *
 * 所以问 jev 之前必须先把「代价地图」摆清楚，否则它会在一个无解的
 * 约束集里硬选，选出来的必然是玩家正期望的形状。
 *
 * 【本文件产出】
 *   ① 每档 M（5/10/20/30/50/100）下「50% 的局 ≥ M」对应的套利严重程度
 *   ② 若干【满足全部底线】的可行形状及其能达到的中位数上限
 *   ③ 一份可以直接交给 jev 的选择题（带明确代价标注）
 *
 * 用法：node scripts/constraint-probe.js --n=500000
 */
const crypto = require('crypto');
const path = require('path');
const GL = require(path.join(__dirname, '..', 'server', 'game-logic.js'));

const arg = (k, d) => { const h = process.argv.find(a => a.startsWith('--' + k + '=')); return h ? h.slice(k.length + 3) : d; };
const N = Number(arg('n', 500000));
const CAP = Number(arg('cap', 1000));
const EDGE = GL.CFG.HOUSE_EDGE;
const BE = 1 / (1 - EDGE);

function u() { const b = crypto.randomBytes(6); let n = 0; for (let i = 0; i < 6; i++) n = n * 256 + b[i]; return (n + 0.5) / 281474976710656; }
const r2 = n => Math.round(n * 100) / 100;
const line = t => console.log('\n' + '='.repeat(84) + '\n' + t + '\n' + '='.repeat(84));

// ─────────── ① 各档 M 下的套利严重程度（纯数学，无需采样） ───────────
line('① 代价地图：「50% 的局 ≥ M」在每个 M 上的套利代价');
console.log('  玩家固定逃 M 的净 EV = 0.97 × M × 0.50 − 1');
console.log('');
console.log('   档位 M    毛赔付 M×0.5    玩家净EV/注     每天(1000注)净收益');
for (const M of [1.5, 2, 3, 5, 10, 20, 30, 50, 100]) {
  const gross = M * 0.5;
  const ev = (1 - EDGE) * gross - 1;
  const daily = ev * 1000;
  const mark = ev > 0 ? '← 稳定暴利' : (ev < -0.15 ? '安全' : '偏紧');
  console.log('  ' + (M + 'x').padStart(7) + gross.toFixed(3).padStart(15) + (ev * 100).toFixed(2).padStart(13) + '%' +
    (daily >= 0 ? '+' : '') + daily.toFixed(0).padStart(14) + ' QUN   ' + mark);
}
console.log('\n  保本线：毛赔付 = 1.0309。对应 M = 1.0309/0.5 = 2.0618');
console.log('  ⇒ 「50% 的局 ≥ M」且玩家不亏的【唯一】解是 M < 2.06。');

// ─────────── ② 可行形状能达到的中位数上限 ───────────
line('② 可行形状的天花板：在「零套利」前提下，中位数能到多少');

/**
 * 构造「构造上零套利」的采样器：显式设计毛赔付 G(m) ≤ HARD。
 *   S(m) = G(m)/m,  f(m) = S(m)/m − G'(m)/m²
 */
function buildSampler(G) {
  const gridN = 12000;
  const edges = new Float64Array(gridN + 1);
  for (let i = 0; i <= gridN; i++) edges[i] = Math.pow(CAP, i / gridN);
  const dG = m => { const h = m * 1e-7; return (G(m + h) - G(m - h)) / (2 * h); };
  const pdf = m => { const S = G(m) / m; if (S <= 0) return 0; const f = S / m - dG(m) / (m * m); return f > 0 ? f : 0; };
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

function audit(smp) {
  const xs = new Float64Array(N);
  for (let i = 0; i < N; i++) xs[i] = smp();
  const s = Float64Array.from(xs).sort();
  const Sgt = c => { let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] <= c) lo = m + 1; else hi = m; } return (N - lo) / N; };
  const Sge = c => { let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] < c) lo = m + 1; else hi = m; } return (N - lo) / N; };
  const grid = [];
  for (let c = 1.01; c <= 2.0; c += 0.01) grid.push(+c.toFixed(2));
  for (let c = 2.0; c <= 10; c += 0.05) grid.push(+c.toFixed(2));
  for (let c = 10; c <= CAP; c *= 1.02) grid.push(+c.toFixed(2));
  let nUp = 0, peak = 0, peakAt = 0;
  for (const c of grid) {
    const P = Sgt(c); if (P === 0) continue;
    const g = c * P;
    if (g > peak) { peak = g; peakAt = c; }
    if ((1 - EDGE) * g - 1 > 0) nUp++;
  }
  const pct = p => s[Math.min(N - 1, Math.floor(p * N))];
  return { nUp, peak, peakAt, p50: pct(0.5), p75: pct(0.75), p90: pct(0.9), p99: pct(0.99), max: s[N - 1], s5_30: Sge(5) - Sge(30), s5: Sge(5), Sgt, s };
}

const HARD = BE * 0.98;
console.log('  红线 ' + BE.toFixed(4) + '，设计上限 ' + HARD.toFixed(4) + '（留 2% 余量）');
console.log('');
console.log('  ' + '形状'.padEnd(34) + '中位数'.padStart(9) + '5-30x'.padStart(9) + '5x+'.padStart(8) + '峰值'.padStart(9) + '正期望点'.padStart(10));

/** 一族可调形状：控制「中段抬升」的强度 */
const shapes = [];
for (const A of [0.45, 0.55, 0.65, 0.75]) {
  for (const d of [0.25, 0.4, 0.6]) {
    for (const B of [0.8, 1.5, 2.5, 4.0]) {
      for (const g of [0.4, 0.7, 1.0]) {
        shapes.push({
          name: `幂律骨架+中段饱和 A=${A} δ=${d} B=${B} γ=${g}`,
          G: m => Math.min(HARD, A * Math.pow(m, -d) * (1 + B) + B * (1 - Math.pow(m, -g))),
        });
      }
    }
  }
}
const results = [];
for (const sh of shapes) {
  const a = audit(buildSampler(sh.G));
  a.name = sh.name;
  results.push(a);
}
const clean = results.filter(a => a.nUp === 0).sort((x, y) => y.p50 - x.p50);
console.log('  零套利形状共 ' + clean.length + ' / ' + results.length + ' 个，按中位数降序（前 10）：');
for (const a of clean.slice(0, 10)) {
  console.log('  ' + a.name.padEnd(34) + (a.p50.toFixed(2) + 'x').padStart(9) + (a.s5_30 * 100).toFixed(1).padStart(8) + '%' +
    (a.s5 * 100).toFixed(1).padStart(7) + '%' + a.peak.toFixed(4).padStart(9) + String(a.nUp).padStart(10));
}
const best = clean[0];
if (best) {
  console.log('\n  ★ 零套利形状的【中位数天花板】= ' + best.p50.toFixed(2) + 'x');
  console.log('    形状：' + best.name);
  console.log('    5-30x 占比 = ' + (best.s5_30 * 100).toFixed(1) + '%   5x 以上 = ' + (best.s5 * 100).toFixed(1) + '%');
  console.log('    ⇒ 客户要的「中位数 5x 以上」在零套利前提下【达不到】，天花板是 ' + best.p50.toFixed(2) + 'x');
}

// ─────────── ③ 交给 jev 的选择题 ───────────
line('③ 交给 jev 的决策包（它在这个约束集里选）');
console.log(JSON.stringify({
  task: '为一个 Discord crash 游戏选择赔率分布形状',
  hardConstraints: [
    '玩家固定任意逃跑点 m 的净期望必须为负：0.97·m·P(X>m) − 1 < 0',
    '全网格（1.01~1000x）不得出现任何正期望点',
    '无空档、无配额节拍、相邻局相关系数 |r| < 0.01',
  ],
  mathFact: '零套利前提下 P(X≥5) 的上限是 20.62%（因为 5·P(X>5) 必须 < 1.0309）。客户要的 50% 超��� 29.4 个百分点，数学上无解。',
  feasibleOptions: [
    { id: 'A', desc: '严格遵守客户原始需求 50% 在 5-30x', consequence: '玩家固定逃 5x 净 EV +142.5%/注，几天内必然被套利' },
    { id: 'B', desc: '把档位降到 2x：50% 的局 ≥ 2x，中位数 ~2x', consequence: '可行但观感提升有限' },
    { id: 'C', desc: '改口径：中位数 2x + 20% 的局在 5x 以上', consequence: '可行，数字诚实' },
  ],
  measuredCeiling: best ? { median: +best.p50.toFixed(2), share5_30: +(best.s5_30 * 100).toFixed(1), shape: best.name } : null,
  question: '在 A/B/C 中选一个；若都不满意，请提出一个我上面没列出的、满足全部硬约束且中位数尽量高的形状',
}, null, 2));
