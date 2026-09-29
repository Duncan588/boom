'use strict';
/** 前台 API 路由 */
const crypto = require('crypto');
const db = require('../db');
const { daily } = require('../daily-activity');
const { CFG, round2 } = require('../game-logic');
const da = require('../discord-auth');
const admin = require('./admin');
const { json, readBody, parseCookies, setCookie, clearCookie, safeEqual } = require('../http-util');

const SESSION_COOKIE = 'bd_sid';
const SESSION_DAYS = 30;
// 之前的 session 存在内存 Map 里，进程一重启全部失效 → 用户每次都要重新登录。
// 现在落库到 SQLite 的 sessions 表，重启/更新进程后登录态依然有效。
const sessions = new Map(); // sid -> {userId, exp}（内存缓存，DB 是权威）

/**
 * 【为什么生产必须 SameSite=None; Secure】
 * Discord 小活动把我们的页面放进一个【跨站 iframe】（discord.com 嵌 boom.monster6324.me）。
 * 浏览器对 Lax 的 Cookie 在跨站请求里【不会携带】，于是：
 *   服务端 createSession() 写入了 session（DB 里确实有记录），
 *   浏览器却把 bd_sid 扣在手里不发送 → 下一个 /api/me 读不到用户，
 *   前端就报「登录会话没有保存，请检查 HTTPS、Cookie 和 Discord URL Mapping」。
 * 这不是配置没填对，是浏览器策略。
 * 参照 dashboard 的 app.py:143 —— https 部署时用 SameSite=None; Secure
 * （None 必须配 Secure，否则浏览器直接拒收）。
 * 本地 http://127.0.0.1 调试保持 Lax，因为 Secure Cookie 在 http 下不会发送。
 */
const IS_HTTPS = process.env.COOKIE_SECURE === '1' || /^https:\/\//.test(process.env.APP_URL || '');
const SESSION_COOKIE_OPTS = IS_HTTPS
  ? { sameSite: 'None', secure: true, partitioned: true }
  : { sameSite: 'Lax', secure: false, partitioned: false };

function createSession(res, userId) {
  const sid = crypto.randomBytes(24).toString('base64url');
  const exp = Date.now() + SESSION_DAYS * 86400 * 1000;
  sessions.set(sid, { userId, exp });
  try {
    db.get().prepare(
      'INSERT OR REPLACE INTO sessions (sid, user_id, exp, created_at) VALUES (?,?,?,?)'
    ).run(sid, userId, exp, String(Date.now()));
  } catch (_) { /* 表不存在时退回内存 */ }
  setCookie(res, SESSION_COOKIE, sid, { maxAge: SESSION_DAYS * 86400, httpOnly: true, ...SESSION_COOKIE_OPTS });
  return sid;
}

function currentUser(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  let s = sessions.get(sid);
  if (!s) {
    // 内存没有 → 查库（进程重启后走这条路）
    try {
      const row = db.get().prepare('SELECT user_id, exp FROM sessions WHERE sid = ?').get(sid);
      if (row) { s = { userId: row.user_id, exp: row.exp }; sessions.set(sid, s); }
    } catch (_) { return null; }
  }
  if (!s) return null;
  if (s.exp < Date.now()) {
    sessions.delete(sid);
    try { db.get().prepare('DELETE FROM sessions WHERE sid = ?').run(sid); } catch (_) {}
    return null;
  }
  return db.getUserById(s.userId);
}

function requireUser(req, res) {
  const u = currentUser(req);
  if (!u) { json(res, 401, { error: '未登录' }); return null; }
  if (u.frozen) { json(res, 403, { error: '账号已被冻结' }); return null; }
  return u;
}

function publicUser(u) {
  return {
    id: u.id, discordId: u.discord_id,
    name: u.global_name || u.username,
    avatar: u.avatar,
    coins: round2(u.coins),
  };
}

function register(router, engine) {
  /* ---------- 认证 ---------- */

  // Activity / 网页版共用入口：前端拿到 Discord code 后换 token
  router.post('/api/auth/discord', async (req, res, { params }) => {
    const body = await readBody(req);
    const { code, code_verifier: verifier, inviter } = body;
    if (!code) return json(res, 400, { error: '缺少 authorization code' });
    try {
      const tok = await da.exchangeCode(code, verifier);
      const prof = await da.me(tok.access_token);
      let inviterId = null;
      if (inviter) {
        const iu = db.getUserByDiscord(String(inviter));
        if (iu) inviterId = iu.id;
      }
      // upsertUser 内部已经在建号同一事务里发放 INITIAL_COINS + INVITE_NEWCOMER_COINS，
      // 这里【不要】再发一次 signup_bonus —— 旧的两处 bonus 是重复发放的根源
      // （曾出现 initial_grant 1000 + invite_newcomer 1000 + signup_bonus 500 = 2500）。
      const { user, created } = db.upsertUser({ ...prof, inviterId });
      createSession(res, user.id);
      const bonus = 0;
      json(res, 200, {
        user: publicUser(db.getUserById(user.id)),
        created, bonus,
        token: tok.access_token,
      });
    } catch (e) {
      console.error('[auth] token 交换失败:', e.message);
      json(res, 401, { error: e.message });
    }
  });

  // 独立网页版 OAuth2（PKCE）
  router.get('/auth/login', async (req, res) => {
    const p = da.pkce();
    sessions.set(`pkce:${p.state}`, { verifier: p.verifier, exp: Date.now() + 600000 });
    res.writeHead(302, { Location: da.authorizeUrl({ state: p.state, challenge: p.challenge }) });
    res.end();
  });

  router.get('/auth/callback', async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const st = state ? sessions.get(`pkce:${state}`) : null;
    sessions.delete(`pkce:${state}`);
    if (!code) { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('缺少 code'); }
    try {
      const tok = await da.exchangeCode(code, st ? st.verifier : null);
      const prof = await da.me(tok.access_token);
      // INITIAL_COINS 已由 upsertUser 在建号事务内发放，这里不再叠加 signup_bonus
      const { user, created } = db.upsertUser(prof);
      createSession(res, user.id);
      const bonus = 0;
      // 白名单内的用户顺手发一个后台会话，进 /admin 不用再登一次
      if (admin.adminIds().includes(String(prof.discordId))) {
        admin.grantSession(res, prof);
      }
      res.writeHead(302, { Location: '/' });
      res.end();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('登录失败: ' + e.message);
    }
  });

  router.post('/api/auth/logout', (req, res) => {
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (sid) sessions.delete(sid);
    clearCookie(res, SESSION_COOKIE);
    json(res, 200, { ok: true });
  });

  /* 本地开发登录：仅允许来自 localhost，方便无 Discord 环境调试 */
  router.post('/api/auth/dev-login', async (req, res) => {
    const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
    if (!['127.0.0.1', '::1', 'localhost'].includes(ip)) {
      return json(res, 403, { error: '仅限本地调试' });
    }
    if (process.env.DEV_LOGIN !== '1') {
      return json(res, 403, { error: '未开启 DEV_LOGIN' });
    }
    const b = await readBody(req);
    const did = String(b.discordId || '000000000000000001');
    // 邀请码：discord_id（用户自己的分享码）或内部数字 id 都接受
    let inviterId = null;
    const code = b.inviteCode || b.inviter;
    if (code) {
      const iu = db.getUserByDiscord(String(code)) || db.getUserById(Number(code));
      if (iu && String(iu.discord_id) !== did) inviterId = iu.id;
    }
    // INITIAL_COINS / INVITE_NEWCOMER_COINS 已由 upsertUser 在建号事务内发放
    const { user, created } = db.upsertUser({
      discordId: did,
      username: b.username || 'tester',
      globalName: b.name || '测试玩家',
      avatar: '',
      inviterId,
    });
    createSession(res, user.id);
    json(res, 200, {
      user: publicUser(db.getUserById(user.id)), created, inviterId,
    });
  });

  router.get('/api/me', (req, res) => {
    const u = currentUser(req);
    if (!u) return json(res, 200, { user: null, discord: { clientId: da.CLIENT_ID() } });
    const s = db.allSettings();
    json(res, 200, {
      user: publicUser(u),
      discord: { clientId: da.CLIENT_ID(), redirect: da.REDIRECT() },
      config: {
        minBet: 1, jackpot: round2(Number(db.getSetting('jackpot', 0)) || 0),
        checkinCoins: Number(process.env.CHECKIN_COINS || 100),
        inviteReward: Number(process.env.INVITE_REWARD_COINS || 200),
        inviteMinRounds: Number(process.env.INVITE_MIN_ROUNDS || 3),
        betMs: CFG.BET_MS,
        minRate: Number(s.min_rate) || CFG.MIN_RATE,
        maxRate: Number(s.max_rate) || CFG.MAX_RATE,
        flightScale: CFG.FLIGHT_SCALE,
        wsPort: Number(process.env.WS_PORT || 9501),
      },
    });
  });

  /* ---------- 游戏 ---------- */

  router.post('/api/game/bet', async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const body = await readBody(req);
    const amount = round2(Number(body.amount));
    const gid = Number(body.roundId);
    if (!gid) return json(res, 400, { error: '缺少期号' });
    const r = engine.bet(u.id, gid, amount);
    if (!r.ok) return json(res, 400, { error: r.msg, code: r.code });
    json(res, 200, { ok: true, balance: round2(r.balance), amount });
  });

  router.post('/api/game/escape', async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const body = await readBody(req);
    const gid = Number(body.roundId);
    if (!gid) return json(res, 400, { error: '缺少期号' });
    const r = engine.escape(u.id, gid);
    if (!r.ok) return json(res, 400, { error: r.msg, code: r.code });
    json(res, 200, { ok: true, profit: r.profit, rate: r.rate, balance: round2(r.balance) });
  });

  /**
   * Bot 连接诊断。
   *
   * 【为什么需要】之前判断「bot 到底连着没有」只能看日志最后一行，
   * 而那行永远是「已上线」—— socket 静默死亡时完全看不出异常。
   * 这个端点直接返回真实状态，不用猜。
   */
  router.get('/api/bot/diagnostics', (req, res) => {
    const bot = global.__bot;
    if (!bot) return json(res, 200, { ok: false, msg: 'bot 未启动（缺少 DISCORD_BOT_TOKEN）' });
    json(res, 200, { ok: true, ...bot.diagnostics() });
  });

  router.get('/api/game/history', async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const rows = db.get().prepare(
      `SELECT b.*, r.rate AS boom FROM bets b
       LEFT JOIN rounds r ON r.id = b.round_id
       WHERE b.user_id = ? ORDER BY b.id DESC LIMIT 30`
    ).all(u.id);
    json(res, 200, { list: rows });
  });

  /* ---------- 弹幕 ---------- */

  // 完整版：玩家可自由发言，不做速率限制与敏感词过滤
  router.post('/api/chat', async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const body = await readBody(req);
    const r = engine.chat(u.id, body.text);
    if (!r.ok) return json(res, 400, { error: r.error });
    json(res, 200, { ok: true });
  });

  // 聊天历史（服务器保留，带时间戳）
  router.get('/api/chat/history', async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.get('limit')) || 50));
    const before = Number(req.query.get('before')) || 0;   // 游标：翻更早的
    const rows = db.get().prepare(
      `SELECT id, name, kind, text, created_at FROM chat_messages
       ${before ? 'WHERE id < ?' : ''}
       ORDER BY id DESC LIMIT ?`
    ).all(...(before ? [before, limit] : [limit]));
    json(res, 200, {
      list: rows.reverse().map((r) => ({
        id: r.id, name: r.name, kind: r.kind, text: r.text, at: r.created_at,
      })),
    });
  });

  /* ---------- 签到 / 邀请 ---------- */

  router.post('/api/checkin', async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const today = new Date().toISOString().slice(0, 10);
    const last = db.get().prepare(
      `SELECT created_at FROM coin_logs WHERE user_id = ? AND reason = 'checkin' ORDER BY id DESC LIMIT 1`
    ).get(u.id);
    if (last && String(last.created_at).slice(0, 10) === today) {
      return json(res, 400, { error: '今天已经签到过了' });
    }
    const amount = Number(process.env.CHECKIN_COINS || 100);
    const balance = db.addCoins(u.id, amount, 'checkin', today);
    json(res, 200, { ok: true, amount, balance: round2(balance) });
  });

  router.get('/api/invite', async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const invitees = db.get().prepare(
      `SELECT i.*, us.global_name, us.username, us.avatar,
              (SELECT COUNT(*) FROM bets b WHERE b.user_id = us.id) AS rounds
       FROM invites i JOIN users us ON us.id = i.invitee_id
       WHERE i.inviter_id = ? ORDER BY i.id DESC LIMIT 50`
    ).all(u.id);
    const minRounds = Number(process.env.INVITE_MIN_ROUNDS || 3);
    const reward = Number(process.env.INVITE_REWARD_COINS || 200);
    // 未达标的好友可领取奖励
    for (const iv of invitees) {
      if (!iv.rewarded && iv.rounds >= minRounds) {
        db.addCoins(u.id, reward, 'invite_reward', iv.invitee_id);
        db.get().prepare('UPDATE invites SET rewarded = 1 WHERE id = ?').run(iv.id);
        iv.rewarded = 1; iv.justRewarded = reward;
      }
    }
    const earned = db.get().prepare(
      `SELECT COALESCE(SUM(delta),0) s FROM coin_logs WHERE user_id = ? AND reason = 'invite_reward'`
    ).get(u.id).s;
    json(res, 200, {
      code: u.discord_id,
      invitees: invitees.map((i) => ({
        name: i.global_name || i.username, avatar: i.avatar,
        rounds: i.rounds, rewarded: !!i.rewarded,
      })),
      totalEarned: round2(earned), minRounds, reward,
    });
  });

  /* ---------- 余额查询 / 转账 ---------- */

  // 查余额：不传 userId 就是自己；传了就是查别人（只返回余额和昵称）
  router.get('/api/balance', (req, res) => {
    const me = requireUser(req, res); if (!me) return;
    const target = req.query.get('userId') || req.query.get('id');
    if (!target) {
      return json(res, 200, { self: true, ...db.balanceOf(me.discord_id) });
    }
    const row = db.balanceOf(String(target));
    if (!row) return json(res, 404, { error: '该用户不存在或还未登录过' });
    json(res, 200, { self: String(target) === String(me.discord_id), ...row });
  });

  // 搜索用户（转账时选人用）：按昵称前缀模糊匹配
  router.get('/api/users/search', (req, res) => {
    const me = requireUser(req, res); if (!me) return;
    const q = String(req.query.get('q') || '').trim();
    if (!q) return json(res, 200, { list: [] });
    const like = `%${q}%`;
    const rows = db.get().prepare(
      `SELECT discord_id, global_name, username, avatar, coins FROM users
       WHERE is_bot = 0 AND frozen = 0
         AND (global_name LIKE ? OR username LIKE ? OR discord_id LIKE ?)
       ORDER BY coins DESC LIMIT 20`
    ).all(like, like, like);
    json(res, 200, {
      list: rows.map((r) => ({
        discordId: r.discord_id, name: r.global_name || r.username,
        avatar: r.avatar, coins: r.coins,
      })),
    });
  });

  // 转账
  router.post('/api/transfer', async (req, res) => {
    const me = requireUser(req, res); if (!me) return;
    const b = await readBody(req);
    const toId = String(b.to || b.toId || b.userId || '').trim();
    if (!toId) return json(res, 400, { error: '缺少收款方' });
    const amount = Number(b.amount);
    if (!Number.isFinite(amount)) return json(res, 400, { error: '金额无效' });

    const target = db.getUserByDiscord(toId);
    if (!target) return json(res, 404, { error: '收款方不存在或还未登录过' });

    let r;
    try {
      r = db.transfer(me.id, target.id, amount);
    } catch (e) {
      return json(res, 400, { error: e.message, code: e.code || 0 });
    }
    if (!r.ok) return json(res, 400, r);

    // 广播给两个人，让对方立刻看到余额变化
    engine.broadcast({
      type: 'chat', kind: 'system',
      name: me.global_name || me.username,
      text: `转账 ${r.amount} QUN 给 ${target.global_name || target.username}`,
    });
    json(res, 200, {
      ok: true, amount: r.amount,
      myBalance: r.fromBalance, toBalance: r.toBalance,
      to: { discordId: target.discord_id, name: target.global_name || target.username },
    });
  });

  // 转账记录
  router.get('/api/transfer/history', (req, res) => {
    const me = requireUser(req, res); if (!me) return;
    json(res, 200, { list: db.transferHistory(me.id, req.query.get('limit') || 20) });
  });

  /* ---------- 每日高倍活动状态 ---------- */
  router.get('/api/daily', (req, res) => {
    json(res, 200, { ...daily.status(), now: db.now() });
  });

  router.get('/api/leaderboard', async (req, res) => {
    // by=coins（默认）→ 余额榜，余额最大的永远排最前
    // by=wagered         → 投注量榜（兼容旧字段）
    const by = String(req.query.get('by') || 'coins');
    // ⚠️ 排序列必须用表达式/别名的安全写法。之前 `ORDER BY us.coins DESC, wagered DESC`
    // 在 SQLite 里会报 "Cannot read properties of undefined (reading 'get')" —— wagered 是
    // SELECT 别名，跟在后面的逗号项解析失败，接口 500，前端就显示"没有任何数据"。
    const orderBy = by === 'wagered'
      ? 'COALESCE(SUM(CASE WHEN b.status = 2 THEN b.amount ELSE 0 END), 0) DESC, us.coins DESC'
      : 'us.coins DESC, COALESCE(SUM(CASE WHEN b.status = 2 THEN b.amount ELSE 0 END), 0) DESC';
    const rows = db.get().prepare(
      `SELECT us.id, us.global_name, us.username, us.avatar, us.discord_id, us.coins,
              COUNT(b.id) AS bets,
              COALESCE(SUM(CASE WHEN b.status = 2 THEN b.amount ELSE 0 END), 0) AS wagered
       FROM users us LEFT JOIN bets b ON b.user_id = us.id
       WHERE us.is_bot = 0
       GROUP BY us.id ORDER BY ${orderBy} LIMIT 50`
    ).all();
    json(res, 200, {
      list: rows.map((r) => ({
        id: r.id, name: r.global_name || r.username, avatar: r.avatar,
        bets: r.bets, wagered: round2(r.wagered), coins: round2(r.coins),
      })),
    });
  });

  /* ---------- Bot 接口（供 discord.py 签到机器人调用） ---------- */

  const botGuard = (req) => {
    const secret = process.env.BOT_API_SECRET;
    if (!secret) return false;
    const h = req.headers['x-bot-secret'] || '';
    const q = new URL(req.url, 'http://x').searchParams.get('secret');
    return safeEqual(h || q, secret);
  };

  router.post('/api/bot/checkin', async (req, res) => {
    if (!botGuard(req)) return json(res, 401, { error: 'unauthorized' });
    const body = await readBody(req);
    const ids = String(body.discordId || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return json(res, 400, { error: '缺少 discordId' });
    const amount = Number(body.amount || process.env.CHECKIN_COINS || 100);
    const out = [];
    for (const did of ids) {
      const u = db.getUserByDiscord(did);
      if (!u) { out.push({ discordId: did, ok: false, reason: '用户不存在' }); continue; }
      const today = new Date().toISOString().slice(0, 10);
      const last = db.get().prepare(
        `SELECT created_at FROM coin_logs WHERE user_id = ? AND reason = 'checkin' ORDER BY id DESC LIMIT 1`
      ).get(u.id);
      if (last && String(last.created_at).slice(0, 10) === today) {
        out.push({ discordId: did, ok: false, reason: '今日已签到' }); continue;
      }
      const balance = db.addCoins(u.id, amount, 'checkin', today);
      out.push({ discordId: did, ok: true, amount, balance: round2(balance), name: u.global_name || u.username });
    }
    json(res, 200, { results: out });
  });

  router.post('/api/bot/grant', async (req, res) => {
    if (!botGuard(req)) return json(res, 401, { error: 'unauthorized' });
    const body = await readBody(req);
    const amount = round2(Number(body.amount));
    if (!amount) return json(res, 400, { error: '缺少 amount' });
    const ids = String(body.discordId || '').split(',').map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const did of ids) {
      const u = db.getUserByDiscord(did);
      if (!u) { out.push({ discordId: did, ok: false }); continue; }
      const balance = db.addCoins(u.id, amount, 'bot_grant', body.reason || 'discord_bot');
      out.push({ discordId: did, ok: true, balance: round2(balance) });
    }
    json(res, 200, { results: out });
  });

  return { publicUser, currentUser, createSession };
}

module.exports = { register, currentUser, publicUser, sessions };
