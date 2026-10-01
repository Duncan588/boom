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

const crypto = require('crypto');

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
  /**
   * 【2026-09-30 A 项】飞行期 tick 广播节拍（毫秒）。
   *
   * 原来飞行期间 WS 完全静默，客户端自己按本地时钟算倍率。
   * 现在服务端每 100ms 推一次当前倍率，客户端只渲染。
   * 100ms 的理由：原版曲线每 100ms 加一个数据点（chart.js 的 STEP_MS），
   * 节拍与采样点对齐，客户端插值后曲线与原来逐点绘制完全一致。
   *
   * ⚠️ 这里是【已经过去的倍率】，不是剩余时间。绝不能在这个消息里
   *    带上 ms / 剩余秒数 —— 那会再次变成可反推的答案。
   */
  TICK_MS: 100,
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
  const ms = Math.round(t * CFG.FLIGHT_SCALE * 1000);
  return applyHighRateAccel(ms, r);
}

/**
 * 【2026-09-30 高倍加速】倍率 > ACCEL_FROM 时压缩飞行时长。
 *
 * 用户要求：「1-100 正常速度，100 以上做曲线加速，1000x 最终 100 秒，
 *            中间不要加得太快，不然一下就过去了」。
 *
 * 曲线 = 对数线性：每「翻一倍倍率」时长增加的时间完全相同。
 *   100x  → 73.8s  （ACCEL_FROM 处，与原速完全一致，无缝衔接）
 *   200x  → 81.7s  (+7.9s)
 *   400x  → 89.6s  (+7.9s)
 *   800x  → 97.5s  (+7.9s)
 *   1000x → 100.0s (目标)
 *
 * 为什么是对数线性而不是「越往后越快」：
 *   「越快」会让【时长随倍率下降】—— 1000x 只飞 24.5s 而 100x 飞 73.8s，
 *   玩家一眼就能从「飞得特别快」认出千倍局。这和之前那些常量热点是同一类错误。
 *   对数线性保证【时长 ∝ 倍率】严格单调递增，只是斜率递减。
 *
 * 1000x 以上用指数收敛兜底，保证无论 max_rate 配多大都不会飞出离谱时长
 * （10000x 也只 112.6s）。engine.js 已删除 max_flight_ms 钳制，
 * 所以这条兜底就是防卡服的最后一道防线。
 */
const ACCEL_FROM = 100;                                    // 加速起点
const ACCEL_TARGET_MS = 100000;                             // 1000x = 100 秒
const ACCEL_TAIL = 20000;                                   // 1000x 以上的渐近余量

/**
 * 未加成的原始飞行毫秒 —— 基准值的唯一来源。
 *
 * ⚠️ ACCEL_BASE_MS 必须在【模块加载时】就固定下来。
 *   早先版本用 `applyHighRateAccel.base ??= rawFlightMs(...)` 惰性自举，
 *   结果 flightMs() 与 rateAt() 可能各自初始化、各自持有不同的 base，
 *   往返误差高达 99.9%（1000x 反解成 1857x）—— 那意味着玩家点逃跑时
 *   屏幕显示一个倍率、按另一个倍率赔付，是直接的钱款错误。
 *   常量在声明处一次算清，两个函数读同一个值，不可能不一致。
 */
const ACCEL_BASE_MS = Math.round(((Math.sqrt(40 * ACCEL_FROM - 24) - 4) / 2) * CFG.FLIGHT_SCALE * 1000);
const ACCEL_HEAD_MS = ACCEL_TARGET_MS - ACCEL_BASE_MS;

function applyHighRateAccel(ms, rate) {
  // ⚠️ 必须用 >= 而不是 >：ACCEL_BASE_MS 处加成为恒等变换，
  //   所以 100x 既走原速、也走加速分支都得到同一个值，接缝处不会出现
  //   「100.00x 与 100.01x 差 73 秒」的断崖。
  if (!(rate >= ACCEL_FROM)) return ms;
  if (rate <= 1000) {
    return Math.round(ACCEL_BASE_MS + ACCEL_HEAD_MS * Math.log10(rate / ACCEL_FROM));
  }
  const over = Math.log10(rate / 1000);
  return Math.round(ACCEL_TARGET_MS + ACCEL_TAIL * (1 - Math.exp(-over)));
}

/**
 * applyHighRateAccel 的【严格逆变换】—— ms → 倍率。
 *
 * ⚠️⚠️ 这两个函数必须严格互逆，否则资金结算会错：
 *   玩家在 30 秒点逃跑，rateAt(30000) 必须反推出与结算时【完全相同】的倍率，
 *   否则屏幕上显示 30x、实际按 12x 赔付 —— 直接的钱款错误。
 *   test/flight-curve.js 会做往返验证（误差必须为 0）。
 */
function unapplyHighRateAccel(ms) {
  if (!(ms > ACCEL_BASE_MS)) return ms;

  // ① 由加速后的时长反解出【倍率】
  //    正向是 ms = BASE + HEAD·log₁₀(rate/100)，所以 log₁₀(rate/100) = (ms−BASE)/HEAD。
  let rate;
  if (ms <= ACCEL_TARGET_MS) {
    rate = ACCEL_FROM * Math.pow(10, (ms - ACCEL_BASE_MS) / ACCEL_HEAD_MS);
  } else {
    const tail = 1 - (ms - ACCEL_TARGET_MS) / ACCEL_TAIL;
    if (tail <= 0) return Infinity;          // 已到渐近线，倍率趋近无穷
    rate = 1000 * Math.pow(10, -Math.log(tail));
  }

  // ② 再把倍率换算回【未加速的等效时长】交给 rateAt 的原版公式。
  //    ⚠️ 这一步早先漏掉了 —— 少了它，rateAt 会拿「压缩过的时长」
  //       直接喂进原版公式，反解出的倍率与真实爆点完全对不上
  //       （实测 1000x 被反解成 1857x，误差 99.9%）。
  return rawFlightMs(rate);
}

/** 未加成的原始飞行毫秒（倍率 → 等效时长，与 flightMs 的前半段同源） */
function rawFlightMs(rate) {
  const r = Math.max(rate, 1);
  const disc = 40 * r - 24;
  if (disc < 0) return 0;
  return Math.round(((Math.sqrt(disc) - 4) / 2) * CFG.FLIGHT_SCALE * 1000);
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
  // 先把「加速压缩过」的时长还原回未加速的等效时长，
  // 再走原版公式 —— 保证显示倍率与结算倍率绝对一致。
  const ms = unapplyHighRateAccel(Number(elapsedMs) || 0);
  const t = (ms / 1000) / scale;
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

/* ===================================================================
 * 模式 9：幂律分布（恒定期望）
 *
 * 【为什么要有这个模式 —— 它解决的是本项目反复踩到的那一类问题】
 * 玩家发现爆点「稳定在某个区间」并稳定赚钱。每一代算法都栽在这里：
 *   · 均匀分布 [1.1, 50]   → 10 局净赚 5 倍本金
 *   · 五段加权 / 百分比表   → 出现「习惯区间」，逃 2x 最稳
 *   · 池子反推 / Jev 选段   → 与玩家行为耦合，房间不变则分布不变
 * 根子都一样：分布里存在一个「期望收益更高」的区间，玩家发现它之后
 * 只需要固定逃跑点就能长期获利。
 *
 * 【本模式的性质：对任意逃跑目标 m，P(X ≥ m) = RTP / m】
 * 于是两个更强的不变量同时成立：
 *
 *   ① 毛赔付恒定：P(X≥m)·m = RTP                     —— 对所有 m ≤ cap 精确相等
 *   ② 净期望恒定：EV(m) = P·(0.97m − 1) + (1−P)·(−1)
 *                = 0.97·m·P − 1 = 0.97·RTP − 1     —— 【与 m 完全无关】
 *
 * ② 才是「不存在最优点、不存在稳定赚钱区间」那句话的字面含义：
 * 玩家逃 1.5x、逃 100x 还是逃 30x，长期每注的期望完全一样。
 * 任何固定的逃跑习惯都不比另一个习惯更好。
 *
 * ⚠️ 推 ② 时最容易漏掉【输掉的那一支】：
 *    只写 P·(0.97m − 1) 会算出「逃跑点越高期望越高」（0.97+0.03 那次就漏了），
 *    因为它把「没逃出去 = 输掉全部本金」这一支漏掉了。
 *    补上 (1−P)·(−1) 之后 m 整个约掉，这才是玩家真实面对的赌局。
 *    test/odds-powerlaw.js §2 用仿真（不是闭式）独立验证 ②，
 *    就是为了让这个减法出错时被抓住，而不是靠注释提醒。
 *
 * 数值（默认 RTP=0.97，payout() 抽水 3%）：EV = 0.97·0.97 − 1 = **−0.0591**
 * 也就是说玩家每注期望亏 5.91%，与逃到哪里无关。
 *
 * 【为什么必须用 crypto 而不是 Math.random】
 * Math.random() 是可预测的（V8 用 xorshift128+，观察输出即可恢复内部状态），
 * 而爆点直接决定钱。一条能被玩家反推的伪随机序列 = 一个可被套利的固定序列。
 * crypto.randomBytes 走 OS 的 CSPRNG，观察输出无法恢复内部状态。
 *
 * 【瞬爆概率不再单独设置】
 * 由公式自然产生：X ≤ 1.00 当且仅当 RTP/U < 2，即 U > RTP/2，
 * 概率 = 1 − RTP/2·... 实测 ≈ 1 − RTP（3.9% @ RTP=0.97）。
 * 所以不需要「瞬爆段」这种额外旋钮，也就没有「配了瞬爆段」和
 * 「瞬爆率对不上」两个新问题。
 */
const POWERLAW = {
  RTP_DEFAULT: 0.97,     // 默认返还率。后台可配，范围 0.80–1.00
  RTP_MIN: 0.80,
  /**
   * ⚠️ RTP 硬上限 1.00。超过 1.00 玩家就是正期望，长期必然赢。
   *
   * 精确的保本线其实比 1.00 更靠后：EV = 0.97·RTP − 1 = 0 ⇒ RTP = 1.0309。
   * 所以 1.00 留了 3 个百分点的余量（那时玩家 EV 仍为 −0.0300，庄家仍有 3% 优势）。
   * 【为什么不把上限设成 1.0309】保本点是个危险的心理锚点：
   * 运营把它配到附近、活动加成叠上去就越线，而且 0.97 抽水是全局常量、
   * 任何改抽水的活动都会让这条线移动。1.00 是个与抽水无关的整数安全线。
   * 活动加成的加法幅度必须 clamp 到这里。
   */
  RTP_MAX: 1.00,
  CAP_DEFAULT: 120,      // 倍率上限（独立于 max_rate，避免护栏改写定价）
  CAP_MIN: 1.01,
  /** 活动期加成的默认幅度与上限（后台可配，activities_json 覆盖） */
  EVENT_BONUS_DEFAULT: 0.03,
  EVENT_BONUS_MAX: 0.20,
};

/**
 * 取 RTP，clamp 到 [0.80, 1.00]。
 * 0.80 是运营下限：低于它玩家体感是「必输」，社区游戏会直接流失。
 * 1.00 是数学红线，见 POWERLAW.RTP_MAX 的注释。
 */
function normRtp(v) {
  const n = Number(v);
  if (!isFinite(n)) return POWERLAW.RTP_DEFAULT;
  return Math.max(POWERLAW.RTP_MIN, Math.min(POWERLAW.RTP_MAX, n));
}

function normCap(v) {
  const n = Number(v);
  if (!isFinite(n) || n < POWERLAW.CAP_MIN) return POWERLAW.CAP_DEFAULT;
  return n;
}

/**
 * 活动期的 RTP 幅度（加法）。
 *
 * 【为什么是加法而不是 ×1.05】
 * 乘法后要在代码里 clamp，运营配 1.5 倍时 clamp 位置不直观；
 * 加法直接是「这一小时每人多返 3%」，力度可线性换算，
 * 且 clamp 到 RTP_MAX 之后语义明确：活动最多把 RTP 拉到 1.00，不会溢出。
 * 配 0（显式关闭活动加成）与留空（有活动就给默认幅度）都支持。
 */
function normEventBonus(v) {
  if (v === undefined || v === null || v === '') return POWERLAW.EVENT_BONUS_DEFAULT;
  const n = Number(v);
  if (!isFinite(n) || n < 0) return 0;
  return Math.min(POWERLAW.EVENT_BONUS_MAX, n);
}

/** 均匀随机数 U ∈ (0,1)，48 bit，来自 CSPRNG。禁止改成 Math.random() */
function cryptoUniform() {
  const b = crypto.randomBytes(6);
  let n = 0;
  for (let i = 0; i < b.length; i++) n = n * 256 + b[i];
  return (n + 0.5) / 281474976710656;   // 2^48
}

/**
 * 幂律抽样：X = min(cap, max(1.00, floor2(RTP / U)))
 *
 * 【截断为什么必须用 clamp（把超界质量并进 cap），不能用重抽】
 * 实测 100 万局、cap=120、RTP=0.97：
 *                    P(X≥10) 误差   P(X≥30) 误差   P(X≥100) 误差
 *   clamp 到 120       +0.54%          −0.49%         −2.85%
 *   超界重抽           −8.1%           −25.2%         −83.2%
 * 原因：cap=120 ≥ 所有关心的 m ≤ 120，超界质量全部堆在 120.00 这【一个点】上，
 * 而该点本身就在每个 m 的赢面内，恒等式 P(X≥m)·m = RTP 不被破坏。
 * 重抽则把尾部直接削掉 —— m 越接近 cap 偏得越狠，破坏的正是本模式的核心性质。
 *
 * 【定点量化用 floor 而不是 round】
 * floor 把连续值向下取到分，x 的 P(X≥m) 严格 ≥ RTP/m；round 会把一半质量
 * 抬到 m 的正上方，使 P(X≥m) 略低于 RTP/m。实测 100 万局最大相对误差：
 * floor −0.99%@(m=100) vs round +0.73%@(m=100) —— 两者同量级，
 * 选 floor 是因为它的偏差方向单调（只会偏低，不会把高逃跑点说成更划算），
 * 配合测试里单向断言更安全。
 *
 * @param {number} rtp  已 normRtp 归一化的 RTP
 * @param {number} cap  倍率上限
 * @returns {number} 2 位小数的倍率，恒在 [1.00, cap]
 */
function powerlawRate(rtp = POWERLAW.RTP_DEFAULT, cap = POWERLAW.CAP_DEFAULT) {
  const r = normRtp(rtp);
  const c = normCap(cap);
  const u = cryptoUniform();                 // (0,1)
  const raw = r / u;                          // ≥ r
  const q = Math.floor(raw * 100) / 100;      // 向下取到分
  return round2(Math.max(1, Math.min(c, q)));
}

/**
 * 幂律模式的完整决策。忽略 pot / pool / ctx —— 见 decideRate 的 E 条说明。
 * @param {object} cfg    settings
 * @param {object} event  命中的限时活动（无则 null），只用来加 RTP
 */
function powerlawDecide(cfg, event) {
  const base = normRtp(cfg.powerlaw_rtp);
  const cap = normCap(cfg.powerlaw_cap);
  // 活动只改 RTP，且以本局 begin 时读到的配置为准（本函数在 decideRate 里
  // 每局调用一次，cfg 就是那一局 refreshSettings() 之后的快照）。
  const bonus = event ? normEventBonus(event.rtp_bonus) : 0;
  const rtp = Math.min(POWERLAW.RTP_MAX, base + bonus);   // ⚠️ 硬 clamp
  const rate = powerlawRate(rtp, cap);
  return {
    rate,
    fast: false,
    mode: '9-powerlaw',
    powerlaw: { rtp: round4(rtp), baseRtp: round4(base), bonus: round4(bonus), cap },
  };
}

function round4(n) { return Math.round(n * 10000) / 10000; }

/**
 * 根据 admin 配置计算本局爆点。
 * @param {object} cfg  游戏参数（来自 db.allSettings()）
 * @param {number} pot  本局总投注
 * @param {number} pool 后台资金池
 * @param {object|null} event 命中的限时活动（无则 null）
 * @param {object|null} ctx  【mode 7 新增】房间上下文 { seated:[{ar,thr,lossStreak}], lastBoom, act }
 *   前六个模式不使用它，保持原调用方式不变（ctx 省略即行为不变）。
 */
function decideRate(cfg, pot, pool, event, ctx) {
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
    /**
     * 【2026-09-30 重写：活动改走老虎机引擎 v3】
     *
     * 原来这里是一次性算出一个固定的 event.rate 就返回 —— 整个活动时段
     * 同一个倍率，玩家看到的是「一整小时都爆在 23.4x」。这既不是活动该有的
     * 体验，也让 events_json 里的 min/max/weight 三个字段实际只被用了一次。
     *
     * 现在：活动的 min/max 作为倍率【范围】，boom_rate 作为瞬爆概率，
     * 每局由 v3 引擎独立抽取 —— 活动期同样有起伏，且瞬爆率可控。
     * v3 是纯本地算法，零 API 成本。
     *
     * ⚠️【2026-09-30 mode 9 例外】幂律模式下本分支【不执行】。
     *    v3 的随机游走与幂律是完全不同的分布形状：活动期会突然换成另一个游戏，
     *    玩家只要玩过一次活动时段就能识别出「这段时间的爆点不一样」——
     *    这正是幂律下活动只调 RTP（不改 min/max、不换引擎）的原因。
     */
    if (mode === '9') {
      return powerlawDecide(cfg, event);   // 只加 RTP，分布形状不变
    }
    const ev = require('./v3/engine');
    const d = ev.rollRange({
      min: Math.max(min, Number(event.min) || 1),
      max: Number(event.max) || 1000,
      boomRate: event.boom_rate,
      width: event.width,
    });
    return {
      rate: d.rate, fast: false,
      mode: 'event-v3:' + (event.name || ''),
      event: { boom: d.boom, center: d.center },
    };
  }

  /**
   * 模式 9：幂律（恒定期望）。**必须在空注早退【之上】。**
   *
   * 【为什么位置这么关键 —— 这是本模式最重要的一行代码】
   * 下面有一句 `if (!pot || pot <= 0) return {rate: min + Math.random()*0.9}`，
   * 它位于【所有 mode 分支之上】。后果是：无人下注的时段根本到不了 mode 9，
   * 分布变成一个【固定形状的均匀分布 1.10–2.00】，逃 1.11x 的赢面 89%、
   * EV +0.076/注 —— 深夜 Discord 无人时这是个稳定可套利的区间。
   * 实测确认：pot=0 时 decideRate 返回 mode='base'，任何 odds_mode 都改不动它。
   *
   * 所以幂律分支放在这里：所有局都吃幂律，【无人下注也照常抽】。
   * 无人局的爆点照常落库 + 广播（engine 里不再因 pot=0 跳过），
   * 保证公开的爆点历史与真实分布一致 —— 否则历史曲线自己就是一个可辨识信号。
   *
   * 【去耦合：这里【不读】 pot / pool / ctx / seated / lastBoom】
   * 爆点只由 CSPRNG 决定。任何对玩家状态、资金池、上一局爆点的依赖，
   * 都会让「房间不变 → 分布不变」，重新制造可套利区间。
   * pool 仍是后台监控指标（engine 照常累计与展示），但不参与定价。
   */
  if (mode === '9') {
    return powerlawDecide(cfg, null);
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
  } else if (mode === '7') {
    /**
     * 【2026-09-30 新增】Jev 做庄模式。
     *
     * 爆点仍然【只有一个】，全场共享同一条 rateAt 曲线 —— 与前六个模式完全一致，
     * 不引入任何按人差异化的东西。Jev 只决定这一局落在哪个倍率段，
     * 段内取多少倍率由 Math.random() 完成。
     *
     * 分段边界贴着在场玩家的逃跑阈值分位数自适应（见 server/jev-bands.js），
     * 所以后台那张百分比表在 mode 7 下不参与选段，只作为降级基线与后台预览对照。
     *
     * ctx 形如 { seated:[{ar,thr,lossStreak}], lastBoom }，由 engine 传入。
     * 缺 ctx 或无人 → 直接退回表驱动，绝不在空房间调用外部 API。
     *
     * ⚠️ 命中限时活动时【不会走到这里】—— 函数开头就有
     *    `if (event) return { rate: ev.rate }` 的早退（见上），活动倍率由
     *    activeEvent() 算好后原样透传。所以「活动时段切菩萨人格」在当前
     *    架构下无法实现：活动分支把 Jev 整个绕过去了。
     *    早先我为此另建 jev_act_* 四个 setting 试图绕过，结果与 events_json
     *    构成两套活动上限、谁生效说不清，且那个 roundsLeft 扣减机制还引入了
     *    「一局扣两次」的真 bug。已全部删除。
     */
    const seated = ctx && Array.isArray(ctx.seated) ? ctx.seated.filter((p) => p && isFinite(p.thr)) : [];
    if (!seated.length) {
      const t = tableRate(cfg);
      return { rate: t ? round2(t.v) : clamp(min + Math.random() * 0.9), fast: false, mode: '7-fallback' };
    }
    const jev = require('./jev');
    const pick = jev.pickBand(seated, ctx.lastBoom ?? null, null);
    return { rate: pick.rate, fast: false, mode: '7-jev', jev: { band: pick.band, source: pick.source, confidence: pick.confidence } };

  } else if (mode === '8') {
    /**
     * 【2026-09-30 新增】老虎机算法（v3）—— 日常模式的零成本选项。
     *
     * 【它和 mode 7 的区别】
     *   mode 7 (Jev)  每一局可能调用一次外部 AI（约 $0.17/局），由 AI 选倍率段。
     *   mode 8 (v3)   纯本地随机游走，零 API 成本，行为完全可预测地稳定。
     *
     * 【为什么数字不可推算 —— 三个叠加的随机源】
     *   ① 瞬爆：每局独立掷骰，与历史完全无关
     *   ② 中心游走：在 log 空间按「档位」上/下走一格（每格 ×3.16），
     *      跳变概率随停留时间上升但封顶 0.55
     *   ③ 采样：在中心邻域内对数均匀
     *   三者叠加后相邻局差、连续相同值、间隔节奏都没有可观察的内部结构。
     *
     * 【为什么不做「连着 6 局不许重复」】
     *   Provably fair crash 游戏（Stake/Aviator）和老虎机认证标准（GLI-11）
     *   都【明确不】在单局层面过滤结果 —— 过滤掉的痕迹本身就是新模式，
     *   玩家观察几轮就能推出「上一局 100x → 这局必然不是 100x」。
     *   行业做法是让分布自己在时间上漂移，也就是这里的中心游走。
     *
     * 爆点仍然只有一个、全场共享同一条 rateAt 曲线，不做任何按人差异化。
     * 无人下注时同样不消耗任何东西（v3 是纯本地算法，没有 API 调用）。
     */
    const v3 = require('./v3/engine');
    // 后台存的是「百分比」字符串（便于运营填 10 表示 10%），
    // 这里统一转成 0–1。留空 → undefined → 引擎用默认 10%。
    /**
     * ⚠️ 留空必须落到【引擎默认值】，不能落到 0。
     *    留空 =「没配」≠「配成 0%」—— 后者会让运营以为设了瞬爆却一局都不爆
     *    （这个 bug 实测踩过：slot_boom_rate 留空 → 瞬爆 0%）。
     *
     * 三项的语义和量级都不同，不能用同一个解析函数：
     *   boom_rate  后台填百分比（10 = 10%）→ 引擎要 0–1
     *   width      直接是倍数（2.5 = ±2.5 倍），不是百分比
     *   jump_rate  直接是 0–1 的概率（0.5 = 50%）
     */

    // ⚠️ 默认值【已经是 0–1 的概率】，不能再除100 ——
    //   早先写成 num(cfg, 0.10) / 100 = 0.001，瞬爆率被压到 0.1%。
    //   这里分两段：先取「原始值」（后台是百分比），再统一归一化到 0–1。
    const SLOT_DEFAULTS = { boomPct: 10, width: 2.5, jumpRate: 0.5 };
    const num = (v, def) => {
      if (v === undefined || v === null || v === '') return def;
      const n = Number(v);
      return Number.isFinite(n) ? n : def;
    };
    const boomRate = Math.max(0, Math.min(1, num(cfg.slot_boom_rate, SLOT_DEFAULTS.boomPct) / 100));
    const d = v3.rollRange({
      min: Math.max(min, 1),
      max: max,
      boomRate,
      width: Math.max(1.05, num(cfg.slot_width, SLOT_DEFAULTS.width)),
      jumpRate: Math.max(0, Math.min(1, num(cfg.slot_jump_rate, SLOT_DEFAULTS.jumpRate))),
    });
    return {
      rate: d.rate, fast: false,
      mode: '8-slot',
      event: { boom: d.boom, center: d.center },
    };
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
    // ⚠️ weight 不再用来「一次性抽一个固定倍率」—— 那个做法让整个活动时段
    // 都是同一个数，玩家看到一整小时都在爆 23.4x。
    // 现在 weight 只作为 v3 的兼容字段保留，倍率由 v3 每局独立抽取。
    // 瞬爆概率由 boom_rate（0–1，如 0.30 = 30%）控制。
    const boomRate = Math.max(0, Math.min(1, Number(ev.boom_rate ?? 0)));
    return {
      name: ev.name || '限时活动', min: lo, max: hi, weight: w, boom_rate: boomRate,
      width: ev.width,
      /**
       * 【2026-09-30】幂律（mode 9）下活动期唯一生效的字段。
       * 加法幅度，clamp 到 [0, 0.20]，且最终 RTP 硬 clamp 到 1.00。
       * ⚠️ 非幂律模式下这个字段【完全不被读取】 —— 那些模式仍走 v3 的
       *    min/max/boom_rate，所以「配了活动但没生效」要按当前模式排查。
       */
      rtp_bonus: ev.rtp_bonus,
    };
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
  /**
   * 【mode 9 专用报告】
   *
   * 【为什么幂律要单独一套指标，而不是塞进下面的桶】
   * 下面的 buckets 是给「人为分段的分布表」用的（1.5/10/30/50/80 这些桶界）。
   * 幂律的核心性质是【毛赔付恒定】，不是「落在哪个桶」。
   * 报告 EV(m) 才能让运营看见「提高 RTP 会怎样影响所有逃跑点」。
   */
  if (String(cfg.odds_mode ?? '4') === '9') {
    return powerlawReport(cfg, rounds);
  }

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

/**
 * 幂律分布报告 —— 后台「爆点分布预览」与 saveOdds 提示都用它。
 *
 * 【报什么、不报什么】
 * 报：P(X≥m)、毛赔付 P(X≥m)·m（应恒等于 RTP）、净期望 EV(m)、瞬爆率。
 * 不报：中位/平均倍率当「慷慨程度」的指标 —— 幂律的平均值由尾部主导，
 * 报出来会让人误以为很慷慨，实际决定玩家盈亏的是毛赔付那一列。
 */
function powerlawReport(cfg, rounds = 20000) {
  const N = Math.max(100, Math.min(200000, Number(rounds) || 20000));
  const base = normRtp(cfg.powerlaw_rtp);
  const cap = normCap(cfg.powerlaw_cap);
  const targets = [1.5, 2, 3, 5, 10, 20, 30, 50, 100, 120].filter((m) => m <= cap);

  const hits = new Map(targets.map((m) => [m, 0]));
  const capHits = { instant: 0, atCap: 0 };
  let sum = 0, maxSeen = 0;
  for (let i = 0; i < N; i++) {
    const x = powerlawRate(base, cap);
    sum += x;
    if (x > maxSeen) maxSeen = x;
    if (x <= 1.0) capHits.instant++;
    if (x >= cap) capHits.atCap++;
    for (const m of targets) if (x >= m) hits.set(m, hits.get(m) + 1);
  }
  const vals = targets.map((m) => {
    const p = hits.get(m) / N;
    return {
      target: m,
      pGe: round4(p),
      theory: round4(base / m),
      gross: round4(p * m),              // 不变量①：毛赔付，应 ≈ RTP
      // 不变量②：净期望。【必须带 (1−P)·(−1) 那一支】
      // 只算赢的那一支会得出「逃得越高期望越高」的假象（少了一次减一）。
      ev: round4(p * (payout(1, m) - 1) + (1 - p) * -1),
    };
  });
  return {
    rounds: N,
    mode: '9-powerlaw',
    rtp: round4(base),
    cap,
    instantBoom: capHits.instant,
    instantBoomPct: round2((capHits.instant / N) * 100),
    instantTheoryPct: round2((1 - base) * 100),
    atCapPct: round2((capHits.atCap / N) * 100),
    avg: round2(sum / N),
    max: round2(maxSeen),
    targets: vals,
    evFlat: round4(payout(1, 1) * base - 1),   // 理论净期望，与 m 无关
    breakevenRtp: round4(1 / payout(1, 1)),      // 1 / 0.97 = 1.0309
    note: `毛赔付 P(X≥m)×m 对所有 m ≤ ${cap} 恒等于 RTP ${round4(base)}；`
      + `净期望对所有 m 恒等于 ${round4(payout(1, 1) * base - 1)}（含输掉那一支），`
      + `因此任何固定逃跑点都不优于其它。保本 RTP = ${round4(1 / payout(1, 1))}，`
      + `上限 1.00 仍在保本线之下。`,
  };
}

module.exports = {
  CFG, flightMs, rateAt, decideRate, activeEvent, payout, round2, sleep,
  toMinutes, tableRate, simulate, beijingParts,
  powerlawRate, powerlawDecide, powerlawReport, normRtp, normCap, normEventBonus, POWERLAW,
};
