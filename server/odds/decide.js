'use strict';
/**
 * server/odds/decide.js —— decideRate()：本项目【唯一】参与定价的函数
 *
 * 四条性质，全部可被脚本验证：
 *   ① 纯函数、无状态、单次抽样、无记忆 —— 不读 pot / pool / ctx / 上一局爆点
 *   ② 随机源只用 crypto.randomBytes
 *   ③ 对任意逃跑目标 m：P(X ≥ m) = RTP / m ⇒ 不存在最优逃跑点
 *   ④ 无人下注（pot=0）也照常抽样
 *
 * 当前只有两个分支：odds_mode=10（零套利高倍率，见 shaped-rate.js）与
 * 幂律（mode 9/默认，见 powerlaw.js）。mode 7/8 的代码在同目录保留但已不接线路径。
 */

// 本文件由 scripts/tmp-odds-migrate.js 从原 server/game-logic.js 按行号区间原样切出。
// 【不要手改算法】要改行为请改这里再重跑 node --check server/odds/*.js + test/odds-invariants.js

const { shapedDecide } = require('./shaped-rate');
const { powerlawDecide } = require('./powerlaw');

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
  const ev = event && typeof event === 'object' ? event : null;
  const p = Number(pot) || 0;

  /**
   * 【mode 10：零套利高倍率引擎 + 空房独立区间】
   *
   * ⚠️ 这里【读 pot】是 mode 10 唯一一次读房间状态，而且是有理由的：
   *   客户要求「没人下单时倍率 10–39x」，所以 pot=0 必须走另一条分支。
   *   这与幂律「读都不读 pot」的原则相反，但两者服务的目标不同：
   *     · 幂律要防的是「同一个人在同一房间反复玩 ⇒ 分布不变」
   *     · mode 10 要的是「空房时的展示形态可控」
   *   隔离由三点保证（test/shaped-rate.js §5 有断言）：
   *     ① 分布不同：空房 ⊆ [10,39]，真人局 ∈ [1,1000]，支撑集不重叠
   *     ② 顺序无关：空房局不影响真人局的抽样（两个独立采样器）
   *     ③ 结构不同：mode 字符串不同，engine 可据此决定是否落库
   *
   * ⚠️ 何时算「空房」：engine 在【封盘后、起飞前】调 decideRate，
   *   此时 pot 来自 bets 表求和。有下注的局一定是真人局，
   *   玩家下单之后引擎才读 pot —— 所以 pot=0 ⇔ 本局全程无人下注。
   */
  if (String(cfg.odds_mode) === '10') {
    return shapedDecide(cfg, p <= 0);
  }

  // pot / pool / ctx 是历史签名，engine.js 按位置传 5 个参数。
  // 这里【读都不读】—— 读它们就让分布耦合到房间状态上。
  // 保留位置是为了让 engine.js 一行不用改（它不是我负责的文件）。
  void p; void pool; void ctx;
  return powerlawDecide(cfg, ev);
}
module.exports = { decideRate };
