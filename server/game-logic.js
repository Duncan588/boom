'use strict';
/**
 * 爆点游戏核心算法
 *
 * 赔率曲线：  rate = t/2 + (t² − t)/10 + 1     （t 为飞行秒数）
 * 闭式反解：  t = (√(40·rate − 24) − 4) / 2
 *   原实现 getBDTime() 用最多 10 万次迭代逼近，此处改用闭式解，1.00~1000x 全区间精确。
 *
 * 爆点计算还原原版四种模式（admin 可调）：
 *   1 = 赢    爆点 = (资金池 − 设定值) / 总投注
 *   2 = 输    爆点 = (设定值 + 资金池) / 总投注
 *   3 = 平衡  爆点 = (资金池 + 总投注) × (1−抽水) / 总投注
 *   4 = 区间  在 [下限, 上限] 之间均匀随机
 *   5 = 加权  三段加权分布（低倍率占大头，高倍率稀有）—— 2026-09 新增
 * 池子不够时走「立即结算」：全部判负，爆点压到 1.00~1.20x
 *
 * 无论哪种模式，爆点都受 min_rate 下限保护（默认 1.10x），
 * 保证玩家至少有逃跑窗口。
 */

const CFG = {
  BET_MS: 10000,         // 下单阶段（用户要求 10 秒）
  LOCK_MS: 5000,         // 封盘阶段（用户要求 5 秒封盘后才起飞）
  WAIT_MS: 4200,         // 兼容旧字段：WAIT_MS 不再用于计算
  MIN_RATE: 1.10,        // 最低爆点（admin 可调）
  MAX_RATE: 1000,        // 最高爆点
  HOUSE_EDGE: 0.03,      // 平台抽成 3%
  ROBOT_MIN: 8,
  ROBOT_MAX: 20,
  ROBOT_BET_MIN: 10,
  ROBOT_BET_MAX: 200,
  /**
   * 飞行时间缩放系数：原版 getBDTime 换算出的 t×2.5 秒。
   * 1 = 按数学公式的真实秒数（太快，玩家来不及逃跑）
   * 2.5 = 与原版完全一致
   * 调大可让窗口更宽松，适合社区小游戏
   */
  FLIGHT_SCALE: 2.5,
  /**
   * 最低飞行时长（毫秒）。按公式 1.10x 只有 0.2 秒、1.5x 只有 1 秒 ——
   * 玩家来不及看曲线就炸了。2.5 秒是「能看到火箭飞起来再炸」的最小值。
   */
  // 【2026-09-30 已删除 MIN_FLIGHT_MS 保底飞行时长】
  //
  // 原来这里有个 2500ms 的下限，理由是「低倍率局按公式只有 0.2~1 秒，
  // 玩家来不及看清曲线」。但这个保底把【原版的瞬爆】彻底破坏了：
  // 原版 PushController::fastCalc() 的爆率是 rand(100,120)/100 = 1.00~1.20x，
  // 火箭刚起飞就炸（立即结算，0 飞行时间）。
  //
  // 加上保底后：1.01~1.5x 全部被撑成 2.5 秒，瞬爆效果完全消失。
  // 于是又不得不加一个「☐ 瞬爆」勾选框去强行绕过自己加的保底 ——
  // 纯属自己造 bug 自己补。
  //
  // 现在恢复原版行为：不设任何飞行时长下限，1.0x 就是 0ms。
  // 用户分布表里 1.01~1.5x 那行【不需要勾任何东西】自动就是瞬爆。
  MIN_FLIGHT_MS: 0,
};

/**
 * 赔率 → 飞行毫秒数（闭式解）
 *
 * 原版 getBDTime()：循环累加 t += 0.04 直到 rate <= t/2 + (t²-t)/10 + 1，
 * 然后 `(($t / 0.04) * 100) * 1000` 微秒。
 * 化简：(t/0.04) = t×25，(t×25)×100×1000 = t×2,500,000 微秒 = t×2.5 秒。
 * 所以原版的飞行时长是 曲线参数 t × 2.5 秒，**不是 t 秒**。
 * （调用方 usleep($rateTime) 收的是微秒；前端 setTime = getBDTime()/1000 - 2000 毫秒）
 */
function flightMs(rate, opts) {
  const r = Math.max(rate, 1);
  const disc = 40 * r - 24;
  if (disc < 0) return 0;
  const t = (Math.sqrt(disc) - 4) / 2;
  /**
   * 【2026-09-30】删掉了飞行时长下限，恢复原版行为。
   *
   * 原来这里是 `Math.max(opts.instant ? 0 : MIN_FLIGHT_MS, ...)`，
   * 其中 MIN_FLIGHT_MS=2500。查原版源码 PushController.php 确认：
   *   - fastCalc()（立即结算）爆率 rand(100,120)/100 = 1.00~1.20x
   *   - 整个项目 grep 不到任何「保底时长 / MIN_FLIGHT」概念
   * 也就是说原版低倍率局【就是会飞很短甚至 0】，没有下限保护。
   *
   * 加上那个 2500ms 保底后，原版瞬爆被彻底抹平，
   * 只好再引入「☐ 瞬爆」勾选去绕过自己加的保底。
   *
   * 现在：严格按公式走，1.0x → 0ms，1.2x → 1124ms，2.0x → 4354ms。
   * opts.instant 保留（engine 仍会传），但不再影响结果 ——
   * 1.0x 以下公式本身就返回 0，语义天然一致。
   */
  return Math.round(t * CFG.FLIGHT_SCALE * 1000);
}

/**
 * 已飞行毫秒 → 赔率（服务端与前端共用的唯一公式）
 *
 * 曲线: rate = t/2 + (t²-t)/10 + 1，而原版 getBDTime 反解出的真实飞行时间是
 * t × FLIGHT_SCALE 秒。所以「已飞 ms」要先除以缩放系数才得到 t。
 *
 * ⚠️ 前后端必须用同一个公式、同一个缩放，否则屏幕上显示的倍率和真实结算倍率会错位。
 */
function rateAt(elapsedMs, scale = CFG.FLIGHT_SCALE) {
  const t = (elapsedMs / 1000) / scale;
  return t / 2 + (t * t - t) / 10 + 1;
}

/** 派奖：投入 amount，逃跑倍率 r → 净盈利（已扣平台抽成） */
function payout(amount, r) {
  const gross = amount * r;
  const fee = gross * CFG.HOUSE_EDGE;
  return Math.round((gross - fee) * 100) / 100;
}

function round2(n) { return Math.round(n * 100) / 100; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 根据 admin 配置计算本局爆点。
 * @param {object} cfg  游戏参数（来自 db.allSettings()）
 * @param {number} pot  本局总投注
 * @param {number} pool 后台资金池
 * @param {object|null} event 命中的限时活动（无则 null）
 */
function decideRate(cfg, pot, pool, event) {
  const min = Number(cfg.min_rate) || CFG.MIN_RATE;
  const max = Number(cfg.max_rate) || CFG.MAX_RATE;
  const mode = String(cfg.odds_mode ?? '4');
  const setValue = Number(cfg.odds_value) || 0;
  const percent = Math.max(0, Math.min(1, Number(cfg.rake_percent) || 0));
  const jitter = Math.random() * 0.09;

  const clamp = (r) => {
    let v = Number(r);
    if (!isFinite(v) || v < min) v = min;
    if (v > max) v = max;
    return round2(v);
  };

  /**
   * 限时活动优先：直接在该活动的倍率区间内取。
   *
   * 【2026-09-30 修：活动倍率不能被后台 max_rate 砍掉】
   *
   * 原来这里走的是 clamp()，而 clamp 用的是 cfg.min_rate / cfg.max_rate
   * —— 那对护栏是给日常分布表用的。后果：后台 max_rate=125 时，
   * 活动里配的 min=20 / max=1000 被压成【全部 125x】，
   * 活动配置写什么都没用。用户反馈「配了 20x-1000x 但没生效」就是这个。
   *
   * 修法：活动倍率只保下限（不能低于 min_rate，否则玩家连反应都来不及），
   * 上限由活动自己的 max 决定 —— 运营显式配的高倍时段不该被日常护栏截断。
   */
  if (event) {
    const lo = Math.max(min, Number(event.rate) || min);
    return { rate: round2(lo), fast: false, mode: 'event:' + (event.name || '') };
  }

  // 无下注 → 保底区间随机
  if (!pot || pot <= 0) {
    const base = min + Math.random() * (Number(cfg.base_random) || 0.9);
    return { rate: clamp(base), fast: false, mode: 'base' };
  }

  let rate = null;

  if (mode === '1') {
    if (pool > setValue + pot) rate = Math.round((pool - setValue) / pot) - jitter;
    else return { rate: clamp(1.00 + Math.random() * 0.20), fast: true, mode: 'win-fast' };
  } else if (mode === '2') {
    if (pool + setValue - pot * 1.5 > 0) rate = Math.round((setValue + pool) / pot) - jitter;
    else return { rate: clamp(1.00 + Math.random() * 0.20), fast: true, mode: 'lose-fast' };
  } else if (mode === '3') {
    const effPool = (pool + pot) * (1 - percent);
    if (pool > 0) rate = Math.round(effPool / pot) - jitter;
    else return { rate: clamp(1.00 + Math.random() * 0.20), fast: true, mode: 'balance-fast' };
  } else if (mode === '4') {
    const lo = Number(cfg.band_min) || 1.10;
    const hi = Math.max(lo, Number(cfg.band_max) || 3.00);
    rate = lo + Math.random() * (hi - lo);
  } else if (mode === '5') {
    const w = weightedRate(cfg);
    // 只有「瞬爆段」才绕过 min_rate 下限保护 —— 它的全部意义就是不给逃跑窗口。
    // 走正常 clamp 会被 min_rate 顶回去，玩家照样能等到下限逃跑，瞬爆就名存实亡。
    //
    // ⚠️ 必须用 weightedRate 返回的 boom 标记，不能用「r < min」反推：
    // 低段下限（1.01）也可能低于 min_rate，那是正常低倍率局，不该被当成瞬爆。
    if (w.boom) return { rate: round2(w.v), fast: true, mode: '5-instant' };
    rate = w.v;
  } else if (mode === '6') {
    const t = tableRate(cfg);
    if (!t) return { rate: clamp(min + Math.random() * 0.9), fast: false, mode: '6-fallback' };
    /**
     * 【2026-09-30】不再有「瞬爆勾选」。
     * 原版低倍率局本来就飞得极短（1.0x → 0ms），没有下限保护；
     * 我之前加的 MIN_FLIGHT_MS=2500 保底把那个行为抹平了，
     * 才不得不引入 boom 标记去绕过。保底已删，boom 一并去掉。
     *
     * 现在「瞬爆」不是一个配置项，而是【下界填多少】的自然结果：
     * 下界 1.00 → 0ms（刚起飞就炸）
     * 下界 1.50 → 2500ms
     */
    rate = t.v;
  }

  /**
   * 【2026-09-30】模式 6 不再走 clamp()。
   *
   * 原来所有模式最后都 `return { rate: clamp(rate) }`，
   * 而 clamp 用的是后台 min_rate / max_rate 那对护栏。
   * 后果：用户手填的区间下界被【静默改写】——
   *   填 1.5–10x、后台 min_rate=1.01 → 实际从 1.01 开始取（等于 1.01–10x）
   *   填 20–30x       → 实际从 1.01 开始取，80% 的局掉进 1.5–20x
   * 「三列都手填」这个需求等于没实现。
   *
   * 与限时活动同一个毛病（活动被 max_rate 砍成 125x），
   * 根子都是「用户配的区间不该被后台护栏改写」。
   *
   * 护栏仍然存在，但只作为【兜底】：配置本身合法时不再干涉，
   * 避免 clamp 把用户填的区间边界改掉。
   */
  if (mode === '6') {
    // tableRate 已保证 min < max 且 min ≥ 0.01，这里只防数值异常
    const v = Number(rate);
    return { rate: isFinite(v) && v > 0 ? round2(v) : clamp(min), fast: false, mode };
  }

  return { rate: clamp(rate), fast: false, mode };
}

/**
 * 模式 5：加权分布。
 *
 * 为什么需要它：模式 4 是「下限 + random × (上限−下限)」的【均匀分布】，
 * 意味着 1.1x 和 50x 出现概率完全相同。线上曾把 band 配成 1.1–50，
 * 结果 81.8% 的局超过 10x、41% 超过 30x（实测 10 万局模拟），
 * 玩家每局都在 25x 附近逃跑，10 局净赚 5 倍本金 —— 赢率离谱地高。
 *
 * 均匀分布不适合「偶尔来一发大的、平时小赢」的手感。
 * 模式 5 改成五段加权：
 *   1) 按权重决定落在哪一段（低倍率占大头，高倍率稀有）
 *   2) 段内再均匀取值
 * 于是低倍率被大幅加权，高倍率稀有但存在。
 *
 * 默认参数（50 万局模拟）：
 *   瞬爆  6% → 1.00–1.01x   刚起飞就没，绕过 min_rate 与最低飞行时长
 *   低段 50% → 1.01–4.00x   日常区间
 *   中段 22% → 4.00–10.00x
 *   高段 20% → 10.00–30.00x 约 22 局来一次
 *   爆段  2% → 30.00–50.00x 约 50 局来一次
 *
 * 玩家视角：日常 1.01–10x，偶尔冲到 30x+，50x 是稀有事件。
 * 想要更稳就把 w_high / w_top 调小、w_low 调大。
 */
/**
 * 模式 6：百分比分布表（简化配置，用户 2026-09-29 要求）
 *
 * 【为什么要有这个模式】
 * 模式 5 是五段「区间 + 权重」两组参数（10 个数字），后台表单很难读懂，
 * 改起来也不知道改完会变成什么分布。
 * 模式 6 改成一张【百分比表】：每行「倍率上限 + 占比%」，加总 100% 即可。
 * 例如用户给的配置：
 *
 *   倍率区间            占比
 *   1.5x 以下（瞬爆）      10
 *   1.5 – 10x            40
 *   10 – 30x             30
 *   30 – 50x             10
 *   50 – 80x              5
 *   80 – 100x             5
 *
 * 存成一行 JSON：odds_table_json
 *   [{"max":1.5,"pct":10,"boom":true},
 *    {"max":10,"pct":40},{"max":30,"pct":30},
 *    {"max":50,"pct":10},{"max":80,"pct":5},{"max":100,"pct":5}]
 *
 * 第一行标了 "boom":true 表示「瞬爆」—— 刚起飞就炸，不给逃跑窗口，
 * 不受 min_rate 下限保护。其余各行在 [上一行的 max, 本行的 max] 区间内均匀取值。
 * 若第一行没标 boom，则最低一段从 min_rate 起算。
 */
function tableRate(cfg) {
  let rows = [];
  try {
    const raw = cfg.odds_table_json;
    rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) { rows = []; }
  if (!Array.isArray(rows) || !rows.length) return null;

  /**
   * 清洗用户填的行。
   *
   * 【2026-09-30 用户确认：下界也手填】
   * 原来是「下界 = 上一行的 max」，每行只有一个上界。
   * 现在每行有独立的 min，用户在后台看到什么就按什么填，互不影响。
   *
   * 兼容：老配置（只有 max、没有 min）仍按「上一行的 max」推导，
   * 所以线上现有配置升级后行为不变。
   */
  const clean = [];
  let prevMax = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const max = Number(r.max);
    const pct = Number(r.pct);
    if (!isFinite(max) || !isFinite(pct) || pct <= 0) continue;
    if (max <= prevMax) continue;             // 上界必须严格递增，避免区间倒挂

    // 下界：优先用户手填的 min；没有就接上一行
    let lo;
    if (r.min != null && r.min !== '') {
      lo = Number(r.min);
      if (!isFinite(lo)) lo = clean.length ? prevMax : 1;
    } else {
      lo = clean.length === 0
        ? Math.max(1, Number(cfg.min_rate) || CFG.MIN_RATE)
        : prevMax;
    }
    /**
     * 下界可以低于 1 —— 原版就是允许的，倍率越接近 1 飞得越快，
     * 1.00 时公式直接返回 0ms（刚起飞就炸）。
     * 但倍率不能是 0 或负数，所以下限卡在 0.01。
     */
    lo = Math.max(0.01, Math.min(lo, max - 0.001));  // 保证区间不倒挂
    clean.push({ min: lo, max, pct });
    prevMax = max;
  }
  if (!clean.length) return null;

  const total = clean.reduce((a, x) => a + x.pct, 0);
  if (total <= 0) return null;

  // 按百分比抽段
  let r = Math.random() * total;
  for (let i = 0; i < clean.length; i++) {
    r -= clean[i].pct;
    if (r > 0) continue;
    return { v: clean[i].min + Math.random() * (clean[i].max - clean[i].min) };
  }
  // 浮点兜底：落在最后一行
  const last = clean[clean.length - 1];
  return { v: last.min + Math.random() * (last.max - last.min) };
}

function weightedRate(cfg) {
  /**
   * 取配置值，0 是【合法值】（表示该段完全不要）。
   *
   * ⚠️ 这里原来写的是 `v > 0 ? v : d` —— 于是后台把某段权重设成 0 时，
   * 会静默落回默认值。实测：w_boom=50, w_low=50, 其余三个设 0，
   * 实际 total 变成 50+50+22+20+2=144，瞬爆只有 50/144=34.4%，
   * 而不是用户要的 50%。「设 0 关闭某段」这个操作根本不生效。
   *
   * 现在只有「键不存在 / 非数字」才用默认值，0 尊重用户输入。
   * 区间端点仍要求 > 0（倍率不能是 0 或负数），用 numPos。
   */
  const num = (k, d) => {
    if (cfg[k] === undefined || cfg[k] === null || cfg[k] === '') return d;
    const v = Number(cfg[k]);
    return isFinite(v) ? v : d;
  };
  /** 倍率端点必须 > 0 */
  const numPos = (k, d) => {
    const v = Number(cfg[k]);
    return isFinite(v) && v > 0 ? v : d;
  };
  // 五段权重：瞬爆 / 低 / 中 / 高 / 爆（0 表示关闭该段）
  const wBoom = Math.max(0, num('w_boom', 6));
  const wLow = Math.max(0, num('w_low', 50));
  const wMid = Math.max(0, num('w_mid', 22));
  const wHigh = Math.max(0, num('w_high', 20));
  const wTop = Math.max(0, num('w_top', 2));

  // 瞬爆：1.00 ~ boomMax（默认 1.01），刚起飞就没
  const boomMax = Math.max(1.001, numPos('w_boom_max', 1.01));
  // 常规四段，段内均匀（端点用 numPos，倍率不能 <= 0）
  const loMin = numPos('w_lo_min', 1.01);
  const loMax = Math.max(loMin, numPos('w_lo_max', 4.00));
  const midMin = numPos('w_mid_min', 4.00);
  const midMax = Math.max(midMin, numPos('w_mid_max', 10.00));
  const highMin = numPos('w_high_min', 10.00);
  const highMax = Math.max(highMin, numPos('w_high_max', 30.00));
  const topMin = numPos('w_top_min', 30.00);
  const topMax = Math.max(topMin, numPos('w_top_max', 50.00));

  const total = wBoom + wLow + wMid + wHigh + wTop;
  const r = Math.random() * total;
  if (r < wBoom) return { v: 1.00 + Math.random() * (boomMax - 1.00), boom: true };
  if (r < wBoom + wLow) return { v: loMin + Math.random() * (loMax - loMin) };
  if (r < wBoom + wLow + wMid) return { v: midMin + Math.random() * (midMax - midMin) };
  if (r < wBoom + wLow + wMid + wHigh) return { v: highMin + Math.random() * (highMax - highMin) };
  return { v: topMin + Math.random() * (topMax - topMin) };
}

/**
 * "HH:MM" → 当日分钟数；非法返回 null。
 *
 * ⚠️ 必须接受 "24:00"（= 1440 = 当日末尾）。
 * 之前这里写的是 `if (h > 23) return null`，于是 "24:00" 被判非法返回 null，
 * 活动条目直接被 activeEvent() 跳过 —— 调用方只好把结束时间封到 "23:59"，
 * 绕了一圈才把"跨天/整点结束"这个坑填上。
 * 现在 24:00 合法，daily-activity.js 可以直接写 "22:00" 这种正常整点。
 */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 24 || mi > 59) return null;
  if (h === 24 && mi > 0) return null;   // 只允许精确的 24:00
  return h * 60 + mi;                    // "24:00" → 1440
}

/**
 * 取北京时间的「时:分」。
 *
 * ⚠️ 必须显式换算时区。服务器是 Etc/UTC，Date 的本地 getter
 * （getHours/getMinutes）返回的是 UTC 小时 —— 拿它和北京时间配置比对，
 * 会整体差 8 小时，导致活动配置永不生效。
 */
function beijingParts(d = new Date()) {
  const s = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return { hour: s.getHours(), minute: s.getMinutes() };
}

/**
 * 限时活动：指定时段内提高爆点（支持跨零点，如 23:00-01:00）
 * events_json 形如：
 * [{"name":"黄金时段","from":"19:00","to":"22:00","min":2,"max":30,"weight":0.8,"enabled":true}]
 */
function activeEvent(cfg, now = new Date()) {
  const raw = cfg && cfg.events_json;
  if (!raw) return null;
  let list;
  try { list = JSON.parse(raw); } catch (_) { return null; }
  if (!Array.isArray(list)) return null;

  /**
   * 【重大 bug：这里原来用 now.getHours()】
   *
   * 服务器时区是 Etc/UTC，而活动时段是按【北京时间】配置的。
   * daily-activity.js 写进 events_json 的是 "21:00"–"21:59"（北京时间），
   * 这里却拿 UTC 小时去比 —— 北京 21:00 = UTC 13:00，永远对不上，
   * 于是「每日高倍活动」配置正确却【从不生效】。
   *
   * 修法：和 daily-activity.js 一样显式换算北京时间。
   * 注意不要再用 Date 的本地 getter（getHours/getMinutes）—— 它们跟随
   * 进程时区，而进程时区是 UTC。
   */
  const bjParts = beijingParts(now);
  const cur = bjParts.hour * 60 + bjParts.minute;
  for (const ev of list) {
    if (!ev || ev.enabled === false) continue;
    const from = toMinutes(ev.from), to = toMinutes(ev.to);
    if (from == null || to == null) continue;

    /**
   * 时段命中判定。
   *
   * events_json 里活动的 to 历史上被写成 "21:59"（因为 toMinutes('24:00')
   * 会得到 1440，和引擎的 0-1439 比永远不命中，只能退而求其次封到 23:59）。
   * 现在 daily-activity.js 直接写 "22:00"，这里两者都支持：
   *   - to == 1440（"24:00"）→ 视为当天末尾 cur < 1440
   *   - 正常 "22:00" → cur < 1320
   *   - from > to（如 23:00-01:00）→ 跨零点
   */
  const end = to === 1440 ? 1440 : to;
  const hit = from <= end ? (cur >= from && cur < end) : (cur >= from || cur < end);
    if (!hit) continue;

    const lo = Math.max(1, Number(ev.min) || 1.10);
    const hi = Math.max(lo, Number(ev.max) || 10);
    const w = Math.max(0, Math.min(1, Number(ev.weight ?? 1)));
    // weight 越大越偏向高倍率：指数 1（均匀）→ 2（明显右偏）
    const r = 1 - Math.pow(1 - Math.random(), 1 + w);
    return { name: ev.name || '限时活动', min: lo, max: hi, weight: w, rate: round2(lo + r * (hi - lo)) };
  }
  return null;
}

/**
 * 模拟 N 局，返回实际分布 —— 后台「保存后提示是否生效」用。
 *
 * 【为什么需要】保存配置后静默生效，用户不知道改完是什么样。
 * 这个函数把「你填的百分比」翻译成「实际跑 10000 局的结果」，
 * 两者不一致时（配置被 min_rate/max_rate 截断、max 未递增等）立刻能看出来。
 *
 * @param {object} cfg  游戏参数
 * @param {number} rounds 模拟局数
 */
function simulate(cfg, rounds = 10000) {
  const min = Number(cfg.min_rate) || CFG.MIN_RATE;
  const max = Number(cfg.max_rate) || CFG.MAX_RATE;
  const buckets = new Map();      // 「显示区间」 -> 局数
  const KEY = [
    [0, 1.5, '1.5x 以下'],
    [1.5, 10, '1.5 – 10x'],
    [10, 30, '10 – 30x'],
    [30, 50, '30 – 50x'],
    [50, 80, '50 – 80x'],
    [80, 1e9, '80x 以上'],
  ];
  for (const k of KEY) buckets.set(k[2], 0);

  let sum = 0;
  let boom = 0;
  let nonBoomMin = Infinity;
  const vals = [];
  for (let i = 0; i < rounds; i++) {
    const r = decideRate(cfg, 1000, 0, null);
    sum += r.rate;
    vals.push(r.rate);
    /**
     * 「瞬爆」的判定标准改为「飞行时间不足 1 秒」——
     * 也就是倍率落在 1.5x 以下。
     * 【2026-09-30】不再依赖 r.fast 标记：那个标记原本是给
     * MIN_FLIGHT_MS 保底做「跳过」用的，保底已删，标记失去意义。
     */
    if (r.rate < 1.5) boom++;
    else if (r.rate < nonBoomMin) nonBoomMin = r.rate;
    for (const k of KEY) {
      if (r.rate >= k[0] && r.rate < k[1]) { buckets.set(k[2], buckets.get(k[2]) + 1); break; }
    }
  }
  vals.sort((a, b) => a - b);
  const pct = (n) => round2((n / rounds) * 100);
  return {
    rounds,
    instantBoom: boom,
    instantBoomPct: pct(boom),
    avg: round2(sum / rounds),
    median: vals[Math.floor(rounds / 2)],
    max: vals[rounds - 1],
    min: vals[0],
    minNonBoom: nonBoomMin === Infinity ? null : round2(nonBoomMin),
    buckets: KEY.map((k) => ({
      label: k[2],
      count: buckets.get(k[2]),
      pct: pct(buckets.get(k[2])),
    })),
    /**
     * 是否被 min_rate / max_rate 截断。
     * ⚠️ 瞬爆局（fast）本来就低于 min_rate（1.00x 起），
     *    那是设计如此，不算截断 —— 所以只检查非瞬爆局的最低值。
     */
    truncated: nonBoomMin < min - 0.001 || vals[rounds - 1] > max + 0.001,
    minRate: min,
    maxRate: max,
  };
}

module.exports = {
  CFG, flightMs, rateAt, decideRate, activeEvent, payout, round2, sleep,
  toMinutes, tableRate, simulate, beijingParts,
};
