'use strict';
/**
 * sim-session.js —— 一千局整场模拟（离线，零成本，不碰服务器、不连数据库）
 *
 * 直接 import 现网引擎 decideRate()，所以倍率是真的引擎抽出来的，
 * 账是按 payout() 真的算出来的。@全栈开发 可以拿这份结果做 50 万抽样交叉验。
 *
 * 用法：
 *   node scripts/sim-session.js --mode=9 --rtp=0.95 --cap=120 \
 *        --rounds=1000 --stake=100 --escape=1.5
 *
 * @运营与社区 要的三项：
 *   ① 净流入／净流出（按固定逃跑点折算）
 *   ② 整场节奏曲线（每 N 局一段，不是单局分布）
 *   ③ 连续冷启动时段（连续 <escape 的最长段落，以及它的分布）
 * @测试与风控 要的两项：
 *   ④ 固定逃跑点的净 EV 极差（套利探测）
 *   ⑤ 冷场/连败的段长分布（必须是几何分布的尾巴，不是配额节拍）
 */
const path = require('path');
const GL = require(path.join(__dirname, '..', 'server', 'game-logic.js'));

const arg = (k, d) => { const h = process.argv.find(a => a.startsWith('--' + k + '=')); return h ? h.slice(k.length + 3) : d; };

// 线上现配（2026-10-01 从 data/baodian.db 读出）
const LIVE = {
  odds_mode: '5', min_rate: '1.10', max_rate: '50', rake_percent: '1',
  w_low: '50', w_mid: '22', w_high: '20',
  w_lo_min: '1.01', w_lo_max: '4.00', w_mid_min: '4.00', w_mid_max: '10.00',
  w_high_min: '10.00', w_high_max: '30.00', w_boom: '6', w_boom_max: '1.01',
  w_top: '2', w_top_min: '30.00', w_top_max: '50.00',
  powerlaw_rtp: '0.97', powerlaw_cap: '120',
};

const mode = arg('mode', LIVE.odds_mode);
const rtp = Number(arg('rtp', LIVE.powerlaw_rtp));
const cap = Number(arg('cap', LIVE.powerlaw_cap));
const R = Number(arg('rounds', 1000));
const STAKE = Number(arg('stake', 100));
const ESC = Number(arg('escape', 1.5));
const SEG = Number(arg('seg', 50));
const EDGE = GL.CFG.HOUSE_EDGE;

const cfg = { ...LIVE, odds_mode: mode, powerlaw_rtp: String(rtp), powerlaw_cap: String(cap) };

const rates = new Float64Array(R);
for (let i = 0; i < R; i++) rates[i] = GL.decideRate(cfg, STAKE * 3, 0, null, null).rate;
const s = Float64Array.from(rates).sort();
const q = p => s[Math.floor(p * R)];
const S = c => { let lo = 0, hi = R; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] < c) lo = m + 1; else hi = m; } return (R - lo) / R; };

console.log('='.repeat(74));
console.log('一千局整场模拟  mode=' + mode + (mode === '9' ? ' rtp=' + rtp + ' cap=' + cap : '') +
  '  局数=' + R + '  每局注金=' + STAKE + '  固定逃跑点=' + ESC + 'x  抽水=' + (EDGE * 100) + '%');
console.log('='.repeat(74));
console.log('倍率: min=' + s[0].toFixed(2) + '  max=' + s[R - 1].toFixed(2) +
  '  p25/p50/p75=' + q(.25).toFixed(2) + '/' + q(.5).toFixed(2) + '/' + q(.75).toFixed(2) +
  '  p90=' + q(.9).toFixed(2) + '  p99=' + q(.99).toFixed(2) +
  '  mean=' + (s.reduce((a, b) => a + b, 0) / R).toFixed(2));
console.log('瞬爆 ≤1.00x = ' + rates.filter(x => x <= 1).length + ' 局 (' + (rates.filter(x => x <= 1).length / R * 100).toFixed(2) + '%)');
console.log('飞行 <0.6s（<1.10x，按不到逃跑按钮）= ' + rates.filter(x => x < 1.10).length + ' 局 (' + (rates.filter(x => x < 1.10).length / R * 100).toFixed(2) + '%)');
console.log('>=10x = ' + rates.filter(x => x >= 10).length + ' 局    >=50x = ' + rates.filter(x => x >= 50).length + ' 局    >=100x = ' + rates.filter(x => x >= 100).length + ' 局');

// ---- ④ 固定逃跑点净 EV（套利探测）----
/**
 * ⚠️ 一千局的样本量在尾部是不够的，必须把 σ 打出来，否则会读出一个不存在的套利区。
 * P(X≥100) ≈ 0.95%，一千局里就是 9~15 次命中 —— 这个量级的相对误差是 ±50%，
 * 于是 100x 那一行会算出 +45% 的「净EV」。那是抽样噪声，不是分布性质。
 * 尾部的性质只能用大样本判定（sim-odds.js 的 --n=2000000 那档）。
 */
console.log('\n④ 固定逃跑点套利探测（净 EV = 0.97·c·S(c) − 1）');
const evRows = [];
const theory = (1 - EDGE) * (mode === '9' ? rtp : 0.97) - 1;
for (const m of [1.02, 1.10, 1.20, 1.50, 2.00, 2.50, 3.00, 5.00, 8.00, 10.00, 20.00, 50.00, 100.00]) {
  const P = S(m);
  if (P === 0) { console.log('   ' + m.toFixed(2).padStart(6) + 'x   赢面 0.00%   永不赢，无法套利'); continue; }
  const ev = (1 - EDGE) * m * P - 1;
  const sigma = m * (1 - EDGE) * Math.sqrt(P * (1 - P) / R);
  evRows.push({ m, ev, sigma, dev: ev - theory });
  const weak = sigma > 0.05;
  console.log('   ' + m.toFixed(2).padStart(6) + 'x  赢面 ' + (P * 100).toFixed(2).padStart(6) + '%   净EV ' +
    (ev * 100).toFixed(3).padStart(8) + '%  ±σ ' + (sigma * 100).toFixed(2).padStart(7) + '%  偏差 ' +
    ((ev - theory) * 100 >= 0 ? '+' : '') + ((ev - theory) * 100).toFixed(2).padStart(7) + '% = ' +
    ((ev - theory) / sigma).toFixed(1).padStart(5) + 'σ  1000局净 ' +
    (ev * R * STAKE).toFixed(0).padStart(9) + ' QUN' + (weak ? '  ← 样本不足' : ''));
}
if (evRows.length > 1) {
  /**
   * 判据是【每一行 vs 理论值】，不是【行与行的极差】。
   * 极差在统计上是错的：n 行各自的估计误差都是 σ 量级，取最大最小必然把
   * 两个各自 1.2σ 的误差拼成 2.4σ，n 越多极差越大 —— 分布越完美反而越会「报警」。
   * 每行单独对理论值判 3σ，这才是分布性质。
   */
  const usable = evRows.filter(r => r.sigma <= 0.05);
  const worst = usable.reduce((a, b) => Math.abs(b.dev) > Math.abs(a.dev) ? b : a);
  const bad = usable.filter(r => Math.abs(r.dev) > 3 * r.sigma);
  console.log('   → 理论净EV = ' + (theory * 100).toFixed(3) + '%（= 0.97·RTP − 1，与逃跑点无关）');
  console.log('   → 样本足够的 ' + usable.length + ' 行里，最大偏差出现在 ' + worst.m.toFixed(2) +
    'x：' + (worst.dev * 100).toFixed(3) + '% = ' + (Math.abs(worst.dev) / worst.sigma).toFixed(1) + 'σ  ' +
    (bad.length === 0 ? '✅ 全部在 3σ 内 ⇒ 无最优逃跑点' : '❌ ' + bad.length + ' 行超 3σ：' + bad.map(r => r.m.toFixed(2) + 'x').join(', ')));
  console.log('   → 尾部（赢面 <5%）另见 sim-odds.js --n=2000000，那才是尾部性质的判据');
}

// ---- ①② 整场节奏曲线 + 净流入/流出 ----
console.log('\n② 整场节奏曲线（每 ' + SEG + ' 局一段，玩家从 ' + ESC + 'x 逃跑）');
const net = r => (r >= ESC) ? (GL.payout(STAKE, ESC) - STAKE) : -STAKE;
let cum = 0, total = 0;
for (let b = 0; b < R; b += SEG) {
  const end = Math.min(b + SEG, R);
  let seg = 0, wins = 0, hi = 0;
  for (let i = b; i < end; i++) { seg += net(rates[i]); if (rates[i] >= ESC) wins++; if (rates[i] > hi) hi = rates[i]; }
  cum += seg; total += seg;
  const up = seg >= 0;
  const bar = up ? '#'.repeat(Math.min(28, Math.round(seg / (STAKE * SEG * 0.05)))) : '.'.repeat(Math.min(28, Math.round(-seg / (STAKE * SEG * 0.05))));
  console.log('   局 ' + String(b + 1).padStart(4) + '-' + String(end).padStart(4) +
    '  赢 ' + String(wins).padStart(3) + '/' + (end - b) +
    '  最高 ' + hi.toFixed(2).padStart(6) + 'x' +
    '  段净 ' + (up ? '+' : '-') + String(Math.abs(seg).toFixed(0)).padStart(7) +
    '  累计 ' + (cum >= 0 ? '+' : '-') + String(Math.abs(cum).toFixed(0)).padStart(8) + '  ' + bar);
}
console.log('\n① 净流入／净流出');
console.log('   一千局合计 ' + (total >= 0 ? '+' : '') + total.toFixed(0) + ' QUN   每局 ' + (total / R).toFixed(2) + ' QUN/局（每局 1 注）');
console.log('   折算 100 注在场 = ' + (total / R * 100).toFixed(0) + ' QUN/局 的资金池净' + (total >= 0 ? '流入' : '流出'));
console.log('   → 玩家的钱整体在' + (total >= 0 ? '赢钱（庄家亏）' : '归集到资金池（庄家赚）') +
  '，每注期望 ' + ((1 - EDGE) * (mode === '9' ? rtp : 0.97) - 1).toFixed(3) + '（理论值）');

// ---- ③ 冷启动时段 ----
console.log('\n③ 连续冷启动时段（连续 <' + ESC + 'x 的段落）');
const segs = [];
let cur = 0;
for (let i = 0; i < R; i++) { if (rates[i] < ESC) cur++; else { if (cur) segs.push(cur); cur = 0; } }
if (cur) segs.push(cur);
segs.sort((a, b) => b - a);
console.log('   段数 ' + segs.length + '   最长 ' + (segs[0] || 0) + ' 局   次长 ' + (segs[1] || 0) +
  '   段长分布 ' + segs.slice(0, 12).join(','));
const totalCold = segs.reduce((a, b) => a + b, 0);
console.log('   冷场局数合计 ' + totalCold + ' / ' + R + ' = ' + (totalCold / R * 100).toFixed(1) + '%');
// 段长是否像几何分布：相邻两段长度不可能总是同一个数
const hist = {};
for (const x of segs) hist[x] = (hist[x] || 0) + 1;
console.log('   段长频次: ' + Object.entries(hist).sort((a, b) => +a[0] - +b[0]).map(([k, v]) => k + '局×' + v).join('  '));
const maxSeg = segs[0] || 0;
console.log('   判定: ' + (maxSeg <= 6 ? '✅ 最长 ' + maxSeg + ' 局，正常随机尾部，玩家不会觉得「系统在卡」'
  : '⚠️ 最长 ' + maxSeg + ' 局，超过 5 局玩家会觉得被针对（纯随机也会出现，不是配额节拍）'));

// 连败（<1.10x，按不到按钮）
let l1 = 0, l1max = 0, c1 = 0;
for (let i = 0; i < R; i++) { if (rates[i] < 1.10) { c1++; if (c1 > l1max) l1max = c1; } else c1 = 0; }
console.log('   连续按不到逃跑按钮（<1.10x）最长 ' + l1max + ' 局，共 ' + rates.filter(x => x < 1.10).length + ' 局');

console.log('\n' + '='.repeat(74));
console.log('服务器状态：本脚本只 import server/game-logic.js，不连数据库、不开端口、不改任何文件。');
console.log('='.repeat(74));