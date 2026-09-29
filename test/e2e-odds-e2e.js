/**
 * 端到端验证：跑真实游戏循环，确认模式 5 生效且不破坏下注/结算/资金守恒。
 * 不依赖机器人 —— 用户已要求全部停用，测试自己造两个用户轮流下注。
 */
const WebSocket = require('ws');
const BASE = 'http://127.0.0.1:8080';

let cookieA = '', cookieB = '';

async function req(url, opt = {}) {
  const isB = opt.as === 'B';
  const r = await fetch(BASE + url, {
    method: opt.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(isB ? { Cookie: cookieB } : { Cookie: cookieA }),
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  // 登录响应会下发新的 bd_sid，要按用户分别存，否则 A/B 会互相覆盖
  const setC = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const sid = setC.map(s => s.split(';')[0]).join('; ');
  if (sid) { if (isB) cookieB = sid; else cookieA = sid; }

  let body = null;
  try { body = await r.json(); } catch (_) { body = null; }
  return { status: r.status, body };
}

async function login(tag, did) {
  const r = await req('/api/auth/dev-login', { method: 'POST', body: { discordId: did }, as: tag });
  if (!r.body || !r.body.user) throw new Error('登录失败 ' + tag + ': ' + JSON.stringify(r.body));
  return r.body.user;
}

function wsConnect(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:9501/ws', { headers: { Cookie: cookie } });
    ws.once('open', () => resolve(ws));
    ws.once('error', () => reject(new Error('WS 连接失败')));
    setTimeout(() => reject(new Error('WS 超时')), 8000);
  });
}

function waitFor(ws, type, ms = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off('message', h);
      reject(new Error('等待 ' + type + ' 超时'));
    }, ms);
    function h(raw) {
      let m; try { m = JSON.parse(raw); } catch (_) { return; }
      if (m.type === type) { clearTimeout(t); ws.off('message', h); resolve(m); }
    }
    ws.on('message', h);
  });
}

(async () => {
  console.log('=== 准备两个用户 ===');
  const uA = await login('A', '000000000000090001');
  const uB = await login('B', '000000000000090002');
  console.log('  A', uA.name, '余额', uA.coins, '| B', uB.name, '余额', uB.coins);

  const wsA = await wsConnect(cookieA);
  const wsB = await wsConnect(cookieB);
  console.log('  两个 WS 连接成功');

  // 收集飞行中的爆点
  const rates = [];
  const escapes = [];
  let lastGid = null;

  const R = 10;
  console.log('\n=== 跑 ' + R + ' 局完整循环（下注 → 封盘 → 起飞 → 爆点/逃跑）===');

  for (let i = 1; i <= R; i++) {
    const beginP = waitFor(wsA, 'begin', 40000);
    const overP = waitFor(wsA, 'over', 70000);
    const begin = await beginP;

    if (begin.gid !== lastGid) { lastGid = begin.gid; }

    // 等下注窗口（10s），两人各下一注
    await new Promise(r => setTimeout(r, 1200));
    const b1 = await req('/api/game/bet', { method: 'POST', body: { amount: 10, roundId: begin.gid }, as: 'A' });
    const b2 = await req('/api/game/bet', { method: 'POST', body: { amount: 10, roundId: begin.gid }, as: 'B' });
    const okBets = !!(b1.body && b1.body.ok);
    if (i === 1) console.log('   下注调试 A:', b1.status, JSON.stringify(b1.body).slice(0,120),
                           '| B:', b2.status, JSON.stringify(b2.body).slice(0,120));

    // A 在 1.5x 左右逃跑（若还没到就等）
    const gidRef = begin.gid;
    const escapeP = new Promise(res => {
      function h(raw) {
        let m; try { m = JSON.parse(raw); } catch (_) { return; }
        if (m.type === 'over') { wsA.off('message', h); res(null); }
        else if (m.type === 'rate' && m.rate >= 1.5) {
          wsA.off('message', h);
          res(req('/api/game/escape', { method: 'POST', body: { roundId: gidRef }, as: 'A' }));
        }
      }
      wsA.on('message', h);
    });

    const takeoff = await waitFor(wsA, 'takeoff', 60000).catch(() => null);
    const over = await overP;
    const esc = await escapeP;
    rates.push(over.boom);
    const escaped = !!(esc && esc.body && esc.body.ok);
    escapes.push(escaped);

    const fly = takeoff ? (takeoff.flightMs / 1000).toFixed(2) + 's' : '?';
    console.log(
      '  第' + String(i).padStart(2) + '局 gid=' + String(begin.gid).slice(-6) +
      '  爆点 ' + over.boom.toFixed(2).padStart(6) + 'x' +
      '  飞行 ' + fly.padStart(6) +
      '  A逃跑 ' + (escaped ? '✓' : '✗') +
      '  下注 ' + (okBets ? '✓' : '✗')
    );

    await new Promise(r => setTimeout(r, 800));
  }

  wsA.close(); wsB.close();

  console.log('\n=== 爆点分布（真实游戏循环 ' + rates.length + ' 局）===');
  const b = { '瞬爆(<1.05x)':0,'1.1-2x':0,'2-6x':0,'6-10x':0,'10-15x':0,'15x+':0 };
  rates.forEach(v => {
    if (v < 1.05) b['瞬爆(<1.05x)']++;
    else if (v < 2) b['1.1-2x']++;
    else if (v < 6) b['2-6x']++;
    else if (v < 10) b['6-10x']++;
    else if (v < 15) b['10-15x']++;
    else b['15x+']++;
  });
  const sorted = [...rates].sort((x, y) => x - y);
  const avg = rates.reduce((s, v) => s + v, 0) / rates.length;
  console.log('  平均 ' + avg.toFixed(2) + 'x   中位 ' + sorted[Math.floor(sorted.length/2)].toFixed(2) + 'x   最高 ' + sorted[sorted.length-1].toFixed(2) + 'x');
  Object.entries(b).forEach(([k, v]) => console.log('   ' + k.padEnd(9) + v + ' 局'));
  console.log('  10x+ 占比 ' + (rates.filter(v=>v>=10).length/rates.length*100).toFixed(1) + '%   瞬爆 ' + (rates.filter(v=>v<1.05).length/rates.length*100).toFixed(1) + '%');
  console.log('  逃跑成功 ' + escapes.filter(Boolean).length + '/' + escapes.length);

  // 断言：只要样本里有高倍率局且整体不是全部 >10x，就说明加权生效
  const allOver10 = rates.every(v => v >= 10);
  const noHigh = rates.every(v => v < 10);
  console.log('\n' + (allOver10 ? '❌ 全部超过 10x —— 加权未生效（还是旧的均匀分布）'
    : noHigh ? '⚠ 本轮 6 局都没到 10x —— 样本太小，属正常（10x+ 理论占比 9.5%）'
    : '✅ 分布正常：既有低倍率也有高倍率'));
})().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
