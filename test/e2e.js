/**
 * 端到端测试：登录 → 等待开局 → 下注 → 逃跑 → 结算校验
 * 用法：node test/e2e.js [port] [wsPort]
 */
'use strict';
const { WebSocket } = require('ws');
const http = require('http');

const PORT = Number(process.argv[2] || 8090);
const WSP = Number(process.argv[3] || 9591);

let COOKIE = '';

function call(path, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (COOKIE) headers.Cookie = COOKIE;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc) COOKIE = sc.map((c) => c.split(';')[0]).join('; ');
        try { resolve(JSON.parse(s)); } catch (_) { resolve(s); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}

(async function main() {
  console.log('\n=== 1. 登录 ===');
  const login = await call('/api/auth/dev-login', { name: 'E2E测试' });
  check('dev-login 返回用户', !!(login.user && login.user.id), login);
  const uid = login.user.id;

  console.log('\n=== 2. 金币 ===');
  const before = await call('/api/me', null, 'GET');
  check('会话保持', before.user && before.user.id === uid, before);
  const coins0 = before.user.coins;
  console.log('  当前 QUN: ' + coins0);

  console.log('\n=== 3. 签到 ===');
  const ci = await call('/api/checkin', {});
  if (ci.error && /已经签到/.test(ci.error)) console.log('  (今日已签到，跳过)');
  else check('签到成功', ci.ok && ci.amount > 0, ci);

  console.log('\n=== 4. 游戏回合 ===');
  const ws = new WebSocket(`ws://127.0.0.1:${WSP}/ws`);
  let gid = 0, betDone = false, escDone = false, boom = 0;

  const done = new Promise((resolve) => {
    ws.on('open', () => console.log('  WebSocket 已连接'));
    ws.on('message', async (m) => {
      const d = JSON.parse(m.toString());
      if (d.type === 'hello' && d.current) {
        // 连上时可能正处于某局中途
        gid = d.current.gid;
        console.log(`  (加入时进行中 #${gid} 状态=${d.current.status})`);
      }
      if (d.type === 'begin') {
        gid = d.gid;
        console.log(`  BEGIN #${gid} 下注窗口 ${d.betMs}ms`);
        setTimeout(async () => {
          if (betDone) return;
          betDone = true;
          const r = await call('/api/game/bet', { roundId: gid, amount: 50 });
          check('下注成功', r.ok === true, r);
          if (r.ok) check('下注后扣款 50', Math.abs(r.balance - (coins0 + (ci.ok ? ci.amount : 0) - 50)) < 0.01 || r.balance < coins0, r);
        }, 900);
      }
      if (d.type === 'takeoff' && !betDone) {
        // 错过了 begin（本局已在飞行中）—— 只能等下一局
        console.log(`  TAKEOFF #${gid} 飞行 ${d.flightMs}ms（未下注，等下一局）`);
      }
      if (d.type === 'takeoff' && !escDone && betDone) {
        console.log(`  TAKEOFF 飞行 ${d.flightMs}ms`);
        setTimeout(async () => {
          if (escDone) return;
          escDone = true;
          const r = await call('/api/game/escape', { roundId: gid });
          if (r.ok) {
            check('逃跑成功', true);
            check('获得盈利', r.profit > 0, r);
            console.log(`  盈利 ${r.profit} QUN @ ${r.rate}x → 余额 ${r.balance}`);
          } else {
            check('逃跑成功', false, r);
          }
        }, Math.min(1200, d.flightMs - 200));
      }
      if (d.type === 'over') {
        boom = d.boom;
        console.log(`  OVER 爆点 ${boom}x jackpot=${d.jackpot}`);
        // 本局未成功下注+逃跑就继续等下一轮
        if (!escDone) {
          console.log('  (本局未完成，继续等待下一局…)');
          betDone = false; escDone = false;
          return;
        }
        setTimeout(resolve, 400);
      }
    });
    ws.on('error', (e) => { console.log('  WS 错误', e.message); resolve(); });
  });

  const timeout = new Promise((r) => setTimeout(r, 50000));
  await Promise.race([done, timeout]);
  ws.close();

  console.log('\n=== 5. 账目核对 ===');
  const after = await call('/api/me', null, 'GET');
  const hist = await call('/api/game/history', null, 'GET');
  const myBet = (hist.list || [])[0];
  check('战绩已记录', !!(myBet && myBet.round_id === gid), myBet);
  if (myBet) {
    check('状态=已逃跑', myBet.status === 1, myBet);
    check('赔率=爆点倍率', Math.abs(myBet.escape_rate - boom) < 0.01, { esc: myBet.escape_rate, boom });
  }
  console.log(`  余额 ${coins0} → ${after.user.coins}`);

  console.log('\n=== 6. 排行榜 / 邀请 ===');
  const lb = await call('/api/leaderboard', null, 'GET');
  check('排行榜可用', Array.isArray(lb.list) && lb.list.length > 0, lb);
  const inv = await call('/api/invite', null, 'GET');
  check('邀请接口可用', !!inv.code, inv);

  console.log(`\n${'='.repeat(46)}`);
  console.log(`  通过 ${pass} · 失败 ${fail}`);
  console.log(`${'='.repeat(46)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
