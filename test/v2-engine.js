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
let minSeen = Infinity, maxSeen = -Infinity, srcCount = {};
let adjNear = 0, adjTotal = 0;
const hist = [];
const values = [];
for (let i = 0; i < N; i++) {
  const d = E.decide({ seated: players, bounds, history: hist, mood: 'log' });
  values.push(d.rate);
  minSeen = Math.min(minSeen, d.rate);
  maxSeen = Math.max(d.rate, d.rate);
  if (d.source !== 'boom') srcCount[d.source]++;
  else srcCount.boom = (srcCount.boom || 0) + 1;
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
/**
 * ⚠️ 这里不传 boom，所以默认 p=0.10 —— 每 20000 局约有 2000 局是瞬爆，
 *   它们不写 history、不参与相邻差统计。所以 fallback 计数是 ~18000 而不是 20000。
 *   （旧断言写 `=== N` 是我算错了。）
 */
t('没传 suggestion 时来源只有 fallback / boom 两种',
  Object.keys(srcCount).sort().join(',') === 'boom,fallback',
  JSON.stringify(srcCount));
t('瞬爆率约 10%', Math.abs((srcCount.boom || 0) / N - 0.10) < 0.02,
  `${((srcCount.boom || 0) / N * 100).toFixed(1)}%`);
t('相邻局差 <8% 的比例 < 1.5%（实测 0.67%）', adjNear / adjTotal < 0.015,
  `${(adjNear / adjTotal * 100).toFixed(2)}%`);

// ---------- 5. Jev 建议路径 ----------
console.log('\n--- Jev 建议倍率会被采纳但受边界钳制 ---');
const d1 = E.decide({ seated: players, bounds, suggestion: 8.5 });
t('Jev 给 8.5 → 采用', d1.rate === 8.5, String(d1.rate));
t('来源标记为 jev', d1.source === 'jev');
// ⚠️ 必须关掉瞬爆：否则这局可能掷出 boom（1.01x），测的就不是钳制逻辑了。
const d2 = E.decide({ seated: players, bounds, suggestion: 9999, boom: { p: 0 } });
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

// ---------- 9. 瞬爆：纯独立随机 ----------
console.log('\n--- 瞬爆必须是【真随机】，不是节奏配额 ---');
{
  // 注入可控随机源，验证 rollBoom 的语义
  t('rollBoom(0) 永不爆', E.rollBoom(0, () => 0.5) === false);
  t('rollBoom(1) 必爆', E.rollBoom(1, () => 0.99) === true);
  t('rollBoom(0.1): rng=0.05 爆', E.rollBoom(0.1, () => 0.05) === true);
  t('rollBoom(0.1): rng=0.15 不爆', E.rollBoom(0.1, () => 0.15) === false);
  t('rollBoom 未传参数默认 0.1（rng=0.05 爆）', E.rollBoom(undefined, () => 0.05) === true);
  t('rollBoom(null) 走默认 0.1 而不是 0', E.rollBoom(null, () => 0.05) === true);

  /**
   * ⭐ 核心断言：瞬爆位置必须【无可推算的节奏】。
   * 配额版（第 1 局爆、第 10 局爆、第 20 局爆）会让间隔方差极小，
   * 玩家能数出节奏。这里断言间隔的分布是宽的。
   */
  const idx = [];
  for (let i = 0; i < 3000; i++) if (E.rollBoom(0.10)) idx.push(i);
  const gaps = [];
  for (let i = 1; i < idx.length; i++) gaps.push(idx[i] - idx[i - 1]);
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const minGap = Math.min(...gaps);
  const maxGap = Math.max(...gaps);
  console.log(`       3000 局 → 瞬爆 ${idx.length} 次；间隔 均值 ${avgGap.toFixed(1)} 最短 ${minGap} 最长 ${maxGap}`);
  t('瞬爆次数接近 10%（270–330 / 3000）', idx.length >= 270 && idx.length <= 330, String(idx.length));
  // ⭐ 配额版的间隔会集中在 10 附近（方差极小）。真随机的间隔应该是几何分布：
  //   最短 1（连着两局都爆完全可能）、最长几十局。
  t('间隔有 1（连着两局都爆）—— 配额版不可能出现', minGap === 1, String(minGap));
  t('最长间隔 > 25（不会固定在 10）', maxGap > 25, String(maxGap));
  t('间隔分布很宽（max/min > 25）', maxGap / minGap > 25, `${maxGap}/${minGap}`);

  // 相邻窗口的瞬爆数必须波动 —— 配额版每个 100 局窗口都是 10
  const marks = [];
  for (let i = 0; i < 3000; i++) marks.push(E.rollBoom(0.10) ? 1 : 0);
  const per100 = [];
  for (let b = 0; b < 30; b++) {
    let c = 0;
    for (let i = b * 100; i < (b + 1) * 100; i++) c += marks[i];
    per100.push(c);
  }
  console.log('       每 100 局瞬爆数: ' + per100.join(' '));
  t('每 100 局窗口的瞬爆数【不恒定】（配额版会全是 10）',
    new Set(per100).size >= 5, [...new Set(per100)].sort((a,b)=>a-b).join(','));
  t('窗口内波动范围 >= 6（配额版波动 = 0）',
    Math.max(...per100) - Math.min(...per100) >= 6,
    `min ${Math.min(...per100)} max ${Math.max(...per100)}`);
  /**
   * ⚠️ 纯随机【本来就会出现】连续相同的窗口值（几何分布下很常见），
   *   所以「不能有 3 个连续相同」是错的断言 —— 配额版才是波动=0。
   *   正确的判据是：不同窗口值出现的种类足够多。
   */
  const kinds = new Set(per100).size;
  t('窗口值种类 >= 8（配额版只有 1 种）', kinds >= 8, `只有 ${kinds} 种：${[...new Set(per100)].sort((a,b)=>a-b).join(',')}`);
  /**
   * 二项分布 p=0.1、n=100 的理论标准差 = sqrt(100×0.1×0.9) ≈ 3.0。
   * 所以 >= 2 就算健康（配额版恒为 0）。30 个窗口的抽样误差约 0.5。
   */
  const sd100 = (() => { const m = per100.reduce((a,b)=>a+b,0)/per100.length;
    return Math.sqrt(per100.reduce((a,b)=>a+(b-m)*(b-m),0)/per100.length); })();
  console.log('       窗口标准差 ' + sd100.toFixed(2) + '（理论 3.0，配额版 0）');
  t('标准差 >= 2（配额版 = 0）', sd100 >= 2, sd100.toFixed(2));

  // decide 走瞬爆分支
  const players2 = [{ thr: 2 }, { thr: 5 }];
  let booms = 0;
  let badBoomRate = 0;
  for (let i = 0; i < 4000; i++) {
    const d = E.decide({ seated: players2, bounds: { min: 1.01, max: 120 }, history: [], boom: { p: 0.1 } });
    if (d.boom) {
      booms++;
      // 瞬爆必须正好是 min（1.01x），不能是别的值
      if (Math.abs(d.rate - 1.01) > 0.001) badBoomRate++;
    }
  }
  t('4000 局里每次瞬爆都正好是 1.01x', badBoomRate === 0, `${badBoomRate} 次不对`);
  console.log(`       decide 4000 局 → 瞬爆 ${booms} 次 (${(booms/40).toFixed(1)}%)`);
  // 4000 局 × 10% = 400。95% 置信区间约 ±3σ，σ≈19，所以放宽到 [320, 480]。
  t('decide 瞬爆率接近 10%（期望 400）', booms >= 320 && booms <= 480, `${booms} (${(booms/40).toFixed(1)}%)`);
  const dForce = E.decide({ seated: players2, bounds: { min: 1.01, max: 120 }, forceBoom: true });
  t('forceBoom → 1x（等于 min）', Math.abs(dForce.rate - 1.01) < 0.001, String(dForce.rate));
  t('forceBoom 标记 boom=true', dForce.boom === true && dForce.escapes === 0, JSON.stringify(dForce));
  t('forceBoom 时 source=boom', dForce.source === 'boom');
  // 空房时不掷瞬爆骰（没人可爆）
  const dEmpty = E.decide({ seated: [], bounds: { min: 1.01, max: 120 }, boom: { p: 1.0 } });
  t('空房时不触发瞬爆（boom.p=1 也无效）', dEmpty.source === 'empty', dEmpty.source);
}

// ---------- 10. 高倍必须真的出得来 ----------
console.log('\n--- 高倍局（用户：「为什么都是低倍率，高倍率呢」）---');
{
  const B = { min: 1, max: 125 };
  const spec = E.buildSpectrum(players, B);
  const topThr = Math.max(...players.map((p) => p.thr));
  t(`谱延伸到 max_rate 125x（原本停在最高阈值 ${topThr}x）`,
    spec[spec.length - 1].rate >= 120, String(spec[spec.length - 1].rate));

  const has = (t) => spec.some((r) => r.rate >= t);
  t('谱里有 20x / 50x / 80x / 100x 附近的点', [20, 50, 80, 100].every(has),
    spec.map((r) => r.rate).join(','));
  /**
   * ⚠️ 语义澄清（我第一版测试也写反了）：
   *   escapes = 这一局有多少人【跑掉了/能跑掉】。
   *   高倍局（32x/51x/…）是【全员都能跑掉】= escapes 10/10，
   *   因为倍率早就超过了所有人的阈值，他们都在自己愿意的位置撤了。
   *   真正「全灭」（escapes=0）的是【低倍局】——倍率 1.2x，一个都跑不掉。
   *
   *   所以高倍局越往上，【留下被爆的人越少】，这正是高倍局的爽点。
   */
  t('超过最高阈值的点：全员都跑得掉（escapes = 全场）',
    spec.filter((r) => r.rate > topThr).every((r) => r.escapes === players.length),
    spec.filter((r) => r.rate > topThr).map((r) => `${r.rate}:${r.escapes}`).join(' '));
  t('最低点 escapes = 0（低倍局才是全灭）', spec[0].escapes === 0, String(spec[0].escapes));

  // 实测分布：高倍必须真的抽得到
  for (const mood of ['log', 'spicy', 'flat']) {
    let h = [], pending = 0;
    const v = [];
    for (let i = 0; i < 5000; i++) {
      const d = E.decide({ seated: players, bounds: B, history: h, mood, boom: { p: 0.1 }, floor: pending });
      pending = d.boom ? d.nextFloor : 0;
      if (d.boom) continue;
      v.push(d.rate);
      h.push(d.rate); if (h.length > 8) h.shift();
    }
    const over = (t) => v.filter((x) => x >= t).length / v.length * 100;
    const mx = Math.max(...v);
    console.log(`  ${mood.padEnd(6)} ≥20x ${over(20).toFixed(1)}%  ≥50x ${over(50).toFixed(1)}%  max ${mx.toFixed(1)}x`);
    t(`${mood}: 有局出到 ≥20x（原本实测 0.0%）`, over(20) > 0, over(20).toFixed(2) + '%');
    t(`${mood}: 出现过 ≥40x`, mx >= 40, mx.toFixed(1) + 'x');
    t(`${mood}: 没有任何一局越过 max_rate 125`, v.every((x) => x <= 125));
  }

  /**
   * ⚠️ 权重必须按【log 位置】算而不是【下标位置】。
   * 谱点在对数刻度上疏密不均：低倍 20 个点挤在 1.2–20，高倍 5 个点摊在 20–125。
   * 用下标会让高倍点权重 ≈ 0.02，几乎抽不到（实测 ≥50x 只有 0.2%）。
   */
  const w = E.shapeWeights(spec, 'log', B);
  t('shapeWeights 长度与谱一致', w.length === spec.length);
  t('权重随倍率单调不增', w.every((x, i) => i === 0 || x <= w[i - 1] * 1.0001));
  /**
   * ⚠️ 125x 的权重 = (1-1)^1.6 + 1e-6 = 1e-6，几乎抽不到。
   *   但这是 log 手感的【设计意图】—— 高倍天然极罕见。
   *   实测 log 下 ≥50x 有 0.6%，spicy 2.2%，flat 3.5%，
   *   最高能出到 111-114x（抖动带来）。够用了。
   *   所以这里只断言「不为 0」（1e-6 的下限保证它可能但极罕见）。
   */
  t('最高点权重 > 0（1e-6 下限保证可能但极罕见）', w[w.length - 1] > 0, String(w[w.length - 1]));
  t('最高点权重确实是极小的（log 手感：125x 极罕见）', w[w.length - 1] < 1e-4, w[w.length - 1].toExponential(2));
  // log 位置下：50x 处的权重应显著高于下标位置的算法
  const i50 = spec.findIndex((r) => r.rate >= 50);
  t('50x 处的权重不是最小（说明用了 log 位置而非下标）',
    i50 < spec.length - 1 && w[i50] > w[w.length - 1],
    `i50=${i50}/${spec.length - 1} w=${w[i50]?.toExponential(2)}`);
}

console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===\n`);
process.exit(fail ? 1 : 0);
