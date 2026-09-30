'use strict';
/**
 * ============================================================================
 *  爆点倍率引擎 v3 —— 从零重写，不依赖 v1/v2 任何结构
 * ============================================================================
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  1. 我从行业做法学到了什么
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 【Provably fair crash 游戏（Stake / Aviator）】
 * 每局完全独立，连续 5 次 2x 就是 5 次 2x。官方明确说 streak 是统计噪声。
 * 它不做防连击，因为防连击一定会造出可推算的模式。
 *
 * 【老虎机（GLI-11 / 各类认证）】
 * 原文：「Volatility describes the long-run distribution of outcomes over
 * millions of spins, NOT streak behavior within a session.」
 * 它们用四个杠杆控长期分布：
 *   ① 命中率（hit rate）
 *   ② 赔付表形状（paytable shape）
 *   ③ bonus 触发频率
 *   ④ 倍率设计（固定/累积/封顶）
 * **从不在单局层面过滤结果。** 这条是铁律。
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  2. 但用户要的「起伏」是对的，只是实现方式错了
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 用户原话：
 *   「上一次是 100X，这次是 50X，但是下次就是瞬爆」
 *   「上次是瞬爆，这次是 10X，下次就是 50x」
 *   「不是看单个玩家，而是要照顾比赛内的所有玩家的游戏体验」
 *
 * 用户要的是【体验有起伏】，不是【连击就不许连击】。
 * 这两件事必须分开：
 *
 *   ❌ 过滤式（我 v1/v2 做的）：上一局 100x → 这一局不许出 100x
 *      副作用：玩家观察几轮就能推出「100x 之后必然不是 100x」。
 *      过滤掉的痕迹就是新模式。
 *
 *   ✅ 漂移式（本文件）：让「高倍阶段 / 低倍阶段」随机交替
 *      起伏来自「现在轮到高倍阶段了」，而不是来自「上一局是什么」。
 *      阶段切换本身是随机的 → 没有可推算的规则。
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  3. v3 的算法：随机游走中心 + 对数均匀采样
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 每一局：
 *
 *   ① 瞬爆判定（硬性条件，独立随机）
 *      Math.random() < p_boom → 1x
 *      每局与历史完全无关，长期频率收敛到 p_boom。
 *      ⚠️ 不能用「每 100 局补足 10 局」的水位配额 ——
 *         那是节拍器，玩家数得出来。见 rollBoom()。
 *
 *   ② 中心游走（这才是「起伏」的来源）
 *      维护一个中心 T（在 log 空间）：
 *        - 多数时候：T 保持不动（局部平稳，看起来像普通随机）
 *        - 约 30% 的概率：T 整个跳到 [min, max] 的随机位置
 *      于是 T 在时间上随机漂移：
 *        高倍期连续几局都是 50–100x（因为 T 在高位）
 *        突然跳到低位 → 接下来几局都是 1.5–3x
 *        再跳回高位 → 又来一波高倍
 *      这自然产生用户要的「100x → 50x → 瞬爆 → 10x → 50x」，
 *      而玩家无法推出 T 什么时候跳。
 *
 *   ③ 采样
 *      在 [T/k, T·k] 内【对数均匀】取一个倍率，夹到 [min, max]。
 *      对数均匀 = 每一个「倍级」出现概率相同。
 *      这是数学上最干净的分布：没有可被观察的内部结构。
 *      （v1 的「点有几个」和 v2 的 beta 权重都是人为结构，会被看穿。）
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  4. 为什么这样不可推算
 * ────────────────────────────────────────────────────────────────────────────
 *
 *  · 瞬爆：每局独立掷骰，任意两局之间无关联
 *  · T 的跳变：概率 30%，跳到哪里均匀随机
 *  · 采样：对数均匀
 *  三者叠加后，「相邻局差」「连续相同值」「间隔节奏」全部无结构。
 *  玩家能看到 100x 之后是 50x，但那是因为刚好 T 还在高位，
 *  不是因为 100x 触发了某种「回落规则」。
 *
 * ============================================================================
 */

/** 随机游走中心的状态 */
function createEngine(cfg) {
  const c = cfg || {};
  const min = Math.max(1, Number(c.min) || 1.01);
  const max = Math.max(min + 0.5, Number(c.max) || 125);
  const width = Math.max(1.05, Number(c.width) || 1.8);
  const jumpRate = Math.max(0, Math.min(1, Number(c.jumpRate) || 0.3));

  // T 在 log 空间：lnT ∈ [lnMin, lnMax]
  const lnMin = Math.log(min);
  const lnMax = Math.log(max);
  const logSpan = lnMax - lnMin;

  // 初始 T 随机落在全区间
  let center = lnMin + Math.random() * logSpan;
  let boomQuota = c.boomQuota === undefined ? 0.10 : Number(c.boomQuota);
  let sinceJump = 0;

  return {
    min,
    max,
    get center() { return Math.exp(center); },

    /** 抽这一局的倍率 */
    roll(rng) {
      const rand = rng || Math.random;

      // ── ① 瞬爆：纯独立随机，无状态、无配额 ──
      if (boomQuota > 0 && rand() < boomQuota) {
        // 瞬爆也让中心回中，避免「爆完一直卡在高位」or「爆完一直卡在低位」
        center = lnMin + rand() * logSpan;
        sinceJump = 0;
        return { rate: round2(min), boom: true, center: round2(Math.exp(center)) };
      }

      // ── ② 中心漂移 ──
      // 跳变概率随「距上次跳变的时间」上升：越久没跳，越可能跳。
      // 这样低倍阶段不会无限延续（那正是「一直是低倍率」的问题），
      // 但跳变时刻仍不可预测。
      sinceJump += 1;
      const p = Math.min(0.9, jumpRate * (0.6 + sinceJump * 0.12));
      if (rand() < p) {
        center = lnMin + rand() * logSpan;
        sinceJump = 0;
      }

      // ── ③ 在中心邻域内对数均匀采样 ──
      // 邻域宽度 width：每局在自己的中心周围 ±width 倍内浮动。
      // width 太小 → 数值集中，玩家能看出「围绕某个数波动」；
      // width 太大 → 中心漂移失去意义，退化成全局均匀。
      const half = Math.log(width);
      const lo = Math.max(lnMin, center - half);
      const hi = Math.min(lnMax, center + half);
      const picked = lo + rand() * (hi - lo);

      return {
        rate: round2(Math.exp(picked)),
        boom: false,
        center: round2(Math.exp(center)),
      };
    },

    /** 测试用：读取内部状态 */
    stats() {
      return {
        min, max, center: round2(Math.exp(center)),
        width, jumpRate, boomQuota, sinceJump,
      };
    },

    setBoomQuota(p) { boomQuota = p; },
  };
}

/**
 * 瞬爆判定 —— 保留为独立函数以便测试和文档化。
 *
 * ⚠️ 这里曾经是「配额调度器」（每 100 局欠账就补一次），
 *    行为是第 1 局爆、第 10 局爆、第 20 局爆 —— 玩家数得出来。
 *    用户明确纠正：「你这样弄得不就用户不就可以推算出来了吗？」
 *    现在是纯粹的每局独立掷骰。
 */
function rollBoom(p, rng) {
  const prob = p === undefined || p === null || p === '' ? 0.10 : Number(p);
  if (!(prob > 0)) return false;
  if (prob >= 1) return true;
  return (rng || Math.random)() < prob;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { createEngine, rollBoom, round2, rollRange };

/**
 * 活动时段用的便捷入口：按 min/max/boom_rate 每局抽一个倍率。
 *
 * ⚠️ 中心 T 必须在【模块级】持久化，不能每局新建 —— 否则「中心漂移」
 * 这个核心机制在活动里完全失效，会退化成全局均匀分布（没有起伏）。
 * 活动时段结束、倍率范围变化时调用 resetRange() 清掉。
 */
const _rangeState = new Map();

function rollRange(cfg) {
  const min = Math.max(1, Number(cfg.min) || 1);
  const max = Math.max(min + 0.5, Number(cfg.max) || 1000);
  const key = min + ':' + max;
  let eng = _rangeState.get(key);
  if (!eng) {
    eng = createEngine({
      min, max,
      width: cfg.width || 1.8,
      jumpRate: 0.3,
      boomQuota: cfg.boomRate === undefined || cfg.boomRate === '' ? 0 : Number(cfg.boomRate),
    });
    _rangeState.set(key, eng);
  }
  return eng.roll();
}

function resetRange() { _rangeState.clear(); }
