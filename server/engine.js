'use strict';
/**
 * 游戏引擎 —— 取代原 3 个 PHP 进程（Quotation.php + Cmd.php + pushLoop）
 *
 * 一轮流程：
 *   1. INSERT round (status=1) → 广播 {type:'begin', gid, betMs}
 *   2. 机器人陆续下注 → 广播 {type:'bets', is_list:1, list:[...]}
 *   3. 等待 BET_MS，锁定下注 (status=2)
 *   4. 按赔率飞行 flightMs(rate) → 期间玩家可点击逃跑
 *   5. 广播 {type:'over', gid, boom:rate}，未逃跑者判负
 */
const { CFG, FLIGHT_SCALE, flightMs, rateAt, payout, decideRate, activeEvent, round2, sleep } = require('./game-logic');
const { runHooks } = require('./activities');
const db = require('./db');

class Engine {
  constructor(broadcast) {
    this.broadcast = broadcast || (() => {});
    this.current = null;
    this.timer = null;
    this.running = false;
    this.jackpot = 0;
    this.settings = {};
    this.pool = 0;        // 后台资金池（原 moneypool）
  }

  start() {
    if (this.running) return;
    this.running = true;
    // 展示用奖池：给个非零起点，纯装饰，无真实资金
    this.jackpot = Number(db.getSetting('jackpot', 0)) || 0;
    if (this.jackpot <= 0) {
      this.jackpot = 50000 + Math.round(Math.random() * 50000);
      db.setSetting('jackpot', this.jackpot);
    }
    this.refreshSettings();
    this._loop();
  }

  /** 重新读取 admin 配置（后台改参数后立即生效） */
  refreshSettings() {
    this.settings = db.allSettings();
    this.pool = Number(this.settings.pool_balance) || 0;
    return this.settings;
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async _loop() {
    while (this.running) {
      try {
        await this.playRound();
      } catch (e) {
        console.error('[engine] 轮次异常:', e.message);
        await sleep(1500);
      }
    }
  }

  async playRound() {
    this.refreshSettings();
    const cfg = this.settings;

    // ---- 0a. 小活动插件钩子（可在开局前改倍率上限/抽成/标签）----
    // 框架在 server/activities/，加活动只加文件，不改主循环。
    const act = runHooks('onRoundBegin', {
      maxRateOverride: null,
      rakeOverride: null,
      activityLabel: null,
    });
    if (act.activityLabel) {
      console.log(`[activity] 本局生效: ${act.activityLabel}`);
    }
    if (act.maxRateOverride) {
      // 只抬高引擎上限，不改用户配置的 band —— 由 odds 层消费
      cfg = { ...cfg, max_rate: String(Math.max(Number(cfg.max_rate) || 0, act.maxRateOverride)) };
    }

    // ---- 0. 限时活动检测 ----
    const ev = activeEvent(cfg);
    if (ev && this.currentEventId !== ev.name) {
      this.currentEventId = ev.name;
      this.broadcast({ type: 'event', name: ev.name, min: ev.min, max: ev.max });
      console.log(`[event] 活动开始: ${ev.name} (${ev.min}x-${ev.max}x)`);
    } else if (!ev && this.currentEventId) {
      console.log(`[event] 活动结束: ${this.currentEventId}`);
      this.currentEventId = null;
      this.broadcast({ type: 'event_end' });
    }

    // ---- 1. 开新局 ----
    const info = db.get().prepare(
      `INSERT INTO rounds (rate, status, created_at) VALUES (?, 1, ?)`
    ).run(Number(cfg.min_rate) || CFG.MIN_RATE, db.now());
    const roundId = Number(info.lastInsertRowid);
    // 绝对截止时间：下单阶段结束 / 封盘阶段结束（服务端时钟）
    const t0 = Date.now();
    this.betEndAt = t0 + CFG.BET_MS;
    this.lockEndAt = this.betEndAt + CFG.LOCK_MS;
    this.current = {
      id: roundId, status: 'betting',
      rate: Number(cfg.min_rate) || CFG.MIN_RATE,
      betEndAt: this.betEndAt, lockEndAt: this.lockEndAt,
    };

    this.broadcast({
      type: 'begin',
      gid: roundId,
      betMs: CFG.BET_MS,                   // 下单阶段
      lockMs: CFG.LOCK_MS,                 // 封盘阶段
      totalMs: CFG.BET_MS + CFG.LOCK_MS,   // 总窗口
      // 绝对截止时间（服务端时钟，毫秒）。前端按它算倒计时，
      // 不再用「总数 - 已经过时间」自己估，否则机器人推送耗时会让倒计时偏长。
      betEndAt: this.betEndAt,
      lockEndAt: this.lockEndAt,
      jackpot: round2(this.jackpot),
      event: ev ? { name: ev.name, min: ev.min, max: ev.max } : null,
    });

    // ---- 2. 机器人下注（错峰推送，制造"人气"）----
    // 机器人推送必须【严格落在下单阶段内】，否则会把封盘/起飞推迟。
    // 之前用「预算 + 补足 sleep」两段式，总时长 = 机器人耗时 + 补足量 ≈ 10s，
    // 但前端按 13.2s 倒计时 → 多出 3.2s 假倒计时（用户反馈"还有3秒就开始了"）。
    // 现在改成：先算出下单阶段截止时间，机器人按剩余时间分配间隔，推完就等封盘。
    const robots = db.listRobots(0);
    const n = Math.max(1, Math.min(CFG.ROBOT_MAX, robots.length));
    const bMin = Number(cfg.robot_bet_min) || CFG.ROBOT_BET_MIN;
    const bMax = Number(cfg.robot_bet_max) || CFG.ROBOT_BET_MAX;
    const picked = robots.slice(0, n).map((r) => ({ ...r, bet: round2(bMin + Math.random() * (bMax - bMin)) }));
    // 机器人占下单阶段的前 70%，剩下 30% 留给真人玩家
    const slotMs = Math.max(60, (CFG.BET_MS * 0.70) / n);
    for (const rb of picked) {
      if (!this.running || this.current.id !== roundId) return;
      this.broadcast({
        type: 'bets', is_list: 0,
        memberid: `r${rb.id}`,
        nickname: rb.name,
        head_url: rb.avatar || '/assets/robot.svg',
        bet: rb.bet,
      });
      await sleep(slotMs * (0.75 + Math.random() * 0.5));
    }
    this.broadcast({ type: 'bets_done' });

    // ---- 3. 等到下单阶段结束（按绝对时间，不靠累加 sleep 估算）----
    await this.waitUntil(this.betEndAt, roundId);
    if (!this.running || this.current.id !== roundId) return;

    // ---- 3.5 封盘阶段：明确广播，前端禁用下注按钮并显示封盘倒计时 ----
    this.current.status = 'locked';
    this.broadcast({ type: 'lock', gid: roundId, lockMs: CFG.LOCK_MS, lockEndAt: this.lockEndAt });

    // ---- 4. 等封盘结束才起飞 ----
    await this.waitUntil(this.lockEndAt, roundId);
    if (!this.running || this.current.id !== roundId) return;

    db.get().prepare('UPDATE rounds SET status = 2 WHERE id = ?').run(roundId);
    this.current.status = 'flying';

    // ---- 4. 决定爆点（资金池反推 / 限时活动）----
    const pot = db.get().prepare(
      `SELECT COALESCE(SUM(amount),0) s FROM bets WHERE round_id = ?`
    ).get(roundId).s;
    const dec = decideRate(cfg, pot, this.pool, ev);
    const rate = dec.rate;
    // 飞行时长上限：原版靠资金池约束不会出现极端值，但我们允许后台把 max_rate 调到
    // 1000，flightMs(1000) = 700 秒，会把整个引擎 sleep 住（单进程引擎，12 分钟卡死）。
    // 这里钳一个物理上限，保证每一局都能在可接受时间内结束。
    //
    // 100x = 73.8s（实测），所以活动封顶 100x 时上限必须 > 73.8s，
    // 否则高倍局会被静默截断成 90s 但倍率仍显示 100x（显示与结算不一致）。
    const rawMs = flightMs(rate, { instant: dec.fast });
    const CAP_MS = Number(cfg.max_flight_ms) || 120000;   // 默认 120s
    const ms = Math.min(rawMs, CAP_MS);
    if (rawMs > CAP_MS) {
      console.warn(`[engine] 爆点 ${rate.toFixed(2)}x 飞行 ${(rawMs / 1000).toFixed(1)}s 超过上限，钳到 ${CAP_MS / 1000}s`);
    }
    db.get().prepare('UPDATE rounds SET rate = ? WHERE id = ?').run(rate, roundId);
    this.current.rate = rate;
    this.current.flightStart = Date.now();      // 逃跑时按真实已飞时间算倍率
    this.current.flightTotalMs = ms;            // 中途加入的玩家据此算剩余时间
    this.broadcast({ type: 'takeoff', gid: roundId, flightMs: ms });

    await sleep(ms);
    if (!this.running || this.current.id !== roundId) return;

    // ---- 5. 爆点结算 ----
    const now = db.now();
    const hash = require('crypto').createHash('sha256').update(`${roundId}:${now}`).digest('hex');

    const losers = db.get().prepare('SELECT * FROM bets WHERE round_id = ? AND status = 0').all(roundId);
    if (losers.length) {
      const lostPot = losers.reduce((s, b) => s + b.amount, 0);
      for (const b of losers) {
        // 【爆掉 = 输钱，不退本金】
        // 下注时已经扣过一次钱，这里再补一笔就成了凭空造币：
        // 余额 0 → 下注 -1000 → 爆点 +1000 → 又是 1000，于是每局白嫖一次，
        // 流水看起来像钱在凭空产生（原版 PushController 只把 state 置 1、
        // is_win 置 0，把注额并进奖池，从不给输家退钱，这里跟原版对齐）。
        db.get().prepare(
          `UPDATE bets SET status = 2, profit = 0, escape_rate = 0 WHERE id = ?`
        ).run(b.id);
      }
      // 爆掉的钱进奖池（展示用）和后台资金池（决定赔率）
      this.jackpot += lostPot;
      this.pool += lostPot;
    }

    db.get().prepare(
      `UPDATE rounds SET status = 3, settled_at = ?, hash = ? WHERE id = ?`
    ).run(now, hash, roundId);
    db.setSetting('jackpot', round2(this.jackpot));
    db.setSetting('pool_balance', round2(this.pool));

    this.broadcast({
      type: 'over',
      gid: roundId,
      boom: rate,
      jackpot: round2(this.jackpot),
    });
    this.current = null;
    await sleep(2500);
  }

  /**
   * 等待到某个绝对时间点（服务端时钟），期间每 200ms 检查一次是否被中止。
   * 用绝对时间而不是累加 sleep —— 累加会把每一步的误差累积起来，
   * 机器人推送耗时一变，实际起飞时间就跟着漂移，倒计时就对不上了。
   */
  async waitUntil(endAt, roundId) {
    while (this.running && (!roundId || (this.current && this.current.id === roundId))) {
      const left = endAt - Date.now();
      if (left <= 0) return;
      await sleep(Math.min(200, left));
    }
  }

  /** 下单 */
  bet(userId, roundId, amount) {
    if (!this.current || this.current.id !== roundId || this.current.status !== 'betting') {
      return { ok: false, code: 10002, msg: '本期已封盘' };
    }
    const u = db.getUserById(userId);
    if (!u) return { ok: false, code: 10004, msg: '用户不存在' };
    if (u.frozen) return { ok: false, code: 10005, msg: '账号已被冻结' };
    if (amount <= 0) return { ok: false, code: 10000, msg: '金额无效' };
    if (u.coins < amount) return { ok: false, code: 10001, msg: 'QUN 不足' };

    // 【关键】必须先查重再扣钱。
    // 之前是 addCoins(-amount) 之后才 INSERT OR IGNORE：重复下注时 SQL 被静默忽略，
    // 但钱已经扣掉了 —— 点 N 次扣 N 次的钱，只记 1 笔。这是真实的资金漏洞。
    const dup = db.get().prepare(
      'SELECT id FROM bets WHERE round_id = ? AND user_id = ?'
    ).get(roundId, userId);
    if (dup) return { ok: false, code: 10009, msg: '本期已下注' };

    try {
      db.tx((d) => {
        const row = d.prepare('SELECT coins FROM users WHERE id = ?').get(userId);
        if (!row || row.coins < amount) {
          const e2 = new Error('QUN 不足');
          e2.code = 10001;
          throw e2;
        }
        d.prepare('UPDATE users SET coins = ? WHERE id = ?').run(Math.round((row.coins - amount) * 100) / 100, userId);
        d.prepare(
          `INSERT INTO bets (round_id, user_id, amount, status, created_at) VALUES (?,?,?,0,?)`
        ).run(roundId, userId, amount, db.now());
        d.prepare('INSERT INTO coin_logs (user_id,delta,balance,reason,ref_id,created_at) VALUES (?,?,?,?,?,?)')
          .run(userId, -amount, Math.round((row.coins - amount) * 100) / 100, 'bet', String(roundId), db.now());
      });
    } catch (e) {
      return { ok: false, code: e.code || 10003, msg: e.message };
    }

    const who = u.global_name || u.username;
    this.broadcast({
      type: 'bets', is_list: 0,
      memberid: userId,
      nickname: who,
      head_url: avatarUrl(u),
      bet: amount,
      me: true,
    });
    // 弹幕提示：让所有人（包括玩家自己）都看到「xxx 下注 10 QUN」
    this.saveChat(userId, who, 'bet', `下注 ${round2(amount)} QUN`);
    this.broadcast({
      type: 'chat', kind: 'system',
      name: who,
      text: `下注 ${round2(amount)} QUN`,
    });
    return { ok: true, balance: db.getUserById(userId).coins };
  }

  /**
   * 本局已产生的下注（供中途加入的客户端补齐玩家列表）
   * 只保留广播过的字段，不含任何敏感信息。
   */
  currentBets() {
    if (!this.current) return [];
    const rows = db.get().prepare(
      `SELECT b.id, b.user_id, b.amount, u.username, u.global_name, u.avatar
       FROM bets b LEFT JOIN users u ON u.id = b.user_id
       WHERE b.round_id = ? ORDER BY b.id ASC`
    ).all(this.current.id);
    return rows.map((r) => ({
      id: r.id,
      memberid: r.user_id,
      nickname: r.global_name || r.username || '玩家',
      head_url: r.avatar || '/assets/robot.svg',
      bet: round2(r.amount),
    }));
  }

  /**
   * 这个用户在当前局是否已下注。
   *
   * 【为什么必须有】前端刷新/中途加入时 hasBet 恒为 false（内存态丢失），
   * 按钮会显示「未下注」且点击走下注分支 → 服务端返回「本期已下注」，
   * 用户看到的现象是「下注后无法逃跑」。WS 快照带上这个标记即可恢复。
   */
  hasBetInRound(userId) {
    if (!this.current || !userId) return false;
    const row = db.get().prepare('SELECT 1 AS x FROM bets WHERE round_id = ? AND user_id = ? LIMIT 1')
      .get(this.current.id, userId);
    return !!row;
  }

  /** 逃跑 */
  escape(userId, roundId) {
    if (!this.current || this.current.id !== roundId || this.current.status !== 'flying') {
      return { ok: false, code: 10005, msg: '当前不可逃跑' };
    }
    const row = db.get().prepare('SELECT * FROM bets WHERE round_id = ? AND user_id = ?').get(roundId, userId);
    if (!row) return { ok: false, code: 10006, msg: '您本期未下注' };
    if (row.status !== 0) return { ok: false, code: 10007, msg: '已操作过了' };

    // 【关键】按【已飞行时间】实时算倍率，绝不能用 this.current.rate —— 那是最终爆点。
    // 之前写成 this.current.rate 会导致任何时候点击逃跑都按本局最高倍率结算。
    const elapsed = Date.now() - this.current.flightStart;
    const cur = round2(rateAt(elapsed, FLIGHT_SCALE));
    if (cur < 1) return { ok: false, code: 10008, msg: '倍率过低，无法逃跑' };

    const win = payout(row.amount, cur);
    const ts = db.now();

    try {
      db.tx((d) => {
        d.prepare(`UPDATE bets SET status = 1, escape_rate = ?, profit = ? WHERE id = ?`)
          .run(cur, win, row.id);
        const u = d.prepare('SELECT coins FROM users WHERE id = ?').get(userId);
        const next = Math.round((u.coins + win) * 100) / 100;
        d.prepare('UPDATE users SET coins = ? WHERE id = ?').run(next, userId);
        d.prepare('INSERT INTO coin_logs (user_id,delta,balance,reason,ref_id,created_at) VALUES (?,?,?,?,?,?)')
          .run(userId, win, next, 'escape', String(roundId), ts);
      });
    } catch (e) {
      return { ok: false, code: 10007, msg: '结算失败' };
    }

    // 派奖从后台资金池扣除（与原版 moneypool 逻辑一致，影响后续赔率）
    this.pool = Math.max(0, this.pool - win);

    const u = db.getUserById(userId);
    const name = u.global_name || u.username;
    // ⚠️ 这里是【广播给所有人】，所以不能写 me: true。
    // 之前 me 硬编码为 true → 所有人的前端都进 if (d.me) 分支：
    //   · 自己没逃跑却收到「逃跑成功！+xxx QUN」的 toast 和音效
    //   · S.escDone = true + setBetBtn() → 【别人的逃跑把自己的逃跑按钮也锁了】
    // me 只能通过 sendTo(自己的 socket) 单独发。
    const payload = {
      type: 'escape', is_list: 0,
      uid: userId,
      user_name: name,
      head_url: avatarUrl(u),
      escape: cur,
      bet: row.amount,
      profit: win,
      balance: u.coins,
    };
    this.broadcast(payload);
    // 单独给逃跑者本人：只有他该看到 toast / 余额更新 / 按钮锁定
    try { this.sendTo(userId, { ...payload, me: true }); } catch (_) {}
    // 系统飘字：xxx 逃了 2.35x
    this.saveChat(userId, name, 'escape', `逃了 ${cur.toFixed(2)}x`);
    this.broadcast({ type: 'chat', kind: 'escape', name, text: `逃了 ${cur.toFixed(2)}x` });
    return { ok: true, profit: win, rate: cur, balance: u.coins };
  }

  /**
   * 落库一条聊天/系统消息。服务器保留历史，带时间戳。
   * 不做速率限制和敏感词过滤（用户明确要求），仅做长度与类型校验。
   */
  saveChat(userId, name, kind, text) {
    try {
      db.get().prepare(
        'INSERT INTO chat_messages (user_id, name, kind, text, created_at) VALUES (?,?,?,?,?)'
      ).run(userId == null ? null : userId, String(name || '系统').slice(0, 40), String(kind || 'user'),
            String(text).slice(0, 200), db.now());
    } catch (_) { /* 落库失败不影响广播 */ }
  }

  /**
   * 玩家发言（完整弹幕）。
   * 按要求不做速率限制和敏感词过滤，仅做长度与类型校验。
   */
  chat(userId, text) {
    const msg = String(text == null ? '' : text).trim();
    if (!msg) return { ok: false, error: '不能为空' };
    if (msg.length > 120) return { ok: false, error: '太长了' };
    const u = db.getUserById(userId);
    if (!u) return { ok: false, error: '用户不存在' };
    const name = u.global_name || u.username;
    this.saveChat(u.id, name, 'user', msg);
    this.broadcast({
      type: 'chat', kind: 'user',
      uid: u.id, name,
      avatar: avatarUrl(u),
      text: msg,
      at: Date.now(),
    });
    return { ok: true };
  }
}

function avatarUrl(u) {
  if (!u.avatar) return '/assets/avatar-default.svg';
  if (u.avatar.startsWith('http')) return u.avatar;
  return `https://cdn.discordapp.com/${u.avatar}`;
}

module.exports = { Engine, avatarUrl };
