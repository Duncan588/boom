'use strict';
/**
 * v3 引擎模拟器 —— 打印每局倍率
 *   node scripts/sim-v3.js --rounds=100
 *   node scripts/sim-v3.js --rounds=100 --min=1 --max=125 --boom=10
 *   node scripts/sim-v3.js --rounds=2000 --jump=0.3 --width=1.8
 */
const path = require('path');
const { createEngine } = require(path.join(__dirname, '..', 'server', 'v3', 'engine'));

const argv = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) argv[m[1]] = m[2] === undefined ? true : m[2];
}
const R = Number(argv.rounds) || 100;
const SHOW_ALL = !!argv.all || R <= 120;
const eng = createEngine({
  min: Number(argv.min) || 1,
  max: Number(argv.max) || 125,
  width: argv.width ? Number(argv.width) : 1.8,
  jumpRate: argv.jump ? Number(argv.jump) : 0.3,
  boomQuota: argv.boom === undefined ? 0.10 : Number(argv.boom) / 100,
});

console.log('='.repeat(64));
const st = eng.stats();
console.log(`v3  范围 ${eng.min}–${eng.max}x   采样宽度 ±${Math.log(st.width).toFixed(2)}(log)   跳变率 ${(st.jumpRate * 100).toFixed(0)}%   瞬爆 ${(st.boomQuota * 100).toFixed(0)}%`);
console.log('='.repeat(64));
console.log('\n局号     爆点      中心     来源\n');
console.log('-'.repeat(38));

const rows = [];
for (let i = 1; i <= R; i++) {
  const d = eng.roll();
  rows.push(d);
  if (SHOW_ALL || i > R - 8 || i % 25 === 0) {
    console.log(
      String(i).padEnd(7),
      (d.rate.toFixed(2) + 'x').padEnd(10),
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
const rels = rates.slice(1).map((r, i) => Math.abs(r / rates[i] - 1));
const over = (t) => rates.filter((r) => r >= t).length / rates.length * 100;
const cnt = {};
for (const r of rates) { const k = r.toFixed(1); cnt[k] = (cnt[k] || 0) + 1; }

console.log('\n' + '='.repeat(64));
console.log(`局数 ${R}  不同倍率 ${new Set(rates).size} (${(new Set(rates).size / R * 100).toFixed(0)}%)  瞬爆 ${booms} (${(booms / R * 100).toFixed(1)}%)`);
console.log(`最小 ${s[0]}  p10 ${q(.1)}  p25 ${q(.25)}  中位 ${q(.5)}  p75 ${q(.75)}  p90 ${q(.9)}  最大 ${s[s.length - 1]}`);
console.log(`越界 ${rates.filter((r) => r < eng.min || r > eng.max).length} 局`);
console.log(`\n≥2x  ${over(2).toFixed(0)}%   ≥5x  ${over(5).toFixed(0)}%   ≥10x ${over(10).toFixed(0)}%   ≥20x ${over(20).toFixed(0)}%   ≥50x ${over(50).toFixed(0)}%`);
console.log(`\n⭐ 相邻局差 <5%  ${(rels.filter((x) => x < 0.05).length / rels.length * 100).toFixed(1)}%`);
console.log(`   相邻局差 >50% ${(rels.filter((x) => x > 0.5).length / rels.length * 100).toFixed(0)}%`);
console.log('   最高频: ' + Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}x×${v}`).join('  '));
console.log('');
