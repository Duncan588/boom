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
  if (d.type === 'takeoff' && current) current.flightMs = d.flightMs;
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
    const f = r.flightMs != null ? (r.flightMs / 1000).toFixed(2) + 's' : '?';
    console.log('  局 ' + r.gid + ': 爆点 ' + String(r.boom).padEnd(6) + ' 飞行 ' + f + '  活动=' + (r.event ? r.event.name : '无'));
  }
  const flights = done.filter((r) => r.flightMs).map((r) => r.flightMs);
  ok(done.length >= 3, '至少完成 3 局', String(done.length));
  if (flights.length) {
    const mn = Math.min(...flights);
    ok(mn >= 150, '最短飞行窗口 >= 0.15s（不再是秒炸）', (mn / 1000).toFixed(2) + 's');
  }

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

  const base = rounds.filter((r) => r.done).length;
  // 只统计「保存之后才 begin」的局：进行中的局用的是旧配置快照（下一局生效）
  const nBefore = rounds.length;
  await waitRounds(base + 2);
  await sleep(500);
  const after = rounds.slice(nBefore).filter((r) => r.done);
  console.log('  改后新局: ' + after.map((r) => r.boom + 'x').join(', '));
  ok(after.length > 0 && after.every((r) => r.boom >= 3), '改完后新局爆点 >= 3.00x',
    after.map((r) => r.boom).join(','));
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
  ok(evRounds.length > 0 && evRounds.every((r) => r.boom >= 5), '活动时段爆点 >= 5x', evRounds.map((r) => r.boom).join(','));
  await req('/admin/api/settings', { body: { events_json: '[]' } });

  ws.close();
  await finish(fail ? 1 : 0);
})().catch(async (e) => { console.error('测试异常:', e); await finish(1); });
