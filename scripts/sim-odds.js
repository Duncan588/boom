'use strict';
/**
 * sim-odds.js —— 爆点分布体检器（离线，零成本，不碰服务器）
 *
 * 直接 import 现网引擎 server/game-logic.js 的 decideRate()，
 * 所以测的是真实代码而不是副本。
 *
 * 用法：
 *   node scripts/sim-odds.js --mode=<线上当前mode>          体检现状
 *   node scripts/sim-odds.js --rtp=0.95 --cap=120 --n=1000000 体检幂律候选
 *
 * 全部参数都有默认值，不传参数就跑线上现配。
 *
 * 输出的四项就是 @运营与社区 和 @测试与风控 要的东西：
 *   ① 固定逃跑点的 c·S(c) 与净 EV（套利区扫描）
 *   ② 整场节奏所需的原始倍率数组（第 3 节）+ 直方图
 *   ③ 空档扫描（区间内没有任何落点 = 玩家能看见的「习惯区间」边界）
 *   ④ 可预测性（相邻相关系数 / 相邻近似率 / 不同取值占比）
 */
const crypto = require('crypto');
const path = require('path');
const GL = require(path.join(__dirname, '..', 'server', 'game-logic.js'));

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};

// 线上现配（2026-10-01 从 data/baodian.db 的 settings 读出，db.js 的 DEFAULT 值不同）
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
const N = Number(arg('n', 1000000));
const EDGE = GL.CFG.HOUSE_EDGE;          // payout() 里写死的 3%

const cfg = { ...LIVE, odds_mode: mode, powerlaw_rtp: String(rtp), powerlaw_cap: String(cap) };

/** 均匀 U∈(0,1)，48bit，CSPRNG —— 与引擎内部同源，独立实现（不复用引擎的抽取路径） */
function u() {
  const b = crypto.randomBytes(6);
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + b[i];
  return (n + 0.5) / 281474976710656;
}

function sample(pot) {
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) out[i] = GL.decideRate(cfg, pot, 0, null, null).rate;
  return out;
}
const sorted = a => Float64Array.from(a).sort();
function S(s, c) { let lo = 0, hi = s.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] < c) lo = m + 1; else hi = m; } return (s.length - lo) / s.length; }
const q = (s, p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];

function report(label, raw, rtpTheoretical, ceil) {
  const s = sorted(raw);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;

  console.log('\n' + '='.repeat(74));
  console.log(label);
  console.log('='.repeat(74));
  console.log('N=' + n.toLocaleString() + '  min=' + s[0].toFixed(2) + '  max=' + s[n - 1].toFixed(2) + '  mean=' + mean.toFixed(3));
  console.log('分位: p5=' + q(s, .05).toFixed(2) + ' p10=' + q(s, .1).toFixed(2) + ' p25=' + q(s, .25).toFixed(2) +
    ' p50=' + q(s, .5).toFixed(2) + ' p75=' + q(s, .75).toFixed(2) + ' p90=' + q(s, .9).toFixed(2) +
    ' p99=' + q(s, .99).toFixed(2) + ' p999=' + q(s, .999).toFixed(2));
  const boom = raw.filter(x => x <= 1.00).length;
  const sub = raw.filter(x => x < 1.10).length;
  console.log('瞬爆(≤1.00x)=' + (boom / n * 100).toFixed(2) + '%   低于 1.10x=' + (sub / n * 100).toFixed(2) +
    '%（这两档飞行 <0.59s，逃跑按钮按不到）   >=10x=' + (raw.filter(x => x >= 10).length / n * 100).toFixed(2) +
    '%   >=50x=' + (raw.filter(x => x >= 50).length / n * 100).toFixed(2) + '%');

  // ---- ① 固定逃跑点：毛返还 c·S(c) 与净 EV ----
  console.log('\n① 固定逃跑点扫描（c·S(c) > 1 = 毛正期望；净EV = 0.97·c·S(c) − 1）');
  console.log('  逃跑点    赢面S      c·S(c)    净EV/注    3σ      判定');
  let evs = [];
  for (const m of [1.02, 1.05, 1.10, 1.20, 1.30, 1.50, 2.00, 2.50, 3.00, 4.00, 5.00, 8.00, 10.00, 15.00, 20.00, 30.00, 50.00, 100.00, 120.00, 200.00]) {
    if (m > ceil) break;
    const P = S(s, m);
    if (P === 0) { console.log('  ' + m.toFixed(2).padStart(6) + 'x   0.000%      —         —         —      赢面为 0，无法套利'); continue; }
    const gross = m * P;
    const ev = (1 - EDGE) * gross - 1;
    const theory = (1 - EDGE) * rtpTheoretical - 1;
    const sigma = m * (1 - EDGE) * Math.sqrt(P * (1 - P) / n);
    const bad = Math.abs(ev - theory) > 3 * sigma;
    evs.push({ m, ev });
    console.log('  ' + m.toFixed(2).padStart(6) + 'x  ' + (P * 100).toFixed(3).padStart(8) + '%  ' +
      gross.toFixed(4).padStart(8) + '  ' + (ev * 100).toFixed(3).padStart(8) + '%  ' +
      (sigma * 100).toFixed(3).padStart(7) + '%  ' + (bad ? '<<< 超 3σ' : 'OK'));
  }
  if (evs.length > 1) {
    const mx = evs.reduce((a, b) => b.ev > a.ev ? b : a);
    const mn = evs.reduce((a, b) => b.ev < a.ev ? b : a);
    console.log('  → 不同逃跑点的 EV 极差 = ' + ((mx.ev - mn.ev) * 100).toFixed(3) +
      ' 个百分点（最高 ' + mx.m.toFixed(2) + 'x，最低 ' + mn.m.toFixed(2) + 'x）');
  }

  // ---- ② 直方图 ----
  console.log('\n② 直方图');
  const edges = [];
  for (let c = 1.0; c < 2.0001; c += 0.10) edges.push(+c.toFixed(2));
  for (let c = 2.0; c < 10.0001; c += 0.5) edges.push(+c.toFixed(2));
  for (let c = 10; c <= 60; c += 5) edges.push(+c.toFixed(2));
  for (let c = 60; c <= 200; c += 20) edges.push(+c.toFixed(2));
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i], b = edges[i + 1];
    let cnt = 0;
    for (let j = 0; j < n; j++) if (raw[j] >= a && raw[j] < b) cnt++;
    const p = cnt / n;
    if (p > 0) console.log('   [' + a.toFixed(2).padStart(6) + ',' + b.toFixed(2).padStart(6) + ')  ' + (p * 100).toFixed(3).padStart(7) + '%  ' + '#'.repeat(Math.min(60, Math.round(p * 300))));
  }

  // ---- ③ 空档 ----
  console.log('\n③ 空档扫描（S 在相邻网格完全相等 = 该区间一个落点都没有 = 玩家看得见的习惯区间边界）');
  const grid = [];
  for (let c = 1.02; c <= 3.0001; c += 0.02) grid.push(+c.toFixed(2));
  for (let c = 3.05; c <= 12.0001; c += 0.05) grid.push(+c.toFixed(2));
  for (let c = 12.5; c <= Math.min(ceil, 200); c *= 1.05) grid.push(+c.toFixed(2));
  let hole = null, holes = [];
  let prev = S(s, grid[0]);
  for (let i = 1; i < grid.length; i++) {
    const P = S(s, grid[i]);
    if (P === prev) { if (!hole) hole = [grid[i - 1], grid[i]]; }
    else { if (hole) holes.push(hole); hole = null; }
    prev = P;
  }
  if (hole) holes.push(hole);
  if (!holes.length) console.log('   无空档（连续分布，没有可被记忆的区间边界）');
  for (const h of holes) console.log('   洞: ' + h[0].toFixed(2) + 'x ~ ' + h[1].toFixed(2) + 'x');

  // ---- ④ 可预测性 ----
  let ma = 0, mb = 0;
  for (let i = 0; i + 1 < n; i++) { ma += raw[i]; mb += raw[i + 1]; }
  ma /= n; mb /= n;
  let sa = 0, sb = 0, sab = 0, dup = 0;
  for (let i = 0; i + 1 < n; i++) {
    const dx = raw[i] - ma, dy = raw[i + 1] - mb;
    sa += dx * dx; sb += dy * dy; sab += dx * dy;
    if (Math.abs(raw[i] - raw[i + 1]) / Math.max(raw[i], raw[i + 1]) < 0.08) dup++;
  }
  console.log('\n④ 可预测性（玩家要能反推，必须出现其中之一）');
  console.log('   相邻局倍率相关系数 r = ' + (sab / Math.sqrt(sa * sb)).toFixed(5) + '（|r|<0.01 = 无记忆）');
  console.log('   相邻两局差 <8% 的比例 = ' + (dup / (n - 1) * 100).toFixed(2) + '%');
  console.log('   不同取值占比 = ' + (new Set(raw).size / n * 100).toFixed(2) + '%');
  // 短周期检测
  const head = raw.slice(0, 2000);
  const cycles = [2, 3, 4, 5, 7, 10, 20, 50, 100].filter(k => {
    for (let i = k; i < head.length; i++) if (head[i] === head[i - k]) return false;
    return true;
  });
  console.log('   2000 局序列中「无重复」的周期长度: ' + (cycles.length ? cycles.join(',') : '（全部有重复 ⇒ 无周期）'));

  return s;
}

console.log('爆点分布体检  mode=' + mode + '  rtp=' + rtp + '  cap=' + cap + '  N=' + N.toLocaleString() + '  抽水=' + (EDGE * 100) + '%');
console.log('（配置取自 data/baodian.db 线上现值；RTP 只在 mode 9 生效）');

const ceiling = mode === '9' ? cap : 50;
const withBets = sample(1000);
report('【有注 pot=1000】这是玩家实际面对的分布', withBets, mode === '9' ? rtp : 0.97, ceiling);

const idle = sample(0);
report('【无人下注 pot=0】必须与上面同分布，否则深夜空房间就是一个稳定套利区', idle, mode === '9' ? rtp : 0.97, mode === '9' ? cap : 2);

console.log('\n' + '='.repeat(74));
console.log('结论判据：净 EV 全网格极差 < 1 个百分点 且 无空档 且 |r|<0.01  ⇒ 无可套利区间');
console.log('='.repeat(74));