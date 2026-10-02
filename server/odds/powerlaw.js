'use strict';
/**
 * server/odds/powerlaw.js —— 模式 9：幂律分布（恒定期望）
 *
 * X = min(cap, max(1.00, floor₂(RTP / U))) ，U 来自 CSPRNG（crypto.randomBytes）。
 * 对任意逃跑目标 m（m ≤ cap）：P(X ≥ m) = RTP / m，于是毛赔付恒等于 RTP、
 * 净期望 EV(m) = 0.97·RTP − 1 与 m 完全无关 ⇒ 不存在最优逃跑点。
 *
 * 硬性约束：纯函数、无状态、单次抽样、不读 pot/pool/ctx；随机源只用
 * crypto.randomBytes（Math.random 是 V8 xorshift128+，可被反推）。
 */

// 本文件由 scripts/tmp-odds-migrate.js 从原 server/game-logic.js 按行号区间原样切出。
// 【不要手改算法】要改行为请改这里再重跑 node --check server/odds/*.js + test/odds-invariants.js

const crypto = require('crypto');
const { round2, payout } = require('./flight-curve');

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
  POWERLAW, normRtp, normCap, normEventBonus,
  cryptoUniform, powerlawRate, powerlawDecide, powerlawReport, simulate,
  round4,
};
