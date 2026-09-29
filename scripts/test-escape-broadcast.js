/**
 * 多人逃跑定向推送测试。
 *
 * 复现的 bug：服务端 broadcast({..., me:true}) 把「逃跑成功」发给所有人，
 * 导致别人逃跑时你的前端也进 if (d.me) 分支 →
 *   S.escDone = true → 你的逃跑按钮被锁（用户报「其他人无法逃跑」）
 *   toast('逃跑成功！+xxx') + 余额被改成别人的数字（用户报「通知发给全部人」）
 *
 * 判定：玩家 B 没逃跑时，绝不能收到 me:true 的 escape 事件，
 *      且自己的 actBtn 仍可点。
 */
const WebSocket = require('ws');

const HTTP = 'http://127.0.0.1:8080';
const WS = 'ws://127.0.0.1:9501/ws';
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? '✅' : '❌') + ' ' + n + (extra ? '  ' + extra : '')); };

async function login(discordId) {
  const r = await fetch(`${HTTP}/api/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discordId }),
  });
  const setc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')];
  return setc.map(s => String(s).split(';')[0]).join('; ');
}

function connect(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS, { headers: { Cookie: cookie } });
    const msgs = [];
    ws.on('message', m => { try { msgs.push(JSON.parse(m.toString())); } catch (_) {} });
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws 连接超时')), 6000);
  });
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const latest = (msgs, t) => msgs.filter(m => m.type === t).pop();

(async () => {
  console.log('=== 准备两个真人玩家 ===');
  const ckA = await login('000000000000000101');   // A：会逃跑
  const ckB = await login('000000000000000102');   // B：不下注也不逃跑
  const A = await connect(ckA);
  const B = await connect(ckB);
  await wait(600);
  ok('两个 WS 都连上', A.ws.readyState === 1 && B.ws.readyState === 1);

  // 拿到本期期号。连接时可能正处在飞行中（没有 begin），此时用 hello.current.gid。
  // 最多等一整局（飞行最长 120s + 15s 窗口 + 收尾）。
  let gid = null;
  for (let i = 0; i < 400 && !gid; i++) {
    await wait(500);
    const b = latest(A.msgs, 'begin');
    if (b) { gid = b.gid; break; }
    const h = latest(A.msgs, 'hello');
    if (h && h.current && h.current.status === 'betting') { gid = h.current.gid; break; }
  }
  ok('拿到本期期号', !!gid, 'gid=' + gid);
  if (!gid) { console.log('A 消息类型:', [...new Set(A.msgs.map(m => m.type))].join(',')); process.exit(1); }

  // A 下注
  const betR = await fetch(`${HTTP}/api/game/bet`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ckA },
    body: JSON.stringify({ amount: 10, roundId: gid }),
  }).then(r => r.json()).catch(e => ({ error: e.message }));
  ok('A 下注成功', betR.ok === true, JSON.stringify(betR).slice(0, 90));

  // 等到 flying
  let flew = false;
  for (let i = 0; i < 80 && !flew; i++) { await wait(500); flew = !!latest(A.msgs, 'takeoff'); }
  ok('进入飞行阶段', flew);
  if (!flew) { console.log('A 消息类型:', [...new Set(A.msgs.map(m => m.type))].join(',')); }

  // 等 1.5 秒让倍率涨起来
  await wait(1500);

  // A 逃跑
  const escR = await fetch(`${HTTP}/api/game/escape`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ckA },
    body: JSON.stringify({ roundId: gid }),
  }).then(r => r.json()).catch(e => ({ error: e.message }));
  ok('A 逃跑成功', escR.ok === true, JSON.stringify(escR).slice(0, 90));
  await wait(1200);

  // 核心断言
  const escB = B.msgs.filter(m => m.type === 'escape');
  const escA = A.msgs.filter(m => m.type === 'escape');
  console.log('');
  console.log('A 收到的 escape:', JSON.stringify(escA.map(e => ({ uid: e.uid, me: e.me }))));
  console.log('B 收到的 escape:', JSON.stringify(escB.map(e => ({ uid: e.uid, me: e.me }))));

  ok('A（逃跑者）收到 me:true', escA.some(e => e.me === true));
  // B 应该收到【公开】的逃跑事件（下注列表要显示 A 逃了、飘字），
  // 但绝不能带 me:true —— 带了就会弹「逃跑成功」toast 并锁死自己的逃跑按钮。
  ok('B 收到公开 escape（用于更新列表）', escB.length === 1, `B 收到 ${escB.length} 条`);
  ok('B 的 escape 不带 me:true（不弹 toast、不锁按钮）', !escB.some(e => e.me === true));
  ok('A 只收到 1 条 me:true（不重复）', escA.filter(e => e.me === true).length === 1);

  // B 能否继续：下一局 B 自己下注并逃跑，验证没被 A 的逃跑锁死
  let gid2 = null;
  // 一局 = 10s 下单 + 5s 封盘 + 飞行(最高 120s) + 2.5s 收尾，给足 4 分钟
  for (let i = 0; i < 480 && !gid2; i++) {
    await wait(500);
    const b = latest(B.msgs, 'begin');
    if (b && b.gid !== gid) gid2 = b.gid;
  }
  ok('等到下一局', !!gid2, 'gid=' + gid2);
  if (gid2) {
    const betB = await fetch(`${HTTP}/api/game/bet`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ckB },
      body: JSON.stringify({ amount: 10, roundId: gid2 }),
    }).then(r => r.json()).catch(e => ({ error: e.message }));
    ok('B 也能下注（没被 A 的逃跑影响）', betB.ok === true, JSON.stringify(betB).slice(0, 90));

    // 等 B 自己这一局的起飞信号（不能只看有没有 takeoff — 可能还在等上一局的）
    let flew2 = false;
    for (let i = 0; i < 120 && !flew2; i++) {
      await wait(500);
      flew2 = B.msgs.some(m => m.type === 'takeoff' && m.gid === gid2);
    }
    ok('B 的这一局已起飞', flew2, 'gid2=' + gid2);
    await wait(1500);
    const escB2 = await fetch(`${HTTP}/api/game/escape`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ckB },
      body: JSON.stringify({ roundId: gid2 }),
    }).then(r => r.json()).catch(e => ({ error: e.message }));
    ok('B 也能逃跑（核心：不被别人锁死）', escB2.ok === true, JSON.stringify(escB2).slice(0, 90));
  }

  A.ws.close(); B.ws.close();
  console.log('');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
