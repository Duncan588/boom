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

/**
 * Gateway intents。
 *
 * 【修复 it.user 为 undefined】日志实测：
 *   ★ 收到交互：指令 /balance 来自 undefined (undefined)
 * 原因是没有 DIRECT_MESSAGES(1<<12)：缺这个 intent 时，Discord 对
 * 非消息上下文（部分 slash 交互）不会附带完整 user 对象，
 * 于是 commands.js 里的 actorOf() 取到 undefined，红包/指令直接报错。
 *
 * 组成：
 *   GUILDS           (1<<0)
 *   GUILD_MESSAGES   (1<<9)
 *   DIRECT_MESSAGES  (1<<12)  ← 补上，提供完整 user
 *   MESSAGE_CONTENT  (1<<15)
 *   USER             (1<<19)
 */
const INTENTS =
  (1 << 0) |   // GUILDS
  (1 << 9) |   // GUILD_MESSAGES
  (1 << 12) |  // DIRECT_MESSAGES
  (1 << 15) |  // MESSAGE_CONTENT
  (1 << 19);   // USER

const OP = {
  DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6,
  RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11,
};

/**
 * 官方 close code 表里标了 Reconnect = false 的，以及「旧会话已不可信」的。
 * 遇到这些 code 时不能 RESUME，必须丢弃 session_id 重新 IDENTIFY。
 *   4002 Decode error / 4003 Not authenticated / 4007 invalid seq
 *   4004 auth failed / 4010~4014（intents、shard、version 配置问题，重连无解）
 */
const NO_RESUME = new Set([4002, 4003, 4004, 4007, 4010, 4011, 4012, 4013, 4014]);

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
    this.reconnectTimer = null;   // 关键：必须保证同时只有一条重连路径在跑
    this.stopped = false;
    this.retries = 0;
    this.connected = false;
    this._acked = true;
    this._willResume = false;
    this._lastRecv = 0;      // 最后一次收到任何 Gateway 帧的时间
  }

  /**
   * 关键状态快照。
   *
   * 【为什么必须加】之前日志里最后一条永远是「已上线」，即使 socket 早已
   * 静默死亡 —— 进程活着、日志看着正常、指令全部失效，完全看不出异常。
   * 所以每条关键日志都带上当时的真实连接状态。
   */
  _state(tag) {
    const ws = this.ws;
    const rs = ws ? (ws.readyState == null ? 'n/a' : ws.readyState) : 'null';
    const OPEN = WebSocket && WebSocket.OPEN;
    const rsName = rs === 'null' ? '无socket'
      : rs === 0 ? 'CONNECTING'
      : rs === 1 ? 'OPEN'
      : rs === 2 ? 'CLOSING'
      : rs === 3 ? 'CLOSED' : String(rs);
    void OPEN;
    return `[${tag}] socket=${rsName} connected=${this.connected} acked=${this._acked} ` +
           `session=${this.sessionId ? this.sessionId.slice(0, 8) : 'null'} ` +
           `seq=${this.seq} 重试=${this.retries} ` +
           `心跳${this.heartbeatTimer ? '运行中' : '未启动'} ` +
           `距上次收包=${this._lastRecv ? ((Date.now() - this._lastRecv) / 1000).toFixed(0) + 's' : 'n/a'}`;
  }

  /**
   * 启动。
   *
   * 【实测结论】同一份代码裸跑 40 秒 0 次 4002，但经 systemd restart 后
   * 第一次 IDENTIFY 必被 close 4002。差别只有一个：重启时旧进程的 TCP
   * 连接尚未从 Discord 侧释放，新进程 IDENTIFY 撞上仍活动的旧会话。
   *
   * 所以这里延迟 15 秒再连，给旧会话留出释放时间。
   * 代价只是「重启后 bot 晚 15 秒上线」，换掉的是必然发生的一次掉线。
   */
  start() {
    this.stopped = false;
    // 取本 bot 的 application_id，用来校验收到的 interaction 是不是发给我们的。
    this.rest('GET', '/oauth2/applications/@me')
      .then((a) => { this.appId = a.id; this.log(`[bot] application_id=${a.id} (${a.name})`); })
      .catch((e) => this.log(`[bot] 取 application_id 失败: ${e.message}`));
    this.log('[bot] 15 秒后连接 Gateway（等待旧会话释放）');
    setTimeout(() => { if (!this.stopped) this._connect(); }, 15000);

    // 周期性体检：日志里必须有「现在到底连着没有」这一行。
    // 之前最后一条永远是「已上线」，socket 死了也看不出来。
    this._healthTimer = setInterval(() => {
      this.log('  · ' + this._state('体检'));
    }, 60000);
    if (this._healthTimer.unref) this._healthTimer.unref();
  }

  stop() {
    this.stopped = true;
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; }
  }

  /**
   * 连接目标主机的选择规则（见 _connect 内的注释）。
   * IDENTIFY → 主网关；RESUME → resume_gateway_url。
   */
  /** READY 返回的 resume_gateway_url 不带 version/encoding，官方要求补齐 */
  _resumeTarget() {
    if (!this.resumeUrl) return null;
    // 官方原文：When resuming with the resume_gateway_url you need to provide
    // the same version and encoding as the initial connection.
    let u = this.resumeUrl;
    if (!/[?&]v=/.test(u)) u += (u.includes('?') ? '&' : '?') + 'v=10';
    if (!/[?&]encoding=/.test(u)) u += (u.includes('?') ? '&' : '?') + 'encoding=json';
    return u;
  }

  _connect() {
    if (this.stopped) return;
    // 官方原文：IDENTIFY 用初始连接的 URL；RESUME 用 resume_gateway_url。
    const resumeTarget = this.sessionId ? this._resumeTarget() : null;
    const url = resumeTarget || GATEWAY_URL;
    // 记住本次是「续接」，_onMessage 据此选 opcode（6=RESUME / 2=IDENTIFY）
    this._willResume = !!resumeTarget;
    this.log(`[bot] 连接 Gateway（${this._willResume ? 'RESUME' : 'IDENTIFY'}）`);

    // _newWS 是测试注入点：生产用真 WebSocket，单测换成假 socket，
    // 从而在不连 Discord 的情况下验证重连逻辑（见 test/e2e-gateway-reconnect.js）
    const ws = this._newWS
      ? this._newWS(url)
      : new WebSocket(url, { headers: { 'User-Agent': 'DiscordBot (https://discord.com, 1.0)' } });
    this.ws = ws;
    // 记住这一代 socket：旧 socket 迟到的 close/error 必须被忽略，
    // 否则一次断开会被计成两次，旧 socket 的 close 还会把新 socket 的
    // 重连定时器清掉。
    const gen = (this._gen = (this._gen || 0) + 1);
    const isStale = () => gen !== this._gen;

    ws.on('open', () => { this.log('  ' + this._state('握手完成')); });

    ws.on('ping', () => { /* ws 自动回 pong */ });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      this._lastRecv = Date.now();
      this._onMessage(msg);
    });

    ws.on('error', (e) => {
      if (isStale()) return;
      this.log(`[bot] Gateway 错误: ${e.message} | ${this._state('错误时')}`);
    });

    ws.on('close', (code, reasonBuf) => {
      if (isStale()) return;          // 过期 socket，不参与任何重连决策
      const reason = reasonBuf ? String(reasonBuf).slice(0, 60) : '';
      this.log(`[bot] 连接被关闭 code=${code} ${reason} | ${this._state('关闭时')}`);
      this.connected = false;
      this.ws = null;
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
      if (this.stopped) return;
      // 官方 close code 表：4004/4010~4014 标了 Reconnect=false（重连无意义）。
      // 4002(Decode error) / 4003 / 4007 也不该再 RESUME —— 直接重新 IDENTIFY。
      if (NO_RESUME.has(code)) {
        this.log(`[bot] close ${code} 不可续接，放弃旧会话`);
        this.sessionId = null;
        this.resumeUrl = null;
        this.seq = null;
        this._willResume = false;
      }
      this._scheduleReconnect(`code=${code}`);
    });
  }

  /**
   * 唯一的重连入口，幂等。
   *
   * 之前 _reconnect()（1.5s 固定）和 close 处理器（指数退避）各自 setTimeout，
   * 一次断开就同时挂了两个定时器 → 连接风暴 → 两个 socket 抢同一个 session →
   * Discord 发 INVALID_SESSION → 无限循环，表现为「指令完全用不了」。
   * 现在只有这一条路径，且每次调度前先清掉上一个定时器。
   */
  _scheduleReconnect(reason, delayMs = null) {
    if (this.stopped) return;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.retries++;
    // 【修 3】IDENTIFY 的官方限流是 max_concurrency = 每 5 秒 1 次。
    // 之前下限 2 秒，重连必然落进限流窗口 → 4002 → 再重连 → 死循环。
    // 所以下限提到 6 秒：2s/4s 那档会被抬到 6s，之后 12s/24s/48s/60s。
    const wait = delayMs != null ? delayMs
      : Math.max(6000, Math.min(60000, 2000 * Math.pow(2, Math.min(this.retries, 5))));
    this.log(`[bot] Gateway 断开（${reason}），${Math.round(wait / 1000)}s 后重连（第 ${this.retries} 次）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, wait);
  }

  _onMessage(msg) {
    if (msg.s != null) this.seq = msg.s;

    // 记录每个收到的关键事件。之前的日志只有我自己主动打的「已上线」，
    // 看不到 Discord 到底发来了什么 —— 排查时完全瞎猜。
    if (msg.op === 10) this.log(`  ← HELLO heartbeat_interval=${msg.d && msg.d.heartbeat_interval}ms`);
    else if (msg.op === 11) this.log('  ← HEARTBEAT_ACK');
    else if (msg.op === 7) this.log('  ← RECONNECT（服务端要求重连）');
    else if (msg.op === 9) this.log(`  ← INVALID_SESSION d=${msg.d}（会话已失效）`);
    else if (msg.op === 0) {
      const extra = msg.t === 'READY'
        ? `session=${msg.d.session_id.slice(0, 8)} resume=${msg.d.resume_gateway_url}`
        : (msg.t === 'RESUMED' ? '' : `t=${msg.t}`);
      this.log(`  ← DISPATCH ${msg.t} ${extra}`);
    }

    switch (msg.op) {
      case OP.HELLO: {
        const interval = (msg.d && msg.d.heartbeat_interval) || 41250;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        // 【发送顺序必须正确】官方规定：先 IDENTIFY，再开始心跳。
        // 之前在 HELLO 里先发心跳、后 IDENTIFY，等于「未认证就发 payload」
        // → close 4002 (Decode error) / 4003 (Not authenticated)。
        // 定时器在 IDENTIFY 之后才启动；不发「立即那一次」，
        // 因为首个 interval 有 41 秒，足够 IDENTIFY 完成。
        if (this.connected) {
          // 同上：已有就绪连接就别再 RESUME
          this.log('[bot] 已有活动连接，跳过 RESUME');
          return;
        }
        if (this._willResume && this.sessionId) {
          this._send({ op: OP.RESUME, d: { seq: this.seq, session_id: this.sessionId, token: this.token } });
          this._startHeartbeat(interval);
        } else {
          // 已在上面统一判过 connected，这里不再重复。
          this._send({
            op: OP.IDENTIFY,
            d: {
              token: this.token,
              intents: INTENTS,
              properties: { os: process.platform, browser: 'baodian', device: 'baodian' },
            },
          });
          this.log('[bot] 已发送 IDENTIFY');
          this._startHeartbeat(interval);
        }
        break;
      }
      case OP.HEARTBEAT:
        // Discord 主动要求心跳，此时已认证，可以直接回
        this._beat();
        break;
      case OP.HEARTBEAT_ACK:
        this._acked = true;
        break;
      case OP.RECONNECT:
        this.log('[bot] 服务端要求重连');
        this._reconnect();
        break;
      case OP.INVALID_SESSION:
        /**
         * 官方原文（第 199 行）：
         *   "If the d field is set to false (which is most of the time), your app
         *    should disconnect. After disconnect, your app should create a new
         *    connection with your cached URL ... then send an Identify event."
         *
         * 也就是说：必须【先断开当前 socket】，再用主网关新建连接发 IDENTIFY。
         * 之前的实现是在同一个 socket 上直接发 IDENTIFY —— 这正是 close 4002
         * （Decode error）的来源：旧会话尚未失效，新 payload 落在已废弃的
         * 连接上被拒绝。
         */
        this.log(`[bot] 会话失效（d=${msg.d}），断开后重新 IDENTIFY`);
        this.sessionId = null;
        this.resumeUrl = null;
        this.seq = null;
        this._willResume = false;
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
          const it = msg.d;
          /**
           * 【按钮交互的字段位置和 slash 不同】
           * MESSAGE_COMPONENT(type 3) 的结构是：
           *   it.data.custom_id   ← 按钮 id（不是 it.custom_id！）
           *   it.member.user      ← 用户（没有顶层 it.user）
           * 我之前读 it.custom_id 和 it.user，所以两个都是 undefined，
           * 于是「未知按钮 custom_id=undefined」→ 领取永远走不到处理器。
           */
          const cid = it.data && it.data.custom_id;
          const what = it.type === 3
            ? `按钮 custom_id=${cid}`
            : `指令 /${it.data && it.data.name}`;
          const actor = it.user || (it.member && it.member.user);
      this.log(`  ★ 收到交互：${what} 来自 ${actor && actor.username} (${actor && actor.id})` +
                   `  [顶层user=${it.user ? '有' : '无'} member.user=${it.member && it.member.user ? '有' : '无'}]`);
          // 关键诊断：把 interaction 的 id/type/token 相关字段原样打出来。
          // 「应用程序未响应」= ACK 送达失败，而 ACK 失败 404 code:0 说明
          // Discord 找不到这个 interaction —— 最可能就是 id 本身不对。
          this.log(`  ★ 原始 interaction: id=${JSON.stringify(it.id)} type=${it.type} ` +
                   `application_id=${JSON.stringify(it.application_id)} ` +
                   `token长度=${it.token ? it.token.length : '无'} ` +
                   `version=${it.version} keys=${Object.keys(it).join(',')}`);
          // 【决定性】如果 interaction 的 application_id 不是【本 bot】，
          // 说明这些命令是别的 application 注册的 —— 那么本 bot 根本
          // 不该收到它们，ACK 自然 404，命令永远不可能工作。
          if (it.application_id && this.appId && String(it.application_id) !== String(this.appId)) {
            this.log(`  ✗✗ application_id 不匹配！交互属于 app=${it.application_id}，` +
                     `本 bot 的 app=${this.appId} → 这些命令不是本 bot 注册的`);
          } else if (this.appId) {
            this.log(`  ✓ application_id 匹配本 bot (${this.appId})`);
          }
          this._handleInteraction(it);
        } else {
          this.emit(msg.t, msg.d);
        }
        break;
      }
    }
  }

  /**
   * 主动重连。
   *
   * 必须等旧 socket 真正 close 之后再 IDENTIFY：Discord 对同一 token 只允许
   * 一个活动 Gateway 连接，旧连接未断就发 IDENTIFY 会被回 close code 4002
   * （认证失败）—— 线上就是因此反复掉线，指令全部失效。
   */
  _reconnect() {
    this.log('  ' + this._state('准备重连'));
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    const old = this.ws;
    this._gen = (this._gen || 0) + 1;     // 让旧 socket 的 close 变成 stale
    this.ws = null;
    this.connected = false;
    // 【修 3 续】主动重连同样要避开 IDENTIFY 的 5 秒限流，不能用 1.5 秒。
    const DELAY = 6000;
    if (!old) { this._scheduleReconnect('主动重连', DELAY); return; }
    let done = false;
    const go = () => { if (!done) { done = true; this._scheduleReconnect('主动重连', DELAY); } };
    old.once('close', go);
    // 【官方原文】close code 1000/1001 会让 session 立即失效、bot 显示离线。
    // 重连场景要用 terminate()（直接断 TCP），让 Discord 侧保留会话供 RESUME。
    try { old.terminate(); } catch (_) { go(); }
    // 兜底：3 秒后无论如何都要重连，避免 close 事件丢失导致永久挂起
    setTimeout(go, 3000);
  }

  /**
   * 启动心跳。必须在 IDENTIFY / RESUME 之后调用 ——
   * Discord 规定未认证时发任何 payload 都会导致连接被关闭。
   */
  _startHeartbeat(interval) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this._acked = true;
    this._beat(interval);
    this.heartbeatTimer = setInterval(() => {
      // 【漏 ACK 自检】Discord 连续两次没回 ACK 就会断开。
      // 但更常见的情况是 socket 静默死亡：进程活着、日志停在「已上线」，
      // 实际连接早已不存在 —— 指令全部失效却毫无迹象。
      // 所以这里主动检查：上一个心跳没等到 ACK 就重连。
      if (!this._acked) {
        this.log('[bot] 心跳未收到 ACK，判定连接已死，主动重连');
        this._acked = true;
        this._reconnect();
        return;
      }
      this._beat(interval);
    }, interval);
  }

  _beat(interval) {
    this._acked = false;
    this._send({ op: OP.HEARTBEAT, d: this.seq });
    void interval;
  }

  _send(obj) {
    const ws = this.ws;
    if (!ws) return;
    // 记录发出的关键帧。心跳只在会话内前 3 次记录，否则每 41 秒一条会淹没日志。
    if (obj.op === OP.HEARTBEAT) this._beatCount = (this._beatCount || 0) + 1;
    if (obj.op !== OP.HEARTBEAT || this._beatCount <= 3) {
      const desc = obj.op === OP.HEARTBEAT ? `HEARTBEAT #${this._beatCount} seq=${obj.d}`
        : obj.op === OP.IDENTIFY ? `IDENTIFY intents=${obj.d.intents} (token 隐去)`
        : obj.op === OP.RESUME ? `RESUME session=${String(obj.d.session_id).slice(0, 8)} seq=${obj.d.seq}`
        : obj.op === 4 ? `INTERACTION 响应 op4 type=${obj.d.type} id=${obj.d.interaction_id}`
        : `op=${obj.op}`;
      this.log(`  → ${desc}`);
    }
    if (process.env.BOT_TRACE) {
      const raw = JSON.stringify(obj);
      // token 不打，只打结构和长度
      this.log(`[trace] 发 op=${obj.op} 长度=${Buffer.byteLength(raw)} ${raw.slice(0, 120).replace(/"token":"[^"]+"/, '"token":"***"')}`);
    }
    // readyState 在测试用的假 socket 上可能不存在，缺失时视为可写
    if (ws.readyState != null && ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch (e) { this.log('[bot] 发送失败: ' + e.message); }
  }

  async _handleInteraction(it) {
    if (it.type === 3) {   // MESSAGE_COMPONENT —— 红包领取按钮
      /**
       * 【领取一直无效的根因】按钮 id 在 it.data.custom_id，
       * 我之前读的是 it.custom_id —— 顶层没有这个字段，恒为 undefined，
       * 于是查表必然落空 → 「未知按钮 custom_id=undefined」→ 领取永远进不去。
       */
      const cid = String((it.data && it.data.custom_id) || '');
      const key = cid.split(':')[0];          // 'hongbao:claim' → 'hongbao'
      const handler = this.commands.get('__component:' + key);
      if (!handler) {
        this.log(`[bot] 未知按钮 custom_id=${cid}（已注册: ${[...this.commands.keys()].filter(k => k.startsWith('__')).join(',')}）`);
        this._defer(it);
        return this._patch(it, { content: '这个按钮已经失效了。', ephemeral: true });
      }
      return this._run(it, handler, 'component:' + cid);
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
    // 3 秒内必须 ACK，否则 Discord 显示「应用未响应」。
    this._defer(it);
    // 记录 handler 的开始/结束/异常。之前 handler 静默失败时毫无痕迹，
    // 只能看到「收到交互」，看不出到底跑没跑。
    this.log(`  ▶ 执行 handler: /${label}`);
    try {
      const r = await handler(it, this);
      this.log(`  ✔ handler 完成: /${label}${r === undefined ? '' : ' 返回=' + JSON.stringify(r).slice(0, 60)}`);
      return r;
    } catch (e) {
      this.log(`[bot] /${label} 处理异常: ${(e && e.stack) || e}`);
      try { await this._patch(it, { content: `❌ \`/${label}\` 执行出错：${e.message}`, ephemeral: true }); }
      catch (_) {}
    }
  }

  /**
   * 运行时诊断快照。返回「现在到底连着没有」的全部事实，
   * 而不是从日志里猜。WebSocketServerName/readyState 映射为可读名称。
   */
  diagnostics() {
    const ws = this.ws;
    const stateName = !ws ? '无连接'
      : ws.readyState === 0 ? '连接中'
      : ws.readyState === 1 ? '已连接'
      : ws.readyState === 2 ? '关闭中'
      : ws.readyState === 3 ? '已断开' : '未知';
    return {
      socketState: stateName,
      connected: this.connected,
      lastAck: this._acked,
      sessionId: this.sessionId,
      resumeUrl: this.resumeUrl,
      seq: this.seq,
      willResume: this._willResume,
      retries: this.retries,
      heartbeatRunning: !!this.heartbeatTimer,
      lastRecvSecondsAgo: this._lastRecv
        ? Math.round((Date.now() - this._lastRecv) / 1000) : null,
      uptimeSeconds: Math.round(process.uptime()),
      commands: [...this.commands.keys()],
    };
  }

  // ---------- 交互响应 ----------

  _ackPayload(payload) {
    return { type: 4, data: { ...payload, flags: payload.ephemeral ? 64 : undefined } };
  }

  /**
   * ACK 交互：DEFER_CHANNEL_MESSAGE（type 5 = 「稍后回复」）。
   *
   * 【必须是 REST，不是 Gateway】Gateway 的可发送 opcode 里没有「交互响应」，
   * 我之前用 _send({op:4}) 在 WebSocket 上发，Discord 无法解码，
   * 立刻 close 4002（Error while decoding payload）—— 日志证据：
   * 每次「★ 收到交互」后面紧跟着 4002，且用户永远收不到任何回复。
   *
   * 正确端点是 POST /interactions/{interaction_id}/callback。
   * 同一个 interaction 只能 ACK 一次，所以这里做去重。
   */
  _defer(it) {
    if (!this._deferred) this._deferred = new Set();
    if (this._deferred.has(it.id)) return false;
    this._deferred.add(it.id);
    if (this._deferred.size > 50) {
      const first = this._deferred.values().next().value;
      this._deferred.delete(first);
    }
    const iid = String(it.id);

    /**
     * 【4002/404 的真正根因 —— 路径缺了 interaction.token】
     *
     * 官方原文（Create Interaction Response）：
     *   POST /interactions/{interaction.id}/{interaction.token}/callback
     *
     * 注意 {interaction.token} 是【路径的一段】，不是请求头。
     * 我此前写的是 POST /interactions/{id}/callback —— 少了一段，
     * Discord 无法把请求路由到该交互，于是返回 404 {"code":0}。
     * 这个 404 与「id 是否存在」无关：我用一个纯属捏造的 id 打同一路径，
     * 拿到的响应字节完全相同 —— 所以之前所有「token 过期」「被消费」
     * 「端点废弃」的推断全是错的。
     *
     * 该端点【不需要】Bot token 认证，用 interaction.token 本身即可。
     */
    if (process.env.SKIP_INTERACTION_ACK === '1') {
      this.log(`  ⏭ 跳过 ACK（诊断模式）id=${iid}`);
      return true;
    }
    /**
     * 【不要用 type 5 (DEFERRED)】
     *
     * type 5 会让 Discord 显示「爆点正在响应……」，直到收到一条【正式回复】。
     * 我们的回复全部走私信（Responder），于是那条正式回复永远不来 ——
     * 用户看到的就是永久转圈，直到 token 过期。
     * 日志里实测过：补发 type 4 + content:'' 会返回
     * 400 "already acknowledged"，挂起也关不掉。
     *
     * 所以这里【直接发 type 4 的 ephemeral 占位】：
     *   - 满足 3 秒内响应要求（不再显示「应用程序未响应」）
     *   - 没有挂起状态（不会出现「正在响应……」）
     * 真正的内容随后由私信送达。
     */
    this.restAnon('POST', `/interactions/${iid}/${it.token}/callback`, {
      type: 4,
      data: { content: '⏳ 处理中，详情稍后发到你的私信…', flags: 64 },
    })
      .then(() => { this._ackOk = true; this.log(`  ✓ 已响应 ${iid}（无挂起，详情走私信）`); })
      .catch((e) => {
        this._ackOk = false;
        this.log(`  ✗ 响应失败 ${iid}: ${e.message} 原始=${JSON.stringify(e.raw || null)}`);
      });
    return true;
  }

  /**
   * 后续回复交互。
   *
   * 端点是 /interactions/{id}/callback（不是 PATCH /interactions/{id}）：
   * 后者已被 Discord 废弃，且我们此前 PATCH 出的 404 正是它造成的。
   * 一旦已 ACK(type 5)，后续所有回复都走同一个 callback 端点，
   * 第一次之后的要带 message id（可从返回的 message 对象拿到）。
   */
  _patch(it, payload) {
    const body = this._ackPayload(payload);
    // 已 ACK 过(type 5)时，后续回复用 type 4 + 附带 message id
    if (this._deferred && this._deferred.has(it.id)) {
      const mid = it._messageId;
      if (mid) body.data.message_id = mid;
    }
    return this.restAnon('POST', `/interactions/${it.id}/${it.token}/callback`, body);
  }

  _reply(it, payload) {
    return this._patch(it, payload);
  }

  // ---------- REST ----------

  /**
   * multipart 请求。带附件的消息必须走这个 —— 用 JSON 发 files[] 会被
   * Discord 静默丢弃附件（attachments: []），不报错但图永远不显示。
   */
  async restForm(method, path, form) {
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: 'Bot ' + this.token },   // 不设 Content-Type，让 fetch 带 boundary
      body: form,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!r.ok) {
      const msg = (data && data.message) || `HTTP ${r.status}`;
      this.log(`[bot] REST ${method} ${path} → ${r.status} ${msg} 原始=${JSON.stringify(data).slice(0, 200)}`);
      const e = new Error(msg);
      e.status = r.status;
      e.raw = data;
      throw e;
    }
    return data;
  }

  /**
   * 交互回调专用请求。
   *
   * 官方明确：Create Interaction Response 端点用 interaction.token 认证，
   * 不需要 Bot token。这里必须【不发】Authorization 头 ——
   * 带 Bot token 时该端点会返回 404（凭据与路径中的 token 不匹配）。
   */
  async restAnon(method, path, body) {
    const r = await fetch(API + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!r.ok) {
      const msg = (data && data.message) || `HTTP ${r.status}`;
      // 不打完整路径 —— 里面含 interaction token
      this.log(`[bot] 交互回调 ${method} /interactions/${path.split('/')[2]} → ${r.status} ${msg}`);
      const e = new Error(msg);
      e.status = r.status;
      e.raw = data;
      throw e;
    }
    return data;
  }

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
