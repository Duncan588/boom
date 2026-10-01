/**
 * 守恒测试的真实前置（补上 seed-robots.js 的空缺）。
 *
 * 【为什么需要这个文件】—— 不是新功能，是补一道一直假绿的闸门。
 *
 * 两个实测到的事实：
 *   1. seed-robots.js 往 users 表插 is_bot=1，但引擎的 db.listRobots()
 *      读的是 robots 表（db.js:496）。两者永不相交 ⇒ 机器人永远不会下注。
 *   2. engine.js:280-290 的「机器人下注」只 broadcast({type:'bets'}) 推一条
 *      前端假消息，从不往 bets 表插行。所以就算 robots 表有数据，
 *      结算分支也永远不会执行。
 *
 * 结论：scripts/test-money-conservation.js 在没有真人下注时
 * 「bet+boom+escape <= 0」就是 0 <= 0，恒真。那句 ✅ 通过 不代表任何事。
 *
 * 这个脚本用 DEV_LOGIN 起一个真人会话打真注单，让 bets 表真的有数据，
 * 于是守恒断言跑在真实样本上。
 *
 * 用法（必须先起服务，且 DEV_LOGIN=1）：
 *   DB_FILE=<临时库绝对路径> PORT=8090 WS_PORT=9590 DEV_LOGIN=1 node server/index.js
 *   node scripts/test-conservation-e2e.js --base=http://127.0.0.1:8090
 *
 * 绝不碰线上库：脚本开局断言 DB 路径不是 data/baodian.db。
 */
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const WebSocket = require('ws');

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const BASE = arg('base', 'http://127.0.0.1:8090');
const WSU = arg('ws', 'ws://127.0.0.1:9590/ws');
const MAX_SEC = Number(arg('seconds', 400));

// ---- 安全闸：拒绝打线上库 ----
const DB_PATH = process.env.DB_FILE || path.join(__dirname, '..', '..', 'data', 'baodian.db');
if (/baodian\.db$/i.test(DB_PATH) && !/rewrite|test|verify|sim/i.test(DB_PATH)) {
  console.error('❌ 拒绝执行：DB 指向生产库 ' + DB_PATH);
  console.error('   守恒测试会写注单和流水。必须用临时库，例如：');
  console.error('   DB_FILE="E:/爆点/data/rewrite-verify.db"');
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });

function snap() {
  const log = {};
  for (const r of db.prepare(
    `SELECT reason, COALESCE(SUM(delta),0) s, COUNT(*) n FROM coin_logs
     WHERE reason IN ('bet','boom','escape') GROUP BY reason`
  ).all()) log[r.reason] = { s: r.s, n: r.n };
  const users = db.prepare('SELECT COALESCE(SUM(coins),0) c FROM users').get().c;
  const bets = db.prepare('SELECT COUNT(*) c FROM bets').get().c;
  return { log, users, bets };
}

const before = snap();
console.log('起点：总余额 =', before.users, '| 注单 =', before.bets);

let cookie = '';
async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body || {}),
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function get(p) {
  const r = await fetch(BASE + p, { headers: cookie ? { cookie } : {} });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const ok = (cond, msg, extra) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + msg + (extra ? '  ' + extra : ''));
  if (!cond) process.exitCode = 1;
  return cond;
};

(async () => {
  const N = 6;                       // 玩家数
  const STAKE = 100;

  // 期号只有 WS 的 begin 消息带；/api/me 不返回当前局。
  const gids = [];
  const ticks = new Map();          // gid -> 已见过的 tick（判断飞行已开始）
  const ws = new WebSocket(WSU);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (m) => {
    try {
      const d = JSON.parse(String(m));
      if (!d || !d.gid) return;
      if (d.type === 'begin' && !gids.includes(d.gid)) gids.push(d.gid);
      if (d.type === 'takeoff') ticks.set(d.gid, true);   // 已起飞，可以逃跑了
    } catch (_) {}
  });
  console.log('\n⓪ WS 已连上 ' + WSU + '，等 begin 事件拿期号');

  console.log('\n① 起 ' + N + ' 个真人会话');
  for (let i = 0; i < N; i++) {
    cookie = '';
    const r = await post('/api/auth/dev-login', { discordId: '7000000000000' + String(100 + i) });
    if (r.status !== 200) {
      console.error('  ❌ dev-login 失败', r.status, JSON.stringify(r.body));
      console.error('     服务必须 DEV_LOGIN=1 启动，且请求来自 127.0.0.1');
      process.exit(1);
    }
    if (i === 0) console.log('   登录 ok:', JSON.stringify(r.body).slice(0, 120));
  }

  console.log('\n② 收到新期号就下注；每局起飞后每 200ms 试逃一次，跑赢家和输家两条结算路径');
  const t0 = Date.now();
  let rounds = 0;
  let pending = null;              // 正在等逃跑的局

  const tryEscape = async (gid, playerIdx) => {
    cookie = '';
    await post('/api/auth/dev-login', { discordId: '7000000000000' + String(100 + playerIdx) });
    return post('/api/game/escape', { roundId: gid });
  };

  while ((Date.now() - t0) / 1000 < MAX_SEC) {
    while (rounds < gids.length) {
      const gid = gids[rounds];
      rounds++;
      for (let i = 0; i < N; i++) {
        cookie = '';
        await post('/api/auth/dev-login', { discordId: '7000000000000' + String(100 + i) });
        await post('/api/game/bet', { amount: STAKE, roundId: gid });
      }
      process.stdout.write('\r   已下注 ' + rounds + ' 局…');
      pending = { gid, nextTry: 0, done: new Set() };
    }
    // 起飞后开始尝试逃跑：每 200ms 换一个玩家试，直到全员逃完或该局已爆
    if (pending && Date.now() >= pending.nextTry) {
      pending.nextTry = Date.now() + 200;
      if (ticks.has(pending.gid)) {
        for (let i = 0; i < N; i++) {
          if (pending.done.has(i)) continue;
          const r = await tryEscape(pending.gid, i);
          if (r.status === 200 && r.body?.ok) {
            pending.done.add(i);          // 逃成功，这位不用再试
            process.stdout.write('\r   ✅ 逃成功 ' + r.body.rate + 'x（第 ' + rounds + ' 局）    ');
          } else if (r.body?.code === 10010 || r.body?.code === 10007) {
            pending.done.add(i);          // 已爆 / 已操作过，这局结束
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  process.stdout.write('\n');
  // 等最后一局飞完再取账，否则 escape 流水可能还没落库
  console.log('   等最后一局结算…');
  await new Promise((r) => setTimeout(r, (MAX_SEC % 2 === 0 ? 12 : 0) * 1000 + 20000));
  ws.close();

  const after = snap();
    const d = (k) => (after.log[k]?.s || 0) - (before.log[k]?.s || 0);

    console.log('\n=== 真实样本守恒断言 ===');
    console.log('  处理局数        :', rounds);
    console.log('  bets 表注单增量  :', after.bets - before.bets);
    console.log('  bet   流水      :', d('bet').toFixed(2));
    console.log('  boom  流水      :', d('boom').toFixed(2));
    console.log('  escape 流水     :', d('escape').toFixed(2));
    console.log('  三项净额        :', (d('bet') + d('boom') + d('escape')).toFixed(2));
    console.log('  用户总余额变化  :', (after.users - before.users).toFixed(2));

    // ⚠️ 关键：先断言样本非空，再谈守恒。空样本下 0<=0 恒真，是假绿。
    ok(after.bets - before.bets > 0, '样本非空（bets 表真的有注单）', `+${after.bets - before.bets} 行`);
    if (after.bets - before.bets <= 0) {
      console.error('\n   ⛔ 样本为空，守恒断言无效（0 <= 0 恒真）。这不是通过，是没测到东西。');
      process.exit(1);
    }
    ok(after.bets - before.bets >= 6, '样本量够跑结算分支', `${after.bets - before.bets} 注单`);
    ok(d('boom') === 0, '爆点结算流水恒为 0（爆掉退不了本金）', d('boom').toFixed(2));
    // ⚠️ escape 必须 > 0：只验「输」不验「赢」，闸门等于只跑了一半。
    // escape 派奖才是唯一会把钱从池子搬给玩家的路径，它为 0 就没验到。
    ok(d('escape') > 0, '逃跑派奖路径真的执行过（escape 流水 > 0）', d('escape').toFixed(2));
    if (d('escape') <= 0) {
      console.error('   ⛔ escape = 0：赢家结算分支没跑到。这道闸门只验了输家，不能算通过。');
      process.exit(1);
    }
    ok(d('bet') + d('boom') + d('escape') <= 0, 'bet+boom+escape <= 0（没有凭空造币）',
       (d('bet') + d('boom') + d('escape')).toFixed(2));

    /**
     * 逐用户对账：users.coins == SUM(coin_logs.delta)。
     *
     * ⚠️ 别用「总余额变化 == bet+boom+escape」当守恒判据 —— 那条会把
     * initial_grant / checkin 落在账外，于是明明一分钱没多没少也会报
     * ⚠️ 不一致（实测就是这样：6 个会话的 initial_grant +7000 和 1 笔
     * checkin +100 没被计入，看起来像漏钱）。正确口径是把每个用户自己的
     * 余额和他自己的全部流水对起来 —— 发放类流水本来就该让余额涨，
     * 那不是凭空造币，是有凭证的外部注资。
     */
    const recon = db.prepare(`
      SELECT u.id, u.coins,
             COALESCE((SELECT SUM(delta) FROM coin_logs WHERE user_id = u.id), 0) AS logged
      FROM users u`).all();
    const bad = recon.filter((u) => Math.abs(u.coins - u.logged) > 0.005);
    ok(bad.length === 0, `逐用户对账：coins == SUM(delta)（${recon.length} 个用户）`,
       bad.length ? JSON.stringify(bad.slice(0, 3)) : `最大差额 ${Math.max(0, ...recon.map((u) => Math.abs(u.coins - u.logged))).toFixed(4)}`);

    const grantTotal = db.prepare(`SELECT COALESCE(SUM(delta),0) s FROM coin_logs WHERE reason NOT IN ('bet','boom','escape')`).get().s;
    console.log(`  外部发放合计（initial_grant/checkin 等，有凭证的注资）: ${grantTotal.toFixed(2)}`);

    console.log('\n' + (process.exitCode ? '❌ 有断言失败' : '✅ 守恒测试在真实样本上通过'));
})().catch((e) => { console.error('脚本异常：', e); process.exit(1); });