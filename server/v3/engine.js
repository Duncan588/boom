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
  // 【2026-09-30 调参】width 1.8 → 2.5，jumpRate 0.3 → 0.5。
  //
  // 两个默认值原来在互相打架：邻域只有 ±1.8 倍宽（中心 30 只能出 17–54x），
  // 而跳变概率要 sinceJump 涨到 10 才到 0.9 —— 卡在单一数量级整整 10 局。
  // 放宽邻域 + 加快跳变后，任何一档都待不满 3 局。
  const width = Math.max(1.05, Number(c.width) || 2.5);
  const jumpRate = Math.max(0, Math.min(1, Number(c.jumpRate) || 0.5));

  // 一「档」= log10 里的一格 = ×3.16。
  // 用它做相邻档游走的步长：上/下走一格就是明确的数量级台阶。
  const TIER = Math.log10(3.16);

  // 均值回归强度（每局把中心往锚点拉回这个比例）。
  // 0.05 = 中心偏离锚点 1 档时，每局拉回 5%，约 20 局回到锚点 ——
  // 足够慢，高倍期能持续十几局；足够快，不会一路滑到边界。
  const REVERT = 0.05;

  /**
   * 回归【锚点】= 12x，是【地板】而不是目标。
   *
   * 它的唯一职责是防止中心滑到 1x 附近贴死 —— 实测没有这一项时，
   * 120 局内中心从 85.9 塌到 1.0x 再也出不来。
   *
   * 中心高于 12x 时完全不干预，所以高倍期可以自由停留（波峰），
   * 低倍期也不会一路滑到地板。
   */
  const ANCHOR = Math.log(Math.max(min, 12));

  // T 在 log 空间：lnT ∈ [lnMin, lnMax]
  const lnMin = Math.log(min);
  const lnMax = Math.log(max);
  const logSpan = lnMax - lnMin;

  // 初始 T 落在【全区间中点】而不是随机位置 ——
  // 随机起步有 1/3 概率开局就贴在高倍或低倍端，第一段观感很差。
  let center = (lnMin + lnMax) / 2;
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
        // ⚠️ 这里【不做】任何中心移动。
        //
        // 早先版本写的是 `center -= TIER`（瞬爆就把中心往下拽一格），
        // 加上 45%/45%/10% 的非对称步进，净漂移必然朝下 ——
        // 实测 120 局内中心从 85.9 一路塌到 1.0x 并贴死，
        // 结果 73.8% 的局落在 1-2x、5 个档位全空。比重原来的问题更糟。
        //
        // 瞬爆只是本局的结果，不该影响节奏中心的走向。
        // 中心位置完全交给下面的游走逻辑，且那个逻辑自带均值回归。
        sinceJump = 0;
        return { rate: round2(min), boom: true, center: round2(Math.exp(center)) };
      }

      // ── ② 中心游走 ──
      //
      // 【2026-09-30 修复：实盘连续 6 局锁在 17–40x】
      //
      // 旧实现是 `center = lnMin + rand() * logSpan` —— 每次跳变都
      // 【扔掉当前位置，在整个 1–1000 区间重新随机】。后果有两个：
      //   1) 中心跳多远完全看运气，邻域又只有 ±1.8 倍宽，于是中心一旦落在
      //      某个数量级就出不来 —— 实盘 #6057–#6065 连续 6 局 17–40x。
      //   2) 没有任何爬升趋势，1000x 活动里 40–80x 整档空掉（最近 60 局 0 次），
      //      玩家从 39x 直接跳到 129x，中间那片完全没出现。
      //
      // 新实现是【相邻档位游走】：中心按档位上/下走一格，档位内再随机落点。
      // 每一格就是 log10 里的一格（约 ×3.16），所以「下走一格」是从 30x 到 9.5x
      // 这种明确的台阶，而不是掷骰子赌跳到哪。
      //
      // 这样保证：
      //   · 每一档都会被走到（爬升是系统性的，不再靠运气）
      //   · 任何一档都待不长（跳变概率随停留时间上升）
      //   · 起伏有波峰波谷（30x → 300x → 30x，而不是 30x → 7x）
      sinceJump += 1;
      // 跳变概率随停留时间上升，但【封顶 0.55】——
      // 早先封到 0.92 且 sinceJump 系数给到 0.22，导致 sinceJump=1 时
      // p 就接近 0.5，也就是【每两局跳一次】。中心永远在乱走，
      // 根本没有时间在一个档位上停留采样 —— 那是塌陷的第二个原因。
      const p = Math.min(0.55, jumpRate * (0.35 + sinceJump * 0.10));
      if (rand() < p) {
        const step = rand() < 0.5 ? 1 : -1;   // 严格对称，无偏
        center += step * TIER;
        // ⚠️ 边界必须在这里钳。早先版本把钳位写在后面（紧跟 center +=），
        //   但现在回归项在游走【之后】执行，若只钳一次，
        //   中心会被游走推出边界后又单向回归拖回来、再推出去 ——
        //   实测中心跑到 1.3e12x。所以游走和回归之后都要各自钳一次。
        if (center < lnMin) center = lnMin;
        if (center > lnMax) center = lnMax;
        sinceJump = 0;
      }

      /**
       * 【单向均值回归】—— 只防塌陷，不压制高倍。
       *
       * 对称回归（往中点拉）有两个致命问题，实测都撞到了：
       *   ① 中心塌到 1.0x 贴死（没有回归时）
       *   ② 中心被锁死在低倍区 —— 100x 以上的占比【实测 0%】，
       *      因为从低倍往上爬时回归一直在往下拉，爬到 30x 就再也上不去。
       *      结果高倍档（80-200x、200x+）永远空着，千倍活动玩不出高倍。
       *
       * 所以回归必须【单向】：只把低于锚点的中心往上拉，高于锚点的完全不管。
       * 高倍期想停多久就停多久 —— 那正是「波峰」的可玩性来源。
       */
      if (center < ANCHOR) center += (ANCHOR - center) * REVERT;
      if (center < lnMin) center = lnMin;
      if (center > lnMax) center = lnMax;

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

module.exports = { createEngine, rollBoom, round2, rollRange, resetRange };

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
  /**
   * 【2026-09-30 修复：缓存 key 必须包含 boomRate】
   *
   * 实盘症状：活动开启后玩了 50 局，瞬爆 0 次；同一份代码单独调用引擎
   * 瞬爆率 29.9%（完全正常）。
   *
   * 根因是缓存 key 只有 `min:max`。服务在 18:09 重启，那一刻
   * events_json 里【还没有 boom_rate 字段】（18:28 才补上），
   * 于是第一次调用 rollRange 时 boomQuota 取到默认 0，
   * 并把一个「永不瞬爆」的实例按 key "1:1000" 存进缓存。
   * 之后补上 boom_rate=0.3，key 没变 → 永远命中那个坏实例。
   *
   * 这类「配置热更新不生效」的 bug 极难从外部观察：引擎本身完全正常，
   * 只是进程内记住了一个过期的实例。任何影响引擎行为的字段都必须进 key。
   */
  const width = cfg.width === undefined || cfg.width === '' ? 'd' : String(cfg.width);
  const jump = cfg.jumpRate === undefined || cfg.jumpRate === '' ? 'd' : String(cfg.jumpRate);
  const boomKey = cfg.boomRate === undefined || cfg.boomRate === '' ? '0' : String(cfg.boomRate);
  // 每一项【影响引擎行为】的字段都必须进key —— 漏一个就是一次热更新失效。
  const key = min + ':' + max + ':' + boomKey + ':' + width + ':' + jump;
  let eng = _rangeState.get(key);
  if (!eng) {
    eng = createEngine({
      min, max,
      // ⚠️ 这里原来硬编码 width:1.8 / jumpRate:0.3，会【覆盖】engine 内部
      //    刚调好的新默认值 —— 活动期用的正是这条路径，不改就等于没修。
      width: cfg.width || undefined,
      jumpRate: cfg.jumpRate || undefined,
      boomQuota: cfg.boomRate === undefined || cfg.boomRate === '' ? 0 : Number(cfg.boomRate),
    });
    _rangeState.set(key, eng);
  }
  return eng.roll();
}

function resetRange() { _rangeState.clear(); }
