/**
 * 回归测试：刷新/中途加入后仍能逃跑 + 倒计时正确。
 *
 * 覆盖用户反馈的三个问题：
 *   1. 下单后无法逃跑，且没有倒计时
 *   2. 刷新网页后也无法逃跑
 *   3. 移动端灰色按钮一点就变黄（CSS，见 game.css）
 *
 * 做法：连一次 WS 下注 → 起飞后【断线重连】→ 检查 hello.current 快照
 * 是否带 hasBet / betEndAt / lockEndAt，以及前端能否走逃跑分支。
 */
const WebSocket = require('ws');

const BASE = 'http://127.0.0.1:8080';
const WS = 'ws://127.0.0.1:9501/ws';
const MY_ID = '000000000000077001';

let cookie = '';
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}

async function api(url, opt = {}) {
  const r = await fetch(BASE + url, {
    method: opt.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map(s => s.split(';')[0]).join('; ');
  let body = null; try { body = await r.json(); } catch (_) {}
  return { status: r.status, body };
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS, { headers: { Cookie: cookie } });
    const t = setTimeout(() => reject(new Error('WS 超时')), 8000);
    ws.once('open', () => { clearTimeout(t); resolve(ws); });
    ws.once('error', () => { clearTimeout(t); reject(new Error('WS 连接失败')); });
  });
}

function waitFor(ws, type, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', h); reject(new Error('等 ' + type + ' 超时')); }, ms);
    function h(raw) {
      let m; try { m = JSON.parse(raw); } catch (_) { return; }
      if (m.type === type) { clearTimeout(t); ws.off('message', h); resolve(m); }
    }
    ws.on('message', h);
  });
}

(async () => {
  console.log('=== 登录 ===');
  const l = await api('/api/auth/dev-login', { method: 'POST', body: { discordId: MY_ID } });
  if (!l.body || !l.body.user) throw new Error('登录失败: ' + JSON.stringify(l.body));
  const uid = l.body.user.id;
  console.log('  uid=' + uid + '  余额=' + l.body.user.coins);

  console.log('\n=== 等下一局并下注 ===');
  const ws1 = await connect();
  const begin = await waitFor(ws1, 'begin', 45000);
  await new Promise(r => setTimeout(r, 1000));
  const bet = await api('/api/game/bet', { method: 'POST', body: { amount: 10, roundId: begin.gid } });
  ok('下注成功', !!(bet.body && bet.body.ok), JSON.stringify(bet.body));

  const takeoff = await waitFor(ws1, 'takeoff', 40000);
  /**
   * 【2026-09-30 反转这条断言】
   * 原来这里断言「起飞消息含 flightMs」—— 那是把信息泄露当成了需求。
   * flightMs 与爆点一一对应，闭式解 t=(√(40r−24)−4)/2 可精确反推（实测往返误差
   * ≤1.2e-2），等于把本局答案发给客户端。现在改为断言它【不在】。
   * 曲线改由每 100ms 的 tick 消息续上，爆炸只由 over 触发。
   */
  ok('起飞消息【不含】flightMs（防泄露）', takeoff.flightMs === undefined,
    'flightMs=' + takeoff.flightMs);
  ok('起飞消息带 flightStart（客户端据此对齐时钟）', typeof takeoff.flightStart === 'number',
    'flightStart=' + takeoff.flightStart);
  await new Promise(r => setTimeout(r, 1200));   // 飞一会儿再重连，模拟用户刷新

  console.log('\n=== 【问题2】刷新网页：断线重连看快照 ===');
  ws1.close();
  await new Promise(r => setTimeout(r, 300));
  const ws2 = await connect();
  const hello = await waitFor(ws2, 'hello', 8000);
  const c = hello.current || {};

  ok('快照带 current', !!c.gid, JSON.stringify(Object.keys(c)));
  ok('快照带 hasBet', typeof c.hasBet === 'boolean', 'hasBet=' + JSON.stringify(c.hasBet));
  ok('hasBet = true（本局我下注了）', c.hasBet === true, '实际 ' + c.hasBet);
  ok('快照带 betEndAt', typeof c.betEndAt === 'number', 'betEndAt=' + c.betEndAt);
  ok('快照带 lockEndAt', typeof c.lockEndAt === 'number', 'lockEndAt=' + c.lockEndAt);
  ok('快照带 elapsedSec（曲线/火箭要动）', typeof c.elapsedSec === 'number' && c.elapsedSec > 0,
    'elapsedSec=' + c.elapsedSec);
  ok('快照带 bets 列表', Array.isArray(c.bets) && c.bets.length > 0, 'count=' + (c.bets || []).length);
  /**
   * 【2026-09-30 新增】快照也必须不含可反推字段。
   * 快照是「刷新页面」那条路径唯一的状态来源，改动前它同时带
   * `rate`（爆点明文）与 `flightMs`（剩余时长，+ elapsedSec = 总时长）。
   * 只测 takeoff 会漏掉这一处，而它恰恰是「刷新就中大奖」的路径。
   */
  ok('快照【不含】rate（爆点明文）', c.rate === undefined, 'rate=' + JSON.stringify(c.rate));
  ok('快照【不含】flightMs（剩余时长可反推）', c.flightMs === undefined, 'flightMs=' + JSON.stringify(c.flightMs));
  ok('快照带 flightStart（客户端据此续曲线）', typeof c.flightStart === 'number',
    'flightStart=' + c.flightStart);

  console.log('\n=== 【问题1】前端能否走逃跑分支（不再误走下注分支）===');
  // 前端逻辑：S.hasBet && S.phase === 'flying' → 逃跑分支
  const phaseIsFlying = c.status === 'flying';
  const wouldEscape = !!c.hasBet && phaseIsFlying;
  ok('status = flying', phaseIsFlying, 'status=' + c.status);
  ok('会走逃跑分支而不是下注分支', wouldEscape);

  console.log('\n=== 实际调用逃跑接口 ===');
  const esc = await api('/api/game/escape', { method: 'POST', body: { roundId: c.gid } });
  ok('逃跑接口返回成功', !!(esc.body && esc.body.ok), JSON.stringify(esc.body));
  if (esc.body && esc.body.ok) {
    ok('返回倍率 rate > 1', Number(esc.body.rate) > 1, 'rate=' + esc.body.rate);
    ok('返回余额字段', esc.body.balance != null, 'balance=' + esc.body.balance);
  }

  console.log('\n=== 【问题1】倒计时：快照时间是否可用 ===');
  // betEndAt/lockEndAt 必须是过去时间（已进入飞行）或未来时间（还在下注）
  const now = Date.now();
  ok('betEndAt 是有效时间戳（毫秒级）',
    c.betEndAt > 1e12 && c.betEndAt < 4e12, 'betEndAt=' + c.betEndAt);
  ok('lockEndAt > betEndAt', c.lockEndAt > c.betEndAt,
    'betEndAt=' + c.betEndAt + ' lockEndAt=' + c.lockEndAt);

  ws2.close();

  console.log('\n' + '='.repeat(52));
  console.log('  ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('='.repeat(52));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });
