'use strict';
/**
 * 爆点逃跑 · 主进程
 * 零外部依赖（除 ws）：HTTP + WebSocket + 游戏引擎 + Discord 认证 + 后台
 */
require('./env').load();

const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const db = require('./db');
const { Engine } = require('./engine');
const { Router, json, serveStatic, parseCookies, parseQuery } = require('./http-util');
const api = require('./routes/api');
const admin = require('./routes/admin');

const PORT = Number(process.env.PORT || 8080);
const WS_PORT = Number(process.env.WS_PORT || 9501);
const PUBLIC = path.join(__dirname, '..', 'public');
const ADMIN_PUBLIC = path.join(__dirname, '..', 'admin');

/* ---------- 启动 ---------- */
db.init();
db.seedSettings();
require('./activities').seed();   // 小活动插件：按 defaultEnabled 落库
seedRobots();
seedSite();

const engine = new Engine(broadcast);
// sendTo：定向推送（逃跑成功只通知本人），在连接处理里回填
engine.sendTo = (userId, obj) => sendTo(userId, obj);

const router = new Router();
api.register(router, engine);
admin.register(router);
router._engine = engine;   // 后台改设置时让引擎立即重载

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ port: WS_PORT, path: '/ws' });
const clients = new Set();

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === 1) { try { ws.send(msg); } catch (_) {} }
  }
}

/**
 * 定向发送：只发给某个 userId 的所有连接。
 * 用途：逃跑成功这类「只有本人该看到」的事件（toast / 余额 / 按钮锁定）。
 * 之前只能 broadcast(me:true)，结果所有人都会收到自己的「逃跑成功」提示，
 * 并且别人的逃跑会把自己的逃跑按钮也锁掉。
 * ws.uid 在前端握手 /api/me 带 cookie 后由 hello 流程写入。
 */
function sendTo(userId, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.uid === Number(userId) && ws.readyState === 1) {
      try { ws.send(msg); } catch (_) {}
    }
  }
}
router._online = 0;

wss.on('connection', (ws, req) => {
  clients.add(ws);
  router._online = clients.size;
  // 绑定用户身份：把 bd_sid cookie 解析成 ws.uid，之后 sendTo(userId) 才能只发给本人。
  // 之前 socket 完全不认人，只能 broadcast，导致「逃跑成功」被发给所有人。
  try {
    const u = api.currentUser(req);
    ws.uid = u ? u.id : 0;
  } catch (_) { ws.uid = 0; }
  // 立即同步当前状态，新加入的客户端能立刻看到进行中的局
  try {
    const snap = { type: 'hello', online: clients.size, jackpot: Math.round((Number(db.getSetting('jackpot', 0)) || 0) * 100) / 100 };
    const cur = engine.current;
    if (cur) {
      const now = Date.now();
      // 飞行中：要带上剩余飞行时间和已飞秒数，前端才能把曲线/火箭画对，
      // 否则中途加入的玩家只看到「飞行中」却没有任何进度（看起来像假死）。
      let flightMs = 0, flightStart = 0, elapsedSec = 0;
      if (cur.status === 'flying' && cur.flightStart) {
        elapsedSec = (now - cur.flightStart) / 1000;
        flightMs = Math.max(0, cur.flightTotalMs - (now - cur.flightStart));
        // ⚠️ 之前这里写 flightStart: flightStart（永远是 0），
        // 前端拿它算「已飞时间」会得到 0 → 中途加入的玩家曲线和火箭不动，
        // 看起来像卡死。必须传真实起飞时刻。
        flightStart = cur.flightStart;
      }
      snap.current = {
        gid: cur.id,
        status: cur.status,
        rate: cur.rate,
        jackpot: Math.round((Number(db.getSetting('jackpot', 0)) || 0) * 100) / 100,
        flightMs: flightMs,
        flightStart: flightStart,
        elapsedSec: elapsedSec,
        // ⚠️ 必须带绝对截止时间。缺了它，onJoinCurrent 会退回
        // 「Date.now() + 10000」自己估倒计时 —— 用户反馈「刷新后没有倒计时」。
        betEndAt: cur.betEndAt,
        lockEndAt: cur.lockEndAt,
        // ⚠️ 必须带上「我自己在这局下注了没」。缺了它，刷新后的前端
        // hasBet 恒为 false → 按钮显示「未下注」且点击走下注分支 →
        // 服务端返回「本期已下注」→ 用户反馈「下注后无法逃跑」。
        hasBet: engine.hasBetInRound ? engine.hasBetInRound(ws.uid) : false,
        // 已产生的下注列表，让中途加入的玩家也能看到本局谁下了多少
        bets: engine.currentBets ? engine.currentBets() : [],
      };
    }
    ws.send(JSON.stringify(snap));
  } catch (_) {}
  ws.on('close', () => { clients.delete(ws); router._online = clients.size; });
  ws.on('error', () => { clients.delete(ws); router._online = clients.size; });
  ws.on('message', (raw) => {
    // 客户端心跳
    try { const d = JSON.parse(raw.toString()); if (d && d.type === 'ping') ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {}
  });
});

/* ---------- HTTP ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  // 查询串解析（?by=coins / ?limit=50 等）。之前缺这一步，路由里用
  // req.query.get() 直接抛 undefined.get → 接口 500。
  req.query = parseQuery(url.search);

  // CORS（Activity 内嵌需要）
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bot-Secret');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    const m = router.match(req.method, pathname);
    if (m) {
      router._online = clients.size;
      const out = await m.handler(req, res, m);
      if (out !== undefined && !res.headersSent) json(res, 200, out);
      return;
    }

    // 静态资源
    if (req.method === 'GET' || req.method === 'HEAD') {
      // 后台：/admin 与 /admin/ 都直接返回 index.html
      if (pathname === '/admin' || pathname === '/admin/') {
        if (serveStatic(res, ADMIN_PUBLIC, '/index.html')) return;
      } else if (pathname.startsWith('/admin/')) {
        if (serveStatic(res, ADMIN_PUBLIC, pathname.slice('/admin'.length))) return;
        if (serveStatic(res, ADMIN_PUBLIC, pathname.slice('/admin'.length) + '.html')) return;
        return serveStatic(res, ADMIN_PUBLIC, '/index.html');
      }
      if (serveStatic(res, PUBLIC, pathname)) return;
      // SPA 回退
      const p = pathname === '/' ? '/index.html' : pathname;
      if (fs.existsSync(path.join(PUBLIC, p)) && !path.extname(p)) {
        if (serveStatic(res, PUBLIC, p)) return;
      }
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    // 未匹配的 API 路径返回 404 JSON，不要走 SPA 重定向
    if (pathname.startsWith('/api/') || pathname.startsWith('/admin/api/')) {
      return json(res, 404, { error: 'not found' });
    }
    // 其余未知路径：明确 404，不要 302 到 / （否则用户看到"跳到游戏界面"）
    json(res, 404, { error: 'not found', path: pathname });
  } catch (e) {
    console.error('[http]', pathname, e);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

/* ---------- 初始数据 ---------- */

/** 每日高倍活动的默认设置（只在缺失时写入，不覆盖后台改过的值） */
function seedDailySettings() {
  const { CFG_DEFAULT } = require('./daily-activity');
  for (const [k, v] of Object.entries(CFG_DEFAULT)) {
    if (db.getSetting('daily_' + k, null) == null) db.setSetting('daily_' + k, v);
  }
  // guild 从 .env 读（bot 加入的服务器）
  const g = process.env.BOT_GUILD_ID || process.env.GUILD_ID || '';
  if (g && db.getSetting('daily_guild_id', '') !== g) db.setSetting('daily_guild_id', g);
  if (process.env.DISCORD_EVENT_CHANNEL_ID) {
    db.setSetting('daily_channel_id', process.env.DISCORD_EVENT_CHANNEL_ID);
  }
}

function seedRobots() {
  const c = db.get().prepare('SELECT COUNT(*) c FROM robots').get().c;
  if (c > 0) return;
  const names = [
    'Luna', 'Nova', 'Kai', 'Zoe', 'Rex', 'Mika', 'Ash', 'Juno', 'Vex', 'Orbit',
    'Pixel', 'Echo', 'Blaze', 'Nimbus', 'Cyan', 'Quark', 'Vega', 'Comet', 'Drift', 'Lyra',
    'Onyx', 'Zephyr', 'Iris', 'Flux', 'Halo', 'Axel', 'Nebula', 'Surge', 'Vertex', 'Wisp',
  ];
  const ins = db.get().prepare('INSERT INTO robots (name,avatar,active) VALUES (?,?,1)');
  db.tx(() => { for (const n of names) ins.run(n, ''); });
  console.log(`[seed] 已创建 ${names.length} 个默认机器人`);
}

function seedSite() {
  const defaults = {
    signup_bonus: '0',      // 已废弃：初始金币统一走 INITIAL_COINS，这里必须为 0 否则重复发放
    site_name: '爆点逃跑',
    announce: '',
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (db.getSetting(k) === null) db.setSetting(k, v);
  }
}

/* ---------- 启动 ---------- */
server.listen(PORT, () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────┐');
  console.log('  │  爆点逃跑 · Baodian                       │');
  console.log('  └─────────────────────────────────────────┘');
  console.log(`  游戏:    http://127.0.0.1:${PORT}/`);
  console.log(`  后台:    http://127.0.0.1:${PORT}/admin/`);
  console.log(`  Discord: ${process.env.DISCORD_CLIENT_ID ? `已配置 (${process.env.DISCORD_CLIENT_ID})` : '未配置 DISCORD_CLIENT_ID'}`);
  console.log(`  WebSocket: ws://127.0.0.1:${WS_PORT}/ws`);
  console.log('');
  engine.start();
  // 每日高倍活动调度器（北京时间 18-23 随机一小时，倍率 1x-100x）
  const { daily } = require('./daily-activity');
  seedDailySettings();
  daily.start();
});

function shutdown() {
  console.log('\n正在关闭...');
  engine.stop();
  try { wss.close(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
