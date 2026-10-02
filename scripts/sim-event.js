'use strict';
/**
 * 活动模式模拟器 —— 老虎机算法（v3）+ 活动规则
 *
 * 活动规则：
 *   · 范围 1 – 1000x
 *   · 30% 概率瞬爆 1x
 *   · 100x 以上对数线性加速（100x=73.8s，1000x=100s）
 *
 * 日常规则（对照组）：
 *   · 范围 1 – 125x
 *   · 10% 概率瞬爆
 *   · 同一套加速曲线（100x 以下不变）
 *
 *   node scripts/sim-event.js --mode=event --rounds=100
 *   node scripts/sim-event.js --mode=daily --rounds=100
 */
const path = require('path');
const { createEngine } = require(path.join(__dirname, '..', 'server', 'odds', 'v3', 'engine'));
const { flightMs } = require(path.join(__dirname, '..', 'server', 'odds'));

const argv = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) argv[m[1]] = m[2] === undefined ? true : m[2];
}

const MODE = argv.mode || 'event';
const R = Number(argv.rounds) || 100;
const SHOW_ALL = !!argv.all || R <= 120;

const PRESET = {
  event: { min: 1, max: 1000, boom: 0.30 },
  daily: { min: 1, max: 125, boom: 0.10 },
};
const P = PRESET[MODE] || PRESET.event;

const eng = createEngine({
  min: P.min, max: P.max, width: 1.8, jumpRate: 0.3, boomQuota: P.boom,
});

// 加速曲线（还没写进 game-logic，这里本地复刻一份用于预览）
const T100 = flightMs(100);
const HEAD = 100000 - T100;
function msOf(rate) {
  if (rate <= 100) return flightMs(rate);
  if (rate <= 1000) return T100 + HEAD * Math.log10(rate / 100);
  return 100000 + 20000 * (1 - Math.exp(-Math.log10(rate / 1000)));
}

console.log('='.repeat(70));
console.log(`${MODE === 'event' ? '活动模式' : '日常模式'}  范围 ${P.min}–${P.max}x   瞬爆 ${(P.boom * 100).toFixed(0)}%`);
console.log(`${MODE === 'event' ? '高倍加速：100x=73.8s → 1000x=100s（每翻倍 +7.9s）' : '100x 以下原速'}`);
console.log('='.repeat(70));
console.log('\n局号     爆点      飞行      中心     来源\n');
console.log('-'.repeat(48));

const rows = [];
for (let i = 1; i <= R; i++) {
  const d = eng.roll();
  const ms = d.boom ? 0 : msOf(d.rate);
  rows.push({ ...d, ms });
  if (SHOW_ALL || i > R - 8 || i % 25 === 0) {
    console.log(
      String(i).padEnd(7),
      (d.rate.toFixed(2) + 'x').padEnd(10),
      (d.boom ? '0.0s' : (ms / 1000).toFixed(1) + 's').padEnd(10),
      (d.center.toFixed(2) + 'x').padEnd(9),
      d.boom ? '💥 瞬爆' : ''
    );
  }
}
if (!SHOW_ALL && R > 32) console.log('   ...');

const rates = rows.map((r) => r.rate);
const booms = rows.filter((r) => r.boom).length;
const s = rates.slice().sort((a, b) => a - b);
const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
const mss = rows.map((r) => r.ms);
const over = (t) => rates.filter((r) => r >= t).length / rates.length * 100;

console.log('\n' + '='.repeat(70));
console.log(`局数 ${R}  不同倍率 ${new Set(rates).size} (${(new Set(rates).size / R * 100).toFixed(0)}%)  瞬爆 ${booms} (${(booms / R * 100).toFixed(1)}%)`);
console.log(`倍率  最小 ${s[0]}  p10 ${q(.1)}  p25 ${q(.25)}  中位 ${q(.5)}  p75 ${q(.75)}  p90 ${q(.9)}  最大 ${s[s.length - 1]}`);
console.log(`飞行  最短 ${(Math.min(...mss) / 1000).toFixed(1)}s  中位 ${(mss.slice().sort((a, b) => a - b)[Math.floor(R / 2)] / 1000).toFixed(1)}s  最长 ${(Math.max(...mss) / 1000).toFixed(1)}s`);
console.log(`      超过 120s 的局: ${mss.filter((x) => x > 120000).length}  （取消硬上限后无此风险）`);
console.log(`\n≥10x ${over(10).toFixed(0)}%   ≥50x ${over(50).toFixed(0)}%   ≥100x ${over(100).toFixed(0)}%   ≥500x ${over(500).toFixed(0)}%`);
console.log('');
