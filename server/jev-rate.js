'use strict';
/**
 * 倍率决策 —— Jev 做庄的新核心
 *
 * ============================================================
 * 【为什么推翻旧设计】
 * ============================================================
 * 旧设计是「Jev 选五档之一，档内 Math.random()」。实测暴露三个问题：
 *
 * 1) max_rate 从没被读过
 *    段边界由在场玩家的逃跑阈值分位数切（p50≈3.4x、p95≈11.8x），
 *    所以段顶天然在 15x 附近 —— 管理员配 max_rate=120 存进 DB，
 *    代码一次都没读。用户实测「最高没超过 15x」就是这么来的。
 *
 * 2) 房间不变 → 倍率范围锁死
 *    同一批人反复玩，阈值不变 → 边界不变 → Jev 只能在 5 个固定区间里挑。
 *    「完全失去游戏体验」。
 *
 * 3) 分布复用把随机性削平
 *    jev_cache_rounds=4 让同一份概率连用 4 局，Jev 每次把权重压在 mid，
 *    段内随机全落在 6.1–6.2。线上 #5517 与 #5518 倍率完全相同就是证据。
 *
 * ============================================================
 * 【新设计：Jev 直接给一个倍率数字】
 * ============================================================
 *   玩家画像 + 管理员配置(min/max/高倍目标)
 *        → Jev 回 {"multiplier": 8.4, "reason": "..."}
 *        → 代码钳到 [min_rate, max_rate]
 *        → flightMs() 算飞行时长
 *
 * Jev 从「五选一」变成「给个数」。它看的是房间语义（谁在、上一局多少、
 * 管理员想要什么），这是查表做不到的。
 *
 * ⚠️ 但采样率意味着大部分局根本不打 API —— 走 fallback。
 *    所以 fallback 同样必须由【管理员配置】驱动，而不是手写权重表。
 *    否则 Jev 挂掉时游戏体验会突变成另一个游戏。
 */

/** 管理员可配的倍率范围。Jev 回来的数字一律钳到这里。 */
function normRange(cfg) {
  const min = Math.max(1, Number(cfg && cfg.minRate) || 1.01);
  const maxRaw = Number(cfg && cfg.maxRate) || 120;
  const max = Math.max(min + 0.5, maxRaw);
  return { min: round2(min), max: round2(max) };
}

/**
 * 高倍局的占比目标 —— 用户在 admin 里配，fallback 用它定分布。
 * 例：{ low: 60, mid: 30, high: 10 } 表示
 *   低于 min×5 的局占 60%，中间占 30%，≥min×5 的高倍局占 10%。
 *
 * 为什么要这个：Jev 自由判断可能给一堆 3x（对用户温和但 boring），
 * 也可能给一堆 50x（刺激但挫败感强）。给一个明确目标才有可控的分布。
 */
function normShape(cfg) {
  const s = (cfg && cfg.shape) || {};
  const lo = Math.max(0, Number(s.low) || 60);
  const mid = Math.max(0, Number(s.mid) || 30);
  const hi = Math.max(0, Number(s.high) || 10);
  const total = lo + mid + hi;
  if (total <= 0) return { low: 60, mid: 30, high: 10 };
  return { low: (lo / total) * 100, mid: (mid / total) * 100, high: (hi / total) * 100 };
}

/**
 * 档位切分（fallback 专用）—— 按【管理员的倍率范围】对数切，不看玩家阈值。
 *
 * ⚠️ 这是与旧设计最本质的差别：边界来自配置，max_rate 终于生效。
 *   旧版按玩家阈值切，所以 max_rate 永远不生效（用户实测「最高没超过 15x」）。
 *
 * 【为什么必须对数切，不能线性切】
 * 倍率在玩家感知里是对数的：1x → 10x → 100x 是「差不多远」的三档，
 * 不是 1 → 61 → 121。线性切会切出 low = 1.01–17.67x 这种跨度 17 倍的档，
 * 结果「低倍局」里混着 1.42x 和 15.19x，玩家根本感觉不到差别，
 * 同档连击统计还会算出「7 局连续低倍」。
 *
 * 线性版本实测：同档最长连击 7 局，被标为「会被看出规律」。
 * 对数切之后每档跨度约 5 倍（1–5 / 5–20 / 20–120），同一档内的倍率
 * 玩家感受一致，连击才真正对应「看起来像连着几局都差不多」。
 */
function buildZones(range, shape) {
  // 对数切点：min×4 和 min×16。跨度固定（4x、4x），与 max 无关。
  // 范围窄时（如 1.01–2x）放不下两个切点，按比例退让，保证三档都非空。
  const span = range.max / range.min;
  let midCut;
  let hiCut;
  if (span < 8) {
    // 跨度不足 8 倍：两个对数切点会挤在一起，退回线性三等分
    midCut = range.min + (range.max - range.min) * 0.34;
    hiCut = range.min + (range.max - range.min) * 0.67;
  } else {
    // 跨度够：固定 4 倍一档。hiCut 若越过 max（max < min×16），按比例压回来
    midCut = range.min * 4;
    hiCut = Math.min(range.max, range.min * 16);
    // 但仍要给 high 段留出至少 5% 的宽度，否则高倍档退化成空段
    hiCut = Math.max(hiCut, midCut + (range.max - range.min) * 0.05);
  }
  const zones = [
    { key: 'low',  min: range.min, max: midCut },
    { key: 'mid',  min: midCut,   max: hiCut },
    { key: 'high', min: hiCut,    max: range.max },
  ];
  // 逐段收敛：防倒挂（max <= min 时把 max 顶上去）
  let prev = range.min;
  for (const z of zones) {
    z.min = round2(Math.max(z.min, prev));
    z.max = round2(Math.max(z.max, z.min + 0.01));
    prev = z.max;
  }
  return zones;
}

/**
 * 在 [min,max) 内取值，power 越大越偏向【下界】（小倍率）。
 *
 * ⚠️ power 必须随档宽调整：high 段跨度 104x（16–120），若和 low 段
 *   （跨度 4x）用同一个 power，high 段的取值会整体堆在 30–100x，
 *   实测 high 档占比从目标 10% 涨到 19%。按档宽归一化后才可比。
 */
function skewed(rng, min, max, power = 1.35) {
  if (!(max > min)) return round2(min);
  const u = Math.random();
  return round2(min + (max - min) * Math.pow(u, power));
}

/** 档内取值的偏置强度：档越宽，power 越大（否则高倍段会吸走过多局） */
function zonePower(z) {
  const span = (z.max - z.min) / Math.max(0.01, z.min);
  return 1.2 + Math.min(1.1, Math.log10(Math.max(1, span)) * 0.5);
}

/**
 * 连续性破除 —— 直击「连着几局都是 6x」的观感问题。
 *
 * 用户实测 #5519–#5515 = 4.43 6.17 6.17 6.14 6.07，四个连续局几乎一样。
 * 根因是分布复用（jev_cache_rounds=4）+ 段内窄区间。
 *
 * ⚠️ 这个函数对【任何倍率来源】生效 —— 真实 Jev 给的数字也要过这里。
 *    否则 80% 走 fallback 的局有连续性修正、20% 走 Jev 的局没有，
 *    两种手感会不一致，反而更容易被看出「哪几局是 AI 打的」。
 *
 * @param {number} rate    本局原始倍率
 * @param {number[]} recent 最近的倍率（升序索引，越新越靠后）
 * @param {{min,max}} range
 * @param {object[]} zones 档位定义
 * @param {object} shape 各档目标占比（换档时按权重反向选择）
 * @returns {number} 修正后的倍率
 */
function antiPattern(rate, recent, range, zones, shape) {
  const last = recent.length ? recent[recent.length - 1] : null;
  if (!last || !isFinite(last) || last < range.min) return clamp(rate, range);

  /**
   * ① 挨太近（±12% 内）→ 强制朝远离上一局的方向重抽。
   *
   * ⚠️ 第一版的严重 bug：重抽区间的上界写成了 range.max（120x）。
   *   于是「躲开创低值」的那一半会把倍率一路拉到 50–100x，
   *   high 档凭空从 9.9% 涨到 15.7%。20 万局诊断：
   *     纯抽档          low 60.1% / mid 30.0% / high  9.9%  ← 完全符合配置
   *     + antiPattern   low 50.3% / mid 34.0% / high 15.7%  ← 偏差全在这一条
   *   修正：重抽只在【当前档内】做，让档位分布保持不变。
   */
  const ratio = rate / last;
  if (ratio > 0.88 && ratio < 1.14) {
    const z0 = zones.find((x) => rate >= x.min && rate <= x.max) || zones[0];
    const goUp = Math.random() < 0.5;
    const lo = goUp ? Math.min(z0.max, rate * 1.18) : z0.min;
    const hi = goUp ? z0.max : Math.max(z0.min, rate * 0.85);
    if (hi > lo) rate = skewed(0, lo, hi, 1.1);
    else rate = goUp ? z0.max : z0.min;
  }

  /**
   * ② 连击破除 —— 线性切档版本实测「同档最长连击 7 局」，
   *    玩家会觉得「最近一直在低倍」。对数切之后每档宽度约 4 倍，
   *    真正的问题变成「连续 3 局都落在同一档」。
   *
   * ⚠️⚠️ 这一条我改错了两次，20 万局诊断才定位到真因：
   *
   *   第 1 版「连击就换档」→ high 从 9.9% 涨到 19%（凭空多出一截）
   *   第 2 版「连击把该档权重压到 0.05」→ high 13%，仍超标
   *   第 3 版「压到 0.02」→ high 13.1%，完全没改善
   *
   *   诊断数据：规则②触发率 14.3%，而 low 目标 60% 却只落到 51%。
   *   缺失的 9% 正好 = 14.3% × 60%。也就是说每 100 局有 14 局
   *   把 low 挤掉并按 30:10 让给 mid/high —— 每次都白送 high 3.5%。
   *
   *   【正解】连击**不应该改档位**。「连着三局都是低倍」本身不刺眼，
   *   刺眼的是「连着三局都是 6.17x」这种【档内数值几乎相同】。
   *   档位是粗粒度的语义层（低/中/高倍局），要保持配置的分布；
   *   规则①（±12% 数值去重）已经解决了细粒度的重复。
   *   所以这里只做：连击时把取值推到【本档的另一端】，
   *   让 6.17x 变成 1.3x 或 3.8x，而不是变成 25x。
   */
  if (recent.length >= 2) {
    const z = (v) => zones.find((x) => v >= x.min && v <= x.max);
    const cur = z(rate);
    const a = z(recent[recent.length - 1]);
    const b = z(recent[recent.length - 2]);
    if (cur && a && b && cur.key === a.key && a.key === b.key) {
      const near = Math.abs(rate - last) / Math.max(0.01, last);
      /**
       * ⚠️ 推到【固定分位】也不行 —— 1.62x/3.43x（low 档的 20%/80% 分位）
       *   各自出现 20 次，又成了新热点。分位是常量，常量必然被反复命中。
       *   正确做法：分位 + 随机扰动，扰动范围 ±8% 档宽，
       *   既离开上一局又不产生任何固定热点。
       */
      if (near < 0.3) {
        const w = (cur.max - cur.min) * 0.08;
        const q1 = cur.min + (cur.max - cur.min) * 0.20 + (Math.random() * 2 - 1) * w;
        const q3 = cur.min + (cur.max - cur.min) * 0.80 + (Math.random() * 2 - 1) * w;
        const opts = [q1, q3].filter((v) => Math.abs(v - last) / Math.max(0.01, last) > 0.15);
        if (opts.length) rate = opts[Math.floor(Math.random() * opts.length)];
      }
    }
  }
  return clamp(rate, range);
}

/**
 * fallback 倍率 —— Jev 不可用时用。
 *
 * 【关键设计】不查任何手写权重表，直接按管理员配的 shape 比例抽档，
 * 档内按 1/x 偏置取值。所以 Jev 挂掉时，行为仍在管理员配置的意图之内，
 * 只是少了「读懂房间」那份细腻。
 *
 * @param {object} rangeCfg {minRate, maxRate}
 * @param {object} shapeCfg {low, mid, high} 目标占比
 * @param {number[]} recent 最近的倍率（用于连续性破除）
 */
function fallbackRate(rangeCfg, shapeCfg, recent = []) {
  const range = normRange(rangeCfg);
  const shape = normShape(shapeCfg);
  const zones = buildZones(range, shape);

  // 抽档
  let r = Math.random() * 100;
  let z = zones[0];
  for (const c of zones) { r -= shape[c.key]; if (r <= 0) { z = c; break; } }

  const raw = skewed(0, z.min, z.max, zonePower(z));
  return antiPattern(raw, recent, range, zones, shape);
}

function clamp(v, range) {
  if (!isFinite(v)) return range.min;
  return round2(Math.min(range.max, Math.max(range.min, v)));
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  normRange, normShape, buildZones, skewed, zonePower, fallbackRate, antiPattern,
  clamp, round2,
};
