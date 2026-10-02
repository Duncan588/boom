'use strict';
/** 赔率引擎验证：窗口分布 + 限时活动 */
const { decideRate, activeEvent, flightMs } = require('../server/odds');

const cfg = { odds_mode: '4', min_rate: 1.10, max_rate: 1000, band_min: 1.10, band_max: 3.00, base_random: 0.9 };

function pct(o, div) {
  for (const [k, v] of Object.entries(o)) console.log('  ' + k.padEnd(18) + (v / div).toFixed(1) + '%');
}

console.log('=== 默认（区间 1.10-3.00x）3000 局 → 逃跑窗口 ===');
const b = {};
for (let i = 0; i < 3000; i++) {
  const r = decideRate(cfg, 500, 10000, null);
  const ms = flightMs(r.rate);
  const k = ms < 200 ? '<0.2s 不可能' : ms < 400 ? '0.2-0.4s 极限' : ms < 800 ? '0.4-0.8s 紧张'
    : ms < 1500 ? '0.8-1.5s' : ms < 3000 ? '1.5-3s 宽松' : '3s+ 很宽松';
  b[k] = (b[k] || 0) + 1;
}
pct(b, 30);

console.log('\n=== 限时活动 19:00-22:00 高倍场 (min2 max30 weight0.8) ===');
const evCfg = { events_json: JSON.stringify([{ name: '黄金时段', from: '19:00', to: '22:00', min: 2, max: 30, weight: 0.8 }]) };
const ev = activeEvent(evCfg, new Date(2026, 0, 1, 20, 30));
console.log('  命中活动: ' + (ev ? ev.name : '无'));
const c = {};
for (let i = 0; i < 2000; i++) {
  const r = decideRate(cfg, 500, 10000, ev).rate;
  const k = r < 3 ? '2-3x' : r < 8 ? '3-8x' : r < 20 ? '8-20x' : '20x+';
  c[k] = (c[k] || 0) + 1;
}
pct(c, 20);

console.log('\n=== 时段判定 ===');
console.log('  12:00 在 19-22 之外 →', activeEvent(evCfg, new Date(2026, 0, 1, 12, 0)));
const cross = { events_json: JSON.stringify([{ name: '深夜场', from: '23:00', to: '01:00', min: 2, max: 15 }]) };
console.log('  跨零点 23:30 →', (activeEvent(cross, new Date(2026, 0, 1, 23, 30)) || {}).name);
console.log('  跨零点 00:30 →', (activeEvent(cross, new Date(2026, 0, 1, 0, 30)) || {}).name);
console.log('  跨零点 12:00 →', activeEvent(cross, new Date(2026, 0, 1, 12, 0)));
const off = { events_json: JSON.stringify([{ name: '关闭', from: '00:00', to: '23:59', enabled: false }]) };
console.log('  enabled:false →', activeEvent(off, new Date(2026, 0, 1, 12, 0)));

console.log('\n=== 原版四种模式（池子 10000，总注 500）===');
const modes = { 1: '赢', 2: '输', 3: '平衡', 4: '区间' };
for (const [m, name] of Object.entries(modes)) {
  const c2 = { ...cfg, odds_mode: m, odds_value: 100, rake_percent: 0.05 };
  const rs = [];
  let fast = 0;
  for (let i = 0; i < 500; i++) { const r = decideRate(c2, 500, 10000, null); rs.push(r.rate); if (r.fast) fast++; }
  const avg = (rs.reduce((s, x) => s + x, 0) / rs.length).toFixed(2);
  const min = Math.min(...rs).toFixed(2), max = Math.max(...rs).toFixed(2);
  console.log(`  ${name.padEnd(4)} 最低 ${min}  平均 ${avg}  最高 ${max}  立即结算 ${(fast / 5).toFixed(0)}%`);
}

console.log('\n=== 下限保护（min_rate 调到 2.00）===');
const c3 = { ...cfg, min_rate: 2.00 };
const rs2 = [];
for (let i = 0; i < 1000; i++) rs2.push(decideRate(c3, 500, 10000, null).rate);
console.log('  最低爆点 =', Math.min(...rs2).toFixed(2), '(应 >= 2.00)');
console.log('  最小窗口 =', (flightMs(Math.min(...rs2)) / 1000).toFixed(2), '秒');
