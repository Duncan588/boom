'use strict';
/**
 * 高倍加速曲线的回归测试。
 *
 * 最重要的一条是【往返一致性】：rate → ms → rate 必须完全相同。
 * 这条挂了意味着玩家点逃跑时屏幕显示一个倍率、实际按另一个倍率赔付 ——
 * 直接的资金错误。
 */
const GL = require('../server/odds');
const { flightMs, rateAt } = GL;
const v3 = require('../server/odds/v3/engine');

let pass = 0, fail = 0;
function t(name, ok, got) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (got !== undefined ? '   ' + got : '')); }
}

console.log('\n=== 1. 100x 以下完全不动 ===');
for (const r of [1.0, 1.5, 2, 5, 10, 20, 50, 80, 99, 100]) {
  const raw = ((Math.sqrt(40 * r - 24) - 4) / 2) * 2.5 * 1000;
  t(`${r}x 仍是原速`, Math.abs(flightMs(r) - raw) < 1, `实际 ${flightMs(r)} 期望 ${raw.toFixed(0)}`);
}

console.log('\n=== 2. 100x 以上单调递增（不能塌平、不能回落）===');
// ⚠️ prev 必须从 flightMs(100) 起算，不能从 0 起 ——
//    否则第一圈就是「0 → 73820ms」，被误报成 100x 处的断崖。
let prev = flightMs(100), mono = true, worstJump = 0, jumpAt = 100;
for (let r = 100.5; r <= 2000; r += 0.5) {
  const v = flightMs(r);
  if (v < prev) { mono = false; break; }
  if (v - prev > worstJump) { worstJump = v - prev; jumpAt = r; }
  prev = v;
}
t('100–2000x 严格递增', mono);
t('每 1x 的最大增量 < 200ms（无陡崖）', worstJump < 200, `最大 +${worstJump.toFixed(0)}ms @${jumpAt}x`);

console.log('\n=== 3. 每翻倍增量均匀（用户要求：中间不要加太快）===');
const incs = [];
// ⚠️ 只测 [100, 1000) 区间内的翻倍。800→1600 会跨过 1000x 拐点进入
//    指数收敛段（本来就该变缓），混进来会误报「不均匀」。
for (let r = 100; r < 500; r *= 2) incs.push(flightMs(r * 2) - flightMs(r));
const avg = incs.reduce((a, b) => a + b, 0) / incs.length;
const dev = Math.max(...incs.map((x) => Math.abs(x - avg))) / avg;
t(`每翻倍 +${(avg / 1000).toFixed(1)}s，均匀度偏差 ${(dev * 100).toFixed(1)}% < 5%`, dev < 0.05, incs.map((x) => (x / 1000).toFixed(1)).join('/'));

console.log('\n=== 4. 目标值 ===');
t('1000x ≈ 100 秒', Math.abs(flightMs(1000) - 100000) < 1500, `${(flightMs(1000) / 1000).toFixed(1)}s`);
t('最慢的一局 ≤ 90s（低于原 120s 上限）', flightMs(100) < 90000, `${(flightMs(100) / 1000).toFixed(1)}s`);
t('10000x 兜底 ≤ 130s（无论怎么配都不会卡服）', flightMs(10000) < 130000, `${(flightMs(10000) / 1000).toFixed(1)}s`);

console.log('\n=== 5. 往返一致（资金安全关键）===');
let worstErr = 0;
for (let r = 1.0; r <= 1200; r += 0.37) {
  const ms = flightMs(r);
  const back = rateAt(ms);
  const err = Math.abs(back - r) / r;
  if (err > worstErr) worstErr = err;
}
t('往返误差 < 0.01%', worstErr < 0.0001, `最大 ${(worstErr * 100).toFixed(5)}%`);
t('高倍段往返抽查', Math.abs(rateAt(flightMs(1000)) - 1000) < 1, `1000x → ${rateAt(flightMs(1000)).toFixed(2)}x`);

console.log('\n=== 6. 活动模式 v3 ===');
// 模拟活动：1–1000x，30% 瞬爆
const seen = [];
for (let i = 0; i < 2000; i++) {
  seen.push(v3.rollRange({ min: 1, max: 1000, boomRate: 0.30 }));
}
const rates = seen.map((d) => d.rate);
const booms = seen.filter((d) => d.boom).length;
t('倍率全部落在 1–1000', rates.every((r) => r >= 1 && r <= 1000));
t('瞬爆率 ≈ 30%', Math.abs(booms / seen.length - 0.30) < 0.04, `${(booms / seen.length * 100).toFixed(1)}%`);
t('出现了 ≥100x 的高倍局', rates.filter((r) => r >= 100).length / rates.length > 0.10, `${(rates.filter((r) => r >= 100).length / rates.length * 100).toFixed(0)}%`);
t('出现了 ≥500x 的局', rates.filter((r) => r >= 500).length > 0, `最高 ${Math.max(...rates)}x`);
t('不同倍率 > 50%', new Set(rates).size / rates.length > 0.5, `${(new Set(rates).size / rates.length * 100).toFixed(0)}%`);

console.log('\n=== 7. 活动不再返回固定倍率 ===');
const cfg = { min_rate: 1, max_rate: 125, odds_mode: '7', events_json: JSON.stringify([
  { name: 'T', from: '00:00', to: '23:59', min: 1, max: 1000, boom_rate: 0.3, enabled: true },
]) };
const evRates = new Set();
for (let i = 0; i < 300; i++) {
  evRates.add(GL.decideRate(cfg, 10000, 500000, GL.activeEvent(cfg), {}).rate);
}
t('活动 300 局产生多个不同倍率（旧代码只有 1 个）', evRates.size > 50, `不同倍率 ${evRates.size} 个`);

console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===\n`);
process.exit(fail ? 1 : 0);