'use strict';
/** 极简 HTTP 工具：路由、JSON、静态文件、Cookie —— 零依赖 */

const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
};

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    // /api/user/:id → regex + 参数名
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/\/:([A-Za-z0-9_]+)/g, (_, k) => {
      keys.push(k); return '/([^/]+)';
    }) + '$');
    this.routes.push({ method, rx, keys, handler });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.rx);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return null;
  }
}

/**
 * 解析 URL 查询串。
 *
 * ⚠️ 这个项目原本【没有】query 解析器，之前在路由里写 `req.query.get('by')`
 * 会抛 "Cannot read properties of undefined (reading 'get')"，
 * 表现为接口 500、前端「没有任何数据」。
 * 现在提供 get()/has() 两个方法，接口是 Map 风格，和 URLSearchParams 一致。
 */
function parseQuery(search) {
  const q = new URLSearchParams(search || '');
  return {
    get: (k) => (q.has(k) ? q.get(k) : null),
    has: (k) => q.has(k),
    all: () => Object.fromEntries(q),
    raw: q,
  };
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      raw += c;
    });
    req.on('end', () => {
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (ct.includes('application/json')) {
        try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve({}); }
      } else if (ct.includes('application/x-www-form-urlencoded')) {
        resolve(Object.fromEntries(new URLSearchParams(raw)));
      } else {
        resolve(raw ? { _raw: raw } : {});
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, { maxAge = 86400 * 30, httpOnly = true, sameSite = 'Lax', secure = false, partitioned = false, path = '/' } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `Max-Age=${maxAge}`, `SameSite=${sameSite}`];
  // 【iOS/Safari 关键】Activity 是第三方（跨站）iframe，Safari 默认直接【禁用】第三方
  // Cookie，SameSite=None 也不管用。只有带 Partitioned 的 Cookie 才会被接受。
  // Chrome 130+ 也在逐步收紧第三方 Cookie 限制，所以生产一律要带。
  // 规范要求 Partitioned 必须同时是 Secure。
  if (partitioned) bits.push('Partitioned');
  if (secure) bits.push('Secure');
  if (httpOnly) bits.push('HttpOnly');
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(bits.join('; '));
  res.setHeader('Set-Cookie', list);
}

function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; Max-Age=0`);
}

function serveStatic(res, rootDir, urlPath, { maxAge = 3600 } = {}) {
  const rel = decodeURIComponent(urlPath.replace(/^\/+/, '')) || 'index.html';
  const target = path.join(rootDir, rel);
  // 防目录穿越
  if (!target.startsWith(path.resolve(rootDir))) { json(res, 403, { error: 'forbidden' }); return true; }
  let st;
  try { st = fs.statSync(target); } catch (_) { return false; }
  if (st.isDirectory()) return false;
  const ext = path.extname(target).toLowerCase();

  /**
   * HTML 分支：注入构建标记 + 禁用缓存
   *
   * 1) Cache-Control 必须用 no-store，不能用 no-cache。
   *    no-cache 的语义是「可以存，但每次用之前要问服务器」——
   *    一旦验证请求失败（断网、代理、超时），浏览器就拿本地旧副本顶上，
   *    用户看到几小时前的旧页面，而服务器上明明是新的。
   *    2026-09-29 就因为这个，用户看到的还是白屏那版后台，
   *    反复怀疑「部署没生效」，实际是浏览器缓存。
   *
   * 2) 注入 __BUILD__ → 文件 mtime。
   *    页面标题会带上这串时间戳，以后一眼就能区分
   *    「服务器确实是新的」和「我这边缓存了旧的」，不用再猜。
   *    取 mtime 意味着不需要部署脚本配合，不会忘记更新。
   */
  if (ext === '.html') {
    const stamp = st.mtime.toISOString().replace('T', ' ').slice(0, 19);
    const stream = fs.createReadStream(target, { encoding: 'utf8' });
    let buf = '';
    stream.on('data', (c) => { buf += c; });
    stream.on('end', () => {
      const out = buf.replace(/__BUILD__/g, stamp);
      const b = Buffer.from(out, 'utf8');
      res.writeHead(200, {
        'Content-Type': MIME['.html'],
        'Content-Length': b.length,
        'Cache-Control': 'no-store, must-revalidate',
      });
      res.end(b);
    });
    stream.on('error', () => { try { res.end(); } catch (_) {} });
    return true;
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': `public, max-age=${maxAge}`,
  });
  fs.createReadStream(target).pipe(res);
  return true;
}

/** 常量时间比较，避免时序攻击 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto_timingSafeEqual(ba, bb);
}
function crypto_timingSafeEqual(a, b) {
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

module.exports = { Router, json, readBody, parseCookies, setCookie, clearCookie, serveStatic, safeEqual, MIME, parseQuery };
