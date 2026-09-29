/*
 * 每日高倍活动 · 时区回归测试
 *
 * 【这个测试为什么存在】
 * 线上「每日高倍活动」配置完全正确（20x-1000x、北京时间 18-23 点、21 点），
 * 但活动【从不生效】。根因是 game-logic.js 的 activeEvent() 用
 * now.getHours() 取小时 —— 那是服务器本地时间（Etc/UTC），
 * 而活动时段按北京时间配置，整体差 8 小时，永远匹配不上。
 *
 * daily-activity.js 里早就写了这个警告（"不要再依赖服务器 TZ"），但引擎这一处漏了。
 *
 * ⚠️ 【本文件所有数据均为构造的测试数据，不是线上真实数据】
 *   - utcAt() 造的是固定 UTC 时刻（2026-09-29），不读系统当前时间，
 *     所以测试结果与「什么时候跑」无关。
 *   - 活动配置 CFG 是按线上 daily_min_rate=20 / daily_max_rate=1000 写的样例。
 *   - 北京时间 = UTC + 8：utcAt(13,30) 即北京 21:30。
 *
 * 运行：node test/daily-event-tz.js
 */
'use strict';

const { activeEvent, toMinutes, decideRate } = require('../server/game-logic');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

/** 构造固定 UTC 时刻（测试数据）。北京时间 = UTC + 8 小时。 */
function utcAt(h, m = 0) {
  return new Date(Date.UTC(2026, 8, 29, h, m, 0));
}

const CFG = {
  events_json: JSON.stringify([
    { name: '高倍狂欢 21:00–22:00', from: '21:00', to: '22:00', min: 20, max: 1000, weight: 0.9, enabled: true },
  ]),
};

console.log('\n=== 1. 北京时间 21:30 必须命中（UTC 13:30）===');
{
  const ev = activeEvent(CFG, utcAt(13, 30));
  ok(!!ev, '北京 21:30 命中活动');
  ok(ev && ev.name.includes('21:00'), `活动名: ${ev && ev.name}`);
  ok(ev && ev.rate >= 20 && ev.rate <= 1000, `倍率在 20-1000 之间: ${ev && ev.rate}`);
}

console.log('\n=== 2. 北京时间 22:00 之后不再命中（UTC 14:00）===');
{
  const ev = activeEvent(CFG, utcAt(14, 0));
  ok(!ev, '北京 22:00 已过时段，不再命中');
}

console.log('\n=== 3. 北京时间 20:00 尚未开始（UTC 12:00）===');
{
  const ev = activeEvent(CFG, utcAt(12, 0));
  ok(!ev, '北京 20:00 未到时段，不命中');
}

console.log('\n=== 4. 关键回归：旧代码用 getHours() 时会误判 ===');
{
  /**
   * 旧实现取 now.getHours() —— 那是【进程本地时区】的小时。
   * 在 Etc/UTC 服务器上，北京 21:30（= UTC 13:30）会被读成 13 点，
   * 判定「还没到 21 点」→ 活动失效。这就是线上活动从不生效的根因。
   *
   * ⚠️ 本地开发机不是 UTC 时区，所以不能用 d.getHours() 的实际返回值做断言
   *    （那会依赖「在哪台机器上跑」）。改用 getUTCHours() 显式表达 UTC 小时。
   */
  const d = utcAt(13, 30);
  const bj = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  ok(bj.getHours() === 21, `按北京时区读到 ${bj.getHours()} 点（期望 21）`);
  ok(d.getUTCHours() === 13, `同一时刻 UTC 是 ${d.getUTCHours()} 点（差 8 小时 = bug 根源）`);
  ok(!!activeEvent(CFG, d), '新实现按北京时间判定，仍能命中（修复生效）');
}

console.log('\n=== 5. 兼容旧的 "21:59" 封顶写法 ===');
{
  const old = { events_json: JSON.stringify([
    { name: '旧写法', from: '21:00', to: '21:59', min: 20, max: 1000, weight: 0.9, enabled: true },
  ]) };
  ok(!!activeEvent(old, utcAt(13, 30)), 'to="21:59" 仍能命中');
  ok(!activeEvent(old, utcAt(14, 0)), 'to="21:59" 在 22:00 后不命中');
}

console.log('\n=== 6. 24:00 结束时间不再失效 ===');
{
  const c = { events_json: JSON.stringify([
    { name: '全天', from: '18:00', to: '24:00', min: 20, max: 1000, weight: 0.9, enabled: true },
  ]) };
  ok(toMinutes('24:00') === 1440, 'toMinutes("24:00") = 1440');
  ok(!!activeEvent(c, utcAt(13, 30)), '北京 21:30 命中 to=24:00 的活动');
  ok(!!activeEvent(c, utcAt(15, 0)), '北京 23:00 仍命中 to=24:00（修好了 1440 永不命中）');
}

console.log('\n=== 7. 跨零点时段 ===');
{
  const c = { events_json: JSON.stringify([
    { name: '跨夜', from: '23:00', to: '01:00', min: 20, max: 500, weight: 0.9, enabled: true },
  ]) };
  ok(!!activeEvent(c, utcAt(15, 30)), '北京 23:30 命中跨夜活动');
  ok(!!activeEvent(c, utcAt(16, 30)), '北京 00:30（UTC 16:30）仍命中');
  ok(!activeEvent(c, utcAt(14, 0)), '北京 22:00 不命中');
}

console.log('\n=== 8. 无活动配置时返回 null ===');
{
  ok(activeEvent({}, utcAt(13, 30)) === null, '空配置返回 null');
  ok(activeEvent({ events_json: '[]' }, utcAt(13, 30)) === null, '空数组返回 null');
  ok(activeEvent({ events_json: '坏JSON' }, utcAt(13, 30)) === null, '坏 JSON 返回 null（不抛异常）');
}

console.log('\n=== 9. 活动被禁用时不命中 ===');
{
  const c = { events_json: JSON.stringify([
    { name: '关掉的', from: '21:00', to: '22:00', min: 20, max: 1000, enabled: false },
  ]) };
  ok(!activeEvent(c, utcAt(13, 30)), 'enabled:false 不命中');
}

console.log('\n=== 活动倍率不能被后台 max_rate 砍掉（2026-09-30 线上 bug）===');
{
  /**
   * 用户配了活动 min=20 max=1000，但后台 max_rate=125，
   * 结果活动期间【所有局都是 125x】—— 因为 decideRate 的活动分支
   * 也走了 clamp()，被日常护栏压平。活动配置形同虚设。
   *
   * 修法：活动只保下限，上限由活动自己的 max 决定。
   */
  const ev = { name: '高倍', from: '21:00', to: '22:00', min: 20, max: 1000, weight: 0, enabled: true };
  const cfg = {
    min_rate: 1.01, max_rate: 125, odds_mode: '6',
    events_json: JSON.stringify([ev]),
  };
  const at = new Date('2026-09-30T13:00:30Z');   // 北京 21:00:30
  const hit = activeEvent(cfg, at);
  ok(!!hit, '活动命中');
  const rates = [];
  for (let i = 0; i < 4000; i++) {
    const h = activeEvent(cfg, at);
    if (h) rates.push(decideRate(cfg, 1000, 0, h).rate);
  }
  rates.sort((a, b) => a - b);
  const med = rates[Math.floor(rates.length / 2)];
  ok(med > 300, `活动期间中位倍率 ${med}x > 300（原来恒为 125x）`);
  ok(rates[rates.length - 1] > 900, `最大能到 ${rates[rates.length - 1]}x（活动 max=1000 生效）`);
  ok(rates[0] >= 20, `最小不低于活动的 min=20（实际 ${rates[0]}）`);

  // 下限仍要保 min_rate —— 活动 min 配得比 min_rate 还低时不能更差
  const evLow = { name: '低倍', from: '21:00', to: '22:00', min: 0.5, max: 3, weight: 0, enabled: true };
  const cfgLow = { ...cfg, events_json: JSON.stringify([evLow]) };
  const loRates = [];
  for (let i = 0; i < 2000; i++) {
    const h = activeEvent(cfgLow, at);
    if (h) loRates.push(decideRate(cfgLow, 1000, 0, h).rate);
  }
  ok(Math.min(...loRates) >= 1.01, `活动 min=0.5 时仍被抬到 min_rate=1.01（实际 ${Math.min(...loRates)}）`);
}

console.log(`\n${'='.repeat(46)}`);
console.log(fail === 0 ? `✅ 全部通过：${pass}/${pass}` : `❌ ${fail} 项失败（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
