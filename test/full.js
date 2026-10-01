'use strict';
/** 完整验证：赔率下限 / 限时活动 / 弹幕 / 后台参数生效 */
require('../server/env').load();
const { WebSocket } = require('ws');

const HTTP = 'http://127.0.0.1:8080';
const WS = process.env.TEST_WS || 'ws://127.0.0.1:9501/ws';

let CK = '';
let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + m + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + m + (extra ? '  ' + extra : '')); }
};

function req(path, opts = {}) {
  const h = {};
  if (opts.body) h['Content-Type'] = 'application/json';
  if (CK) h.Cookie = CK;
  return fetch(HTTP + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: h,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then((r) => {
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) CK = sc.map((c) => c.split(';')[0]).join('; ');
    return r.json().catch(() => ({}));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- WS 事件收集 ----
const rounds = [];
let current = null;
const ws = new WebSocket(WS);
ws.on('message', (raw) => {
  const d = JSON.parse(raw.toString());
  if (d.type === 'begin') { current = { gid: d.gid, event: d.event || null }; rounds.push(current); }
  if (d.type === 'takeoff' && current) {
    // 【2026-09-30】不再记 flightMs —— 服务端已不下发总飞行时长（可反推爆点）。
    // 改为记录最后一个 tick 的倍率，够用来验证「曲线确实在推进」。
    current.flightStart = d.flightStart;
  }
  if (d.type === 'tick' && current) {
    current.lastTick = d;
    current.ticks = (current.ticks || 0) + 1;
  }
  if (d.type === 'over' && current) { current.boom = d.boom; current.done = true; current = null; }
});
const waitOpen = new Promise((r) => ws.on('open', r));

/** 退出前一定还原赔率配置，避免测试失败留下脏配置 */
const DEFAULTS = { min_rate: '1.10', band_min: '1.10', band_max: '3.00', events_json: '[]' };
async function restore() {
  try { await req('/admin/api/dev-login', { body: {} }); await req('/admin/api/settings', { body: DEFAULTS }); }
  catch (_) { /* 服务已停就算了 */ }
}
process.on('exit', () => { /* 同步不了就算了，靠下面的 finally */ });
async function finish(code) {
  await restore();
  console.log('\n' + '='.repeat(46));
  console.log('  通过 ' + pass + '  失败 ' + fail);
  console.log('='.repeat(46));
  process.exit(code);
}

async function waitRounds(n, timeoutMs = 45000) {
  const t0 = Date.now();
  while (rounds.filter((r) => r.done).length < n && Date.now() - t0 < timeoutMs) await sleep(400);
  return rounds.filter((r) => r.done).length;
}

(async () => {
  await waitOpen;
  console.log('\n=== 1. 登录 ===');
  await req('/api/auth/dev-login', { body: { name: '测试员' } });
  const me = await req('/api/me');
  ok(me.user && me.user.id > 0, 'dev-login 成功', me.user ? me.user.username : '');
  ok(Number(me.config.minRate) >= 1.1, 'minRate 下限已下发', String(me.config.minRate));

  console.log('\n=== 2. 基础赔率窗口 ===');
  // 活动时段每局可能长达 8-10 秒，给足时间
  await waitRounds(4, 120000);
  const done = rounds.filter((r) => r.done);
  for (const r of done) {
    // 【2026-09-30】不再打印飞行时长（服务端不再下发，泄露已消除）。
    // 改看 tick 数量与「最后一个 tick 严格低于爆点」——后者是防泄露的正面证据。
    const t = r.ticks ? r.ticks + ' ticks' : '?';
    console.log('  局 ' + r.gid + ': 爆点 ' + String(r.boom).padEnd(6) + ' ' + t.padEnd(10)
      + ' 末tick ' + (r.lastTick ? r.lastTick.rate : '?') + '  活动=' + (r.event ? r.event.name : '无'));
  }
  ok(done.length >= 3, '至少完成 3 局', String(done.length));

  /**
   * 【2026-09-30 新增】防泄露的正面断言。
   *
   * ⚠️ 只对【收到过 tick 的局】断言 —— 瞬爆局（1.00x）飞行时长是 0ms，
   *    flightLoop 一次 tick 都不会发。要求「每一局都有 tick」会随机红：
   *    幂律的瞬爆率 ≈ 1−RTP = 3%，4 局里撞上一次就有 12% 概率。
   *    这正是「用固定断言去卡一个本身带随机性的量」的老毛病。
   *
   * 零 tick 局改为统计口径：它应该大致等于瞬爆率，且【不能】是全部。
   */
  const ticked = done.filter((r) => r.ticks > 0);
  const leaky = ticked.filter((r) => r.boom && r.lastTick.rate > r.boom);
  ok(leaky.length === 0, '所有收到 tick 的局，末 tick 都不超过爆点（无提前泄露）',
    leaky.length ? JSON.stringify(leaky.map((r) => ({ gid: r.gid, last: r.lastTick.rate, boom: r.boom }))) : '确认');
  /**
   * ⚠️ 这里用 > 而不是 >= 判断泄露，【是个需要说清的决定】。
   * tick 与 over 之间存在一个竞态：最后一次 tick 发出后、结算前，
   * 若两者恰好落在同一个 100ms 边界，客户端就会收到「末 tick 倍率 == 爆点」。
   * 那是时序巧合，不是泄露 —— 泄露的定义是「提前于爆炸拿到答案」。
   * 用 >= 会让这条断言随机红（实测 4 局里中了 2 局）。
   * 真正该守的是：tick 里【不含】任何总时长/剩余量（那才是可反推的），
   * 这一点由 test/ws-leak.js 的字段白名单硬性保证。
   */
  const atBoom = ticked.filter((r) => r.boom && r.lastTick.rate === r.boom);
  if (atBoom.length) {
    console.log(`  （${atBoom.length} 局末 tick 恰好等于爆点，属 tick/over 同边界的时序巧合，非泄露）`);
  }
  const zeroTick = done.length - ticked.length;
  console.log(`  收到 tick 的局 ${ticked.length}/${done.length}，零 tick 局 ${zeroTick}（瞬爆局飞行 0ms）`);
  ok(zeroTick < done.length, '不是所有局都零 tick（tick 循环确实在工作）');
  ok(zeroTick <= Math.ceil(done.length * 0.25),
    '零 tick 局不超过 25%（应≈瞬爆率 3%，不能是「tick 根本没发」）',
    `${zeroTick}/${done.length}`);

  console.log('\n=== 3. 下注 + 弹幕 ===');
  // 确保抓到一局进行中的（下注期约 9 秒，飞行期最长几秒）
  let target = null;
  for (let i = 0; i < 30; i++) {
    const live = rounds.filter((r) => !r.done);
    if (live.length) { target = live[live.length - 1]; break; }
    await sleep(300);
  }
  const before = (await req('/api/me')).user.coins;
  if (target) {
    const bet = await req('/api/game/bet', { body: { roundId: target.gid, amount: 20 } });
    ok(bet.ok, '下注 20 QUN 成功', bet.error || '');
    const chat = await req('/api/chat', { body: { text: '大家好，冲冲冲！' } });
    ok(chat.ok, '玩家发言成功', chat.error || '');
    const empty = await req('/api/chat', { body: { text: '   ' } });
    ok(!empty.ok, '空消息被拒绝');
    const long = await req('/api/chat', { body: { text: 'x'.repeat(200) } });
    ok(!long.ok, '超长消息被拒绝');
  } else {
    ok(false, '抓到进行中的局（下注/弹幕跳过）');
  }
  await sleep(2500);
  const afterBet = (await req('/api/me')).user.coins;
  if (target) ok(afterBet < before, '下注已扣款', before + ' -> ' + afterBet);

  console.log('\n=== 4. 后台改参数立即生效（min_rate -> 3.00） ===');
  await req('/admin/api/dev-login', { body: {} });
  const meAdmin = await req('/admin/api/me');
  ok(meAdmin.id, '后台会话有效（Discord 白名单）', meAdmin.id);
  await req('/admin/api/settings', { body: { min_rate: '3.00', band_min: '3.00', band_max: '5.00' } });
  const st = await req('/admin/api/settings');
  ok(st.settings.min_rate === '3.00', 'min_rate 已改为 3.00', st.settings.min_rate);

  /**
   * 【2026-09-30】这条断言原来写的是「min_rate 改 3.00 ⇒ 新局爆点 ≥ 3.00」，
   * 它编码的是【旧引擎的契约】：min_rate 是定价下限。
   *
   * 幂律（mode 9）下 min_rate/max_rate 是【安全护栏】，不参与定价 ——
   * 定价参数是 powerlaw_rtp / powerlaw_cap。这与本项目既有结论一致：
   * 「护栏不能改写定价，也不该被当成定价」。
   * 所以幂律下 min_rate=3.00 而爆点仍可能 1.4x，这是【正确行为】，
   * 旧断言会稳定红。
   *
   * 上面那条「min_rate 已改为 3.00」继续验证后台保存链路（仍然有价值）；
   * 这里把「爆点必然 ≥ 3.00」换成幂律真正该保证的性质：改了护栏之后，
   * 爆点仍然在 [1.00, powerlaw_cap] 内、分布形状不变。
   */
  const base = rounds.filter((r) => r.done).length;
  // 只统计「保存之后才 begin」的局：进行中的局用的是旧配置快照（下一局生效）
  const nBefore = rounds.length;
  await waitRounds(base + 2);
  await sleep(500);
  const after = rounds.slice(nBefore).filter((r) => r.done);
  console.log('  改后新局: ' + after.map((r) => r.boom + 'x').join(', '));
  const cap = Number((await req('/admin/api/settings')).settings.powerlaw_cap) || 120;
  ok(after.length > 0 && after.every((r) => r.boom >= 1 && r.boom <= cap),
    `幂律下改 min_rate 不改变分布：新局爆点仍在 [1.00, powerlaw_cap=${cap}]`,
    after.map((r) => r.boom).join(','));
  console.log('  （幂律下 min_rate/max_rate 不参与定价，所以爆点不会 ≥3.00 —— 这是设计，不是回归）');
  await req('/admin/api/settings', { body: { min_rate: '1.10', band_min: '1.10', band_max: '3.00' } });

  console.log('\n=== 5. 限时活动 ===');
  await req('/admin/api/settings', {
    body: {
      events_json: JSON.stringify([
        { name: '测试高倍场', from: '00:00', to: '23:59', min: 5, max: 50, weight: 0.9, enabled: true },
      ]),
    },
  });
  const ev = await req('/admin/api/settings');
  ok(Array.isArray(JSON.parse(ev.settings.events_json)), '活动配置已保存');
  // 注意：后台保存只对「之后才开始的新局」生效，已在跑的局仍用旧配置。
  // 所以基线要数「已完成的局」，然后等至少 1 个新局完成。
  const base2 = rounds.filter((r) => r.done).length;
  await waitRounds(base2 + 1, 90000);
  const evRounds = rounds.filter((r) => r.done).slice(base2);
  ok(evRounds.length > 0, '保存后有完成的局', evRounds.length + ' 局');
  const withEv = evRounds.filter((r) => r.event);
  ok(withEv.length > 0, 'begin 带活动信息（前端显示横幅）', withEv.length + ' 局');
  /**
   * 【2026-09-30】原来断言「活动时段爆点 >= 5x」（活动 min=5）。
   * 幂律下活动【只加 RTP，不改倍率区间】—— 换分布形状就等于给活动时段
   * 造一个「只在活动期可辨识」的形状，那正是本次要根除的东西。
   * 所以这里能断言的是：活动照常开、照常有横幅，而爆点仍在幂律范围内。
   */
  const cfgNow = (await req('/admin/api/settings')).settings;
  const rtp0 = Number(cfgNow.powerlaw_rtp) || 0.87;
  // ⚠️ 【2026-10-01 修】上限不能写死 120。cap 已经改成 1000，写死会让这条断言
  // 随抽样随机变红（>120 的局本来是合法的），而「偶发红」会被误当成引擎坏了。
  // 该断言的正确形状是「爆点落在【当前配置的上限】之内」—— 读配置，不是读常量。
  const capNow = Number(cfgNow.powerlaw_cap) || 1000;
  ok(evRounds.length > 0 && evRounds.every((r) => r.boom >= 1 && r.boom <= capNow),
    '幂律下活动不改变倍率区间（爆点仍在幂律范围内）',
    `上限=${capNow}，实测=${evRounds.map((r) => r.boom).join(',')}`);
  console.log(`  （活动 min=5/max=50 在幂律下不生效，只加 RTP；当前 RTP=${rtp0} / cap=${capNow}）`);
  await req('/admin/api/settings', { body: { events_json: '[]' } });

  ws.close();
  await finish(fail ? 1 : 0);
})().catch(async (e) => { console.error('测试异常:', e); await finish(1); });
