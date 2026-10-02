'use strict';
/**
 * server/odds/flight-curve.js —— 飞行曲线（倍率 ↔ 毫秒）+ 全局常量 + 派奖
 *
 * 赔率曲线：  rate = t/2 + (t² − t)/10 + 1     （t 为飞行秒数）
 * 闭式反解：  t = (√(40·rate − 24) − 4) / 2
 * 原实现 getBDTime() 用最多 10 万次迭代逼近，此处改用闭式解，1.00~1000x 全区间精确。
 *
 * ⚠️ applyHighRateAccel 与 unapplyHighRateAccel 必须严格互逆 —— 玩家点逃跑时
 *   屏幕显示的倍率必须与实际结算的倍率【完全相同】，否则是直接的钱款错误。
 *   test/flight-curve.js 做往返断言（误差必须为 0）。
 */

// 本文件的算法代码是从原 server/game-logic.js 按行号区间原样切出的（2026-10-02 目录化）。
// 【不要手改算法】要改行为请改这里再重跑 node --check server/odds/*.js + test/odds-invariants.js

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
module.exports = {
  CFG,
  /** engine.js 按名取 FLIGHT_SCALE —— 此前它拿到的是 undefined，
   *  只因 rateAt 的默认参数恰好回落到 CFG.FLIGHT_SCALE 才没出事。 */
  FLIGHT_SCALE: CFG.FLIGHT_SCALE,
  flightMs, rateAt, payout, round2, sleep,
  // 内部但被本目录其它模块使用
  applyHighRateAccel, unapplyHighRateAccel, rawFlightMs,
};
