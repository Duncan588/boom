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

  /**
   * ⚠️⚠️ 谱必须【延伸到 max_rate】，不能停在最高玩家阈值。
   *
   *   这里原来只把「玩家阈值 + 阈值中点」放进谱，于是谱的最大值
   *   恒等于房间里最高的那个阈值（实测 20x）。管理员配 max_rate=125，
   *   但谱只到 20 —— 于是 ≥20x 的局【实测占比 0.0%】，
   *   ≥50x 也是 0.0%。max_rate 形式上生效、实际完全没用。
   *
   *   这和 v1「段顶只到 15x、max_rate=120 从未被读」是同一个病，
   *   只是换了位置。玩家看不到 20x 以上的局，就永远等不到名场面。
   *
   *   正确做法：高倍段（超过最高阈值之后）由配置的对数阶梯补齐。
   *
   * ⚠️⚠️ 这里有个【语义陷阱】，我第一次写反了：
   *   高倍局的 escapes 是【10/10 全员】，不是 0。
   *   因为 escapes 的含义是「这一局有多少人【跑掉了/能跑掉】」——
   *   倍率 32x 时，所有人都等到了比��的阈值才跑，他们【都赢了】；
   *   倍率越高，【留下被爆的人越少】。
   *
   *   所以高倍局的真实语义是「绝大多数人能跑掉，留下的人全输」，
   *   这正是高倍局该有的爽点。真正「全灭」的是【低倍局】
   *   （倍率 1.2x 时一个都跑不掉，escapes=0）。
   */
  const top = thrs[thrs.length - 1];
  if (bounds.max > top * 1.05) {
    // 对数阶梯：top → maxRate，按 1.6 倍一档
    // 用 1.6 而不是更密，因为高倍区本来就该稀疏（越刺激越少见）
    const ladder = [top];
    let v = top;
    while (v < bounds.max) {
      v *= 1.6;
      ladder.push(Math.min(v, bounds.max));
      if (ladder.length > 24) break;   // 安全上限
    }
    // 阶梯点全部「没人能跑掉」
    for (let i = 1; i < ladder.length; i++) {
      if (ladder[i] > top * 1.001) cand.push(ladder[i]);
    }
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
 *
 * ⚠️⚠️ 权重必须按【倍率的 log 位置】算，不能按【数组下标位置】。
 *
 *   原来写的是 `pos = i / (len - 1)` —— 等分下标。
 *   但谱点在对数刻度上极不均匀：低倍区 20 个点挤在 1.2–20x，
 *   高倍区只有 5 个点摊在 20–125x。等分下标会让低倍区拿走
 *   几乎全部权重（20/25 = 80% 的点都在前 80% 区间内）。
 *
 *   实测：谱修好后（延伸到 125x）≥50x 的局只有 0.2%（log）——
 *   谱里明明有 50x、80x、125x 这些点，但它们的下标接近末尾，
 *   权重 (1-0.92)^1.6 ≈ 0.02，几乎抽不到。
 *
 *   正确做法：pos = (ln(rate) - ln(min)) / (ln(max) - ln(min))。
 *   这样「权重随倍率对数递减」才是真的按倍率分布，
 *   谱点疏密不影响权重分配。
 */
function shapeWeights(rows, mood, bounds) {
  if (!rows.length) return [];
  const betas = {
    log: 1.6,      // 强偏向低倍（默认）
    flat: 0.5,     // 各段接近均匀
    spicy: 0.85,   // 偏向高倍
  };
  const beta = betas[mood] || betas.log;

  const lo = bounds && bounds.min > 0 ? Math.log(bounds.min) : Math.log(rows[0].rate);
  const hi = bounds && bounds.max > 0 ? Math.log(bounds.max) : Math.log(rows[rows.length - 1].rate);
  const span = (hi - lo) || 1;

  return rows.map((r) => {
    const pos = Math.max(0, Math.min(1, (Math.log(Math.max(1e-9, r.rate)) - lo) / span));
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
//  第六部分：瞬爆（1x）—— 纯独立随机
// ============================================================

/**
 * 决定这一局要不要瞬爆（1x 全灭）。
 *
 * ⚠️⚠️ 这里原来是「配额调度器」，方向搞反了，用户明确纠正：
 *   「你这样弄得不就用户不就可以推算出来了吗？我要真随机，
 *     而不是每十局第一次就爆，要百分百随机」
 *
 *   配额水位（已放/应放）的行为是：
 *     第 1 局欠账 → 爆；第 2-9 局不欠 → 不爆；第 10 局又欠账 → 爆……
 *   于是「每隔 9-10 局爆一次」的节奏直接暴露给玩家。
 *   实测 1000 局：第 1 局就爆、第 10 局又爆、第 20 局又爆 ——
 *   这种规律一眼就能推算，配额是反效果。
 *
 * 【正确的做法：每局独立掷骰】
 *   `Math.random() < p` 就是完整的随机 —— 每一局与之前的历史完全独立。
 *   长期频率收敛到 p（期望 100 局 10 局），但任何有限窗口内
 *   都不会呈现固定节奏。玩家能观察到的只是「偶尔有几局全灭」，
 *   推不出下一局什么时候爆。
 *
 * 为什么不「保证恰好 10 局」：那正是可推算的来源。
 * 随机二项分布的波动（100 局可能是 3 局也可能 18 局）不可被预测，
 * 这恰恰是用户要的。
 *
 * @param {number} p 瞬爆概率，0–1。默认 0.10
 * @param {number} [rng] 注入随机源（测试用）
 */
function rollBoom(p, rng) {
  const rawP = p;
  const prob = Math.max(0, Math.min(1,
    rawP == null || rawP === '' ? 0.10 : Number(rawP)));
  if (prob <= 0) return false;
  if (prob >= 1) return true;
  return (rng || Math.random)() < prob;
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
 *   @param {object}  [opts.boom]         {p} 瞬爆概率（0–1），每局独立掷骰
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

  // ---- 瞬爆：1x，全灭。纯独立随机，绝不按节奏配额 ----
  // ⚠️ 传 forceBoom=true 等价于「这局已判定要爆」，保留给测试和
  //    管理员手动强制用；正常路径由下面的 rollBoom 自己掷骰。
  if (o.forceBoom || rollBoom(o.boom && o.boom.p)) {
    return {
      rate: round2(bounds.min),
      source: 'boom',
      spectrumSize: 0,
      escapes: 0,
      boom: true,
      /**
       * ⚠️ 下一局的【最低倍率】：瞬爆是全灭，玩家刚被全员吃掉。
       * 下一局又落在 1.0x 附近的话，两局连着「几乎全灭」，
       * 观感上就是系统在故意坑人。
       *
       * 实测不设下限时相邻差 <8% 的比例升到 1.37%。
       * 这里返回 2.5 倍的 min 作为下限，由调用方施加到下一局。
       * （1.01x → 下一局至少 2.53x，足够拉开观感）
       */
      nextFloor: round2(Math.min(bounds.max, bounds.min * 2.5)),
    };
  }

  const spectrum = buildSpectrum(o.seated, bounds);
  const weights = shapeWeights(spectrum, o.mood, bounds);
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

  // 上一局是瞬爆 → 本局有最低倍率（见 boom 分支的 nextFloor 说明）
  const floor = Number(o.floor) > 0 ? Number(o.floor) : 0;
  if (floor > rate) {
    /**
     * ⚠️⚠️ 不能直接 `rate = floor` —— 那样 floor 本身成了固定倍率。
     *
     *   实测：nextFloor = 1.01 × 2.5 = 2.53，于是「瞬爆后的那一局」
     *   必然是 2.53x。2 万局里 233 次相邻差 = 0%，
     *   全部是 2.53 → 2.53。玩家一眼就能看到「爆完下一局总是 2.53」。
     *   这和 v1 把倍率推到固定分位（1.62x 出现 20 次）是同一个错：
     *   **任何常量都会变成热点**。
     *
     *   正确做法：给 floor 加随机浮动，让它是「至少不低于」而不是「正好等于」。
     *   浮动范围 [floor, floor×1.45]，再夹到 bounds。
     */
    const jittered = floor * (1 + Math.random() * 0.45);
    rate = round2(Math.min(bounds.max, Math.max(floor, jittered)));
  }

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
  breakConsecutive, decide, emptyRoomRate, rollBoom,
  clamp, round2,
};
