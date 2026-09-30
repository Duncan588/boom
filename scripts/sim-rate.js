'use strict';
/**
 * 本地倍率分布模拟器 —— 零成本，不调 API。
 *
 * 【和 scripts/sim-jev.mjs 的区别】
 * 那个模拟整场游戏（玩家池、余额、破产、输赢）。
 * 这个只问一件事：**每一局的爆点倍率是多少** —— 正是用户要看的。
 *
 * 用法：
 *   node scripts/sim-rate.js                     # 100 局默认配置
 *   node scripts/sim-rate.js --rounds=500
 *   node scripts/sim-rate.js --min=1.01 --max=120 --shape=60,30,10
 *   node scripts/sim-rate.js --out="E:/hermes/cache/scratch/rate.json"
 */
const path = require('path');
const fs = require('fs');
const { fallbackRate, normRange, normShape, buildZones, clamp, round2 } =
  require(path.join(__dirname, '..', 'server', 'jev-rate'));

const argv = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) argv[m[1]] = m[2] === undefined ? true : m[2];
}

const ROUNDS = Number(argv.rounds) || 100;
const cfg = {
  minRate: Number(argv.min) || 1.01,
  maxRate: Number(argv.max) || 120,
  shape: (() => {
    if (!argv.shape) return { low: 60, mid: 30, high: 10 };
    const [low, mid, high] = String(argv.shape).split(',').map(Number);
    return { low, mid, high };
  })(),
};
const range = normRange(cfg);
const shape = normShape(cfg.shape);
const zones = buildZones(range, shape);

console.log('='.repeat(74));
console.log(`配置  范围 ${range.min}x – ${range.max}x`);
console.log(`档位  低 ${zones[0].min}–${zones[0].max}  中 ${zones[1].min}–${zones[1].max}  高 ${zones[2].min}–${zones[2].max}`);
console.log(`目标  低 ${shape.low.toFixed(0)}%  中 ${shape.mid.toFixed(0)}%  高 ${shape.high.toFixed(0)}%`);
console.log('='.repeat(74));
console.log('\n局号    爆点倍率   相对上局   档位\n');
console.log('-'.repeat(44));

const rates = [];
const history = [];   // 供 antiPattern 做连续性破除（真实 Jev 也会走同一套）
const rows = [];
for (let i = 1; i <= ROUNDS; i++) {
  const rate = fallbackRate(cfg, cfg.shape, history);
  const prev = history.length ? history[history.length - 1] : null;
  const rel = prev ? ((rate / prev - 1) * 100) : null;
  const zone = zones.find((z) => rate >= z.min && rate <= z.max);
  rates.push(rate);
  rows.push({ id: i, rate, rel, zone: zone ? zone.key : '?' });
  if (i <= 40 || i > ROUNDS - 5 || i % 10 === 0) {
    console.log(
      String(i).padEnd(7),
      (rate.toFixed(2) + 'x').padEnd(11),
      (rel === null ? '—' : (rel > 0 ? '+' : '') + rel.toFixed(0) + '%').padEnd(11),
      zone ? zone.key : '?'
    );
  }
  history.push(rate);
  if (history.length > 6) history.shift();
}
if (ROUNDS > 40 && ROUNDS - 5 > 40) console.log('   ...');

const s = rates.slice().sort((a, b) => a - b);
const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
const distinct = new Set(rates).size;
const rels = rates.slice(1).map((r, i) => Math.abs(r / rates[i] - 1));
const near = rels.filter((x) => x < 0.12).length;

console.log('\n' + '='.repeat(74));
console.log('统计');
console.log('='.repeat(74));
console.log(`  局数            ${ROUNDS}`);
console.log(`  不同倍率        ${distinct}  (${(distinct / ROUNDS * 100).toFixed(0)}%)`);
console.log(`  最小            ${s[0]}x`);
console.log(`  p25             ${q(0.25)}x`);
console.log(`  中位            ${q(0.5)}x`);
console.log(`  p75             ${q(0.75)}x`);
console.log(`  最大            ${s[s.length - 1]}x`);
console.log(`  平均            ${mean.toFixed(2)}x`);
console.log(`  max_rate 生效？  ${s[s.length - 1] <= range.max ? '✅ 未越界' : '❌ 越界'}（配置 ${range.max}x，实际最高 ${s[s.length-1]}x）`);

console.log('\n档位分布（对标配置目标）');
for (const z of zones) {
  const c = rates.filter((r) => r >= z.min && r <= z.max).length;
  console.log(`  ${z.key.padEnd(5)} ${(c / ROUNDS * 100).toFixed(1)}%  (目标 ${shape[z.key].toFixed(0)}%)  ${'-'.repeat(3)} #${c}`);
}

console.log('\n连续性（用户实测 #5519-#5515 四个局几乎一样）');
console.log(`  相邻局差 <12%   ${near}/${rels.length}  = ${(near / rels.length * 100).toFixed(1)}%`);
console.log(`  相邻局差 >50%   ${rels.filter((x) => x > 0.5).length}/${rels.length}  = ${(rels.filter((x) => x > 0.5).length / rels.length * 100).toFixed(1)}%`);
const cnt = {};
for (const r of rates) { const k = r.toFixed(2); cnt[k] = (cnt[k] || 0) + 1; }
const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log(`  最高频倍率      ${top.map(([k, v]) => `${k}x×${v}`).join('  ')}`);
let runMax = 1, run = 1;
for (let i = 1; i < rates.length; i++) {
  const z = zones.find((x) => rates[i] >= x.min && rates[i] <= x.max);
  const pz = zones.find((x) => rates[i - 1] >= x.min && rates[i - 1] <= x.max);
  run = (z && pz && z.key === pz.key) ? run + 1 : 1;
  if (run > runMax) runMax = run;
}
/**
 * ⚠️ 同档连击【不是问题】，别把它当失败信号。
 * low 档占 60%，随机情况下连着 8–10 局都在 low 属正常（几何分布期望 ~1.7，
 * 但尾部到 15 完全可能）。玩家看不出「连着 12 局都是低倍局」——
 * 低倍局本来就是多数。
 * 真正刺眼的是【相邻局数值几乎相同】（4.43 6.17 6.17 6.14 6.07），
 * 那个由「相邻局差 <12%」衡量，现在是 0.5–0.8%。
 */
console.log(`  同档最长连击    ${runMax} 局  ${runMax > 8 ? 'ℹ️ low 占 60%，连着低倍属正常' : ''}`);
console.log(`  ⭐ 真正指标     相邻局差 <12% = ${(near / rels.length * 100).toFixed(1)}%  ${near / rels.length < 0.03 ? '✅ 不会被看出规律' : '⚠️ 会被看出规律'}`);

if (argv.out) {
  fs.writeFileSync(argv.out, JSON.stringify({ cfg: { ...cfg, range, shape }, rows, stats: {
    rounds: ROUNDS, distinct, min: s[0], p25: q(0.25), median: q(0.5), p75: q(0.75),
    max: s[s.length - 1], mean: round2(mean), nearPct: +(near / rels.length * 100).toFixed(1),
  } }, null, 2));
  console.log(`\n已保存 ${argv.out}`);
}
console.log('');
