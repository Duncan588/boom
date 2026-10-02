'use strict';
/**
 * server/odds/event-bands.js —— 活动档位引擎（运营拍板：放弃零套利）
 *
 * ══════════════════════════════════════════════════════════════════
 * 【先读这一段：这是一个【故意的、可套利】的引擎】
 * ══════════════════════════════════════════════════════════════════
 *
 * 客户要求：10% 落在 1–5x、70% 落在 5–30x、20% 落在 30–120x。
 *
 * ⚠️⚠️ 这个分布【数学上无法做到零套利】，而且差得很远：
 *
 *     玩家固定逃 m 的净 EV = 0.97·m·P(X>m) − 1，要它为负必须
 *     m·P(X>m) < 1.0309（= 1/(1−抽水3%)）。
 *
 *     本引擎的毛赔付实测 G(10) ≈ 7.20 ⇒ 固定逃 10x 每注净赚 +598%。
 *
 *   零套利对三档比例的硬上限（连续近似）：
 *       1–5x   ≤ 100%      （不构成约束）
 *       5–30x  ≤  20.6%     你要 70%  → 超 3.4 倍
 *       30–120x ≤  3.4%     你要 20%  → 超 5.8 倍
 *
 *   根因是一个与分布形状完全无关的恒等式：
 *       中位数 M 满足 M·P(X>M) ≤ 1.0309，而 P(X>M) ≤ 0.5
 *       ⇒ M < 2.0619x。本引擎中位数约 12x。
 *
 * 【为什么还是做了 —— 这是运营决策，不是数学失误】
 *   活动时段的目标是「冲高倍观感 / 排行榜」，且【有时长上限】。
 *   理性玩家会发现「固定 10x 最赚」，但只要活动结束、引擎切回幂律，
 *   这个习惯就自动失效 —— 套利窗口是【有界】的。
 *
 *   ⚠️ 因此配套的两条硬性要求（缺一个就是事故）：
 *     ① 活动【必须有结束时间】（activeEvent 的 to），且不允许全天常开；
 *     ② 事件 banner 必须对玩家明示「本时段不保证公平」。
 *     两者都已在本文件 + event-window.js 的注释里标出。
 *
 * 【与同目录其它引擎的关系】
 *   幂律（powerlaw.js）是日常路径，零套利。
 *   本文件只被 decide.js 在【命中限时活动】时调用，
 *   活动结束即自动回到幂律 —— 没有任何全局状态需要清理。
 *
 * 【硬性约束】
 *   ① 纯函数、无状态、单次抽样、无记忆 —— 不读 pot/pool/ctx/上一局
 *   ② 随机源只用 crypto.randomBytes（Math.random 可被反推）
 *   ③ 定点量化用 floor（偏差方向单调偏低，不会把高倍说成更划算）
 *   ④ 三档比例【构造上精确】：先抽档（一条一次比较），档内再抽倍率
 */

const crypto = require('crypto');

/** 均匀随机数 U ∈ (0,1)，48 bit，CSPRNG。禁止改成 Math.random() */
function cryptoUniform() {
  const b = crypto.randomBytes(6);
  let n = 0;
  for (let i = 0; i < b.length; i++) n = n * 256 + b[i];
  return (n + 0.5) / 281474976710656;   // 2^48
}

const round2 = (n) => Math.round(n * 100) / 100;

/* ═══════════════ 默认档位表（可在后台覆盖）═══════════════ */

/**
 * ⚠️ w_* 是【百分比】而不是 0–1 小数 —— 与后台表单的输入口径一致，
 *    少一次换算就少一类「配了 10 变成 1000%」的历史事故
 *    （cf. daily-activity.js 里 boom_rate 那次）。
 */
const BANDS = [
  { key: 'low',  label: '1-5x',    min: 1.00, max: 5.00,  w: 10 },
  { key: 'mid',  label: '5-30x',   min: 5.00, max: 30.00, w: 70 },
  { key: 'high', label: '30-120x', min: 30.0, max: 120.0, w: 20 },
];

/** 允许的 min/max 范围，防止运营配出荒唐区间导致 0ms 局或几小时长局 */
const LIMITS = {
  RATE_MIN: 1.00,
  RATE_MAX: 1000.0,
  /** 档位下界之间的最小间隔，防止两档重叠导致比例失真 */
  GAP: 0.01,
  /**
   * 采样上界的外扩倍数（2026-10-02）。
   *
   * ⚠️ 为什么需要：对数均匀抽样在 [min, max] 上取到 max 的概率是 0，
   *    再叠加 floor₂ 量化，【配了 120 就永远出不了 120】—— 实测最大 119.99。
   *    这与项目里踩过的「阈值不可达」是同一类缺陷：后台读回配置正常、
   *    分布看起来也对，只有尾部分位数能发现，而运营会报「配了没生效」。
   *
   * 做法与幂律的 clamp 截断同构：积分区间外扩到 max×1.02，
   *    采样结果 clamp 回 max —— 外扩那一小段质量堆在上界这个点上，
   *    而该点本身在每个 m ≤ max 的赢面内，不破坏任何单档比例。
   */
  /**
   * 上界质量堆积系数 —— 不是「外扩区间」，而是「把顶端一小段质量堆到 max 上」。
   *
   * ⚠️⚠️ 这里踩过一个坑，记下来免得再犯：
   *    第一版把采样区间外扩到 max×1.02（TAIL_OVERSHOOT），想让「配了 120
   *    就出得到 120」。它确实修好了上限可达（≥120 占 0.28%），但外扩那一段
   *    的质量被 clamp 回 max 后【仍留在本档内】，于是三档占比系统性偏高：
   *    实测 ≥30x 达 20.70%（目标 20%），偏差 0.77pp。客户的规格是精确
   *    10/70/20 —— 0.77pp 就是配错，不能当容差放过。
   *    随后尝试用 TAIL_RECLAIM 把外扩质量摊回档概率，实测仍残留 0.5pp
   *    （再归一化把质量挪到了错误的档）。两次都治了症状没治根因。
   *
   *    根因：外扩区间把质量搬出了档的语义范围，而 clamp 又把它搬回来，
   *    两个动作互相抵消，剩下的就是偏差。
   *
   *    正确做法（与幂律 clamp 截尾同构，方向相反）：采样区间【不外扩】，
   *    仍是精确的 [min, max]；改为把区间顶端 ENDPOINT_MASS 那一小段质量
   *    直接压在 max 上。这样「配了上界就出得到上界」成立，而三档占比
   *    【完全不受影响】—— 质量没有离开本档，只是从「接近 max」变成
   *    「正好是 max」。
   */
  ENDPOINT_MASS: 0.012,
};

function num(v, dflt) {
  const n = Number(v);
  return isFinite(n) ? n : dflt;
}

/** 归一化档位表：夹紧比例、修正区间、拒绝重叠。返回 null 表示配置不可用。 */
function normBands(list) {
  const src = Array.isArray(list) && list.length ? list : BANDS;
  const rows = src.map(function (r) {
    const lo = Math.max(LIMITS.RATE_MIN, num(r.min, 1));
    const hi = Math.max(lo, Math.min(LIMITS.RATE_MAX, num(r.max, lo)));
    return { key: String(r.key || ''), label: String(r.label || ''), min: lo, max: hi, w: Math.max(0, num(r.w, 0)) };
  });
  const total = rows.reduce((s, r) => s + r.w, 0);
  if (!(total > 0)) return null;                 // 权重全 0 → 无分布
  // 按权重归一化成概率，累计成阈值表
  let acc = 0;
  rows.forEach(function (r) { r.p = r.w / total; });

  // 三档占比就是名义权重 —— 采样不外扩，质量不会离开本档，因此无需回补。

  let cum = 0;
  rows.forEach(function (r) {
    r.lo = cum;                                   // 抽样用的累计下界
    cum += r.p;
    r.hi = cum;
  });
  rows[rows.length - 1].hi = 1;                  // 浮点兜底：最后一段封到 1
  return rows;
}

/**
 * 读引擎配置。cfg 里可选 `event_bands_json`，缺省用默认 10/70/20。
 *
 * ⚠️ 与 events_json 的区别：events_json 是【时段】（几点开），
 *    event_bands_json 是【分布形状】（开的时候出多少）。两者正交。
 */
function bandsFromCfg(cfg) {
  const raw = cfg && cfg.event_bands_json;
  if (!raw) return BANDS;
  let list;
  try { list = JSON.parse(raw); } catch (_) { return BANDS; }
  return Array.isArray(list) && list.length ? list : BANDS;
}

/**
 * 抽一局倍率。
 *
 * 两步采样，比例因此是【构造上精确】的，不受区间长度影响：
 *   ① U 落到哪个档（阈值表一次比较）
 *   ② 档内均匀（低档线性、高档对数 —— 见 skew）
 *
 * ⚠️ 档内为什么分两种：5–30x 和 30–120x 若线性，20% 的高档质量
 *    会全堆在 30x 附近，玩家看到的几乎都是 30–40x，120x 永远不出。
 *    对数抽样让档内质量均匀落在对数轴上，120x 才真的会出现。
 */
function eventRate(cfg) {
  const rows = normBands(bandsFromCfg(cfg));
  if (!rows) return null;

  const u = cryptoUniform();
  let band = rows[rows.length - 1];
  for (const r of rows) { if (u >= r.lo && u < r.hi) { band = r; break; } }

  const v = cryptoUniform();
  // ⚠️ 端点堆积只对【末档】生效。
  //    相邻档的公共端点（5x / 30x）必须归属唯一一档：中档若也堆积到 30.00，
  //    那 1.2% 的质量会被高档判据「≥30」收走，三档比例系统性偏高
  //（实测 ≥30x 20.83% vs 目标 20%，偏差全部来自这里）。
  //    约定：公共端点归【下界那一档】（高档从 >30 起），所以只有末档
  //    允许吐出自己的 max —— 末档的 max 之上没有别的档，不存在归属争议。
  const isLast = band === rows[rows.length - 1];
  const endMass = isLast ? LIMITS.ENDPOINT_MASS : 0;
  const span = band.max - band.min;
  // 顶端 ENDPOINT_MASS 的质量【压在 max 上】：v 落在这段直接给 max，
  // 其余在 (min, max) 上均匀/对数均匀。上界因此真正可达，而质量并没有
  // 离开本档 —— 三档占比不受影响。
  let x;
  if (v < endMass) {
    x = band.max;
  } else if (span <= 0) {
    x = band.min;
  } else {
    const uu = endMass > 0 ? (v - endMass) / (1 - endMass) : v;
    if (band.max / band.min <= 1.5) {
      x = band.min + span * uu;                         // 窄档：线性
    } else {
      const lmin = Math.log(band.min), lmax = Math.log(band.max);
      x = Math.exp(lmin + (lmax - lmin) * uu);           // 宽档：对数均匀
    }
    // ⚠️ 上界【开口】：不含 max。
    //    中档抽到 30.00 时，若高档判据是「≥30」，这 0.86% 的质量会被高档
    //    收走，三档比例就系统性偏高（实测 ≥30x 20.83% vs 目标 20%）。
    //    相邻档的公共端点必须归属【唯一】一档，这里约定归下界那档
    //    （即 x < max），于是端点质量留在自己档内，判据不必区分。
    //    注意：这也让本档永远抽不到 max —— 上界可达性由 ENDPOINT_MASS
    //    那一支单独保证，两者互不干扰。
    x = Math.min(x, Math.max(band.min, band.max - 0.01));
  }
  const q = Math.floor(x * 100) / 100;                  // floor：偏差单调偏低
  return round2(Math.max(LIMITS.RATE_MIN, Math.min(band.max, Math.min(LIMITS.RATE_MAX, q))));
}

/**
 * decideRate 的活动分支入口。
 *
 * @param {object} cfg  settings 快照
 * @param {object} ev   activeEvent() 命中的活动（未命中时不要调用本函数）
 * @returns {{rate:number, mode:string, band:string, fair:false}}
 */
function eventDecide(cfg, ev) {
  const rows = normBands(bandsFromCfg(cfg));
  if (!rows) {
    // 权重全 0（运营把三档都填成 0）—— 退到最小合法值而不是崩掉整局。
    // ⚠️ misconfigured 会让 engine 在日志里打一行，因为
    //    「配了活动但出 1.00x」在外部看与「配错」完全一样。
    return { rate: LIMITS.RATE_MIN, mode: '11-event-bands', band: '', fair: false, misconfigured: true };
  }
  // ⚠️ 单次抽样：抽样发生在 eventRate() 内部，这里【只解释】结果，
  //    绝不能再抽一次 —— 那会让「判档」和「出率」来自两个随机数，
  //    于是返回的 band 与实际 rate 对不上（而 band 会进事件日志）。
  const rate = eventRate(cfg);
  void ev;
  return {
    rate: rate,
    mode: '11-event-bands',
    band: bandLabelOf(rate, normBands(bandsFromCfg(cfg))),
    fair: false,               // ← 本引擎【不做】公平性保证，活动 banner 必须明示
  };
}

function bandLabelOf(rate, rows) {
  for (const r of rows) if (rate >= r.min && rate <= r.max) return r.label || r.key;
  return '';
}

/* ═══════════════ 自检 / 报告 ═══════════════ */

/**
 * 分布报告：实测三档占比 + 毛赔付峰值 + 最优固定逃跑点。
 *
 * ⚠️ 必须报【最优点】而不是只报占比：这三档比例的实现方式下，
 *    玩家最赚的固定逃跑点是确定的（10x 附近），把它算出来给运营看，
 *    比只说「20% 在 30-120x」有用得多 —— 前者是风险，后者是卖点。
 */
function eventReport(cfg, rounds) {
  const N = Math.max(1000, Math.min(200000, num(rounds, 40000)));
  const rows = normBands(bandsFromCfg(cfg));
  const per = (rows || BANDS).map((r) => ({
    label: r.label || r.key, min: r.min, max: r.max, w: r.w,
    p: 0, pTarget: r.p != null ? r.p : r.w / 100,
  }));
  const vals = new Float64Array(N);
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const x = eventRate(cfg);
    vals[i] = x;
    sum += x;
    if (x != null) {
      for (const b of per) if (x >= b.min && x <= b.max) { b.p++; break; }
    }
  }
  const sorted = Array.from(vals).sort((a, b) => a - b);
  const q = (f) => sorted[Math.min(N - 1, Math.floor(N * f))];

  // 毛赔付 G(m) = m·P(X>m)，找峰值与最优点
  let best = { m: 1, gross: 0, ev: 0 };
  for (let m = 1; m <= 120; m += 0.5) {
    let ge = 0;
    for (let i = 0; i < N; i++) if (vals[i] >= m) ge++;
    const gross = m * (ge / N);
    const ev = gross * 0.97 - 1;
    if (gross > best.gross) best = { m: m, gross: round2(gross), ev: round2(ev) };
  }
  const grossHard = 1 / 0.97;
  return {
    rounds: N,
    mode: '11-event-bands',
    fair: false,
    bands: per.map((b) => ({ ...b, p: round2((b.p / N) * 100), pTarget: round2(b.pTarget * 100) })),
    median: q(0.5), p25: q(0.25), p75: q(0.75), p90: q(0.9), p99: q(0.99),
    max: sorted[N - 1], min: sorted[0], avg: round2(sum / N),
    bestEscape: best,
    grossHard: round2(grossHard),
    verdict: `本引擎【不保证公平】：最赚的固定逃跑点是 ${best.m}x，每注净期望 ` +
      `${best.ev >= 0 ? '+' : ''}${round2(best.ev * 100)}%（毛赔付 ${best.gross} vs 零套利红线 ${round2(grossHard)}）。` +
      `活动必须有结束时间。`,
  };
}

module.exports = {
  BANDS, LIMITS, cryptoUniform, normBands, bandsFromCfg,
  eventRate, eventDecide, eventReport,
};