'use strict';
/**
 * v2 引擎演示 —— 打印每局倍率。
 *   node scripts/sim-v2.js --rounds=100
 *   node scripts/sim-v2.js --mood=spicy --max=1000
 *   node scripts/sim-v2.js --seated=steady
 *   node scripts/sim-v2.js --boom=10          每 100 局 10 局瞬爆
 *   node scripts/sim-v2.js --empty=30          每 30 局有 1 局空房
 */
const path = require('path');
const E = require(path.join(__dirname, '..', 'server', 'v2', 'engine'));

const argv = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) argv[m[1]] = m[2] === undefined ? true : m[2];
}
const ROUNDS = Number(argv.rounds) || 100;
const MOOD = argv.mood || 'log';
const BOOM_QUOTA = argv.boom === undefined ? null : Number(argv.boom);
const EMPTY_EVERY = Number(argv.empty) || 0;   // 每 N 局有 1 局空房
const bounds = { min: Number(argv.min) || 1.01, max: Number(argv.max) || 120 };

/**
 * 不同房间的典型阈值画像。
 * 逃 = 心理阈值：跑到这个倍率以上就按逃跑。
 * 数字参考线上实测：escape_rate p50≈3.4x、p95≈11.8x。
 */
const ROOMS = {
  mixed:    [1.2, 1.5, 1.8, 2.1, 3.0, 5.5, 11.8, 20, 2.4, 4.2],
  steady:   [1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.0, 1.3, 1.5],
  greedy:   [3.0, 5.0, 8.0, 12.0, 20.0, 30.0, 15.0, 6.0, 10.0, 25.0],
  whale:    [50, 100, 200, 80, 150, 300, 60, 120, 90, 250],
  tiny:     [1.05, 1.1, 1.15, 1.2, 1.3, 1.1, 1.25, 1.4],
  solo:     [3.4],
};
const roomName = argv.seated || 'mixed';
const seated = (ROOMS[roomName] || ROOMS.mixed).map((thr) => ({ thr }));

console.log('='.repeat(72));
console.log(`房间 ${roomName}  ${seated.length} 人`);
console.log(`阈值 ${seated.map((p) => p.thr.toFixed(1)).join(' / ')}`);
console.log(`配置 ${bounds.min}x – ${bounds.max}x   手感 ${MOOD}`);
const spec = E.buildSpectrum(seated, bounds);
console.log('倍率谱 ' + spec.map((r) => `${r.rate}(${r.escapes}跑)`).join(' '));
const sched = BOOM_QUOTA != null ? E.createBoomScheduler({ quota: BOOM_QUOTA / 100, per: 100 }) : null;
if (sched) console.log(`瞬爆配额 每 100 局 ${BOOM_QUOTA} 局（1x 全灭）`);
if (EMPTY_EVERY) console.log(`空房模拟 每 ${EMPTY_EVERY} 局有 1 局无人下注（10x–50x）`);
console.log('='.repeat(72));
console.log('\n局号    爆点     相对上局   能跑掉   来源\n');
console.log('-'.repeat(46));

const hist = [];
const rows = [];
const rates = [];
let escSum = 0, escN = 0;
for (let i = 1; i <= ROUNDS; i++) {
  // 每 EMPTY_EVERY 局模拟一次空房
  const isEmpty = EMPTY_EVERY && (i % EMPTY_EVERY === 0);
  const forceBoom = sched ? sched.next() : false;
  const d = E.decide({
    seated: isEmpty ? [] : seated,
    bounds, history: hist, mood: MOOD,
    forceBoom: !isEmpty && forceBoom,
    emptyCfg: { lo: 10, hi: 50 },
  });
  const prev = hist.length ? hist[hist.length - 1] : null;
  const rel = prev ? ((d.rate / prev - 1) * 100) : null;
  // 最近谱点（用于显示能跑掉的人）
  const near = spec.reduce((a, b) => Math.abs(b.rate - d.rate) < Math.abs(a.rate - d.rate) ? b : a, spec[0]);
  rates.push(d.rate);
  if (near.escapes != null) { escSum += near.escapes; escN++; }
  rows.push({ id: i, rate: d.rate, rel, escapes: near.escapes, source: d.source });
  if (i <= 40 || i > ROUNDS - 6 || i % 10 === 0) {
    console.log(
      String(i).padEnd(7),
      (d.rate.toFixed(2) + 'x').padEnd(9),
      (rel === null ? '—' : (rel > 0 ? '+' : '') + rel.toFixed(0) + '%').padEnd(11),
      (near.escapes == null ? '—' : near.escapes + '/' + seated.length).padEnd(9),
      d.source
    );
  }
  // ⚠️ 空房和瞬爆都不写 history —— 空房倍率（10-50x）不该影响
  //    真人局的破连续判断，瞬爆（1x）更不该（否则下一局必然被推离 1x）。
  if (!isEmpty && !d.boom) {
    hist.push(d.rate);
    if (hist.length > 8) hist.shift();
  }
}
if (ROUNDS > 40 && ROUNDS - 6 > 40) console.log('   ...');

const s = rates.slice().sort((a, b) => a - b);
const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
const rels = rates.slice(1).map((r, i) => Math.abs(r / rates[i] - 1));
const near8 = rels.filter((x) => x < 0.08);
const cnt = {};
for (const r of rates) { const k = r.toFixed(2); cnt[k] = (cnt[k] || 0) + 1; }

console.log('\n' + '='.repeat(72));
console.log(`局数 ${ROUNDS}   不同倍率 ${new Set(rates).size} (${(new Set(rates).size / ROUNDS * 100).toFixed(0)}%)`);
console.log(`最小 ${s[0]}x   p25 ${q(0.25)}x   中位 ${q(0.5)}x   p75 ${q(0.75)}x   最大 ${s[s.length - 1]}x`);
console.log(`边界 ${bounds.min}–${bounds.max}  越界 ${rates.filter((r) => r < bounds.min || r > bounds.max).length} 局`);
console.log(`平均能跑掉 ${(escSum / escN).toFixed(1)} / ${seated.length} 人  →  赢面约 ${(100 - (escSum / escN / seated.length) * 100).toFixed(0)}%`);
console.log(`\n⭐ 相邻局差 <8%  ${near8.length}/${rels.length} = ${(near8.length / rels.length * 100).toFixed(1)}%  ${near8.length / rels.length < 0.01 ? '✅ 玩家看不出规律' : '⚠️ 会被看出'}`);
console.log(`   相邻局差 >30% ${rels.filter((x) => x > 0.3).length}/${rels.length} = ${(rels.filter((x) => x > 0.3).length / rels.length * 100).toFixed(0)}%`);
console.log('   最高频倍率: ' + Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}x×${v}`).join('  '));
console.log('');
