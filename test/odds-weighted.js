/**
 * 模式 5「五段加权」验证 —— 纯脚本，不跑游戏循环。
 * 直接调用生产用的 decideRate()，验证 50 万局的分布。
 *
 * 目标手感（用户原话）：
 *   - 平常都是 1.01x – 10x
 *   - 20 多局来 5 次 30x
 *   - 50 多局来一次 50x
 */
const { decideRate, flightMs } = require('../server/game-logic.js');

const CFGOBJ = {
  odds_mode: '5',
  min_rate: '1.10',
  max_rate: '50',
  w_boom: '6', w_boom_max: '1.01',
  w_low: '50', w_mid: '22', w_high: '20', w_top: '2',
  w_lo_min: '1.01', w_lo_max: '4.00',
  w_mid_min: '4.00', w_mid_max: '10.00',
  w_high_min: '10.00', w_high_max: '30.00',
  w_top_min: '30.00', w_top_max: '50.00',
};

const N = 500000;
const rows = [], booms = [];
for (let i = 0; i < N; i++) {
  const d = decideRate(CFGOBJ, 10000, 50000, null);
  rows.push(d.rate);
  if (d.fast) booms.push(d.rate);
}

const sorted = [...rows].sort((a, b) => a - b);
const avg = rows.reduce((s, v) => s + v, 0) / N;
const med = sorted[Math.floor(N / 2)];
const pct = p => sorted[Math.floor(N * p)];

const b = {
  '瞬爆(<1.02x)': 0, '1.02-4x': 0, '4-10x': 0, '10-30x': 0, '30x+': 0,
};
rows.forEach(v => {
  if (v < 1.02) b['瞬爆(<1.02x)']++;
  else if (v < 4) b['1.02-4x']++;
  else if (v < 10) b['4-10x']++;
  else if (v < 30) b['10-30x']++;
  else b['30x+']++;
});

console.log('=== decideRate 模式5「五段加权」实测（' + N.toLocaleString() + ' 局）===');
console.log('最低 ' + sorted[0].toFixed(2) + 'x   25% ' + pct(0.25).toFixed(2) +
  'x   中位 ' + med.toFixed(2) + 'x   75% ' + pct(0.75).toFixed(2) +
  'x   95% ' + pct(0.95).toFixed(2) + 'x   最高 ' + sorted[N - 1].toFixed(2) + 'x');
console.log('平均 ' + avg.toFixed(2) + 'x');
console.log('');
for (const [k, v] of Object.entries(b)) {
  const p = v / N * 100;
  console.log('  ' + k.padEnd(14) + p.toFixed(2).padStart(6) + '%  ' +
    '█'.repeat(Math.round(p * 1.2)) + '  (' + (N / v).toFixed(0) + ' 局来一次)');
}

console.log('\n=== 你要的三个节奏 ===');
const p30 = b['30x+'] / N * 100;
const p10 = b['10-30x'] / N * 100;
console.log('  平常 1.01–10x  ' + (b['瞬爆(<1.02x)'] + b['1.02-4x'] + b['4-10x']) / N * 100 + '%');
console.log('  10–30x        ' + p10.toFixed(2) + '%  → 每 ' + (N / (b['10-30x'])).toFixed(0) + ' 局来一次');
console.log('  30x+          ' + p30.toFixed(2) + '%  → 每 ' + (N / b['30x+']).toFixed(0) + ' 局来一次');
console.log('  其中 30–50x   ' + (b['30x+'] / N * 100).toFixed(2) + '%  → 每 ' + (N / b['30x+']).toFixed(0) + ' 局来一次（就是 30x+ 那档）');
const p50 = rows.filter(v => v >= 45).length / N * 100;
console.log('  45x+ 顶格     ' + p50.toFixed(2) + '%  → 每 ' + (N / (rows.filter(v => v >= 45).length)).toFixed(0) + ' 局来一次');

console.log('\n=== 玩家成功率 ===');
[2, 5, 10, 20, 30].forEach(t => {
  const s = rows.filter(v => v > t).length / N * 100;
  console.log('  在 ' + String(t).padStart(2) + 'x 逃: ' + s.toFixed(1) + '%');
});

console.log('\n=== 关键指标核对 ===');
const over10 = rows.filter(v => v >= 10).length / N * 100;
const boomp = booms.length / N * 100;
const checks = [
  ['10x 以下占 70~82%（平常区间）', over10 <= 30 && over10 >= 18],
  ['10–30x 占 16~24%（约 20 局一次）', p10 >= 16 && p10 <= 24],
  ['30x+ 占 1.5~3%（约 33~66 局一次）', p30 >= 1.5 && p30 <= 3],
  ['瞬爆占 4~8%', boomp >= 4 && boomp <= 8],
  ['瞬爆全部 < 1.02x', booms.every(v => v < 1.02)],
  ['瞬爆绕过 min_rate(=1.10)', booms.some(v => v < 1.10)],
  ['低段(1.02-4x)不被误判为瞬爆', b['1.02-4x'] / N * 100 > 40],
  ['最高爆点 <= 50', sorted[N - 1] <= 50.01],
];
checks.forEach(([n, ok]) => console.log((ok ? '✅' : '❌') + ' ' + n));

console.log('\n=== 飞行时长 ===');
[1.01, 1.05, 2, 4, 10, 30, 50].forEach(r => {
  const normal = flightMs(r);
  const instant = flightMs(r, { instant: true });
  console.log('  ' + String(r).padStart(5) + 'x  常规 ' + (normal / 1000).toFixed(2).padStart(6) +
    's   瞬爆 ' + (instant / 1000).toFixed(2).padStart(6) + 's' + (r < 1.02 ? '  ← 瞬爆段' : ''));
});
const boomFast = flightMs(1.005, { instant: true }) < 1000;
const lowOk = flightMs(2) >= 2500;
console.log('\n' + (boomFast ? '✅' : '❌') + ' 瞬爆局 1 秒内爆炸');
console.log((lowOk ? '✅' : '❌') + ' 2x 局仍有 2.5 秒最低飞行时间');

const allOk = checks.every(c => c[1]) && boomFast && lowOk;
console.log('\n' + (allOk ? '✅ 全部通过' : '❌ 有失败项'));
process.exit(allOk ? 0 : 1);
