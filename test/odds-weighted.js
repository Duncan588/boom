/**
 * 模式 5「中位 10x + 1.01 瞬爆」验证 —— 直接调用生产用的 decideRate()，
 * 确认和推演脚本一致。瞬爆必须能绕过 min_rate 和最低飞行时长。
 */
const { decideRate, flightMs, CFG } = require('../server/game-logic.js');

const CFGOBJ = {
  odds_mode: '5',
  min_rate: '1.10',
  max_rate: '50',
  w_low: '22', w_mid: '48', w_high: '25',
  w_lo_min: '1.10', w_lo_max: '1.70',
  w_mid_min: '6.00', w_mid_max: '15.00',
  w_high_min: '15.00', w_high_max: '50.00',
  w_boom: '5', w_boom_max: '1.04',
};

const N = 200000;
const rows = [], inst = [];
for (let i = 0; i < N; i++) {
  const d = decideRate(CFGOBJ, 10000, 50000, null);
  rows.push(d.rate);
  if (d.fast) inst.push(d.rate);
}

const sorted = [...rows].sort((a, b) => a - b);
const avg = rows.reduce((s, v) => s + v, 0) / N;
const med = sorted[Math.floor(N / 2)];
const over10 = rows.filter(v => v >= 10).length / N * 100;
const boomp = inst.length / N * 100;

const b = { '瞬爆(<1.05x)': 0, '1.1-2x': 0, '2-6x': 0, '6-10x': 0, '10-15x': 0, '15x+': 0 };
rows.forEach(v => {
  if (v < 1.05) b['瞬爆(<1.05x)']++;
  else if (v < 2) b['1.1-2x']++;
  else if (v < 6) b['2-6x']++;
  else if (v < 10) b['6-10x']++;
  else if (v < 15) b['10-15x']++;
  else b['15x+']++;
});

console.log('=== decideRate 模式5「中位10x+瞬爆」实测（' + N.toLocaleString() + ' 局）===');
console.log('中位 ' + med.toFixed(2) + 'x   平均 ' + avg.toFixed(2) + 'x   95分位 ' + sorted[Math.floor(N * 0.95)].toFixed(2) + 'x');
console.log('10x+ 占比 ' + over10.toFixed(1) + '%   瞬爆占比 ' + boomp.toFixed(1) + '%   fast 标记 ' + inst.length + ' 次');
console.log('');
for (const [k, v] of Object.entries(b)) {
  const p = v / N * 100;
  console.log('  ' + k.padEnd(13) + p.toFixed(1).padStart(5) + '%  ' + '█'.repeat(Math.round(p * 0.7)));
}

const flee2 = rows.filter(v => v > 2).length / N * 100;
const flee10 = rows.filter(v => v > 10).length / N * 100;
console.log('\n=== 玩家成功率 ===');
console.log('  2x  就逃: ' + flee2.toFixed(1) + '%');
console.log('  10x 就逃: ' + flee10.toFixed(1) + '%');

console.log('\n=== 关键指标核对 ===');
const checks = [
  ['中位爆点 9.5~11.0x', med >= 9.5 && med <= 11.0],
  ['平均爆点 12.5~14.5x', avg >= 12.5 && avg <= 14.5],
  ['10x+ 占比 48~56%', over10 >= 48 && over10 <= 56],
  ['瞬爆占比 4~6%', boomp >= 4 && boomp <= 6],
  ['瞬爆全部 < 1.05x', inst.length === 0 || inst.every(v => v < 1.05)],
  ['瞬爆绕过 min_rate(=1.10)', inst.length === 0 || inst.some(v => v < 1.10)],
  ['最高爆点 <= 50', sorted[N - 1] <= 50.01],
];
checks.forEach(([n, ok]) => console.log((ok ? '✅' : '❌') + ' ' + n));

console.log('\n=== 飞行时长：瞬爆必须「刚起飞就没」===');
[1.01, 1.03, 1.10, 1.5, 2, 6, 10, 15, 50].forEach(r => {
  const normal = flightMs(r);
  const instant = flightMs(r, { instant: true });
  const mark = r < 1.05 ? '  ← 瞬爆段' : '';
  console.log('  ' + String(r).padStart(5) + 'x  常规 ' + (normal / 1000).toFixed(2).padStart(6) +
    's   瞬爆 ' + (instant / 1000).toFixed(2).padStart(6) + 's' + mark);
});

const boomFast = flightMs(1.02, { instant: true }) < 1000;
const lowNormal = flightMs(1.5) >= 2500;
console.log('\n' + (boomFast ? '✅' : '❌') + ' 瞬爆局 1 秒内爆炸（不给逃跑窗口）');
console.log((lowNormal ? '✅' : '❌') + ' 低倍率局仍有 2.5 秒最低飞行时间（看得清曲线）');

const allOk = checks.every(c => c[1]) && boomFast && lowNormal;
console.log('\n' + (allOk ? '✅ 全部通过' : '❌ 有失败项'));
process.exit(allOk ? 0 : 1);
