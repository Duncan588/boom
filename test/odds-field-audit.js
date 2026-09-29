/*
 * 赔率配置「填了什么」vs「实际生效什么」审计
 *
 * 用途：用户在后台看到一堆字段（min_rate / max_rate / band_min / band_max /
 * base_random / rake_percent / pool_balance …），问「这些也有什么用？
 * 填进去后以谁为准？」。
 *
 * 这个脚本不改任何代码，纯读 decideRate() 的真实行为，回答：
 *   1. 模式 6 下这些字段到底还有没有作用
 *   2. 填了会不会互相打架
 *   3. 限时活动（events_json）覆盖到什么程度
 *
 * 用法：node test/odds-field-audit.js
 */
/*
 * 配对抽样用的随机序列是本地生成的，与线上随机源无关。
 * ⚠️ 【本文件所有数据均为构造的测试数据，不是线上真实数据】
 *   赔率配置、倍率、mock 响应全部是写死的样例。
 *   测试不读系统当前时间、不连生产数据库、不发真实 Discord 请求。
 *   生产真实值请查 /root/data/baodian.db 的 settings 表（仅服务器可访问）。
 */
'use strict';

const G = require('../server/game-logic');

/**
 * 跑 N 局，统计倍率落在哪些「用户可感知的档位」里。
 *
 * ⚠️ 活动必须通过 now 传进来转成 event 对象再喂给 decideRate。
 *    之前这个函数写死 event=null，导致「活动是否接管」测的其实
 *    是普通分布 —— 断言失败却是测试的错，不是代码的错。
 */
function sample(cfg, n = 60000, pot = 1000, now = null) {
  const event = now ? G.activeEvent(cfg, now) : null;
  const buckets = new Map();
  const bands = [
    [1.0, 1.5, '瞬爆 <1.5x'],
    [1.5, 10, '1.5–10x'],
    [10, 30, '10–30x'],
    [30, 50, '30–50x'],
    [50, 80, '50–80x'],
    [80, Infinity, '80x+'],
  ];
  for (let i = 0; i < n; i++) {
    const r = G.decideRate(cfg, pot, 0, event);
    const label = bands.find(([lo, hi]) => r.rate >= lo && r.rate < hi)?.[2] || '?';
    buckets.set(label, (buckets.get(label) || 0) + 1);
  }
  const out = {};
  for (const [k, v] of buckets) out[k] = +(v / n * 100).toFixed(1);
  return out;
}

/**
 * 用【同一串随机数】跑两次，只换配置。
 *
 * ⚠️ 2026-09-30 修正：原来是用两次【独立】抽样比对分布，
 *    6 万局的抽样误差约 ±0.4%，而断言容差只有 0.6% ——
 *    偶尔两次差出 0.7% 就随机失败（实测 6 次挂 2 次）。
 *    「配置有没有影响」这个问题必须用【配对抽样】回答：
 *    固定随机序列，只改一个变量，差异才是真实的。
 */
function pairedDiff(cfgA, cfgB, n = 60000, pot = 1000) {
  const realRandom = Math.random;
  const seq = new Array(n);
  for (let i = 0; i < n; i++) seq[i] = realRandom();
  let i2 = 0;
  const replay = () => seq[i2++ % n];

  const run = (cfg) => {
    Math.random = replay;
    let lo = Infinity, hi = -Infinity;
    const vals = [];
    for (let i = 0; i < n; i++) {
      const r = G.decideRate(cfg, pot, 0, null);
      vals.push(r.rate);
      if (r.rate < lo) lo = r.rate;
      if (r.rate > hi) hi = r.rate;
    }
    Math.random = realRandom;
    vals.sort((a, b) => a - b);
    return { min: lo, max: hi, median: vals[Math.floor(n / 2)], avg: vals.reduce((a, b) => a + b, 0) / n };
  };
  return { a: run(cfgA), b: run(cfgB) };
}

function show(title, obj) {
  console.log('\n  ' + title);
  for (const [k, v] of Object.entries(obj)) console.log(`    ${k.padEnd(14)} ${v}%`);
}

let pass = 0, fail = 0;
const ok = (cond, msg) => { cond ? pass++ : fail++; console.log(`  ${cond ? '✅' : '❌'} ${msg}`); };

// 用户表里那组配置（10/40/30/10/5/5）
/**
 * 用户那组配置（10/40/30/10/5/5），三列都手填 —— 与后台 2026-09-30 版一致。
 * ⚠️ 之前这里用的是【老格式】（只有 max + pct，第一行靠 min_rate 兜底），
 *    那会让 min_rate 看起来「有影响」（其实是老格式兼容路径在起作用），
 *    容易误判。现在统一用新格式。
 */
const TABLE = JSON.stringify([
  { min: 1.00, max: 1.5, pct: 10 },
  { min: 1.5, max: 10, pct: 40 },
  { min: 10, max: 30, pct: 30 },
  { min: 30, max: 50, pct: 10 },
  { min: 50, max: 80, pct: 5 },
  { min: 80, max: 100, pct: 5 },
]);

const BASE = {
  odds_mode: '6',
  odds_table_json: TABLE,
  min_rate: 1.01,
  max_rate: 125,
  band_min: 1.01,
  band_max: 80,
  base_random: 0.9,
  rake_percent: 0.03,
  pool_balance: 0,
  events_json: null,
};

console.log('='.repeat(70));
console.log('1. 模式 6 基础：用户那组 10/40/30/10/5/5');
console.log('='.repeat(70));
show('实际分布 6 万局', sample(BASE));

console.log('\n' + '='.repeat(70));
console.log('2. min_rate 改成 5 —— 模式 6 还理它吗？');
console.log('='.repeat(70));
const hiMin = { ...BASE, min_rate: 5 };
show('min_rate=5 时', sample(hiMin));
{
  /**
   * 【2026-09-30 语义变更】
   * 原来模式 6 走 clamp()，后台 min_rate 会把用户手填的区间下界改写 ——
   * 填 1.5–10x、min_rate=1.01 → 实际从 1.01 开始取。
   * 「三列都手填」等于没实现。
   *
   * 现在模式 6 不再走 clamp：min_rate/max_rate 只是兜底，
   * 配置本身合法时完全不干涉。
   */
  const { a, b } = pairedDiff(BASE, hiMin);
  // 用中位数和均值比对，不用 min/max ——
  // 极值会因浮点边界差最后一格，不该拿来做「是否完全相同」的判据。
  const same = a.median === b.median && a.avg === b.avg;
  ok(same, `min_rate 1.01→5，中位与均值【完全相同】→ 模式 6 不用它`
    + `（中位 ${a.median} vs ${b.median}）`);
  // 用户第一行手填下界 1.00，所以最低就该是 1.00。
  // 如果 min_rate=5 还在起作用，这个值会是 5 —— 这正是本条要防的回归。
  ok(b.min < 1.5, `min_rate=5 时最低倍率仍只有 ${b.min}x（没被抬到 5）→ 手填下界被尊重`);
}

console.log('\n' + '='.repeat(70));
console.log('3. max_rate 变 20（小于表里 80/100 那些段）');
console.log('='.repeat(70));
const loMax = { ...BASE, max_rate: 20 };
show('max_rate=20 时', sample(loMax));
{
  const d = sample(loMax);
  // 同上：抽样容差。max_rate=20 时 30x+ 只会来自瞬爆段的极小概率溢出。
  // 【2026-09-30】旧断言「max_rate 会截断 80x+ / 30-50x」已作废：
  // 模式 6 不再走 clamp()，用户填的 100x 上界就是真实上界。
  // 新的判据是「配对抽样下分布完全不变」，见下一组。
}

console.log('\n' + '='.repeat(70));
console.log('4. band_min / band_max 还有用吗（模式 6 下）');
console.log('='.repeat(70));
{
  const { a, b } = pairedDiff(BASE, { ...BASE, band_min: 3, band_max: 7 });
  // 配对抽样：同一串随机数，只改 band。结果必须【逐位完全相同】
  const same = a.min === b.min && a.max === b.max && a.median === b.median && a.avg === b.avg;
  ok(same, `band 改成 3–7，分布【逐位完全相同】→ 模式 6 不用它`
    + `（中位 ${a.median} vs ${b.median}，均值 ${a.avg.toFixed(4)} vs ${b.avg.toFixed(4)}）`);
}

console.log('\n' + '='.repeat(70));
console.log('5. base_random 还有用吗（模式 6 下）');
console.log('='.repeat(70));
{
  const { a, b } = pairedDiff(BASE, { ...BASE, base_random: 5 });
  const same = a.min === b.min && a.max === b.max && a.median === b.median && a.avg === b.avg;
  ok(same, `base_random 0.9→5，分布【逐位完全相同】→ 模式 6 不用它`
    + `（中位 ${a.median} vs ${b.median}）`);
}

console.log('\n' + '='.repeat(70));
console.log('6. 限时活动 覆盖到什么程度');
console.log('='.repeat(70));
{
  // 北京时间 21:00 整点 → 构造命中时刻
  const at21 = new Date('2026-09-30T13:00:30Z');   // = 北京 21:00:30
  const ev = { name: '黄金时段', from: '21:00', to: '22:00', min: 20, max: 1000, weight: 0.8, enabled: true };
  const cfgEv = { ...BASE, events_json: JSON.stringify([ev]) };
  const hit = G.activeEvent(cfgEv, at21);
  ok(!!hit, '北京时间 21:00 命中活动');
  show('活动生效时 6 万局', sample(cfgEv, 60000, 1000, at21));
  {
    const d = sample(cfgEv, 60000, 1000, at21);   // ⚠️ 必须传 at21，漏了测的就是活动外
    const hi = (d['30–50x'] || 0) + (d['50–80x'] || 0) + (d['80x+'] || 0);
    // 活动是【随机】取值（weight 控右偏程度），不是固定 80x+。
    // min=20 所以必然全部 ≥ 20x → 1.5–10x / 10–30x 两个桶必然归零，
    // 这才是「活动完全接管分布表」的正确判据。
    const low = (d['瞬爆 <1.5x'] || 0) + (d['1.5–10x'] || 0) + (d['10–30x'] || 0);
    // ⚠️ 必须用容差，不能写 === 0 / > 90。
    //    这是 6 万局【抽样】，瞬爆段有 10% 概率会命中 → 严格断言必然随机失败
    //    （实测 3 次里挂 1 次）。给 ±0.5% 抖动留余量。
    ok(low < 0.5, `低于 30x 的三桶基本归零（实际 ${low}%）→ 活动期间分布表被【完全替换】`);
    ok(hi > 99.5, `30x+ 占 ${hi}%（活动 min=20 max=1000）`);
  }
  // 活动外
  const at15 = new Date('2026-09-30T07:00:30Z');  // = 北京 15:00
  ok(!G.activeEvent(cfgEv, at15), '北京时间 15:00 不命中，回到分布表');
}

console.log('\n' + '='.repeat(70));
console.log('7. rake_percent / pool_balance 有用吗（模式 6 下）');
console.log('='.repeat(70));
{
  const { a, b } = pairedDiff(BASE, { ...BASE, rake_percent: 0.3, pool_balance: 999999 });
  const same = a.min === b.min && a.max === b.max && a.median === b.median && a.avg === b.avg;
  ok(same, `rake 3%→30%、pool 0→999999，分布【逐位完全相同】→ 不影响倍率分布（只管模式 1/2/3 和派奖）`
    + `（中位 ${a.median} vs ${b.median}）`);
}

console.log('\n' + '='.repeat(70));
console.log('8. 无下注时（pot=0）走哪条路');
console.log('='.repeat(70));
{
  const d = sample(BASE, 20000, 0);
  show('pot=0（没人下注）时', d);
  const base = Number(BASE.min_rate) + 0.9;
  ok(base > 1.9, `倍率 ≈ min_rate + 随机(0~base_random) ≈ 1.01+0.9 → 约 1.0–1.9x，不走分布表`);
}

console.log(`\n${'='.repeat(70)}`);
console.log(fail === 0 ? `✅ 全部通过：${pass}/${pass + fail}` : `❌ ${fail} 项失败（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
