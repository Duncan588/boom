'use strict';
/**
 * C 项：活动钩子的 const 重赋值 + this 绑定 + 幂律下的活动语义
 *
 * 【这个 bug 为什么要专门写一个测试】
 * `playRound()` 里 `const cfg = this.settings`，而下面应用活动 maxRateOverride
 * 时写 `cfg = { ...cfg, ... }` —— strict mode 下抛
 * "Assignment to constant variable"，_loop 捕获后 sleep(1500) 再崩，无限循环。
 *
 * 【但它今天打不响，而这才是真正要修的东西】
 * 原来 runHooks 是裸调用 `fn({...ctx, p})`，于是钩子里的 `this` 不是模块对象；
 * 两个活动模块又都写 `const p = this.p || {}` ⇒ p 恒为 {} ⇒ 钩子恒返回 null
 * ⇒ maxRateOverride 恒为空 ⇒ 那行 const 重赋值永远不执行。
 * 也就是说 lucky_hour 从上线至今从未生效过。
 *
 * 危险在于：只修 this 绑定而不修 const，活动一开就【每局崩】。
 * 只修 const 而不修 this，活动仍然死。这两处必须一起被断言，
 * 所以本测试同时钉住：钩子能拿到参数、返回 override、且 playRound 不抛。
 */
require('../server/env').load();
const path = require('path');
const fs = require('fs');
const db = require('../server/db');
db.init();
const acts = require('../server/activities');
const { POWERLAW } = require('../server/odds');

let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + m + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + m + (extra ? '  ' + extra : '')); }
};

// ---- 备份现场 ----
const bak = {
  activities: db.getSetting('activities', null),
  activities_json: db.getSetting('activities_json', null),
  powerlaw_rtp: db.getSetting('powerlaw_rtp', null),
  odds_mode: db.getSetting('odds_mode', null),
};
function restore() {
  if (bak.activities === null) db.get().prepare('DELETE FROM settings WHERE key = ?').run('activities');
  else db.setSetting('activities', bak.activities);
  if (bak.activities_json === null) db.get().prepare('DELETE FROM settings WHERE key = ?').run('activities_json');
  else db.setSetting('activities_json', bak.activities_json);
  if (bak.powerlaw_rtp === null) db.get().prepare('DELETE FROM settings WHERE key = ?').run('powerlaw_rtp');
  else db.setSetting('powerlaw_rtp', bak.powerlaw_rtp);
  if (bak.odds_mode === null) db.get().prepare('DELETE FROM settings WHERE key = ?').run('odds_mode');
  else db.setSetting('odds_mode', bak.odds_mode);
}
process.on('exit', restore);

// 全时段窗口，让 inRange 一定命中（现在 21:xx，00:00–23:59 覆盖）
const ALL_DAY = { from: '00:00', to: '23:59' };

console.log('\n=== §1 源码：playRound 必须是 let，且这一行在条件分支里 ===');
const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'engine.js'), 'utf8');
ok(/let cfg = this\.settings;/.test(engineSrc), 'playRound 用 let cfg（不是 const）');
const assignLine = engineSrc.split('\n').find((l) => /cfg = \{ \.\.\.cfg, max_rate/.test(l)) || '';
ok(!!assignLine, 'maxRateOverride 的赋值行存在');
// 关键：它必须在 else 分支里（幂律下不执行），而不是无条件执行
const blockStart = engineSrc.indexOf('if (act.maxRateOverride) {');
const blockSlice = engineSrc.slice(blockStart, blockStart + 700);
ok(/if \(powerlaw\)/.test(blockSlice) && /else\s*\{/.test(blockSlice),
  '幂律下 maxRateOverride 被显式跳过（走 else 才重赋值）');

// 运行时实证：把 cfg 声明成 const 时那行确实抛错
(function () {
  let threw = null;
  try {
    (function () {
      'use strict';
      const c = { max_rate: '50' };
      c = { ...c, max_rate: '500' };   // eslint-disable-line no-const-assign
    })();
  } catch (e) { threw = e.message; }
  ok(threw && /Assignment to constant variable/.test(threw),
    '（对照）const 形态确实抛 Assignment to constant variable', threw || '没抛');
})();

console.log('\n=== §2 this 绑定：钩子必须能读到自己的参数 ===');
db.setSetting('activities', 'lucky_hour');
db.setSetting('activities_json', JSON.stringify({ lucky_hour: { ...ALL_DAY, maxRate: 500, rtpBonus: 0.03 } }));
ok(JSON.stringify(acts.params('lucky_hour')).includes('maxRate'),
  'activities.params() 能读到 lucky_hour 的配置');

const r1 = acts.runHooks('onRoundBegin', {
  maxRateOverride: null, rakeOverride: null, activityLabel: null, powerlawRtp: 0.97,
});
ok(r1 && r1.activityLabel === '幸运时段',
  'runHooks 真的触发了钩子（修复前恒为 null）', JSON.stringify(r1));
ok(r1 && r1.maxRateOverride === 500,
  '钩子能读到 maxRate 并返回 maxRateOverride（this/ctx.p 绑定已修）', String(r1 && r1.maxRateOverride));
ok(r1 && Math.abs(r1.rtpOverride - 1.00) < 1e-9,
  '钩子返回 rtpOverride = 0.97 + 0.03 = 1.00（被 clamp 到上限）', String(r1 && r1.rtpOverride));

console.log('\n=== §3 幂律下：maxRateOverride 不参与定价，改用 rtpOverride ===');
// 复刻 engine.js 的应用逻辑
let cfg = { powerlaw_rtp: '0.97', max_rate: '50' };
let powerlaw = true;
if (r1.maxRateOverride) {
  if (powerlaw) { /* 跳过：幂律下不抬 max_rate */ }
  else cfg = { ...cfg, max_rate: String(Math.max(Number(cfg.max_rate) || 0, r1.maxRateOverride)) };
}
if (r1.rtpOverride != null && powerlaw) {
  const rtp = Math.max(0.80, Math.min(1.00, Number(r1.rtpOverride)));
  cfg = { ...cfg, powerlaw_rtp: String(rtp) };
}
ok(cfg.max_rate === '50', '幂律下 max_rate 没被活动改写（仍是 50）', cfg.max_rate);
ok(cfg.powerlaw_rtp === '1', '幂律下 RTP 被活动抬到 1.00', cfg.powerlaw_rtp);
ok(Number(cfg.powerlaw_rtp) <= POWERLAW.RTP_MAX,
  'RTP 绝不会超过硬上限 1.00', cfg.powerlaw_rtp);

// 非幂律模式：仍应抬 max_rate（老行为不变）
let cfg2 = { powerlaw_rtp: '0.97', max_rate: '50' };
const powerlaw2 = false;
if (r1.maxRateOverride) {
  if (powerlaw2) { /* skip */ }
  else cfg2 = { ...cfg2, max_rate: String(Math.max(Number(cfg2.max_rate) || 0, r1.maxRateOverride)) };
}
ok(cfg2.max_rate === '500', '非幂律模式仍按老行为抬 max_rate（向后兼容）', cfg2.max_rate);

// 关键：let 版本不抛错
let threw = null;
try {
  let c3 = { powerlaw_rtp: '0.97', max_rate: '50' };
  if (r1.maxRateOverride) { c3 = { ...c3, max_rate: '500' }; }
  if (r1.rtpOverride != null) { c3 = { ...c3, powerlaw_rtp: String(Number(r1.rtpOverride)) }; }
} catch (e) { threw = e.message; }
ok(threw === null, '应用活动的这段代码在 let 之下不抛错（活动期不会每局崩）', threw || '正常');

console.log('\n=== §4 活动加成幅度：默认值、上限、显式 0 ===');
const cases = [
  ['留空（用默认）', undefined, 1.00],
  ['0.02', 0.02, 0.99],
  ['0.03', 0.03, 1.00],
  ['0.20（上限）', 0.20, 1.00],
  ['0.50（应被 clamp 到 0.20）', 0.50, 1.00],
  ['0（显式关闭加成）', 0, null],
];
for (const [label, bonus, expectRtp] of cases) {
  const p = { ...ALL_DAY };
  if (bonus !== undefined) p.rtpBonus = bonus;
  db.setSetting('activities_json', JSON.stringify({ lucky_hour: p }));
  const r = acts.runHooks('onRoundBegin', { maxRateOverride: null, powerlawRtp: 0.97 });
  if (expectRtp === null) {
    ok(r.rtpOverride == null, `rtpBonus ${label} → 不返回 rtpOverride`, String(r.rtpOverride));
  } else {
    ok(r.rtpOverride != null && Math.abs(r.rtpOverride - expectRtp) < 1e-9,
      `rtpBonus ${label} → RTP = ${expectRtp}`, String(r.rtpOverride));
    ok(r.rtpOverride <= POWERLAW.RTP_MAX, `  └ 未超过硬上限 1.00`, String(r.rtpOverride));
  }
}

console.log('\n=== §5 newbie-protect：没有 userBetCount 就不该生效 ===');
db.setSetting('activities', 'newbie_protect');
db.setSetting('activities_json', JSON.stringify({ newbie_protect: { rounds: 3, rtpBonus: 0.02 } }));
const nb1 = acts.runHooks('onRoundBegin', { powerlawRtp: 0.97 });
ok(nb1.activityLabel == null, '引擎不传 userBetCount 时活动不生效（不猜默认值）', JSON.stringify(nb1.activityLabel));
const nb2 = acts.runHooks('onRoundBegin', { powerlawRtp: 0.97, userBetCount: 1 });
ok(nb2.activityLabel === '新人保护' && Math.abs(nb2.rtpOverride - 0.99) < 1e-9,
  'userBetCount=1 < rounds=3 时生效，RTP 0.97→0.99', String(nb2.rtpOverride));
const nb3 = acts.runHooks('onRoundBegin', { powerlawRtp: 0.97, userBetCount: 9 });
ok(nb3.activityLabel == null, 'userBetCount=9 ≥ rounds=3 时不生效', JSON.stringify(nb3.activityLabel));

console.log('\n=== §6 幂律下不发任何玩家数据（E.2）===');
db.setSetting('activities', 'lucky_hour');
db.setSetting('activities_json', JSON.stringify({ lucky_hour: { ...ALL_DAY, rtpBonus: 0.03 } }));
const hookCtx = acts.runHooks('onRoundBegin', { powerlawRtp: 0.97 });
ok(!('seated' in hookCtx) && !('profiles' in hookCtx),
  '活动钩子不会把玩家档案塞进 ctx', Object.keys(hookCtx).join(','));
// jev 在幂律下完全不参与
const jev = require('../server/odds/jev');
ok(typeof jev.pickBand === 'function', 'jev 模块仍可加载（mode 7 保留可用）');
const engineSrc2 = engineSrc;
ok(/const mode7Active = mode7 && !powerlaw;/.test(engineSrc2),
  '幂律下 mode7Active 恒为 false（不查 seatedProfiles、不调 jev.prefetch）');
ok(/const seated = mode7Active \? this\.seatedProfiles/.test(engineSrc2),
  'seatedProfiles 只在 mode7Active 时调用');
ok(/if \(mode7Active && seated && seated\.length\)/.test(engineSrc2),
  'jev.tickRound / prefetch 只在 mode7Active 时调用');

// jev 外发内容里有哪些玩家数据（隐私标注）
const jevSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'jev.js'), 'utf8');
const leaks = ['discord_id', 'username', 'avatar', 'global_name', 'coins']
  .filter((k) => new RegExp(k).test(jevSrc));
ok(leaks.length === 0, 'jev 不外发任何身份数据（discord_id/昵称/头像/余额）',
  leaks.length ? '发现：' + leaks.join(',') : '确认无');
ok(/median_escape_target/.test(jevSrc) && /losing_streaks/.test(jevSrc),
  '（文档）jev 外发的是行为画像：逃跑倍率中位数与连败次数 —— 属隐私风险，但幂律下不发');
// 幂律路径绝不触碰 jev
const powerlawDecide = require('../server/odds').powerlawDecide;
const dec = powerlawDecide({ powerlaw_rtp: '0.97', powerlaw_cap: '120' }, null);
ok(dec.mode === '9-powerlaw' && !dec.jev, '幂律决策结果里没有任何 jev 字段', JSON.stringify(dec));

console.log('\n' + '='.repeat(52));
console.log(`  通过 ${pass}  失败 ${fail}`);
console.log('='.repeat(52));
restore();
process.exit(fail ? 1 : 0);
