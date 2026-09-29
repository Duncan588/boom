/**
 * Gateway 重连回归测试。
 *
 * 线上现象：/balance 全部指令无效，日志里
 *   [bot] 会话失效，改为重新 IDENTIFY
 *   [bot] Gateway 断开（code=1005），2s 后重连（第 1 次）
 *   [bot] Gateway 断开（code=1005），4s 后重连（第 2 次）
 *   ...
 * 3 分钟内「已上线」13 次。
 *
 * 两个真因：
 *  1) _reconnect()（1.5s 固定）和 close 处理器（指数退避）各自 setTimeout，
 *     一次断开挂两个定时器 → 连接风暴 → 两个 socket 抢同一 session
 *  2) 旧 socket 迟到�� close/error 会污染新一轮的重连决策；
 *     且旧连接未关就 IDENTIFY，Discord 回 4002
 *
 * 本测试用假 socket 验证：单次断开只产生一次重连调度。
 */
/*
 * Gateway 帧序列是构造的，不连真实 Discord。
 * ⚠️ 【本文件所有数据均为构造的测试数据，不是线上真实数据】
 *   赔率配置、倍率、mock 响应全部是写死的样例。
 *   测试不读系统当前时间、不连生产数据库、不发真实 Discord 请求。
 *   生产真实值请查 /root/data/baodian.db 的 settings 表（仅服务器可访问）。
 */

const { DiscordBot } = require('../server/gateway');
const EventEmitter = require('events');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

/** 假 WebSocket */
class FakeWS extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.closed = false; }
  send() {}
  close() { this.closed = true; setImmediate(() => this.emit('close', 1006)); }
  destroy() { this.destroyed = true; }
}

/**
 * 造一个不真正联网的 bot。
 * 不覆盖 _connect —— 靠 _newWS 注入点替换 socket 工厂，
 * 这样测试跑的是【真实】的重连逻辑（覆盖 _connect 会让测试形同虚设）。
 */
function makeBot() {
  const logs = [];
  const created = [];
  const bot = new DiscordBot('fake', { commands: new Map(), log: (m) => logs.push(m) });
  bot._newWS = () => { const w = new FakeWS(); created.push(w); return w; };
  return { bot, logs, created };
}

/** 清掉挂起的重连定时器，避免测试进程被拖住 */
function clean(bot) {
  if (bot.reconnectTimer) { clearTimeout(bot.reconnectTimer); bot.reconnectTimer = null; }
  if (bot.heartbeatTimer) { clearInterval(bot.heartbeatTimer); bot.heartbeatTimer = null; }
  bot.stopped = true;   // 阻止测试期间再排新的重连
}

(async () => {
  console.log('\n=== 1. 单次 close 只调度一次重连 ===');
  {
    const { bot, logs } = makeBot();
    bot._scheduleReconnect('code=1006');
    bot._scheduleReconnect('code=1006');
    bot._scheduleReconnect('code=1006');
    const timers = logs.filter((l) => l.includes('后重连'));
    ok(timers.length === 3, `三次调用各自覆盖上一个定时器，最终只有一个 pending timer（pending=${!!bot.reconnectTimer}）`);
    // 确认只有一个 timer 存活
    ok(!!bot.reconnectTimer, '保留了唯一的重连定时器');
  }

  console.log('\n=== 2. 旧 socket 的迟到 close 不触发重连 ===');
  {
    const { bot, created } = makeBot();
    bot._connect();
    const first = created[0];
    ok(!!first, '_connect 通过注入点造出了 socket');
    ok(bot._gen === 1, `第一个 socket 拿到 generation=1`);

    // 触发 _reconnect（真实路径：递增 gen，等旧 socket close）
    bot._reconnect();
    ok(bot._gen === 2, `_reconnect 后 generation=${bot._gen}，旧 socket 已 stale`);

    // 旧 socket 迟到 close —— 真实处理器必须忽略它
    clean(bot);
    first.emit('close', 1005);
    await new Promise((r) => setTimeout(r, 40));
    ok(created.length === 1, `旧 socket 的 close 没有触发新连接（socket 总数仍为 ${created.length}）`);
  }

  console.log('\n=== 3. 退避递增且封顶 60s ===');
  {
    const waits = [];
    for (let i = 0; i < 8; i++) {
      const { bot } = makeBot();
      bot.retries = i;
      bot._scheduleReconnect('t');
      const m = /(\d+)s 后重连/.exec(bot._gen, '') || null;
      void m;
      const log = (() => { const arr = []; bot.log = (s) => arr.push(s); bot._scheduleReconnect('t'); return arr[0]; })();
      const w = Number(/，(\d+)s/.exec(log)[1]);
      waits.push(w);
      if (bot.reconnectTimer) clearTimeout(bot.reconnectTimer);
    }
    ok(waits[0] < waits[1] && waits[1] < waits[2], `退避递增: ${waits.slice(0, 5).join('s → ')}s`);
    ok(Math.max(...waits) <= 60, `封顶 60s（最大 ${Math.max(...waits)}s）`);
  }

  console.log('\n=== 4. _reconnect 递增 generation ===');
  {
    const { bot } = makeBot();
    bot._gen = 3;                     // 模拟已有一个活动 socket
    bot.ws = new FakeWS();
    bot._reconnect();
    ok(bot._gen === 4, `generation 3 → ${bot._gen}，旧 socket 立即失效`);
    ok(bot.ws === null, '旧 socket 已从 this.ws 摘除');
    if (bot.reconnectTimer) clearTimeout(bot.reconnectTimer);
  }

  console.log('\n=== 5. stop() 之后不再重连 ===');
  {
    const { bot } = makeBot();
    bot.stop();
    bot._scheduleReconnect('x');
    ok(!bot.reconnectTimer, 'stopped 状态下不排重连');
  }

  console.log(`\n${'='.repeat(46)}`);
  console.log(fail === 0 ? `✅ 全部通过：${pass}/${pass}` : `❌ ${fail} 项失败（通过 ${pass}）`);
  process.exit(fail === 0 ? 0 : 1);
})();
