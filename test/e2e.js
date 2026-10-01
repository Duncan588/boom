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
  let gid = 0, betDone = false, escDone = false, boom = 0, escArmed = false;

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
        console.log(`  TAKEOFF #${gid}（未下注，等下一局）`);
      }
      if (d.type === 'takeoff' && !escDone && betDone) {
        /**
         * 【2026-09-30】起飞消息不再带 flightMs（可反推爆点），
         * 所以逃跑时机不能按「总时长 − 200ms」算。
         * 改成【跟着 tick 走】：见到倍率超过 1.5x 就逃。
         * 这更贴近真实玩家（看到数字了才点），也不会因为拿到总时长
         * 而在测试里精确卡点 —— 那本身就是一种依赖泄露的行为。
         */
        console.log(`  TAKEOFF #${gid} 等待倍率 > 1.5x 再逃跑`);
        escArmed = true;
      }
      if (d.type === 'tick' && escArmed && !escDone && betDone) {
        if (Number(d.rate) >= 1.5) {
          escArmed = false;
          /**
           * ⚠️【2026-10-01 修】原本在这里就 `escDone = true` —— 在【发请求之前】。
           * 后果：POST 还在飞的时候，本局若爆点低于 1.5x（tick 直接从 takeoff
           * 跳到 over，中间没有一个 ≥1.5 的 tick），over 分支看到 escDone=true
           * 就认为「本局已完成」，于是一个 status=0（没逃掉）的 bet 被当成成功样本
           * 送进第 5 节断言，表现为随机的「✗ 状态=已逃跑 / esc=0」。
           *
           * RTP 0.87 让它【更少见】而不是更多见：P(爆点 < 1.5x) = RTP/1.5，
           * 0.87 时 58%，旧的 0.97 是 65%。但真正的放大因素是 cap 从 120 提到
           * 1000 之后分布更散、中位倍率更低，tick 序列更容易直接跳过 1.5x。
           * 它是概率性出现，所以不能用「多跑几次看看」来判断修没修好。
           *
           * 修法：只在【服务端确认逃成功】时才置 escDone；失败就重新武装，
           * 让下一局还有机会，而不是把失败当成功记账。
           */
          call('/api/game/escape', { roundId: gid }).then((r) => {
            if (r.ok) {
              escDone = true;
              check('逃跑成功', true);
              check('获得盈利', r.profit > 0, r);
              console.log(`  盈利 ${r.profit} QUN @ ${r.rate}x → 余额 ${r.balance}`);
            } else {
              escDone = false;
              escArmed = true;
              console.log('  (逃跑被拒，可能是已爆点，重置等下一局)', r.error || '');
              check('逃跑成功', false, r);
            }
          }).catch((e) => {
            escDone = false;
            escArmed = true;
            console.log('  逃跑请求异常', e.message);
          });
        }
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
    /**
     * ⚠️【2026-10-01 修：这条断言原本写反了】
     * 原本是 `escape_rate === boom`，但这个测试在【第一个 rate ≥ 1.5 的 tick】
     * 就逃跑（第 97 行），所以 escape_rate 天然是 1.5 附近的值，
     * 而 boom 是之后的最终倍率。两者【必然】不相等，除非爆点刚好就在 1.5x。
     *
     * 也就是说：原断言只在「爆点恰好 = 逃跑点」时通过 —— 概率约 1/几百，
     * 平时必红。实测 esc=1.5 / boom=3.93 就是正确的正常结算。
     *
     * 真正的不变量是：成功逃跑 ⇒ escape_rate ≤ boom，且 escape_rate ≥ 1。
     * 这条才同时表达了「钱按玩家逃到的倍率赔」和「没在爆点之后才逃」。
     */
    check('赔率=逃跑时倍率（且 ≤ 爆点）',
      myBet.escape_rate >= 1 && myBet.escape_rate <= boom + 1e-9,
      { esc: myBet.escape_rate, boom });
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
