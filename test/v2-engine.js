'use strict';
/**
 * 爆点倍率引擎 v2 —— 单元测试
 *
 * 【测试原则】
 * 测「必须成立的不变量」，不测「某个具体数字」——
 * 随机算法不能断言具体值，但可以断言分布和边界性质。
 */
const path = require('path');
const E = require(path.join(__dirname, '..', 'server', 'v2', 'engine'));

let pass = 0, fail = 0;
function t(name, ok, extra) {
  if (ok) { console.log('  OK   ' + name); pass++; }
  else { console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); fail++; }
}

console.log('\n=== v2 引擎测试 ===\n');

// ---------- 1. 倍率谱 ----------
console.log('--- 倍率谱（来自真实逃跑阈值）---');
const players = [
  { thr: 1.2 }, { thr: 1.5 }, { thr: 1.8 }, { thr: 2.1 },
  { thr: 3.0 }, { thr: 5.5 }, { thr: 11.8 }, { thr: 20 },
];
const bounds = { min: 1.01, max: 120 };
const spec = E.buildSpectrum(players, bounds);
t('谱非空', spec.length > 0, `length=${spec.length}`);
t('谱按倍率升序', spec.every((r, i) => i === 0 || r.rate >= spec[i - 1].rate));
t('谱内每点都在管理员边界内',
  spec.every((r) => r.rate >= bounds.min && r.rate <= bounds.max),
  spec.filter((r) => r.rate < bounds.min || r.rate > bounds.max).map((r) => r.rate).join(','));
t('每点都标注了能跑掉的人数',
  spec.every((r) => r.escapes === null || (r.escapes >= 0 && r.escapes <= players.length)));
// escapes 必须随倍率单调不减
t('能跑掉的人数随倍率单调不减',
  spec.every((r, i) => i === 0 || r.escapes >= spec[i - 1].escapes),
  spec.map((r) => `${r.rate}:${r.escapes}`).join(' '));
console.log('       谱 = ' + spec.map((r) => `${r.rate}x(${r.escapes}人跑)`).join(' '));

// 阈值真的进了谱
t('玩家阈值出现在谱里',
  [1.2, 2.1, 20].every((thr) => spec.some((r) => Math.abs(r.rate - thr) < 0.01)));

// ---------- 2. 边界 ----------
console.log('\n--- 管理员边界是硬约束 ---');
const tight = { min: 2, max: 8 };
const sp2 = E.buildSpectrum(players, tight);
t('窄范围谱全部在 [2,8] 内',
  sp2.every((r) => r.rate >= 2 && r.rate <= 8), sp2.map((r) => r.rate).join(','));

// ---------- 3. 空房间 ----------
console.log('\n--- 空房间 / 无效阈值 ---');
const empty = E.buildSpectrum([], bounds);
t('无人时谱仍非空', empty.length > 0);
t('无人时谱在边界内', empty.every((r) => r.rate >= bounds.min && r.rate <= bounds.max));
const badThrs = E.buildSpectrum([{ thr: NaN }, { thr: 0 }, { thr: -5 }], bounds);
t('阈值全无效时退化为默认谱', badThrs.length > 0);
t('退化谱不越界', badThrs.every((r) => r.rate >= bounds.min && r.rate <= bounds.max));

// ---------- 4. decide 的不变量 ----------
console.log('\n--- decide 输出的不变量 ---');
const N = 20000;
let minSeen = Infinity, maxSeen = -Infinity, srcCount = { jev: 0, fallback: 0 };
let adjNear = 0, adjTotal = 0;
const hist = [];
const values = [];
for (let i = 0; i < N; i++) {
  const d = E.decide({ seated: players, bounds, history: hist, mood: 'log' });
  values.push(d.rate);
  minSeen = Math.min(minSeen, d.rate);
  maxSeen = Math.max(d.rate, d.rate);
  srcCount[d.source]++;
  if (hist.length) {
    adjTotal++;
    if (Math.abs(d.rate - hist[hist.length - 1]) / hist[hist.length - 1] < 0.08) adjNear++;
  }
  hist.push(d.rate);
  if (hist.length > 8) hist.shift();
}
t('2 万局全部在边界内', minSeen >= bounds.min && maxSeen <= bounds.max,
  `实际 ${minSeen} – ${maxSeen}`);
t('2 万局都不止一个值（不是常量）', new Set(values).size > 50, `只有 ${new Set(values).size} 种`);
t('来源都是 fallback（没传 suggestion）', srcCount.fallback === N, JSON.stringify(srcCount));
t('相邻局差 <8% 的比例 < 1%', adjNear / adjTotal < 0.01,
  `${(adjNear / adjTotal * 100).toFixed(2)}%`);

// ---------- 5. Jev 建议路径 ----------
console.log('\n--- Jev 建议倍率会被采纳但受边界钳制 ---');
const d1 = E.decide({ seated: players, bounds, suggestion: 8.5 });
t('Jev 给 8.5 → 采用', d1.rate === 8.5, String(d1.rate));
t('来源标记为 jev', d1.source === 'jev');
const d2 = E.decide({ seated: players, bounds, suggestion: 9999 });
t('Jev 给 9999 → 钳到 max 120', d2.rate === 120, String(d2.rate));
const d3 = E.decide({ seated: players, bounds, suggestion: 0.01 });
t('Jev 给 0.01 → 钳到 min 1.01', d3.rate === 1.01, String(d3.rate));
const d4 = E.decide({ seated: players, bounds, suggestion: NaN });
t('Jev 给 NaN → 退回 fallback', d4.source === 'fallback');

// ---------- 6. 破连续性 ----------
console.log('\n--- 破连续性（用户实测 6.17 6.17 6.14）---');
const B = { min: 1.01, max: 120 };
t('和上一局太接近时被推开',
  E.breakConsecutive(6.15, [6.17], B) !== 6.15,
  String(E.breakConsecutive(6.15, [6.17], B)));
t('单局就破，不等三连（实测 13.4% 证明三连不够）',
  E.breakConsecutive(6.15, [6.17], B) !== 6.15);
t('差距大时不干预',
  E.breakConsecutive(20, [6.17], B) === 20);
t('历史为空时不干预',
  E.breakConsecutive(6.15, [], B) === 6.15);
t('破开后仍在边界内',
  (() => { const v = E.breakConsecutive(1.02, [1.01], B); return v >= B.min && v <= B.max; })());
t('贴近上界时不会推出边界',
  (() => { const v = E.breakConsecutive(119, [118], B); return v <= 120; })(),
  String(E.breakConsecutive(119, [118], B)));

// ---------- 7. 观感分布 ----------
console.log('\n--- 观感：mood 真的起作用 ---');
for (const mood of ['log', 'flat', 'spicy']) {
  const vals = [];
  const h2 = [];
  for (let i = 0; i < 5000; i++) {
    const d = E.decide({ seated: players, bounds, history: h2, mood });
    vals.push(d.rate);
    h2.push(d.rate);
    if (h2.length > 8) h2.shift();
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  console.log(`  ${mood.padEnd(6)} 平均 ${mean.toFixed(2)}x  中位 ${vals.slice().sort((a,b)=>a-b)[2500]}x`);
}
const meanOf = (mood) => {
  const vals = []; const h2 = [];
  for (let i = 0; i < 4000; i++) {
    const d = E.decide({ seated: players, bounds, history: h2, mood });
    vals.push(d.rate); h2.push(d.rate); if (h2.length > 8) h2.shift();
  }
  return vals.reduce((a, b) => a + b, 0) / vals.length;
};
const mLog = meanOf('log'), mFlat = meanOf('flat'), mSpicy = meanOf('spicy');
t('spicy 的平均倍率 > log', mSpicy > mLog, `spicy ${mSpicy.toFixed(2)} vs log ${mLog.toFixed(2)}`);
t('log 的平均倍率 < flat', mLog < mFlat, `log ${mLog.toFixed(2)} vs flat ${mFlat.toFixed(2)}`);

// ---------- 8. 空房间 ----------
console.log('\n--- 空房间倍率（用户要求 10x–50x，不要低倍率空转）---');
{
  const EB = { min: 1.01, max: 120 };
  const ec = { lo: 10, hi: 50 };
  const vals = [];
  for (let i = 0; i < 5000; i++) vals.push(E.emptyRoomRate(EB, ec));
  const mn = Math.min(...vals), mx = Math.max(...vals);
  t('空房倍率全部 >= 10', mn >= 9.99, String(mn));
  t('空房倍率全部 <= 50', mx <= 50.01, String(mx));
  // 对数均匀：每个倍级（10-20,20-30,30-40,40-50）出现率应大致相当
  const dec = [0, 0, 0, 0];
  for (const v of vals) {
    const i = Math.min(3, Math.floor((v - 10) / 10));
    if (i >= 0) dec[i]++;
  }
  const pct = dec.map((d) => (d / 5000 * 100).toFixed(1) + '%');
  console.log('       分布 10-20:' + pct[0] + '  20-30:' + pct[1] + '  30-40:' + pct[2] + '  40-50:' + pct[3]);
  /**
   * ⚠️ 对数均匀的【正确】期望：每一「倍级」(10→20→30→40→50) 等距，
   *   所以低段占的线性宽度最大 —— 10-20x 天然该占最多（~39%），
   *   40-50x 最少（~16%）。这不是 bug，是对数刻度的定义。
   *   理论值 log(20/10):log(30/20):log(40/30):log(50/40)
   *              = 0.693 : 0.405 : 0.288 : 0.223  → 43% : 25% : 18% : 14%
   *   所以要断言的是【各段比例符合这个比值】，不是「四段均等」。
   */
  const theory = [0.693, 0.405, 0.288, 0.223];
  const tot = theory.reduce((a, b) => a + b, 0);
  const okShape = theory.every((th, i) => {
    const want = th / tot * 100;
    const got = dec[i] / 5000 * 100;
    return Math.abs(got - want) < 3;   // 允许 3 个百分点误差
  });
  t('空房是【对数等距】分布（不是线性均等）', okShape,
    '实际 ' + pct.join(' / ') + '  理论 ' + theory.map((x) => (x / tot * 100).toFixed(1) + '%').join(' / '));
  t('空房倍率落在管理员边界内', vals.every((v) => v >= EB.min && v <= EB.max));
  // 边界裁剪：max=30 时不能超 30
  const cap = [];
  for (let i = 0; i < 500; i++) cap.push(E.emptyRoomRate({ min: 1.01, max: 30 }, ec));
  t('空房区间被 max 裁剪（max=30 → 不超 30）', Math.max(...cap) <= 30.01, String(Math.max(...cap)));
}
{
  // decide 走空房分支
  const d = E.decide({ seated: [], bounds: { min: 1.01, max: 120 }, emptyCfg: { lo: 10, hi: 50 } });
  t('decide 无人时走 empty 分支', d.source === 'empty' && d.empty === true, JSON.stringify(d));
  t('decide 无人时倍率在 10–50', d.rate >= 10 && d.rate <= 50, String(d.rate));
  t('decide 无人时 escapes 为 null', d.escapes === null);
  const d2 = E.decide({ seated: [{ thr: 3 }], bounds: { min: 1.01, max: 120 } });
  t('decide 有人时不走 empty', d2.source !== 'empty');
}

// ---------- 9. 瞬爆配额 ----------
console.log('\n--- 瞬爆配额（用户要求「100 局里 10 局瞬间爆炸」）---');
{
  const s = E.createBoomScheduler({ quota: 0.10, per: 100 });
  let hits = 0;
  for (let i = 0; i < 100; i++) if (s.next()) hits++;
  t('100 局恰好 10 局瞬爆', hits === 10, String(hits));

  const s2 = E.createBoomScheduler({ quota: 0.10, per: 100 });
  const per100 = [];
  for (let block = 0; block < 10; block++) {
    let h = 0;
    for (let i = 0; i < 100; i++) if (s2.next()) h++;
    per100.push(h);
  }
  console.log('       每 100 局实际瞬爆: ' + per100.join(' '));
  t('每个 100 局窗口都是 10 局（±1）',
    per100.every((x) => Math.abs(x - 10) <= 1), per100.join(','));

  const s3 = E.createBoomScheduler({ quota: 0.05, per: 50 });
  let h3 = 0;
  for (let i = 0; i < 500; i++) if (s3.next()) h3++;
  t('500 局按 5% → 25 局（±2）', Math.abs(h3 - 25) <= 2, String(h3));

  const s4 = E.createBoomScheduler({ quota: 0, per: 100 });
  let h4 = 0;
  for (let i = 0; i < 500; i++) if (s4.next()) h4++;
  t('quota=0 → 从不瞬爆', h4 === 0, String(h4));

  // 瞬爆间隔不能太长（不能连着 90 局都没有）
  const s5 = E.createBoomScheduler({ quota: 0.10, per: 100 });
  let maxGap = 0, gap = 0;
  for (let i = 0; i < 1000; i++) {
    if (s5.next()) { if (gap > maxGap) maxGap = gap; gap = 0; } else gap++;
  }
  t('瞬爆间隔不超过 30 局（1000 局实测）', maxGap <= 30, String(maxGap));
  console.log('       最长间隔 ' + maxGap + ' 局，stats=' + JSON.stringify(s5.stats()));

  // decide 走瞬爆分支
  const d = E.decide({ seated: [{ thr: 2 }, { thr: 5 }], bounds: { min: 1.01, max: 120 }, forceBoom: true });
  t('forceBoom → 1x（等于 min）', Math.abs(d.rate - 1.01) < 0.001, String(d.rate));
  t('forceBoom 标记 boom=true', d.boom === true && d.escapes === 0, JSON.stringify(d));
  t('forceBoom 时 source=boom', d.source === 'boom');
}

console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===\n`);
process.exit(fail ? 1 : 0);
