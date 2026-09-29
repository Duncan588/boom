/**
 * 每日高倍活动调度器
 *
 * 需求（用户 2026-09-28）：
 *   - 每天北京时间 18:00–23:00 之间【随机选一个小时】自动开启活动
 *   - 倍率范围 1x – 100x（100x 是封顶，实测 flightMs(100)≈73.8s）
 *   - 自动在 Discord 服务器创建「组织活动」（Guild Scheduled Event）
 *   - 并把活动消息发布到频道 921394612378152991
 *
 * 设计要点：
 *   1. 时区：全部用【显式北京时间】判定（beijingParts / todayKey 走 Asia/Shanghai）。
 *      ⚠️ 旧注释说「服务器本身就是 Asia/Shanghai，getHours() 直接是北京时间」——
 *      这是错的。线上服务器 timedatectl 是 Etc/UTC，getHours() 返回 UTC 小时，
 *      于是抽中 21:00 实际在 UTC 21:00 = 北京时间次日 05:00 触发（用户报「凌晨四点开活动」）。
 *      不要再依赖服务器 TZ，也不要用 Date 的本地 getter。
 *   2. 每天的随机小时在【当天首次检查时】决定并落库（daily_hour），
 *      这样同一天的多次重启不会换时段；跨天才重选。
 *   3. 活动写进 events_json（引擎每局读的同一份配置），
 *      所以开了就是引擎真的按这个倍率带跑，不只是前端横幅。
 *   4. 结束时间同样落库，到点自动撤掉，避免"忘了关"导致全天高倍。
 *
 * Discord 部分全部容错：没有 token / 没权限 / 频道不存在都只记日志，
 * 绝不能因为发不出去就让活动开不起来。
 */

const db = require('./db');

const CFG_DEFAULT = {
  enabled: '1',
  window_from: '18',       // 北京时间 18:00 起
  window_to: '23',         // 到 23:00 止（含 22 点那一小时）
  min_rate: '1',
  max_rate: '100',         // 用户指定封顶 100x
  weight: '0.85',          // 偏向高倍
  guild_id: '',            // 由 .env 提供
  channel_id: '921394612378152991',
  announce: '1',
};

// 每天随机挑一个小时（北京时间），落在 [from, to] 闭区间
function hashDay(dayKey) {
  let seed = 0;
  for (let i = 0; i < dayKey.length; i++) seed = (seed * 31 + dayKey.charCodeAt(i)) >>> 0;
  return seed;
}

function todayKey(d = new Date()) {
  return d.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 10);
}

/**
 * 取北京时间的 {hour, minute}。
 *
 * ⚠️ 之前用的是 new Date().getHours() —— 那是【服务器本地时区】。
 * 服务器 timedatectl 显示 Etc/UTC，所以 getHours() 返回 UTC 小时：
 *   抽中 21:00 → UTC 21:00 = 北京时间次日 05:00
 * 用户在凌晨 4 点看到活动就是这么来的（用户报「凌晨四点会开启活动」）。
 * 全部活动判定必须走北京时间，不能依赖服务器 TZ。
 */
function beijingParts(d = new Date()) {
  const s = d.toLocaleString('en-GB', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  // en-GB 24 小时制产出 "29/09/2026, 04:01:05"
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})/);
  if (!m) {
    const n = new Date(d.getTime() + 8 * 3600 * 1000);
    return { hour: n.getUTCHours(), minute: n.getUTCMinutes() };
  }
  return { hour: Number(m[4]), minute: Number(m[5]) };
}

class DailyHighRate {
  constructor() {
    this.timer = null;
    this.lastDay = null;
    this.active = null;      // { hour, eventId, messageId, name, min, max }
  }

  cfg() {
    const g = (k) => db.getSetting(`daily_${k}`, CFG_DEFAULT[k]);
    return {
      enabled: String(g('enabled')) === '1',
      from: Number(g('window_from')) || 18,
      to: Number(g('window_to')) || 23,
      min: Number(g('min_rate')) || 1,
      max: Number(g('max_rate')) || 100,
      weight: Number(g('weight')) ?? 0.85,
      guildId: g('guild_id'),
      channelId: g('channel_id'),
      announce: String(g('announce')) === '1',
    };
  }

  start() {
    this.stop();
    const c = this.cfg();
    if (!c.enabled) { console.log('[daily] 每日高倍活动已关闭（daily_enabled=0）'); return; }
    console.log(`[daily] 每日高倍活动已启用：北京时间 ${c.from}:00–${c.to}:00 之间随机 1 小时，倍率 ${c.min}x–${c.max}x`);
    this.tick();
    // 每 60s 检查一次（引擎每局最长 74s，分钟级精度足够）
    this.timer = setInterval(() => this.tick(), 60 * 1000);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 当前是否应处于活动时段 */
  inWindow(c, hour) {
    return hour >= c.from && hour < c.to;
  }

  tick() {
    let c;
    try { c = this.cfg(); } catch (_) { return; }
    if (!c.enabled) return;

    const now = new Date();
    const day = todayKey(now);
    const bj = beijingParts(now);
    const hour = bj.hour;
    const minute = bj.minute;

    // 跨天 → 清掉昨天的活动状态
    if (this.lastDay !== day) {
      if (this.active) { this.log('跨天清理昨日活动'); this.active = null; }
      this.pending = null;         // 预告也要清，否则会跨天误开
      this.lastDay = day;
    }

    // 今天的随机小时（落库，跨重启稳定）
    //
    // ⚠️ 选点范围是 [from, to] 闭区间，不是 [from, to)。
    // 用户说的「18-23」如果按半开区间实现，23 点永远抽不到
    // （且 lastHour === hour 的判断在 23 点也永远不成立）。
    const LO = c.from;
    const HI = Math.max(c.from, c.to - 1);   // 活动占 [h, h+1)，所以最晚 22 点起
    let chosen = Number(db.getSetting('daily_hour', 0));
    // ⚠️ 之前写成 Number(db.getSetting('daily_hour_day','')) !== day，
    // 而 daily_hour_day 存的是 '2026-09-29' 这种日期串 —— Number('2026-09-29') 是 NaN，
    // NaN !== day 恒为真 → 每次 tick（60 秒）都重新抽一次并打一行日志，
    // boom.log 里刷了 600 多行同一天的结果，还白白覆盖写库。
    const chosenDay = db.getSetting('daily_hour_day', '');
    if (!chosen || chosen < LO || chosen > HI || String(chosenDay) !== day) {
      chosen = LO + (hashDay(day) % Math.max(1, HI - LO + 1));
      db.setSetting('daily_hour', String(chosen));
      db.setSetting('daily_hour_day', day);
      this.log(`${day} 抽中活动时段：${chosen}:00 – ${chosen + 1}:00`);
    }

    if (hour === chosen) {
      if (minute < 1 && !this.active) {
        // 整点后第 0 分钟才真正开启，避免提前生效
      } else if (!this.active) {
        this.activate(c, chosen);
      }
    } else if (this.active && hour > chosen) {
      this.deactivate(c, '时段结束');
    } else if (hour === chosen - 1 && minute >= 59) {
      // 【提前一分钟创建 Discord 组织活动】
      // 用户要求：活动开始前 1 分钟就要在频道身份组上方显示出来。
      // 所以 17:59 就把 Scheduled Event 建好（status=SCHEDULED），
      // 18:00 引擎才真的切到高倍倍率。
      if (!this.pending) {
        this.pending = chosen;
        this.log(`预热：${chosen - 1}:59 创建 Discord 组织活动（引擎 ${chosen}:00 生效）`);
        this.preannounceDiscord(c, chosen);
      }
    }
  }

  log(m) { console.log(`[daily] ${m}`); }

  /** 开启：写入 events_json（引擎每局读它）+ 通知 Discord */
  activate(c, hour) {
    const name = `高倍狂欢 ${hour}:00–${hour + 1}:00`;
    // 活动实际占 [hour:00, hour+1:00)，但 events_json 的 to 用 24:00 会让
    // toMinutes('24:00') 算出 1440，和引擎的 0-1439 比较永远不命中 → 必须封到 23:59
    const endMin = Math.min(1439, (hour + 1) * 60 - 1);
    const entry = {
      name,
      from: `${String(hour).padStart(2, '0')}:00`,
      to: `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`,
      min: c.min,
      max: c.max,
      weight: c.weight,
      enabled: true,
    };

    // 写进 events_json —— 引擎 activeEvent() 每局评估，会真的按这个倍率带
    let list = [];
    try { list = JSON.parse(db.getSetting('events_json', '[]') || '[]'); } catch (_) { list = []; }
    if (!Array.isArray(list)) list = [];
    list = list.filter((e) => e && e.name !== name && !e.__daily);
    list.push({ ...entry, __daily: true });
    db.setSetting('events_json', JSON.stringify(list));

    this.active = { hour, name, ...entry };
    this.log(`活动开启：${name}  倍率 ${c.min}x–${c.max}x  已写入 events_json`);

    if (c.announce) this.announceDiscord(c, name, entry);
  }

  /** 结束：撤掉 events_json 条目 + 更新 Discord 活动状态 */
  deactivate(c, why) {
    if (!this.active) return;
    const name = this.active.name;
    // 快照：closeDiscord 是异步的，而下面马上要把 this.active 置 null。
    // 之前它直接读 this.active.messageId，此时已变成 null →
    // TypeError: Cannot read properties of null (reading 'messageId')
    // → 未捕获的 Promise 拒绝直接带崩进程（游戏停服，登录也跟着挂）。
    const snap = this.active;
    let list = [];
    try { list = JSON.parse(db.getSetting('events_json', '[]') || '[]'); } catch (_) { list = []; }
    if (Array.isArray(list)) {
      list = list.filter((e) => !(e && (e.name === name || e.__daily)));
      db.setSetting('events_json', JSON.stringify(list));
    }
    this.log(`活动结束（${why}）：${name}`);
    // closeDiscord 是异步的：这里不能 await（deactivate 是同步函数），
    // 所以传快照而不是 this.active，并吃掉它的拒绝 —— 之前既没 await 也没 catch，
    // 未捕获的 Promise 拒绝会直接带崩进程（游戏停服，登录跟着挂）。
    if (c.announce) {
      this.closeDiscord(c, snap).catch((e) => this.log('结束 Discord 通知失败: ' + e.message));
    }
    this.active = null;
  }

  /* ---------- Discord：创建组织活动 + 发频道消息 ---------- */

  /**
   * 只创建 Discord 组织活动（Guild Scheduled Event），不改引擎倍率。
   *
   * 提前一分钟调用它 —— 这样活动会出现在 Discord 频道【身份组上方】的
   * 「活动」列表里，玩家提前 1 分钟就能看到，18:00 才真正开始。
   *
   * 频道消息留到 activate() 再发（那是"开始了"的播报，和预告不是一回事）。
   */
  async preannounceDiscord(c, hour) {
    const created = await this.createDiscordEvent(c, hour, '即将开始');
    if (created && created.eventId) {
      this.pendingEventId = created.eventId;
    }
  }

  /** 创建 Guild Scheduled Event，返回 {eventId} 或 null。失败只记日志。 */
  async createDiscordEvent(c, hour, tag = '') {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) { this.log('未配置 DISCORD_BOT_TOKEN，跳过 Discord 活动'); return null; }
    const guildId = c.guildId || process.env.BOT_GUILD_ID;
    if (!guildId) { this.log('未配置 guild id，跳过'); return null; }
    const H = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };

    const name = `🎉 爆点高倍狂欢 ${hour}:00–${hour + 1}:00`;
    // start 必须是【未来的时间】，否则 Discord 报 GUILD_SCHEDULED_EVENT_SCHEDULE_PAST。
    // 提前 1 分钟预热时，start 就是下一个整点。
    const base = new Date();
    const start = new Date(base.getTime() + 5 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);

    const body = {
      name,
      description:
        `🚀 爆点高倍狂欢！${tag ? '\n' + tag : ''}\n` +
        `时间：${hour}:00 – ${hour + 1}:00（北京时间）\n` +
        `倍率：${c.min}x – ${c.max}x\n` +
        `在火箭爆炸前逃跑，赢下你的倍率！`,
      scheduled_start_time: start.toISOString(),
      scheduled_end_time: end.toISOString(),
      privacy_level: 2,          // GUILD_ONLY
      status: 1,                 // SCHEDULED
      entity_type: 3,            // EXTERNAL
      entity_metadata: { location: '在爆点 Activity 内参与' },
    };

    try {
      const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/scheduled-events`, {
        method: 'POST', headers: H, body: JSON.stringify(body),
      });
      if (r.ok) {
        const ev = await r.json();
        this.log(`已创建 Discord 组织活动 id=${ev.id}${tag ? '（' + tag + '）' : ''}`);
        return { eventId: ev.id };
      }
      const t = await r.text();
      // 权限不足要给出可操作的提示，而不是干巴巴一个 403
      let hint = '';
      if (r.status === 403) hint = ' → 需给 bot 「管理活动 / Manage Events」权限';
      if (r.status === 401) hint = ' → DISCORD_BOT_TOKEN 无效';
      this.log(`创建组织活动失败 HTTP ${r.status}${hint}: ${t.slice(0, 140)}`);
      return null;
    } catch (e) { this.log('创建组织活动异常: ' + e.message); return null; }
  }

  async announceDiscord(c, name, entry) {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) { this.log('未配置 DISCORD_BOT_TOKEN，跳过 Discord 通知'); return; }
    const H = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };

    // 1) 组织活动：预热阶段已建过就复用，没有才现在建
    if (this.pendingEventId) {
      this.active.eventId = this.pendingEventId;
      this.pendingEventId = null;
      this.log('复用预热时创建的 Discord 组织活动');
    } else if (!this.active.eventId) {
      const hour = Number(String(entry.from).slice(0, 2));
      const r = await this.createDiscordEvent(c, hour, '');
      if (r) this.active.eventId = r.eventId;
    }

    // 2) 发频道消息
    if (!c.channelId) return;
    try {
      const r = await fetch(`https://discord.com/api/v10/channels/${c.channelId}/messages`, {
        method: 'POST', headers: H,
        body: JSON.stringify({
          embeds: [{
            title: `🎉 ${name}`,
            description:
              `倍率范围 **${c.min}x – ${c.max}x**\n` +
              // ⚠️ 这里必须用 entry.from/entry.to（本次【实际抽中】的时段），
              // 不要用配置里的 window_from/window_to（那是 18:00–23:00 的候选范围）。
              // 用户截图里显示「20:00 – 20:59」而当天抽中的是 21:00–22:00，
              // 就是这里被 UTC/旧值带偏了。entry 在 activate() 里由 hour 现算。
              `时间 **${entry.from} – ${entry.to}**（北京时间）\n\n` +
              `高倍局更容易出现，逃跑一次可能直接翻好几倍。\n` +
              `打开爆点 Activity 即可参与。`,
            color: 0xffb347,
            footer: { text: '爆点 · 社区娱乐积分 QUN' },
          }],
        }),
      });
      if (r.ok) {
        const m = await r.json();
        this.active.messageId = m.id;
        this.log(`已发布频道消息 channel=${c.channelId}`);
      } else {
        this.log(`发布频道消息失败 HTTP ${r.status}: ${(await r.text()).slice(0, 140)}`);
      }
    } catch (e) { this.log('发布频道消息异常: ' + e.message); }
  }

  // snap：调用方 deactivate() 在触发本方法后立刻把 this.active 置 null，
  // 所以必须用快照，否则这里读 this.active.messageId 会拿到 null 而崩溃。
  async closeDiscord(c, snap) {
    const token = process.env.DISCORD_BOT_TOKEN;
    const guildId = c.guildId || process.env.BOT_GUILD_ID;
    if (!token || !guildId) return;
    const a = snap || this.active;
    if (!a) return;
    const H = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
    if (a.eventId) {
      try {
        // status: 3 = COMPLETED（结束活动，不是删除）
        const r = await fetch(
          `https://discord.com/api/v10/guilds/${guildId}/scheduled-events/${a.eventId}`,
          { method: 'PATCH', headers: H, body: JSON.stringify({ status: 3 }) }
        );
        this.log(r.ok ? 'Discord 组织活动已标记结束' : `结束活动 HTTP ${r.status}`);
      } catch (e) { this.log('结束活动异常: ' + e.message); }
    }
    if (a.messageId && c.channelId) {
      try {
        await fetch(`https://discord.com/api/v10/channels/${c.channelId}/messages/${a.messageId}`, {
          method: 'PATCH', headers: H,
          body: JSON.stringify({
            embeds: [{
              title: `🏁 ${a.name} 已结束`,
              description: '本场高倍狂欢已结束，感谢参与。',
              color: 0x666666,
            }],
          }),
        });
      } catch (_) { /* 消息改写失败无所谓 */ }
    }
  }

  status() {
    const c = this.cfg();
    return {
      enabled: c.enabled,
      window: `${c.from}:00-${c.to}:00`,
      rate: `${c.min}x-${c.max}x`,
      todayHour: Number(db.getSetting('daily_hour', 0)) || null,
      today: todayKey(),
      active: this.active ? this.active.name : null,
      channelId: c.channelId || null,
    };
  }
}

module.exports = { DailyHighRate, daily: new DailyHighRate(), CFG_DEFAULT, todayKey, hashDay };
