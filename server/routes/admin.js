'use strict';
/** 后台管理 API —— 取代原 /simple 后台（597 行 GloablController）
 *
 *  登录方式：Discord OAuth2，白名单读 .env 的 ADMIN_DISCORD_IDS
 *  本地无 Discord 时可用 POST /admin/api/dev-login（仅 127.0.0.1）
 */
const crypto = require('crypto');
const db = require('../db');
const activities = require('../activities');
const { round2 } = require('../game-logic');
const { json, readBody, parseCookies, setCookie, clearCookie } = require('../http-util');

const COOKIE = 'bd_admin';
const admins = new Map(); // sid -> {exp, id, name}
// https 部署（Lax 在 Discord 跨站 iframe 里不会被携带，Safari 还要求 Partitioned）→ None; Secure; Partitioned
const IS_HTTPS = process.env.COOKIE_SECURE === '1' || /^https:\/\//.test(process.env.APP_URL || '');
const COOKIE_OPTS = IS_HTTPS
  ? { sameSite: 'None', secure: true, partitioned: true }
  : { sameSite: 'Lax', secure: false, partitioned: false };

function isAuthed(req) {
  // 优先用后台会话
  const sid = parseCookies(req)[COOKIE];
  if (sid) {
    const s = admins.get(sid);
    if (s && s.exp >= Date.now()) return true;
  }
  // 兜底：前台已登录且在白名单内，直接放行（免二次登录）
  const api = require('./api');
  const u = api.currentUser(req);
  if (u && u.discord_id && isAdminDiscordId(u.discord_id)) return true;
  return false;
}

/** 当前管理员身份（后台会话优先，其次前台白名单用户） */
function whoAmI(req) {
  const sid = parseCookies(req)[COOKIE];
  const s = sid ? admins.get(sid) : null;
  if (s && s.exp >= Date.now()) return { id: s.id, name: s.name };
  const api = require('./api');
  const u = api.currentUser(req);
  if (u && u.discord_id && isAdminDiscordId(u.discord_id)) {
    return { id: u.discord_id, name: u.global_name || u.username };
  }
  return null;
}

function requireAdmin(req, res) {
  if (!isAuthed(req)) { json(res, 401, { error: '请先登录后台' }); return false; }
  return true;
}

/* ---------- Discord 管理员白名单（读 .env） ---------- */

/** 允许登录后台的 Discord 用户 ID 列表（逗号分隔） */
function adminIds() {
  return String(process.env.ADMIN_DISCORD_IDS || process.env.DISCORD_ADMIN_IDS || '')
    .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

function isAdminDiscordId(id) {
  const list = adminIds();
  if (!list.length) return false;
  return list.includes(String(id));
}

/** 给已通过白名单校验的 Discord 用户发后台会话（由 /auth/callback 调用） */
function grantSession(res, prof) {
  const sid = crypto.randomBytes(24).toString('base64url');
  admins.set(sid, { exp: Date.now() + 86400 * 7 * 1000, id: prof.discordId, name: prof.globalName || prof.username });
  // 与 bd_sid 同样的跨站 iframe 问题：Discord 小活动里 Lax 不会被携带。
  setCookie(res, COOKIE, sid, { maxAge: 86400 * 7, httpOnly: true, ...COOKIE_OPTS });
  return sid;
}

function register(router) {
  /* ---- Discord 登录 ----
   * 真正的 OAuth 流程走 /auth/admin → /auth/callback（与前台共用同一个回调地址，
   * 避免在 Discord 后台配置第二条 redirect URI）。这里只做转发。
   */
  router.get('/admin/api/login', (req, res) => {
    res.writeHead(302, { Location: '/auth/admin' });
    res.end();
  });
  router.get('/admin/api/callback', (req, res) => {
    res.writeHead(302, { Location: '/auth/admin' });
    res.end();
  });

  // 无 Discord 环境时的本地兜底（仅 localhost）
  router.post('/admin/api/dev-login', async (req, res) => {
    const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
    if (!['127.0.0.1', '::1', 'localhost'].includes(ip)) {
      return json(res, 403, { error: '仅限本地调试' });
    }
    const list = adminIds();
    const id = list[0];
    if (!id) return json(res, 400, { error: '未配置 ADMIN_DISCORD_IDS' });
    const sid = crypto.randomBytes(24).toString('base64url');
    admins.set(sid, { exp: Date.now() + 86400 * 7 * 1000, id, name: 'local-dev' });
    setCookie(res, COOKIE, sid, { maxAge: 86400 * 7, httpOnly: true, ...COOKIE_OPTS });
    json(res, 200, { ok: true, id });
  });

  router.post('/admin/api/logout', (req, res) => {
    const sid = parseCookies(req)[COOKIE];
    if (sid) admins.delete(sid);
    clearCookie(res, COOKIE);
    json(res, 200, { ok: true });
  });

  router.get('/admin/api/me', (req, res) => {
    const who = whoAmI(req);
    if (!who) return json(res, 401, { error: '未登录' });
    json(res, 200, { id: who.id, name: who.name, mode: 'discord', configured: adminIds().length > 0 });
  });

  /* ---- 概览 ---- */
  router.get('/admin/api/stats', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const g = (sql, ...p) => db.get().prepare(sql).get(...p);
    const users = g('SELECT COUNT(*) c FROM users').c;
    const today = new Date().toISOString().slice(0, 10);
    const newToday = g("SELECT COUNT(*) c FROM users WHERE created_at LIKE ?", `${today}%`).c;
    const rounds = g('SELECT COUNT(*) c FROM rounds').c;
    const bets = g('SELECT COUNT(*) c FROM bets').c;
    const wagered = g('SELECT COALESCE(SUM(amount),0) s FROM bets').s;
    const wageredToday = g("SELECT COALESCE(SUM(amount),0) s FROM bets WHERE created_at LIKE ?", `${today}%`).s;
    const esc = g('SELECT COUNT(*) c FROM bets WHERE status = 1').c;
    const boom = g('SELECT COUNT(*) c FROM bets WHERE status = 2').c;
    const paid = g("SELECT COALESCE(SUM(delta),0) s FROM coin_logs WHERE delta > 0").s;
    json(res, 200, {
      users, newToday, rounds, bets, wagered: round2(wagered), wageredToday: round2(wageredToday),
      escaped: esc, boomed: boom, escapeRate: (esc + boom) ? round2((esc / (esc + boom)) * 100) : 0,
      coinsInCirculation: round2(g('SELECT COALESCE(SUM(coins),0) s FROM users').s),
      jackpot: round2(Number(db.getSetting('jackpot', 0)) || 0),
      online: router._online || 0,
    });
  });

  /* ---- 用户 ---- */
  router.get('/admin/api/users', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const q = (new URL(req.url, 'http://x').searchParams.get('q') || '').trim();
    const page = Math.max(1, Number(new URL(req.url, 'http://x').searchParams.get('page') || 1));
    const size = 50;
    let sql = `SELECT us.*, (SELECT COUNT(*) FROM bets b WHERE b.user_id = us.id) bets
               FROM users us WHERE 1=1`;
    const args = [];
    if (q) { sql += ' AND (us.username LIKE ? OR us.global_name LIKE ? OR us.discord_id LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const total = db.get().prepare(sql.replace(/SELECT us\.\*.*?FROM users us/, 'SELECT COUNT(*) c FROM users us')).get(...args).c;
    const rows = db.get().prepare(`${sql} ORDER BY us.id DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
    json(res, 200, { total, page, list: rows.map((u) => ({
      id: u.id, discordId: u.discord_id, name: u.global_name || u.username,
      avatar: u.avatar, coins: round2(u.coins), frozen: !!u.frozen, bets: u.bets,
      createdAt: u.created_at, lastSeen: u.last_seen_at,
    })) });
  });

  // 发放 QUN（单人或批量）
  router.post('/admin/api/grant', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = await readBody(req);
    const amount = round2(Number(b.amount));
    if (!amount) return json(res, 400, { error: '请输入数量' });
    const reason = b.reason || 'admin_grant';
    let targets = [];
    if (Array.isArray(b.userIds) && b.userIds.length) targets = b.userIds;
    else if (b.discordId) targets = String(b.discordId).split(',').map((s) => s.trim()).filter(Boolean);
    if (!targets.length) return json(res, 400, { error: '请选择用户' });
    const out = [];
    for (const t of targets) {
      const u = typeof t === 'number' ? db.getUserById(t) : db.getUserByDiscord(String(t));
      if (!u) { out.push({ id: t, ok: false }); continue; }
      try {
        const bal = db.addCoins(u.id, amount, reason, b.note || null);
        out.push({ id: u.id, name: u.global_name || u.username, ok: true, balance: round2(bal) });
      } catch (e) { out.push({ id: u.id, ok: false, error: e.message }); }
    }
    json(res, 200, { results: out });
  });

  router.post('/admin/api/user/freeze', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = await readBody(req);
    db.get().prepare('UPDATE users SET frozen = ? WHERE id = ?').run(b.frozen ? 1 : 0, Number(b.userId));
    json(res, 200, { ok: true });
  });

  router.post('/admin/api/user/coins', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = await readBody(req);
    const u = db.getUserById(Number(b.userId));
    if (!u) return json(res, 404, { error: '用户不存在' });
    try {
      const bal = db.addCoins(u.id, round2(Number(b.amount)), b.reason || 'admin_adjust', null);
      json(res, 200, { ok: true, balance: round2(bal) });
    } catch (e) { json(res, 400, { error: e.message }); }
  });

  router.get('/admin/api/user/logs', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const uid = Number(new URL(req.url, 'http://x').searchParams.get('userId'));
    const rows = db.get().prepare('SELECT * FROM coin_logs WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(uid);
    json(res, 200, { list: rows });
  });

  /* ---- 订单 / 奖期 ---- */
  router.get('/admin/api/bets', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const p = new URL(req.url, 'http://x').searchParams;
    const page = Math.max(1, Number(p.get('page') || 1));
    const rows = db.get().prepare(
      `SELECT b.*, us.global_name, us.username, us.discord_id, r.rate AS boom
       FROM bets b JOIN users us ON us.id = b.user_id
       LEFT JOIN rounds r ON r.id = b.round_id
       ORDER BY b.id DESC LIMIT 100 OFFSET ?`
    ).all((page - 1) * 100);
    json(res, 200, { list: rows.map((b) => ({
      id: b.id, round: b.round_id, user: b.global_name || b.username,
      discordId: b.discord_id, amount: b.amount, status: b.status,
      rate: b.escape_rate, profit: b.profit, boom: b.boom, at: b.created_at,
    })) });
  });

  router.get('/admin/api/rounds', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = db.get().prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM bets b WHERE b.round_id = r.id) bets,
              (SELECT COALESCE(SUM(amount),0) FROM bets b WHERE b.round_id = r.id) pot
       FROM rounds r ORDER BY r.id DESC LIMIT 60`
    ).all();
    json(res, 200, { list: rows });
  });

  /* ---- 机器人 ---- */
  router.get('/admin/api/robots', (req, res) => {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { list: db.allRobots() });
  });

  router.post('/admin/api/robots', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = await readBody(req);
    if (b.action === 'add') {
      if (!b.name) return json(res, 400, { error: '缺少昵称' });
      db.get().prepare('INSERT INTO robots (name,avatar,active) VALUES (?,?,1)').run(String(b.name).slice(0, 32), b.avatar || '');
    } else if (b.action === 'toggle') {
      db.get().prepare('UPDATE robots SET active = ? WHERE id = ?').run(b.active ? 1 : 0, Number(b.id));
    } else if (b.action === 'delete') {
      db.get().prepare('DELETE FROM robots WHERE id = ?').run(Number(b.id));
    }
    json(res, 200, { ok: true, list: db.allRobots() });
  });

  /* ---- 设置：白名单管理（写回 .env 由人工确认） ---- */
  router.get('/admin/api/admins', (req, res) => {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { ids: adminIds() });
  });

  /* ---- 读取游戏参数 ---- */
  router.get('/admin/api/settings', (req, res) => {
    if (!requireAdmin(req, res)) return;
    json(res, 200, { settings: db.allSettings() });
  });

  /* ---- 游戏参数保存后立即让引擎重载 ---- */
  router.post('/admin/api/settings', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = await readBody(req);
    for (const [k, v] of Object.entries(b)) db.setSetting(k, v);
    if (router._engine && typeof router._engine.refreshSettings === 'function') {
      router._engine.refreshSettings();
    }
    json(res, 200, { ok: true, settings: db.allSettings() });
  });

  /* ---------- 转账：全站记录 + 管理员代发 ---------- */

  router.get('/admin/api/transfers', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const limit = Math.min(200, Math.max(1, Number(req.query.get('limit')) || 50));
    // 只看转出侧（transfer_out），接收侧在同一条记录的 to 里，避免重复
    const rows = db.get().prepare(
      `SELECT cl.id, cl.delta, cl.balance, cl.created_at,
              uf.global_name AS from_name, uf.username AS from_username, uf.discord_id AS from_id,
              ut.global_name AS to_name,   ut.username AS to_username,   ut.discord_id AS to_id
       FROM coin_logs cl
       JOIN users uf ON uf.id = cl.user_id
       LEFT JOIN users ut ON ut.id = CAST(cl.ref_id AS INTEGER)
       WHERE cl.reason = 'transfer_out'
       ORDER BY cl.id DESC LIMIT ?`
    ).all(limit);
    json(res, 200, {
      list: rows.map((r) => ({
        id: r.id,
        at: r.created_at,
        amount: Math.abs(r.delta),
        balance: r.balance,
        fromId: r.from_id, fromName: r.from_name || r.from_username,
        toId: r.to_id, toName: r.to_name || r.to_username,
      })),
    });
  });

  // 管理员代发：从「平台」账户转给指定用户。
  // 平台没有真实用户，所以付款方用 ADMIN_TRANSFER_FROM（默认用户 id=1），
  // 金额同样走 db.transfer 的单事务，双侧都有流水。
  router.post('/admin/api/transfer', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = await readBody(req);
    const toId = String(b.to || '').trim();
    const amount = Number(b.amount);
    if (!toId) return json(res, 400, { error: '缺少收款方 Discord ID' });
    if (!Number.isFinite(amount) || amount <= 0) return json(res, 400, { error: '金额无效' });

    const target = db.getUserByDiscord(toId);
    if (!target) return json(res, 404, { error: '收款方不存在或还未登录过' });

    const fromId = Number(process.env.ADMIN_TRANSFER_FROM_ID || 1);
    const from = db.getUserById(fromId);
    if (!from) return json(res, 500, { error: `平台账户 user id=${fromId} 不存在` });
    if (fromId === target.id) return json(res, 400, { error: '不能转给自己' });

    try {
      const r = db.transfer(fromId, target.id, amount);
      if (!r.ok) return json(res, 400, r);
      json(res, 200, {
        ok: true, amount: r.amount,
        fromName: from.global_name || from.username,
        toName: target.global_name || target.username,
        toBalance: r.toBalance,
      });
    } catch (e) {
      json(res, 400, { error: e.message, code: e.code || 0 });
    }
  });

  /* ---------- 每日高倍活动：读 / 写 ---------- */

  router.get('/admin/api/daily', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { daily } = require('../daily-activity');
    // raw：把 daily_* 全部回给前端做表单回填
    const raw = {};
    for (const row of db.get().prepare(
      "SELECT key, value FROM settings WHERE key LIKE 'daily\\_%' ESCAPE '\\'"
    ).all()) raw[row.key] = row.value;
    json(res, 200, { ...daily.status(), raw });
  });

  router.post('/admin/api/daily', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = await readBody(req);
    // 只接受白名单键，避免前端传脏数据覆盖别的设置
    const ALLOW = new Set([
      'daily_enabled', 'daily_window_from', 'daily_window_to',
      'daily_min_rate', 'daily_max_rate', 'daily_weight',
      'daily_guild_id', 'daily_channel_id', 'daily_announce',
    ]);
    const applied = {};
    for (const [k, v] of Object.entries(b || {})) {
      if (!ALLOW.has(k)) continue;
      db.setSetting(k, String(v));
      applied[k] = String(v);
    }
    // 立刻重算今天的随机小时区间（如果窗口变了）
    const { daily } = require('../daily-activity');
    if (applied.daily_window_from || applied.daily_window_to) {
      db.setSetting('daily_hour', '0');   // 0 = 强制下一 tick 重抽
      db.setSetting('daily_hour_day', '');
    }
    daily.tick();
    json(res, 200, { ok: true, applied, status: daily.status() });
  });

  /* ---------- 小活动插件：列表 / 启停 / 参数 ---------- */

  router.get('/admin/api/activities', (req, res) => {
    if (!requireAdmin(req, res)) return;
    json(res, 200, {
      list: activities.list(),
      params: (() => {
        try { return JSON.parse(db.getSetting('activities_json', '{}') || '{}'); }
        catch (_) { return {}; }
      })(),
    });
  });

  // 启停：{ id, enabled: true|false }
  router.post('/admin/api/activities/toggle', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = await readBody(req);
    try {
      const list = activities.setEnabled(String(b.id || ''), !!b.enabled);
      json(res, 200, { ok: true, list });
    } catch (e) {
      json(res, 400, { error: e.message });
    }
  });

  // 参数覆盖：{ lucky_hour: { from:'20:00', to:'23:00', maxRate: 8 } }
  router.post('/admin/api/activities/params', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = await readBody(req);
    let cur = {};
    try { cur = JSON.parse(db.getSetting('activities_json', '{}') || '{}'); } catch (_) { cur = {}; }
    for (const [k, v] of Object.entries(b || {})) cur[k] = v;
    db.setSetting('activities_json', JSON.stringify(cur));
    json(res, 200, { ok: true, params: cur });
  });
}

module.exports = { register, isAuthed, adminIds, grantSession };
