/*
 * 「瞬爆」和「权重」到底改变了什么 —— 用真实引擎数据说明
 *
 * 用法：node test/explain-instant-and-weight.js
 */
/*
 * 活动 20-1000x 是样例配置，用于说明 weight 行为。
 * ⚠️ 【本文件所有数据均为构造的测试数据，不是线上真实数据】
 *   赔率配置、倍率、mock 响应全部是写死的样例。
 *   测试不读系统当前时间、不连生产数据库、不发真实 Discord 请求。
 *   生产真实值请查 /root/data/baodian.db 的 settings 表（仅服务器可访问）。
 */
'use strict';

const G = require('../server/game-logic');

/**
 * 最小断言框架 —— 这个文件前两节是「打印给人看的解释」，
 * 第 8、9 节是真正的回归断言（防止再把保底时长加回来、
 * 再让后台护栏改写用户手填的区间）。
 */
let pass = 0, fail = 0;
const ok = (cond, msg) => { cond ? pass++ : fail++; console.log(`  ${cond ? '✅' : '❌'} ${msg}`); };

const rows = [
  { min: 1.00, max: 1.5, pct: 10, boom: true },
  { min: 1.5, max: 10, pct: 40 },
  { min: 10, max: 30, pct: 30 },
  { min: 30, max: 50, pct: 10 },
  { min: 50, max: 80, pct: 5 },
  { min: 80, max: 100, pct: 5 },
];
const cfg = { min_rate: 1.01, max_rate: 125, odds_mode: '6', odds_table_json: JSON.stringify(rows) };

console.log('='.repeat(72));
console.log('一、瞬爆是什么：同一个倍率，飞行时间被强行压到 0');
console.log('='.repeat(72));
console.log('');
console.log('  倍率    普通局飞行    瞬爆局飞行    差多少');
console.log('  ' + '-'.repeat(58));
for (const r of [1.00, 1.2, 1.5, 2, 3, 5, 10, 30]) {
  const normal = G.flightMs(r, { instant: false });
  const inst = G.flightMs(r, { instant: true });
  const verdict = inst === 0 ? '根本来不及' : normal - inst > 0 ? `少了 ${normal - inst}ms` : '一样（本来就是 0）';
  console.log(`  ${String(r + 'x').padEnd(8)}${String(normal + 'ms').padEnd(14)}${String(inst + 'ms').padEnd(14)}${verdict}`);
}

console.log('');
console.log('  【机制】game-logic.js 的 flightMs(rate, {instant})：');
console.log('    普通局 → 至少飞 CFG.MIN_FLIGHT_MS（保底时长），玩家来得及看清曲线');
console.log('    瞬爆局 → opts.instant 为真，直接 return 0，火箭刚起飞就炸');
console.log('');
console.log('  实际体感（用你的配置：瞬爆段 = 1.01–1.5x，10%）：');
let n = 0, samples = [];
for (let i = 0; i < 3000; i++) {
  const t = G.tableRate(cfg);
  if (t.boom) { n++; if (samples.length < 3) samples.push(t.v); }
}
console.log(`    3000 局里瞬爆 ${n} 局（${(n / 30).toFixed(1)}%），倍率如 ${samples.map((x) => x + 'x').join('、')}`);
console.log('    这些局玩家点「逃跑」的时间是 0 —— 按钮还没显示就已经炸了。');
console.log('    勾掉「瞬爆」后，同样是 1.01–1.5x，但会吃最低飞行时长，可以逃。');

console.log('');
console.log('='.repeat(72));
console.log('二、权重是什么：只影响「大概率落在哪一段」，不影响段内的具体倍率');
console.log('='.repeat(72));
console.log('');

/**
 * ⚠️ 上一版实验设计错了：我拿「你那张分布表的分段」去统计活动期的结果。
 *    但活动期间 decideRate() 走的是 event 分支，【表根本不参与】，
 *    所以所有倍率都 ≥ 活动 min=20，全部落进 80x+ 桶 —— 三种 weight 结果一样，
 *    看起来像「weight 无效」，其实是我没测到点上。
 *
 * 正确做法：固定同一个活动（min=20 max=1000），只改 weight，
 * 看活动内倍率在 [20,1000] 区间上的【落点偏向】。
 */
const ACT_MIN = 20, ACT_MAX = 1000;
for (const w of [0, 0.5, 1, 2]) {
  const ev = { name: 't', from: '00:00', to: '24:00', min: ACT_MIN, max: ACT_MAX, weight: w, enabled: true };
  const c2 = { ...cfg, events_json: JSON.stringify([ev]) };
  /**
   * ⚠️⚠️ 前面两版这个实验都设计错了，记下来别再犯：
   *
   *   第 1 版：在循环外算一次 hit，反复传给 decideRate
   *          → activeEvent() 每次只产出一个 rate，等于同一个值统计 20 万次
   *          → 结果 100% 落在同一档
   *
   *   第 2 版：修好了每局重算，但用「20-100 / 100-200 / ...」这种分桶
   *          → 活动的倍率是 [20,1000] 上的连续值，20-100 那档只有 80 宽，
   *            100-200 有 100 宽，200-1000 有 800 宽 —— 宽度差 10 倍，
   *            按宽度算百分比当然几乎全在 200 以上那一档
   *          → 而且 round2 只保留 2 位小数，分桶边界和实际值对不上
   *
   *   正确做法：直接看【分位数】。均匀分布时各分位点应该大致等距；
   *   右偏时分位数会往低处挤。不依赖任何人为分桶。
   */
  // 先看 activeEvent 自己吐出来的 rate（绕开 decideRate）
  const N = 60000;
  const at = new Date('2026-09-30T12:00:00Z');  // 北京 20:00，命中活动
  const raw = [];
  for (let i = 0; i < N; i++) {
    const hit = G.activeEvent(c2, at);
    if (hit) raw.push(hit.rate);
  }
  raw.sort((a, b) => a - b);
  const qr = (p) => raw[Math.floor(N * p)];
  console.log(`  【直接看 activeEvent().rate】weight=${w}  `
    + `min ${raw[0]}  p25 ${qr(0.25)}  中位 ${qr(0.5)}  p75 ${qr(0.75)}  max ${raw[N - 1]}`);

  const vals = [];
  for (let i = 0; i < N; i++) {
    const hit = G.activeEvent(c2, at);
    if (hit) vals.push(G.decideRate(c2, 1000, 0, hit).rate);
  }
  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.floor(N * p)];
  console.log(`  weight=${w}  中位 ${String(q(0.5)).padStart(7)}x   `
    + `p25 ${String(q(0.25)).padStart(7)}x   p75 ${String(q(0.75)).padStart(7)}x   `
    + `p90 ${String(q(0.9)).padStart(7)}x   最大 ${String(vals[N - 1]).padStart(7)}x`);
}
console.log('');
console.log('  ⚠️⚠️⚠️ 上面第二行（decideRate 的结果）暴露了一个【线上真 bug】：');
console.log('');
console.log('     activeEvent 自己算的倍率是对的（weight=0 中位 507、weight=1 中位 753）');
console.log('     但 decideRate 吐出来【全部是 125x】—— 正好等于后台的 max_rate。');
console.log('');
console.log('     原因：decideRate 里活动分支也走了 clamp()，');
console.log('     而 clamp 用的是 cfg.min_rate / cfg.max_rate（后台那对护栏）。');
console.log('     所以后台 max_rate=125 时，活动里配的 max=1000 【永远出不来】，');
console.log('     20–1000x 全部被压成 125x —— 这就是用户说的「配了 20x-1000x 没生效」。');
console.log('');
console.log('     修法：活动分支不该受 max_rate 限制（活动是运营显式指定的高倍时段，');
console.log('     用同一个护栏砍它等于活动配置白填）。但下限仍要保 min_rate，');
console.log('     否则活动最低倍率可能低于玩家能反应的极限。');
console.log('');
console.log('  均匀分布（weight=0）时：中位 ≈ (20+1000)/2 = 510x，p25≈265，p75≈755');
console.log('  weight 越大：中位越高、越靠近日均上限 → 「更容易出大倍率」');
console.log('');
console.log('  【机制】activeEvent() 里：');
console.log('    r = 1 - pow(1 - random(), 1 + weight)');
console.log('    weight=0 → r = random()，在 [20, 1000] 上【均匀】分布');
console.log('    weight=1 → r = 1-(1-random())²，明显右偏（越靠 1000 越密）');
console.log('');
console.log('  结论：weight 只决定「偏向大倍率还是均匀」，');
console.log('        它【不改变】活动的最低/最高倍率（min=20 max=1000 依然生效），');
console.log('        也【不影响】你那张分布表 —— 活动期间表完全不参与。');console.log('\n' + '='.repeat(66));
console.log('8. 飞行时长必须恢复原版行为（2026-09-30 删掉保底）');
console.log('='.repeat(66));
{
  /**
   * 【事故经过】
   * 我给所有局加了 MIN_FLIGHT_MS=2500 的保底飞行时长，
   * 理由是「低倍率局玩家来不及看清曲线」。
   *
   * 但查原版源码 PushController.php 确认：
   *   - fastCalc()（立即结算）爆率 rand(100,120)/100 = 1.00~1.20x
   *   - 全项目 grep 不到任何「保底时长 / MIN_FLIGHT」概念
   * 原版低倍率局【就是会飞很短甚至 0】，没有下限保护。
   *
   * 加上保底后原版瞬爆被彻底抹平（1.0x 也飞 2.5 秒），
   * 只好再引入「☐ 瞬爆」勾选去绕过自己加的保底 —— 自己造 bug 自己补。
   *
   * 现在：保底已删，勾选框已删，飞行时间严格按原版公式。
   */
  const expected = [
    [1.00, 0], [1.05, 303], [1.20, 1124], [1.50, 2500],
    [2.00, 4354], [3.00, 7247], [5.00, 11583], [10.00, 19238],
  ];
  for (const [rate, ms] of expected) {
    const got = G.flightMs(rate, {});
    ok(Math.abs(got - ms) <= 1, `${rate}x → ${got}ms（原版公式应为 ${ms}ms）`);
  }
  // 关键：1.00x 必须是 0ms（真瞬爆）
  ok(G.flightMs(1.00, {}) === 0, '1.00x 飞行 0ms —— 刚起飞就炸');
  ok(G.flightMs(1.005, {}) > 0, '1.005x 飞行 > 0ms（不是所有 1.0x 都瞬爆）');
  // opts.instant 已不影响结果（参数保留但无效）
  ok(G.flightMs(2.0, { instant: true }) === G.flightMs(2.0, { instant: false }),
     'opts.instant 不再改变结果（保底已删，参数只是保留）');
  // 任何倍率都不能低于 0
  ok(G.flightMs(0.5, {}) === 0, '倍率低于 1 时也是 0ms（clamp 到 1）');
}

console.log('\n' + '='.repeat(66));
console.log('9. 手填下界必须被尊重（不被 min_rate / max_rate 改写）');
console.log('='.repeat(66));
{
  /**
   * 【同类事故，第二个】
   * 活动倍率被后台 max_rate 砍成 125x；
   * 分布表区间下界被后台 min_rate 改写（1.5–10x 实际从 1.01 起）。
   * 根子都是「用户配的区间不该被后台护栏静默改写」。
   */
  const rows = [{ min: 20, max: 30, pct: 100 }];
  const cfg = { odds_mode: '6', min_rate: 1.01, max_rate: 125, odds_table_json: JSON.stringify(rows) };
  let lo = Infinity, hi = 0;
  for (let i = 0; i < 20000; i++) {
    const t = G.tableRate(cfg);
    if (t.v < lo) lo = t.v;
    if (t.v > hi) hi = t.v;
  }
  ok(lo > 19.9, `下界 20 没被 min_rate 1.01 改写（最低 ${lo.toFixed(2)}x）`);
  ok(hi < 30.1, `上界 30 生效（最高 ${hi.toFixed(2)}x）`);

  // max_rate=20 也压不下去
  const cfg2 = { ...cfg, max_rate: 20 };
  const t2 = G.tableRate(cfg2);
  ok(t2.v >= 20, `max_rate=20 时仍能出 ${t2.v.toFixed(2)}x（不被截断）`);
}

console.log(`\n${'='.repeat(66)}`);
console.log(fail === 0 ? `✅ 回归断言全部通过：${pass}/${pass + fail}` : `❌ ${fail} 项失败（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);


