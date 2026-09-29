'use strict';
/**
 * Discord 认证 —— 双通道
 *
 * A) Activity 内（Embedded App SDK）
 *    前端 discordSdk.authenticate({access_token}) 或 authorize() 拿到 code，
 *    POST /api/auth/token 用 code 换 token。桌面复用 Discord 登录态，手机拉起 App。
 *
 * B) 独立网页版
 *    GET  /auth/login   → 302 到 discord.com/oauth2/authorize
 *    GET  /auth/callback→ code 换 token
 *
 * 两条通道服务端换 token 的逻辑完全一致（authorization_code grant）。
 * 移动端自定义 scheme 必须用 PKCE，这里网页版也启用 PKCE 以保持一致。
 */
const crypto = require('crypto');
const https = require('https');

const API = 'https://discord.com/api/v10';
const OAUTH = 'https://discord.com/api/oauth2';
const CLIENT_ID = () => process.env.DISCORD_CLIENT_ID || '';
const CLIENT_SECRET = () => process.env.DISCORD_CLIENT_SECRET || '';
const REDIRECT = () => process.env.DISCORD_REDIRECT_URI
  || `${process.env.APP_URL || 'http://127.0.0.1:8080'}/auth/callback`;

function req(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const h = { 'User-Agent': 'DiscordBot/1.0 (baodian, 1.0)', ...headers };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method, headers: h,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/* ---------- PKCE ---------- */
function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, state: crypto.randomBytes(16).toString('hex') };
}

/** 构造 authorize URL（网页版 / Activity 外跳 / 后台 共用） */
function authorizeUrl({ state, challenge, prompt = 'consent', scope = 'identify', redirectUri } = {}) {
  const p = new URL(`${OAUTH}/authorize`);
  p.searchParams.set('client_id', CLIENT_ID());
  p.searchParams.set('response_type', 'code');
  p.searchParams.set('redirect_uri', redirectUri || REDIRECT());
  p.searchParams.set('scope', scope);
  p.searchParams.set('prompt', prompt);
  if (state) p.searchParams.set('state', state);
  if (challenge) p.searchParams.set('code_challenge', challenge);
  p.searchParams.set('code_challenge_method', 'S256');
  return p.toString();
}

/**
 * code → token
 *
 * Discord 有两种模式：
 *  - Public Client（开发者后台勾选）：不要 client_secret，PKCE 必须
 *  - Confidential Client（默认）：要 client_secret
 *
 * Activity 路径由 SDK 发起授权，SDK 一定用了 PKCE，所以 code_verifier 必须转发。
 * 网页版本项目自己生成 verifier，两种都支持。
 */
async function exchangeCode(code, codeVerifier, redirectUri) {
  const secret = CLIENT_SECRET();
  const redirect = redirectUri || REDIRECT();
  const base = {
    client_id: CLIENT_ID(),
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirect,
  };
  // 有 verifier 用 PKCE；没有则用 secret（confidential client）
  if (codeVerifier) base.code_verifier = codeVerifier;
  else if (secret) base.client_secret = secret;

  const send = async (params) => {
    const body = new URLSearchParams(params);
    return new Promise((resolve, reject) => {
      const d = Buffer.from(body.toString());
      const rq = https.request(`${OAUTH}/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': d.length,
          'User-Agent': 'DiscordBot/1.0 (baodian, 1.0)',
        },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, json: j, raw }); });
      });
      rq.on('error', reject);
      rq.write(d); rq.end();
    });
  };

  let r = await send(base);

  // 回退：verifier 失败但有 secret 时，改用 secret 方式再试一次
  if (r.status !== 200 && codeVerifier && secret) {
    const retry = { ...base, client_secret: secret };
    delete retry.code_verifier;
    r = await send(retry);
  }

  if (r.status !== 200 || !r.json || !r.json.access_token) {
    const raw = (r.json && (r.json.error_description || r.json.error)) || r.raw.slice(0, 200);
    // 把 Discord 的原始报错翻译成可执行的排查提示
    let hint = '';
    if (/code_verifier/i.test(raw)) {
      hint = '（PKCE 校验失败：Activity 路径必须转发 SDK 返回的 code_verifier）';
    } else if (/redirect_uri|redirect/i.test(raw)) {
      hint = `（回调地址不匹配：${REDIRECT()} 需与开发者后台 OAuth2 → Redirects 完全一致）`;
    } else if (/client|secret/i.test(raw)) {
      hint = '（CLIENT_ID / CLIENT_SECRET 有误，检查 .env）';
    } else if (/Invalid code|expired/i.test(raw)) {
      hint = '（code 已过期或已使用，重新点一次登录）';
    }
    throw new Error(`token 交换失败(${r.status}): ${raw}${hint}`);
  }
  return r.json;
}

/** 用 access_token 取用户资料 */
async function me(accessToken) {
  const r = await req(`${API}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (r.status !== 200 || !r.json || !r.json.id) {
    throw new Error(`获取用户信息失败(${r.status})`);
  }
  const u = r.json;
  const ext = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : '';
  return {
    discordId: u.id,
    username: u.username || '',
    globalName: u.global_name || u.username || '',
    avatar: ext,
  };
}

/** 用 Bot Token 调 Discord API（签到机器人 / 邀请用） */
function bot(pathname, { method = 'POST', body = null, form = null } = {}) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return Promise.reject(new Error('未配置 DISCORD_BOT_TOKEN'));
  return new Promise((resolve, reject) => {
    const u = new URL(`${API}${pathname}`);
    let payload = null; let headers = { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot/1.0 (baodian, 1.0)' };
    if (form) {
      payload = new URLSearchParams(form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(payload);
    } else if (body) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, json: j, raw }); });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

module.exports = { pkce, authorizeUrl, exchangeCode, me, bot, req, OAUTH, API, CLIENT_ID, REDIRECT };
