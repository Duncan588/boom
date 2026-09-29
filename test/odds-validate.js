/*
 * 后端分布表校验测试
 *
 * 2026-09-30：后台改成一张三列表（下界/上界/次数）后，
 * POST /admin/api/settings 增加了服务端校验。
 *
 * 为什么必须在服务端再校验一次：
 *   1. tableRate() 原本会【静默丢弃】非法行（max 不递增、pct<=0），
 *      用户看到「保存成功」，实际分布和填的完全不一样，没有任何提示。
 *   2. 前端校验可以被绕过（直接调接口、curl、旧页面缓存）。
 *   3. 库里存了非法数据后，每次启动都读到一份坏配置。
 *
 * 用法：node test/odds-validate.js
 */
/*
 * 赔率表样例（10/40/30/10/5/5）来自用户需求文档，非线上读出。
 * ⚠️ 【本文件所有数据均为构造的测试数据，不是线上真实数据】
 *   赔率配置、倍率、mock 响应全部是写死的样例。
 *   测试不读系统当前时间、不连生产数据库、不发真实 Discord 请求。
 *   生产真实值请查 /root/data/baodian.db 的 settings 表（仅服务器可访问）。
 */
'use strict';

const { tableRate } = require('../server/game-logic');
const { validateTable } = require('../server/odds-validate');

let pass = 0, fail = 0;
const ok = (cond, msg) => { cond ? pass++ : fail++; console.log(`  ${cond ? '✅' : '❌'} ${msg}`); };
const row = (min, max, pct, boom) => ({ min, max, pct, boom: !!boom });

console.log('='.repeat(66));
console.log('1. 用户那组配置（10/40/30/10/5/5）必须通过');
console.log('='.repeat(66));
{
  const rows = [row(1.0, 1.5, 10, true), row(1.5, 10, 40), row(10, 30, 30),
                row(30, 50, 10), row(50, 80, 5), row(80, 100, 5)];
  const r = validateTable(rows);
  ok(r.ok, `通过校验（实际报错：${r.error || '无'}）`);
}

console.log('\n' + '='.repeat(66));
console.log('2. 合计不等于 100 必须被拒');
console.log('='.repeat(66));
{
  ok(!validateTable([row(1, 2, 10), row(2, 5, 40)]).ok, '合计 50 → 拒绝');
  const r = validateTable([row(1, 2, 10), row(2, 5, 40)]);
  ok(/100/.test(r.error || ''), `错误信息提到 100（实际：${r.error}）`);
  ok(!validateTable([row(1, 2, 100.5)]).ok, '合计 100.5 → 拒绝（容忍浮点但不容忍偏差）');
  ok(validateTable([row(1, 2, 99.98), row(2, 5, 0.02)]).ok, '合计 100.00（浮点误差内）→ 通过');
}

console.log('\n' + '='.repeat(66));
console.log('3. 上界必须严格递增');
console.log('='.repeat(66));
{
  const r = validateTable([row(1, 10, 50), row(10, 10, 50)]);
  ok(!r.ok, '两行上界相同 → 拒绝');
  ok(/大于/.test(r.error || ''), `错误信息说清是「大于上一行」（实际：${r.error}）`);
  ok(!validateTable([row(1, 20, 50), row(5, 10, 50)]).ok, '第二行上界比第一行小 → 拒绝');
}

console.log('\n' + '='.repeat(66));
console.log('4. 上界必须大于下界');
console.log('='.repeat(66));
{
  const r = validateTable([row(10, 5, 100)]);
  ok(!r.ok, `上界 5 < 下界 10 → 拒绝（实际：${r.error || '通过了，BUG'}）`);
}

console.log('\n' + '='.repeat(66));
console.log('5. 空表 / 非法数字');
console.log('='.repeat(66));
{
  ok(!validateTable([]).ok, '空数组 → 拒绝');
  ok(!validateTable(null).ok, 'null → 拒绝');
  ok(!validateTable([row(1, 'abc', 100)]).ok, '上界非数字 → 拒绝');
  ok(!validateTable([row(1, 2, 'abc')]).ok, '次数非数字 → 拒绝');
  ok(!validateTable([row(1, 2, -5)]).ok, '次数为负 → 拒绝');
  ok(validateTable([row(1, 2, 0), row(2, 5, 100)]).ok, '次数 0 是合法的（该段关闭）');
}

console.log('\n' + '='.repeat(66));
console.log('6. 校验通过的配置，tableRate() 必须真的按手填下界取值');
console.log('='.repeat(66));
{
  /**
   * 【2026-09-30 语义变更】
   * 「瞬爆」不再是配置里的一个勾选项（boom 标记已删），
   * 而是「飞行时间 < 1 秒」，也就是倍率落在 1.5x 以下。
   */
  const rows = [row(1.0, 1.5, 10), row(20, 30, 90)];
  let inRange = 0, boom = 0, out = 0;
  const cfg = { odds_mode: '6', min_rate: 1.01, max_rate: 125, odds_table_json: JSON.stringify(rows) };
  for (let i = 0; i < 50000; i++) {
    const t = tableRate(cfg);
    if (t.v < 1.5) { boom++; continue; }        // 1.5x 以下 = 飞行 < 1s = 瞬爆
    if (t.v >= 20 && t.v <= 30) inRange++;
    else out++;
  }
  ok(boom > 4500 && boom < 5500, `瞬爆（<1.5x）约占 10%（实际 ${(boom / 500).toFixed(1)}%）`);
  ok(out === 0, `非瞬爆局 100% 落在手填的 20–30x（实际越界 ${out} 局）`);
}

console.log('\n' + '='.repeat(66));
console.log('7. 兼容：老配置（只有 max、没有 min）行为不变');
console.log('='.repeat(66));
{
  // 老格式：下界靠上一行 max 推导（没有 min 字段）
  const old = [{ max: 1.5, pct: 10 }, { max: 10, pct: 40 }, { max: 30, pct: 50 }];
  let lo2 = Infinity, hi2 = 0, boom = 0;
  const cfg = { odds_mode: '6', min_rate: 1.01, max_rate: 125, odds_table_json: JSON.stringify(old) };
  for (let i = 0; i < 40000; i++) {
    const t = tableRate(cfg);
    if (t.v < 1.5) { boom++; continue; }
    if (t.v <= 10) lo2 = Math.min(lo2, t.v);
    if (t.v > 10) hi2 = Math.max(hi2, t.v);
  }
  ok(boom > 3000 && boom < 5000, `瞬爆（<1.5x）约 10%（实际 ${(boom / 400).toFixed(1)}%）`);
  ok(lo2 >= 1.5, `第 2 段下界仍推导为 1.5（实际 ${lo2}）`);
  ok(hi2 > 29 && hi2 <= 30, `第 3 段上界仍为 30（实际 ${hi2}）`);
}

console.log(`\n${'='.repeat(66)}`);
console.log(fail === 0 ? `✅ 全部通过：${pass}/${pass + fail}` : `❌ ${fail} 项失败（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
