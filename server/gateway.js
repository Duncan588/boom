/**
 * Discord Gateway 客户端 —— 负责接收 slash 指令交互。
 *
 * 【为什么必须存在】Bot 在 Discord 开发者后台注册了 /balance /checkin 等指令，
 * 但注册 ≠ 能响应。指令交互走 Gateway 的 INTERACTION_CREATE 事件，
 * 进程不连 Gateway 就永远收不到 —— 用户看到的现象是「/balance 点了完全没反应」，
 * 而 REST 调用（发频道消息、Scheduled Event）却一切正常，因为那走 HTTP。
 * 这就是「指令存在但无效」的全部原因。
 *
 * 用项目已有的 ws 依赖，不自己实现 WebSocket 帧。
 */

const WebSocket = require('ws');
const { EventEmitter } = require('events');

const API = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

// GUILDS(1<<0) | GUILD_MESSAGES(1<<9) | MESSAGE_CONTENT(1<<15)
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

const OP = {
  DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6,
  RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11,
};

class DiscordBot extends EventEmitter {
  /**
   * @param {string} token      bot token
   * @param {object} opts
   *   - commands: Map<name, handler(interaction, ctx)>
   *   - log: 日志函数
   *   - activityUrl: /boom 指令要跳转的地址
   */
  constructor(token, { commands = new Map(), log = console.log, activityUrl = '' } = {}) {
    super();
    this.token = token;
    this.commands = commands;
    this.log = log;
    this.activityUrl = activityUrl;

    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.heartbeatTimer = null;
    this.stopped = false;
    this.retries = 0;
    this.connected = false;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; }
  }

  _connect() {
    if (this.stopped) return;
    const url = this.resumeUrl || GATEWAY_URL;
    this.log(`[bot] 连接 Gateway${this.resumeUrl ? '（续接会话）' : ''}…`);

    const ws = new WebSocket(url, {
      headers: { 'User-Agent': 'DiscordBot (https://boom.monster6324.me, 1.0)' },
    });
    this.ws = ws;

    ws.on('open', () => { /* 等 HELLO */ });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      this._onMessage(msg);
    });

    ws.on('error', (e) => this.log('[bot] Gateway 错误: ' + e.message));

    ws.on('close', (code) => {
      this.connected = false;
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
      if (this.stopped) return;
      this.retries++;
      // Discord 在连续 2 次未 ACK 心跳后会断开，这里做指数退避重连：
      // 1s→2s→4s→8s→16s→30s 封顶。不断重连的意义是「Bot 进程还活着
      // 但指令失效」不能静默发生 —— 那正是用户报告的现象。
      const wait = Math.min(30000, 1000 * Math.pow(2, Math.min(this.retries, 5)));
      this.log(`[bot] Gateway 断开（code=${code}），${wait / 1000}s 后重连（第 ${this.retries} 次）`);
      setTimeout(() => this._connect(), wait);
    });
  }

  _onMessage(msg) {
    if (msg.s != null) this.seq = msg.s;

    switch (msg.op) {
      case OP.HELLO: {
        const interval = (msg.d && msg.d.heartbeat_interval) || 41250;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => this._beat(interval), interval);
        this._beat(interval);   // 立即发一次，否则首个 interval 内可能被判定为僵尸
        if (this.sessionId) {
          this._send({ op: OP.RESUME, d: { seq: this.seq, session_id: this.sessionId, token: this.token } });
        } else {
          this._send({
            op: OP.IDENTIFY,
            d: {
              token: this.token,
              intents: INTENTS,
              properties: { os: process.platform, browser: 'baodian', device: 'baodian' },
              presence: { status: 'online', activities: [{ name: '爆点逃跑', type: 3 }] },
            },
          });
          this.log('[bot] 已发送 IDENTIFY');
        }
        break;
      }
      case OP.HEARTBEAT:
        this._beat();
        break;
      case OP.HEARTBEAT_ACK:
        break;
      case OP.RECONNECT:
        this.log('[bot] 服务端要求重连');
        this._reconnect();
        break;
      case OP.INVALID_SESSION:
        this.log('[bot] 会话失效，改为重新 IDENTIFY');
        this.sessionId = null;
        this.resumeUrl = null;
        this._reconnect();
        break;
      case OP.DISPATCH: {
        this.retries = 0;
        if (msg.t === 'READY') {
          this.sessionId = msg.d.session_id;
          this.resumeUrl = msg.d.resume_gateway_url;
          this.connected = true;
          this.log(`[bot] 已上线 · ${msg.d.user.username} · 服务器 ${(msg.d.guilds || []).length} 个`);
          this.emit('ready', msg.d);
        } else if (msg.t === 'INTERACTION_CREATE') {
          this._handleInteraction(msg.d);
        } else {
          this.emit(msg.t, msg.d);
        }
        break;
      }
    }
  }

  _reconnect() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    try { if (this.ws) this.ws.close(); } catch (_) {}
    this.ws = null;
    setTimeout(() => this._connect(), 1500);
  }

  _beat(interval) {
    // 漏掉上一次 ACK 且已超过一个周期 → 主动断开重连，别等 Discord 踢
    this._send({ op: OP.HEARTBEAT, d: this.seq });
    void interval;
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(obj)); } catch (e) { this.log('[bot] 发送失败: ' + e.message); }
  }

  async _handleInteraction(it) {
    if (it.type === 3) {   // MESSAGE_COMPONENT —— 红包领取按钮
      const key = it.custom_id || '';
      const handler = this.commands.get('__component:' + key);
      if (!handler) {
        this._defer(it);
        return this._patch(it, { content: '这个按钮已经失效了。', components: [] });
      }
      return this._run(it, handler, 'component:' + key);
    }

    if (it.type !== 2) return;   // 2 = APPLICATION_COMMAND

    const name = (it.data && it.data.name) || '';
    const handler = this.commands.get(name);
    if (!handler) {
      // 指令已注册但没有实现 —— 必须回一个「暂不可用」，
      // 否则用户面对的是 Discord 的默认「此命令失败」，更让人困惑。
      this._defer(it);
      return this._patch(it, {
        content: `⚠️ \`/${name}\` 尚未实现。\n可用指令：${[...this.commands.keys()].filter(k => !k.startsWith('__')).map(k => '/' + k).join('、')}`,
        ephemeral: true,
      });
    }
    this._run(it, handler, name);
  }

  async _run(it, handler, label) {
    // 3 秒内必须 ACK，否则 Discord 显示「应用未响应」。先 defer 拿到交互 token。
    this._defer(it);
    try {
      await handler(it, this);
    } catch (e) {
      this.log(`[bot] /${label} 处理异常: ${(e && e.stack) || e}`);
      try { await this._patch(it, { content: `❌ \`/${label}\` 执行出错：${e.message}`, ephemeral: true }); }
      catch (_) {}
    }
  }

  // ---------- 交互响应 ----------

  _ackPayload(payload) {
    return { type: 4, data: { ...payload, flags: payload.ephemeral ? 64 : undefined } };
  }

  _defer(it) {
    this._send({ op: 4, d: { interaction_id: it.id, type: 5 } });
  }

  _patch(it, payload) {
    return this.rest('PATCH', `/interactions/${it.id}`, payload);
  }

  _reply(it, payload) {
    return this.rest('POST', `/interactions/${it.id}`, this._ackPayload(payload));
  }

  // ---------- REST ----------

  async rest(method, path, body) {
    const r = await fetch(API + path, {
      method,
      headers: {
        Authorization: 'Bot ' + this.token,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!r.ok) {
      const msg = (data && data.message) || `HTTP ${r.status}`;
      this.log(`[bot] REST ${method} ${path} → ${r.status} ${msg}`);
      const e = new Error(msg);
      e.status = r.status;
      e.raw = data;
      throw e;
    }
    return data;
  }
}

module.exports = { DiscordBot, API, INTENTS };
