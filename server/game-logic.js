'use strict';
/**
 * 爆点游戏核心算法
 *
 * 赔率曲线：  rate = t/2 + (t² − t)/10 + 1     （t 为飞行秒数）
 * 闭式反解：  t = (√(40·rate − 24) − 4) / 2
 *   原实现 getBDTime() 用最多 10 万次迭代逼近，此处改用闭式解，1.00~1000x 全区间精确。
 *
 * 爆点分布：单一幂律引擎（无状态、单次抽样、不读任何房间状态）。
 *   X = min(cap, max(1.00, floor₂(RTP / U)))，U 来自 CSPRNG（crypto.randomBytes）。
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
 * 数值（默认 RTP=1.00，payout() 抽水 3%）：EV = 0.97·1.00 − 1 = **−0.0300**
 * 也就是说玩家每注期望亏 3.00%，与逃到哪里无关 —— 精确等于 Aviator/JetX。
 * ⚠️ 别把 powerlaw_rtp 当成对外 RTP：0.97 那个数在两层抽水下等价于 94.09%，
 *    详见 RTP_DEFAULT 的注释。
 *
 * 【为什么必须用 crypto 而不是 Math.random】
 * Math.random() 是可预测的（V8 用 xorshift128+，观察输出即可恢复内部状态），
 * 而爆点直接决定钱。一条能被玩家反推的伪随机序列 = 一个可被套利的固定序列。
 * crypto.randomBytes 走 OS 的 CSPRNG，观察输出无法恢复内部状态。
 *
 * 【瞬爆概率不再单独设置】
 * 精确式是 1 − RTP/1.01 而不是 1 − RTP —— 因为 floor₂ 让 X ≤ 1.00 的条件是
 * RTP/U < 1.01（不是 < 1），而 < 1 的那一小段也被 max(1,·) 兜到 1.00。
 * RTP=1.00 时实测 0.99%，理论 1 − 1/1.01 = 0.99%。
 * 所以不需要「瞬爆段」这种额外旋钮，也就没有「配了瞬爆段」和
 * 「瞬爆率对不上」两个新问题。
 */
const POWERLAW = {
  /**
   * 【2026-10-02 客户拍板】默认 RTP = 0.90 —— 留出活动加成空间。
   *
   * 【为什么是 0.90 而不是 1.00】客户要的是「每日高倍活动」名副其实。
   * RTP 顶到 1.00 时 `min(RTP_MAX, 1.00 + bonus) = 1.00`，任何加成都被
   * clamp 吃掉 ⇒ 活动【配了不生效】。base 降到 0.90 后：
   *     活动 +0.05 → 0.95，真实生效，体感可感知
   *     活动 +0.10 → 1.00，正好触到上限
   * 而幂律性质不受影响：抬 RTP 只把 EV 直线平行上移
   * （EV = 0.97·RTP − 1 与 m 无关），不产生「最优逃跑点」，FAQ-2 仍成立。
   *
   * ⚠️【口径】本项目是【双层抽水】：payout() 写死 HOUSE_EDGE=0.03
   *   已是行业那一层，powerlaw_rtp 是【在它之上再乘一层】：
   *       玩家每注 EV = 0.97 × powerlaw_rtp − 1
   *       庄家总优势   = 1 − 0.97 × powerlaw_rtp
   *   换算成行业口径（行业只有一层）：
   *
   *     powerlaw_rtp   庄家总优势   行业等价 RTP   说明
   *        0.87          15.61%        84.39%      上一版默认值
   *        0.90          12.70%        87.30%      ← 当前默认
   *        0.95           7.85%        92.15%      活动 +0.05 时
   *        1.00           3.00%        97.00%      精确等于 Aviator / JetX，但加成失效
   *
   * ⚠️ RTP_MAX 仍是 1.00 硬红线，超过玩家就是正期望 —— 【不要动它】。
   *    EVENT_BONUS_DEFAULT 也刻意不动：运营要的是活动期明确配 0.05，
   *    不是把全局默认改大。
   *
   * ⚠️ 本文件只决定【代码默认值】。线上真正生效的是 settings 表的
   *    powerlaw_rtp，而 seedSettings() 只在键不存在时写入 ⇒ 代码改了
   *    不改库不会报错也不会生效。必须跑 scripts/migrate-powerlaw.js --apply。
   *
   * 这是运营默认值，不是数学护栏。RTP_MIN/RTP_MAX 才是护栏，不动。
   */
  RTP_DEFAULT: 0.90,
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
  /**
   * 【2026-10-01 改】倍率上限默认 120 → 1000。
   *
   * 实测（现网引擎 50 万局，rtp=0.87 / cap=1000）：把 cap 从 125 拉到 1000
   * 对中位数（1.74x）和 p90（8.70x）几乎无影响，尾部自己出得来 ——
   * ≥50x 占 1.74%、≥100x 占 0.88%，最大观测值 1000.00。
   * 所以【不需要另做尖峰机制】：尾部是幂律自己长出来的，不是外挂的。
   */
  CAP_DEFAULT: 1000,
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
 * 决定本局爆点。**这是本项目唯一参与定价的函数。**
 *
 * 【性质，四条，全部可被脚本验证】
 *   ① 纯函数、无状态、单次抽样、无记忆 —— 不读 pot / pool / ctx / seated /
 *      上一局爆点。任何对房间状态的依赖都会让「房间不变 → 分布不变」，
 *      重新制造一个稳定可套利的区间。
 *   ② 随机源只用 crypto.randomBytes。Math.random() 是 V8 的 xorshift128+，
 *      观察输出即可恢复内部状态 —— 一条能被反推的伪随机序列就是一套可套利的固定序列。
 *   ③ 对任意逃跑目标 m（m ≤ cap）：P(X ≥ m) = RTP / m，于是毛赔付恒等于 RTP，
 *      净期望 EV(m) = 0.97·RTP − 1 与 m 完全无关 ⇒ 不存在最优逃跑点。
 *   ④ 无人下注（pot=0）也照常抽样。历史上这里有一条「无下注 → 均匀 1.10–2.00」
 *      的早退，任何 odds_mode 都改不动它，深夜空房间就成了一条稳定套利通道。
 *
 * 【参数只有两个】
 *   powerlaw_rtp  返还率，0.80–1.00，硬上限 1.00（超过 1.00 玩家就是正期望）
 *   powerlaw_cap  倍率上限，默认 1000（只截尾；c ≤ cap 区间内 ③ 精确成立）
 *
 * ⚠️ min_rate / max_rate / 限时段 / 分布表 / 加权段 / Jev 选段 / 老虎机
 *    全部已删除。它们的共同问题不是参数不对，而是分布里存在「期望更高」的
 *    区间，玩家固定在那个倍率逃跑就能长期获利 —— 而发现它不需要看懂任何规律，
 *    只要记住一个数字。（实测：旧五段加权下 1.10x–20x 之间每一个固定逃跑点
 *    都是 9σ–25σ 的正期望，逃 2.00x 每注 +50%。）
 *
 * @param {object} cfg    settings 快照（db.allSettings()）
 * @param {number} pot    【历史参数·已不读】本局总投注
 * @param {number} pool   【历史参数·已不读】后台资金池
 * @param {object|null} event 命中的限时活动（无则 null）—— 只用来加 RTP，不换引擎
 * @param {object|null} ctx   【历史参数·已不读】房间上下文（seated / lastBoom）
 * @returns {{rate: number, mode: string, powerlaw: object}}
 */
function decideRate(cfg, pot, pool, event, ctx) {
  // pot / pool / ctx 是历史签名，engine.js 按位置传 5 个参数。
  // 这里【读都不读】—— 读它们就让分布耦合到房间状态上。
  // 保留位置是为了让 engine.js 一行不用改（它不是我负责的文件）。
  void pot; void pool; void ctx;
  return powerlawDecide(cfg, event && typeof event === 'object' ? event : null);
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
 * 模拟 N 局并返回分布摘要。
 *
 * ⚠️ 这曾是「按人为分段的桶」统计（1.5/10/30/50/80 那些桶界），
 *   而幂律的核心性质是【毛赔付恒定】不是「落在哪个桶」——
 *   报桶会让人误以为提高 RTP 就是「让桶更宽」，那不是它。
 *   所以现在只有 powerlawReport 一套指标，前缀保留是为了让
 *   /admin/api/odds-preview 继续可用（那是 routes/，不在本次改动范围）。
 */
function simulate(cfg, rounds = 20000) {
  return powerlawReport(cfg, rounds);
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
  CFG,
  /** engine.js 按名取 FLIGHT_SCALE —— 此前它拿到的是 undefined，
   *  只因 rateAt 的默认参数恰好回落到 CFG.FLIGHT_SCALE 才没出事。 */
  FLIGHT_SCALE: CFG.FLIGHT_SCALE,
  flightMs, rateAt, decideRate, activeEvent, payout, round2, sleep,
  toMinutes, beijingParts, simulate,
  powerlawRate, powerlawDecide, powerlawReport, normRtp, normCap, normEventBonus, POWERLAW,
};
