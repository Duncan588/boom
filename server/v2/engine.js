'use strict';
/**
 * ============================================================
 *  爆点倍率引擎 v2 —— 从零重写
 * ============================================================
 *
 * 【为什么推翻 v1】
 * v1 用「五档 + 档内随机」，实测暴露三个结构性问题：
 *
 *   1) 档位边界由代码按玩家阈值硬切，档的语义是猜的
 *   2) Jev 只在 5 个选项里挑，粒度太粗 —— 选出来的分布必然窄
 *   3) 管理员的 max_rate 完全不生效（段顶只到 15x）
 *
 * v2 的立足点完全不同：
 *
 *   ┌──────────────────────────────────────────────┐
 *   │  倍率不是「难度」，是「让几个人能跑掉」的开关  │
 *   └──────────────────────────────────────────────┘
 *
 * 3x 时胆小的人（心理阈值 1.5）早跑了，胆大的人（阈值 20）还在等。
 * 所以倍率天然是【分层】的 —— 每一层对应一批特定的人。
 *
 * v2 的做法：
 *   1) 代码从【玩家的真实逃跑行为】算出一张「有意义的倍率谱」
 *      —— 不是人为配置的百分比表，是这个房间的物理规律
 *   2) Jev 在这张谱上选一个【具体倍率】给这一局
 *   3) 管理员的 min/max 是【硬边界】，Jev 不能越
 *
 * 这样 v1 的三个问题同时解决：
 *   - 粒度不再是 5 档，Jev 有连续的倍率可选
 *   - 倍率谱来自真实行为，不是猜的
 *   - max_rate 真正生效（硬钳制）
 */

// ============================================================
//  第一部分：倍率谱 —— 这个房间「有意义」的倍率有哪些
// ============================================================

/**
 * 从在场玩家的逃跑阈值，算出这张房间的「有意义倍率谱」。
 *
 * 【物理意义】
 * 每个玩家有一个心理阈值：跑到这个倍率以上他就按逃跑。
 * 这个阈值来自他过去的下注行为 —— 梭哈型阈值高，稳健型阈值低。
 *
 * 于是「倍率 x 对应什么样的局」是可以【算出来】的：
 *   倍率 < 最胆小者的阈值   → 全灭，没有任何逃生
 *   倍率 ≈ 半数人的阈值     → 一半人能跑，一半人留下
 *   倍率 ≈ 最胆大者的阈值   → 几乎所有人都能跑
 *
 * 【为什么这不是「人为参数」】
 * v1 的百分比表（10/40/30/10）是拍脑袋定的。
 * v2 的谱是【这个房间这批人】的真实行为算出来的。
 * 房间里都是稳健玩家，谱自然密集在低倍；
 * 房间里都是赌徒，谱自然延伸到高倍。
 * 管理员不需要（也不应该）手工调这张表。
 *
 * @param {{thr:number}[]} seated 在场玩家，thr = 心理阈值
 * @param {{min:number,max:number}} bounds 管理员的硬边界
 * @returns {{rate:number, escapes:number, share:number}[]}
 *          升序的候选倍率，escapes = 有几个人能跑掉
 */
function buildSpectrum(seated, bounds) {
  const thrs = (seated || [])
    .map((p) => Number(p && p.thr))
    .filter((t) => isFinite(t) && t > 1.05)
    .sort((a, b) => a - b);

  // 没有玩家（或阈值全无效）：给一个宽松但合法的默认谱
  if (!thrs.length) return defaultSpectrum(bounds);

  /**
   * 候选倍率的来源：每个玩家的阈值本身 + 阈值之间的中点。
   * 阈值本身是「这一批人里最自然的分界」—— 某一局的倍率正好等于
   * 谁的阈值，这一局的语义就最清楚（「恰好让 3 个人能跑」）。
   */
  const cand = [];
  for (const t of thrs) cand.push(t);
  for (let i = 0; i < thrs.length - 1; i++) {
    // 几何中点：倍率的感知是对数的，算术中点会偏向低倍
    cand.push(Math.sqrt(thrs[i] * thrs[i + 1]));
  }
  // 去重 + 钳制到管理员边界
  const seen = new Set();
  const rows = [];
  for (const c of cand) {
    const r = clamp(c, bounds);
    const key = r.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);
    // 能跑掉的人：阈值 < 这个倍率（严格小于，阈值相等算跑不掉）
    const escapes = thrs.filter((t) => r > t).length;
    rows.push({ rate: r, escapes, share: escapes / thrs.length });
  }
  rows.sort((a, b) => a.rate - b.rate);
  return rows;
}

/** 没有真人玩家时的默认谱 —— 覆盖常见倍率，不要太窄 */
function defaultSpectrum(bounds) {
  const { min, max } = bounds;
  const steps = [];
  // 对数等距取 12 个点，覆盖 min → max
  const lo = Math.log(min);
  const hi = Math.log(max);
  for (let i = 0; i < 12; i++) {
    const v = Math.exp(lo + (hi - lo) * (i / 11));
    steps.push({
      rate: clamp(v, bounds),
      escapes: null,      // 无人，语义未定义
      share: null,
    });
  }
  return steps;
}

// ============================================================
//  第二部分：分布整形 —— 让「什么样的倍率」更常出现
// ============================================================

/**
 * 管理员配置的「手感」：倍率越高越罕见，还是各档均好。
 *
 * 默认（log）：按对数偏置 —— 高倍天然罕见，中低倍常见。
 * 这符合爆点游戏的手感：多数局是小倍数的博弈，偶尔来一发大的。
 *
 * flat：各段等概率（beta 0.5）
 * spicy：高倍更多（beta < 1）
 */
function shapeWeights(rows, mood) {
  if (!rows.length) return [];
  const betas = {
    log: 1.6,      // 强偏向低倍（默认）
    flat: 0.5,     // 各段接近均匀
    spicy: 0.85,   // 偏向高倍
  };
  const beta = betas[mood] || betas.log;

  return rows.map((r, i) => {
    const pos = rows.length === 1 ? 0 : i / (rows.length - 1);
    // 权重 ∝ (1 - pos)^beta  —— pos 越大（倍率越高）权重越小
    return Math.pow(1 - pos, beta) + 1e-6;
  });
}

/** 按权重抽一个下标 */
function pickIndex(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

// ============================================================
//  第三部分：连续性 —— 避免「连着几局都差不多」
// ============================================================

/**
 * 破除连续性 —— 直击用户实测的 #5519–#5515 = 4.43 6.17 6.17 6.14 6.07。
 *
 * 【重要区分】用户说的「规律」有两种，处理方式完全不同：
 *
 *   a) 相邻局【数值几乎相同】（6.17 / 6.14）—— 必须破，这是伪随机
 *   b) 连续几局都是【同一档】（都是低倍）—— 不该破
 *
 * (b) 是正常随机分布的必然结果（低倍局本来就占多数），
 * 强行打散反而会露出「系统在刻意安排」的痕迹。
 * v1 错在把 (b) 当成问题去破，结果破坏了管理员配置的档位分布。
 *
 * ⚠️⚠️ 关键的量级问题（v2 第一版踩了）：
 *   我以为「三连才破」就够了。实测 2 万局相邻差 <8% 高达 13.4%，
 *   远不是少数派。原因是低倍区（1.2–2.1x）被反复抽中，那里空间小，
 *   两局落在同一小段是【大概率事件】，不是巧合。
 *
 *   所以规则必须是【每局都检查 + 单局就破】：
 *   只要这一局和上一局太接近就推开，不等三连。
 *   「看起来像复制」是玩家的直觉，不需要三局来确认。
 *
 * @param {number} rate 本局候选倍率
 * @param {number[]} history 最近的倍率（升序，越新越靠后）
 * @param {{min:number,max:number}} [bounds] 硬边界
 * @param {number} [tolerance=0.08] 判定「太接近」的相对阈值
 */
function breakConsecutive(rate, history, bounds, tolerance = 0.08) {
  if (!history || !history.length) return rate;
  const last = history[history.length - 1];
  if (!isFinite(last) || last <= 0) return rate;

  const rel = Math.abs(rate - last) / last;
  if (rel >= tolerance) return rate;

  /**
   * 太接近 → 朝远离上一局的方向推。
   * 推的幅度要比 tolerance 更大（用 1.6 倍），否则只是擦边，
   * 下一局又可能落回来。
   *
   * 上下两个方向都试一遍，取【仍在边界内】的那个；
   * 边界不允许时用另一个方向；都不行就取边界值（宁可贴边也不重复）。
   */
  const up = last * (1 + tolerance * 1.6);
  const down = last * (1 - tolerance * 1.6);
  const b = bounds || { min: 0, max: Infinity };
  const cands = [up, down].filter((v) => v >= b.min && v <= b.max && isFinite(v));
  if (cands.length) return cands[Math.floor(Math.random() * cands.length)];
  return clamp(up, b);
}

// ============================================================
//  第四部分：主入口
// ============================================================

// ============================================================
//  第五部分：空房间模式 —— 没人下注时不要在低倍率空转
// ============================================================

/**
 * 空房间（或只有机器人）时的倍率。
 *
 * 【为什么需要】
 * 有真人时，倍率谱来自他们的逃跑阈值 —— 阈值普遍在 1.2–20，
 * 所以无人下注的局会一直落在 1.0–2.0x。用户要求：
 * 「如果没人下单，游戏会一直在低倍率运行，让他再 10x 到 50x 运行」。
 *
 * 【为什么必须与真人局的谱完全隔离】
 * 空房间时没有真实阈值，谱会退化成 defaultSpectrum 的 12 个对数点，
 * 集中在 1–3x。如果把这个谱写进任何跨局状态，真人回来后
 * 谱会被污染（玩家阈值被空房倍率带偏）—— 实测线上 75% 的局无注，
 * 混在一起会让真人局的倍率谱整体上移，玩家感知就是「突然都在 10x 以上」。
 *
 * 所以：空房用独立的分段随机，**不参与谱、不写 history**。
 *
 * @param {{min:number,max:number}} bounds
 * @param {{lo?:number,hi?:number}} cfg 空房配置
 *   lo/hi = 空房倍率的运行区间（默认 10 – 50）
 */
function emptyRoomRate(bounds, cfg) {
  const lo = Math.max(bounds.min, Number(cfg && cfg.lo) || 10);
  const hi = Math.min(bounds.max, Number(cfg && cfg.hi) || 50);
  if (hi <= lo) return clamp(lo, bounds);
  // 对数均匀：10x–50x 之间每一「倍级」出现概率相近，
  // 避免线性插值让 10–20x 挤掉 40–50x
  const l = Math.log(lo);
  const h = Math.log(hi);
  return clamp(Math.exp(l + Math.random() * (h - l)), bounds);
}

// ============================================================
//  第六部分：瞬爆（1x）配额 —— 用户要求「100 局里 10 局瞬间爆炸」
// ============================================================

/**
 * 瞬爆调度器 —— 精确控制「每 N 局里有 K 局是 1x」。
 *
 * 【为什么用配额而不是纯概率】
 * 纯概率（每局 p=10%）在短窗口里波动很大：100 局可能出 4 局也可能 16 局。
 * 用户要的是「每一百局中有 10 局」这种【可预期】的节奏，
 * 管理员在后台预览时也需要看到稳定的数字。
 *
 * 【保证精确的做法】
 * 用「已放次数 / 应放次数」的水位比较：
 *   欠账时必放，够了时跳过。水位由局数线性增长，
 *   于是任意长度 N 的窗口内瞬爆数都 ≈ N × quota，误差不超过 1。
 *
 * 状态极小（两个计数器），重启后从配置的最后水位恢复即可。
 */
function createBoomScheduler(cfg) {
  /**
   * ⚠️ 这里原来写成 `Number(cfg.quota) || 0.10` —— 0 是 falsy，
   *   于是「关掉瞬爆」(quota=0) 会变成默认 10%，实测 500 局仍爆了 50 局。
   *   必须用 ?? 或显式判 undefined。
   */
  const rawQ = cfg && cfg.quota;
  const quota = Math.max(0, Math.min(1,
    rawQ == null || rawQ === '' ? 0.10 : Number(rawQ)));
  const N = Math.max(1, Math.round(Number(cfg && cfg.per) || 100));
  let played = 0;   // 已经过的局数
  let fired = 0;   // 已经触发的瞬爆数

  return {
    /** 这一局要不要瞬爆 */
    next() {
      played += 1;
      const shouldBe = (played / N) * quota * N;   // = played × quota
      if (fired < shouldBe) { fired += 1; return true; }
      // 欠账太多时（quota 很小但 N 很大）偶尔补一次，避免长期欠账
      if (fired < played * quota - 1) { fired += 1; return true; }
      return false;
    },
    /** 无真人时可以整体重置（避免空房累积的水位影响真人局） */
    reset() { played = 0; fired = 0; },
    stats() { return { played, fired, quota, per: N, deficit: (played * quota) - fired }; },
  };
}

// ============================================================
//  第七部分：主入口
// ============================================================

/**
 * 决定这一局的倍率。
 *
 *
 * @param {object} opts
 *   @param {{thr:number}[]} opts.seated  在场真人玩家
 *   @param {{min:number,max:number}} opts.bounds 管理员硬边界
 *   @param {string} [opts.mood='log']   管理员手感（log/flat/spicy）
 *   @param {number[]} [opts.history]    最近的倍率（用于破连续）
 *   @param {number}  [opts.suggestion]   Jev 给的建议倍率（可为 null）
 *   @param {object}  [opts.boom]         {quota, per} 瞬爆配额
 *   @param {object}  [opts.boomState]    持久化的调度器状态
 *   @param {object}  [opts.emptyCfg]     {lo, hi} 空房倍率区间
 *   @param {boolean} [opts.forceBoom]    强制瞬爆（调度器说该爆时）
 * @param {boolean} [opts.skipBoom]      跳过瞬爆（空房时）
 */
function decide(opts) {
  const o = opts || {};
  const bounds = {
    min: Math.max(1, Number(o.bounds && o.bounds.min) || 1.01),
    max: Math.max(1, Number(o.bounds && o.bounds.max) || 120),
  };
  if (bounds.max < bounds.min) bounds.max = bounds.min + 0.5;

  // ---- 空房间：独立路径，不碰谱、不碰 history ----
  const hasReal = !!(o.seated && o.seated.length);
  if (!hasReal) {
    const r = emptyRoomRate(bounds, o.emptyCfg);
    return {
      rate: round2(r),
      source: 'empty',
      spectrumSize: 0,
      escapes: null,
      empty: true,
    };
  }

  // ---- 瞬爆：1x，全灭，一局都不能少 ----
  if (o.forceBoom) {
    return {
      rate: round2(bounds.min),
      source: 'boom',
      spectrumSize: 0,
      escapes: 0,
      boom: true,
    };
  }

  const spectrum = buildSpectrum(o.seated, bounds);
  const weights = shapeWeights(spectrum, o.mood);
  const history = Array.isArray(o.history) ? o.history : [];

  // Jev 给了建议就用它（但必须落在谱上或至少在边界内），否则自己抽
  let rate;
  let source;
  if (o.suggestion != null && isFinite(o.suggestion) && o.suggestion > 0) {
    rate = clamp(o.suggestion, bounds);
    source = 'jev';
  } else {
    const idx = pickIndex(weights);
    const chosen = spectrum[idx];
    /**
     * ⚠️ 抖动范围不能只用「相邻两个谱点之间」。
     *   谱在低倍区密集（实测 1.2–2.1 之间有 4 个点，间隔 0.3），
     *   只在点之间抖动的话抖动范围只有 ±0.15x，相邻两局很容易落在
     *   同一小段里 —— 2 万局实测相邻差 <8% 的比例高达 14.14%。
     *
     *   正确做法：抖动范围用【该点的几何邻域】——
     *   取「到最近的两个不同档的距离」中较大的一边的一半，
     *   让低倍区也能抖出足够宽的连续范围。
     */
    const lo = idx > 0 ? spectrum[idx - 1].rate : chosen.rate;
    const hi = idx < spectrum.length - 1 ? spectrum[idx + 1].rate : chosen.rate;
    const halfSpan = Math.max((chosen.rate - lo), (hi - chosen.rate)) * 0.75 || 0.1;
    const jLo = Math.max(bounds.min, chosen.rate - halfSpan);
    const jHi = Math.min(bounds.max, chosen.rate + halfSpan);
    rate = jHi > jLo
      ? jLo + Math.random() * (jHi - jLo)
      : chosen.rate;
    source = 'fallback';
  }

  rate = clamp(breakConsecutive(rate, history, bounds), bounds);

  return {
    rate: round2(rate),
    source,
    spectrumSize: spectrum.length,
    // 这局有多少人能跑掉（无人时为 null）
    escapes: spectrum.length ? (spectrum.find((r) => Math.abs(r.rate - rate) < 0.01) || {}).escapes : null,
  };
}

function clamp(v, bounds) {
  if (!isFinite(v)) return bounds.min;
  return round2(Math.min(bounds.max, Math.max(bounds.min, v)));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  buildSpectrum, defaultSpectrum, shapeWeights, pickIndex,
  breakConsecutive, decide, emptyRoomRate, createBoomScheduler,
  clamp, round2,
};
