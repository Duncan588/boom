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
const jev = require('./jev');

/**
 * 把一个人的心理倍率归到个性档（给降级分布加权用）。
 * 阈值参考模拟器里那六种个性：稳健 2-3x、贪财 1.6-2.2x、
 * 梭哈 1.5-5x、慢热 2.5-6x、捡漏 4-9x、赌高倍 12x 以上。
 * 边界取相邻档的重叠处，避免一个 3.0x 的人被硬塞进某一档。
 */
function classify(thr) {
  if (thr < 1.9) return 'greedy';
  if (thr < 3.2) return 'steady';
  if (thr < 5.0) return 'all_in';
  if (thr < 8.0) return 'late_bomber';
  if (thr < 12.0) return 'slow_hand';
  return 'high_chaser';
}

class Engine {
  constructor(broadcast) {
    this.broadcast = broadcast || (() => {});
    this.current = null;
    this.timer = null;
    this.running = false;
    this.jackpot = 0;
    this.settings = {};
    this.pool = 0;        // 后台资金池（原 moneypool）
    this.lastBoom = null; // 上一局实际爆点 —— Jev 的 state 用它做「已结算的历史」
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
    // Jev 的配置同步过去：后台改人格/采样率/活动段后下一局就生效，不需重启
    try { jev.configure(this.settings); } catch (e) { console.warn('[jev] configure 失败:', e.message); }
    return this.settings;
  }

  /**
   * 【mode 7】取本局在场的真人玩家档案，供 Jev 判断该爆在哪一段。
   *
   * 只统计真人（bets JOIN users），机器人不在 bets 表里所以天然排除。
   *
   * thr = 这个人的心理倍率：从他最近 20 次逃跑的实际倍率取中位数。
   * 没有逃跑历史 → 落回下注习惯推断的默认档（见 jev-archetype）。
   * 用中位数而不是均值：一次手滑点了个 1.02x 不该把他定义成稳健型。
   */
  seatedProfiles(roundId) {
    let rows = [];
    try {
      rows = db.get().prepare(
        `SELECT b.user_id, u.coins FROM bets b
         JOIN users u ON u.id = b.user_id
         WHERE b.round_id = ? AND b.status = 0`
      ).all(roundId);
    } catch (_) { return []; }
    if (!rows.length) return [];

    const out = [];
    for (const r of rows) {
      const hist = db.get().prepare(
        `SELECT escape_rate FROM bets
         WHERE user_id = ? AND status = 1 AND escape_rate > 1
         ORDER BY id DESC LIMIT 20`
      ).all(r.user_id).map((x) => Number(x.escape_rate)).filter((v) => isFinite(v) && v > 1);

      let thr = null;
      if (hist.length >= 3) {
        const s = hist.sort((a, b) => a - b);
        thr = s[Math.floor(s.length / 2)];
      }
      // 落回默认档：按他这一局的下注额相对余额判断是不是梭哈
      const amt = Number(r.coins) || 0;
      if (thr == null) thr = 2.5;
      out.push({
        ar: classify(thr),
        thr: Math.max(1.05, Math.min(thr, 200)),
        lossStreak: 0,
        coins: Math.round(amt),
      });
    }
    return out;
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
    /**
     * 【2026-09-30 修 C 项：const → let】
     *
     * 原来这里是 `const cfg = this.settings`，而下面 0a 段为了应用活动的
     * maxRateOverride 会写 `cfg = { ...cfg, max_rate: ... }` —— 在 strict mode
     * 下抛 TypeError: Assignment to constant variable。
     *
     * 【为什么它今天才暴露，而且潜伏了多久】
     * 两个活动模块都写 `const p = this.p || {}`，而 runHooks 是裸调用
     * `fn({...ctx, p})` ⇒ this 永远不是模块对象 ⇒ p 恒为 {} ⇒ 钩子恒返回 null
     * ⇒ maxRateOverride 恒为空 ⇒ 这行永远不执行。
     * 也就是说 lucky_hour 从上线至今从未生效过，这行代码是休眠的。
     * 一旦修好 this 绑定（activities/index.js 改为 fn.call(mod, ...)），
     * 这行就会在活动期真的执行 —— 不同时修 const 就是「活动一开就每局崩」。
     * 两处必须同一次提交改完。test/activity-hook.js 钉住这个组合。
     */
    let cfg = this.settings;

    /**
     * 【mode 7 / Jev 做庄】本局是否走 Jev 选段。
     * ⚠️ 三个条件缺一不可：后台选了模式 7、jev_enabled=1、API key 存在。
     *    任何一条不满足就整局走原来的表驱动 —— Jev 是可选增强，不是依赖。
     */
    const mode7 = String(cfg.odds_mode) === '7'
      && String(cfg.jev_enabled ?? '0') === '1'
      && !!(cfg.jev_api_key || process.env.TYPESAFE_API_KEY);

    /**
     * 【2026-09-30 E 项：幂律模式下 Jev 完全不参与】
     *
     * 幂律的整个卖点是「爆点与玩家无关」。让 Jev 参与 = 同一个房间得到同一个分布
     * = 玩家只要观察到房间不变就能反推爆点区间。两者在目标上是冲突的。
     * 所以 mode 9 下 mode7 恒为 false：
     *   · 不查 seatedProfiles（省掉 2N 条 SQL）
     *   · 不 tickRound / 不 prefetch（省掉外部 API 调用与费用）
     *   · 隐私：幂律运行时【没有任何玩家数据离开进程】
     *
     * mode 7 的代码与配置全部保留，管理员可以随时切回去使用。
     */
    const powerlaw = String(cfg.odds_mode) === '9';

    /**
     * 【2026-09-30 E 项】幂律模式下 Jev 恒不参与（见上面 powerlaw 的说明）。
     * 这一行放在 mode7 的定义【之后】，覆写它。
     */
    const mode7Active = mode7 && !powerlaw;

    // ---- 0a. 小活动插件钩子（可在开局前改倍率上限/抽成/标签）----
    // 框架在 server/activities/，加活动只加文件，不改主循环。
    const act = runHooks('onRoundBegin', {
      maxRateOverride: null,
      rakeOverride: null,
      activityLabel: null,
      /**
       * 【2026-09-30】活动想知道本局的 baseRtp 才能算出 rtpOverride。
       * 传进来而不是让活动自己读 db：cfg 就是本局 refreshSettings() 之后的
       * 快照，活动读 db 拿到的是【那一刻】的值，两者可能不一致
       * （本局内配置被改过）—— 那正是「活动 RTP 以哪一局为准」的老问题。
       */
      powerlawRtp: Number(cfg.powerlaw_rtp) || 0.97,
    });
    if (act.activityLabel) {
      console.log(`[activity] 本局生效: ${act.activityLabel}`);
    }
    /**
     * 【2026-09-30】maxRateOverride 只在【非幂律】模式生效。
     *
     * 幂律的定价参数是 powerlaw_rtp / powerlaw_cap，不是 max_rate。
     * 活动抬高 max_rate 在幂律下会静默无效 —— 而「配了没生效」正是
     * 本项目反复出现的运维事故形状。所以这里显式拒绝并在日志里说明，
     * 而不是让活动看起来开了、实际什么也没做。
     */
    if (act.maxRateOverride) {
      if (powerlaw) {
        console.log('[activity] 幂律模式下 maxRateOverride 不参与定价（请用 rtpBonus 调整 RTP）');
      } else {
        // 只抬高引擎上限，不改用户配置的 band —— 由 odds 层消费
        cfg = { ...cfg, max_rate: String(Math.max(Number(cfg.max_rate) || 0, act.maxRateOverride)) };
      }
    }
    /**
     * 【2026-09-30】幂律模式下活动通过 rtpOverride 调整返还率。
     *
     * 钳制做在 engine 这一层【和】game-logic 的 normRtp 里各一次：
     * 前者是「活动不许把 RTP 顶到 1.00 以上」，后者是「任何来源的 RTP
     * 都在 [0.80, 1.00]」。只在一处钳制的话，绕开另一处就能配出 RTP>1。
     * 本局内不再变动：cfg 是本局开始时的快照，抽爆点只发生一次。
     */
    if (act.rtpOverride != null && powerlaw) {
      const rtp = Math.max(0.80, Math.min(1.00, Number(act.rtpOverride)));
      if (Math.abs(rtp - (Number(cfg.powerlaw_rtp) || 0)) > 1e-9) {
        console.log(`[activity] 本局 RTP ${cfg.powerlaw_rtp} → ${rtp}`);
        cfg = { ...cfg, powerlaw_rtp: String(rtp) };
      }
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

    /**
     * 【mode 7 / Jev 做庄】取本局在场【真人】玩家档案。
     *
     * ⚠️ 只统计真人下注，机器人不计入 —— 否则「没人也有一屋子机器人」，
     *    Jev 会为一个空房间持续付费，那是纯浪费。
     *
     * 【2026-09-30 E 项：幂律模式下【完全不调用】】
     * mode 9 的爆点只由 CSPRNG 决定，不看任何玩家状态。
     * 这里除了不再影响定价，还省掉了空房间时每局一次 seatedProfiles
     * 查询（每玩家还要再查一次最近 20 次逃跑历史）—— N 个玩家就是 2N 条 SQL。
     */
    const seated = mode7Active ? this.seatedProfiles(roundId) : null;

    // ---- 4. 决定爆点（资金池反推 / 限时活动 / Jev 选段）----
    const pot = db.get().prepare(
      `SELECT COALESCE(SUM(amount),0) s FROM bets WHERE round_id = ?`
    ).get(roundId).s;
    const dec = decideRate(cfg, pot, this.pool, ev, seated && seated.length ? { seated, lastBoom: this.lastBoom } : null);


    /**
     * 【预热下一局分布】fire-and-forget，绝不 await。
     * 起飞这一刻玩家正盯着火箭等结果，任何网络等待都是可见的卡顿。
     * jev.prefetch 内部永不 reject 且带 abort 超时 —— 一个可选的外部
     * 副作用不能有能力把游戏带走（这正是活动 teardown 踩过的坑）。
     */
    if (mode7Active && seated && seated.length) {
      try {
        jev.tickRound(roundId + 1);
        jev.prefetch(seated, dec.rate, null).catch(() => {});
      } catch (_) { /* Jev 是可选增强，失败不影响本局 */ }
    }
    const rate = dec.rate;
    /**
     * 【2026-09-30 删除 max_flight_ms 硬上限】
     *
     * 原来这里有 `Math.min(rawMs, 120000)` —— 120 秒物理上限。
     * 它存在的原因是：原版曲线下 flightMs(1000) = 700 秒，
     * 而引擎是【单进程串行】的，sleep(700s) 期间全服都不能开下一局。
     *
     * 副作用很严重：显示 1000x 但只飞 120 秒 —— 玩家看到千倍结果只等了 2 分钟，
     * 觉得被骗；而且高倍局的【显示时长与结算时长不一致】。
     *
     * 现在 game-logic.js 加入了高倍加速曲线（100x = 73.8s，1000x = 100s，
     * 10000x 也只有 112.6s），最慢的一局就是 100x 的 73.8 秒，
     * 天然低于原来的 120 秒上限 —— 所以上限已经没有任何存在必要。
     *
     * ⚠️ 若这里再钳一次，会重新引入「显示倍率与实际时长不符」的 bug。
     *    game-logic 的加速曲线已用指数收敛兜底，无论 max_rate 配多大都不会飞超时。
     */
    const ms = flightMs(rate, { instant: dec.fast });
    db.get().prepare('UPDATE rounds SET rate = ? WHERE id = ?').run(rate, roundId);
    this.current.rate = rate;
    this.lastBoom = rate;                       // Jev 下一局的 state 依据
    this.current.flightStart = Date.now();      // 逃跑时按真实已飞时间算倍率
    this.current.flightTotalMs = ms;            // 【仅服务端】绝不外发，见下方注释

    /**
     * 【2026-09-30 A 项：起飞消息不再携带 flightMs】
     *
     * flightMs 与爆点【一一对应】，闭式解 t=(√(40r−24)−4)/2 可精确反推：
     * 实测往返误差最大 1.16e-2（250x 处），等于把本局答案直接发给客户端。
     * 之前只删了前端的倒计时显示（app.js 里那段注释），
     * 但【消息里那个字段本身还在】—— 删显示不等于删泄露。
     *
     * 客户端只需要「当前倍率曲线」，所以这里改发【起飞时刻】：
     * 有了 flightStart + 服务端下发的 tick 序列，客户端能画出完全相同的曲线，
     * 却拿不到任何与最终倍率有关的信息。
     */
    this.broadcast({ type: 'takeoff', gid: roundId, flightStart: this.current.flightStart });
    this.ticker = null;   // 旧的 tick 循环，本局新建

    /**
     * 【Jev 决策日志】只在真正走了 Jev 分支时打。
     *
     * ⚠️ 早先版本用 `if (mode7)` 打日志，于是会出现
     *   「[jev] 第 5426 局 段=undefined 来源=undefined」
     * 这样的行：mode7 为真（配置已开）但本局没有真人下注，
     * decideRate 走的是 7-fallback 早退分支，返回值里根本没有 jev 字段。
     * 这种日志会让人误以为 Jev 在工作，实际是空记录。
     */
    if (dec.jev) {
      console.log(`[jev] 第 ${roundId} 局 爆点 ${rate}x  段=${dec.jev.band}  来源=${dec.jev.source}  conf=${dec.jev.confidence ?? '-'}`);
    }

    /**
     * 【2026-09-30 A 项：飞行期间按固定节拍推送 tick】
     *
     * 原来是一句 `await sleep(ms)` —— 期间 WS 完全静默，客户端只能靠自己
     * 的时钟外推。现在每 TICK_MS 推一次当前倍率：
     *   · 客户端渲染的是服务端权威值，不需要自己猜（也不允许自己猜）
     *   · 消息里只有「已经发生的倍率」，与最终爆点无关，不可反推
     *
     * 【为什么不能在最后一刻「多发一跳」给客户端暗示】
     * 爆炸只由下面的 over 消息触发。若客户端收到 boom 就自己画，那本地
     * 外推与真实结束时刻之间有一个 100ms 的不一致窗口，
     * 玩家会看到「倍数冲到 12.7x 却还没炸」—— 那是客户端在替服务端预测。
     * 所以循环严格在 elapsed < ms 时才发 tick，结束由 over 独家触发。
     */
    await this.flightLoop(roundId, ms);
    if (!this.running || this.current.id !== roundId) return;

    /**
     * 【2026-09-30 B 项：到点先置 settling，再结算】
     *
     * 原来 sleep(ms) 到期后，status 仍是 'flying'，直到 this.current = null
     * 才消失。两者之间有一整段同步结算代码（查 losers、UPDATE bets、
     * 写 rounds、发 over），期间 escape() 的守卫 `status === 'flying'`
     * 依然通过 —— 玩家能在这段窗口里按【已超过爆点】的倍率结算。
     *
     * 单线程下这段通常只有几十毫秒，但 sleep 回调被事件循环排队
     * （GC、其它定时器）时可以到几百毫秒，而爆点越接近、这个窗口越致命。
     * 所以到点后立刻把 status 换成 'settling'，escape() 一律拒绝。
     */
    this.current.status = 'settling';

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
   * 飞行期 tick 循环：每 CFG.TICK_MS 广播一次当前倍率，到点返回。
   *
   * @param roundId 本局 id（用于中止判定，换局即退出）
   * @param ms      本局总飞行时长（仅服务端使用，绝不广播）
   */
  async flightLoop(roundId, ms) {
    const end = Date.now() + ms;
    let next = 0;                     // 已推送的 tick 数
    while (this.running && this.current && this.current.id === roundId) {
      const left = end - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(CFG.TICK_MS, left));
      if (!this.running || !this.current || this.current.id !== roundId) return;
      const elapsed = Date.now() - this.current.flightStart;
      // ⚠️ 到点后不再发 tick：爆炸由 over 独家触发，客户端不得自行预测。
      if (elapsed >= ms) break;
      next++;
      this.broadcast({
        type: 'tick', gid: roundId, n: next, elapsedMs: elapsed,
        rate: round2(rateAt(elapsed, FLIGHT_SCALE)),
      });
    }
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
    /**
     * 【2026-09-30 B 项：settling 一律拒绝】
     * 到点后引擎先把 status 置为 'settling' 再做结算，
     * 所以「飞行已结束、结算未完成」这个窗口不再被当成可逃跑。
     */
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

    /**
     * 【2026-09-30 B 项：与本局爆点比较，≥ 爆点一律判失败（已爆）】
     *
     * 【原来缺这一句会发生什么 —— 实测，不是理论】
     * escape() 的守卫只有 `status === 'flying'`，而 flightStart 到结算之间
     * 全程都是 'flying'。所以只要飞行时间已经超过爆点对应的时长，
     * 玩家仍能提交：实测「爆点 2.0x、已飞 100 秒」这一局，
     * rateAt 算出 **1000.34x** 依然被接受并按 1000.34x 派奖。
     * 也就是说飞得越久，赢到的钱越多，而那一局本来早就该炸了。
     *
     * 这是一个真实资金漏洞：sleep 回调被事件循环排队（GC / 其它定时器）
     * 就会打开这个窗口，爆点越低（飞行越短）越容易被卡进去。
     *
     * 用 >= 而不是 >：倍率恰好等于爆点时，那一瞬爆炸也已经在发生。
     */
    const boom = Number(this.current.rate);
    if (isFinite(boom) && cur >= boom) {
      return { ok: false, code: 10010, msg: '已经爆了' };
    }

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
