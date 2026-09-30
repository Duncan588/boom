'use strict';
/**
 * 自适应倍率分段 —— Jev 的「答案空间」
 *
 * 【为什么不用后台那张百分比表】
 * 原来的 odds_table_json 是「倍率区间 + 占比%」，例如 1.5x 以下 10%、1.5–10x 40%。
 * 但 Jev 不做算术（官方文档 § Math and Numbers），而「这一段大概让几成人赢」
 * 必须由代码算出来。所以分段边界改成【贴着在场玩家的阈值分位数】切：
 *
 *   instant  1.00 – p05*k     全灭
 *   low      p05*k – p50*k    赢约一半
 *   mid      p50*k – p80*k    赢约两成
 *   high     p80*k – 高段顶    专喂赌高倍型
 *   top      高段顶 – natural  名场面
 *
 * 于是每个段的语义是确定的，后台那张百分比表退化为两件事：
 *   1) Jev 不可用时的降级分布基线
 *   2) 后台预览的对照
 *
 * 【k = edgeScale】
 * 压低边界 → 同样的倍率覆盖更多阈值 → 赢面上升。这是代码侧唯一能调赢面的旋钮。
 */

const { BAND_KEYS, BAND_LABEL } = require('./jev-personas');

function round2(n) { return Math.round(n * 100) / 100; }

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  const s = sortedAsc;
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

/**
 * @param {number[]} thresholds 在场玩家的逃跑阈值（升序）
 * @param {object} act  活动段配置 { active, maxRate }
 * @param {number} edgeScale 人格缩放
 * @returns {{key,min,max,label}[]}
 */
function buildBands(thresholds, act, edgeScale = 1) {
  const thr = [...thresholds].sort((a, b) => a - b);
  const k = edgeScale || 1;
  const p05 = Math.max(1.05, quantile(thr, 0.05) * k);
  const p50 = Math.max(p05 + 0.3, quantile(thr, 0.50) * k);
  const p80 = Math.max(p50 + 0.5, quantile(thr, 0.80) * k);
  const maxThr = thr[thr.length - 1] || p80;
  const natural = Math.max(p80 + 1, maxThr * 1.5 * k);

  /**
   * 活动段上限：只压缩【顶部】，且按比例缩进，绝不制造倒挂段。
   *
   * ⚠️ 不能写成 top = min(natural, actMax)：房间里赌高倍型阈值 20x 时 p80≈17x，
   *   而 actMax=25 只比 p80 高 1.25 倍 —— 直接取 25 会把 high 和 top
   *   压成同一段，实测 mid/high/top 占比全变 0%、全场只能赢 14%。
   *   按比例缩进才能保住每段的相对宽度。
   */
  let top = natural;
  if (act && act.active && act.maxRate > 0 && natural > act.maxRate) {
    top = round2(p80 + (natural - p80) * Math.max(0.05, (act.maxRate - p80) / (natural - p80)));
  }

  const raw = [
    { key: 'instant', min: 1.00, max: Math.min(1.50, p05) },
    { key: 'low', min: Math.min(1.50, p05), max: p50 },
    { key: 'mid', min: p50, max: p80 },
    { key: 'high', min: p80, max: round2(p80 + (top - p80) * 0.5) },
    { key: 'top', min: round2(p80 + (top - p80) * 0.5), max: top },
  ];

  // 逐段收敛：保证 min < max 且单调递增。倒挂的段收成上一段的上界。
  const out = [];
  let prevMax = 1.00;
  for (const b of raw) {
    const min = Math.max(b.min, prevMax);
    const max = Math.max(b.max, min + 0.01);
    out.push({ key: b.key, min: round2(min), max: round2(max) });
    prevMax = max;
  }
  return out.map((b) => ({ ...b, label: `${BAND_LABEL[b.key]} ${b.min.toFixed(2)}–${b.max.toFixed(2)}x` }));
}

/** 段内取具体倍率（代码随机 —— Jev 只选段，不算数） */
function rateInBand(bands, key) {
  const b = bands.find((x) => x.key === key);
  if (!b || !isFinite(b.min) || !isFinite(b.max) || b.max <= b.min) return null;
  return round2(b.min + Math.random() * (b.max - b.min));
}

/**
 * 降级分布：Jev 挂了时的兜底段权重。
 *
 * ⚠️ 人格必须参与，否则 standard 和 bodhisattva 走同一条降级路径，
 *    两者在 Jev 不可用时表现几乎一样（实测赢面 61.8% / 59.6%，方向完全反了）。
 * 菩萨 = 把 instant 的权重挪给 mid/high（更多人赢）。
 *
 * 个性偏置表按在场构成加权 —— 不能用固定的全局表，
 * 否则「一屋子赌高倍」和「一屋子稳健」会打出同一种手感。
 */
const AR_BAND_BIAS = {
  steady: { instant: 0.02, low: 0.48, mid: 0.28, high: 0.16, top: 0.06 },
  greedy: { instant: 0.06, low: 0.50, mid: 0.26, high: 0.13, top: 0.05 },
  high_chaser: { instant: 0.04, low: 0.18, mid: 0.30, high: 0.30, top: 0.18 },
  all_in: { instant: 0.08, low: 0.46, mid: 0.28, high: 0.13, top: 0.05 },
  late_bomber: { instant: 0.03, low: 0.26, mid: 0.34, high: 0.25, top: 0.12 },
  slow_hand: { instant: 0.03, low: 0.34, mid: 0.33, high: 0.21, top: 0.09 },
};
const PERSONA_BAND_BIAS = {
  standard: { instant: 1.00, low: 1.05, mid: 1.00, high: 0.95, top: 1.00 },
  bodhisattva: { instant: 0.60, low: 1.00, mid: 1.30, high: 1.30, top: 0.80 },
};

/** @param {{ar:string}[]} seated @param {string} personaKey */
function fallbackBand(seated, personaKey) {
  const w = {};
  for (const k of BAND_KEYS) w[k] = 0;
  if (!seated || !seated.length) {
    for (const k of BAND_KEYS) w[k] = 1;
  } else {
    for (const p of seated) {
      const bias = AR_BAND_BIAS[p.ar] || AR_BAND_BIAS.steady;
      for (const k of BAND_KEYS) w[k] += bias[k];
    }
  }
  const pb = PERSONA_BAND_BIAS[personaKey] || PERSONA_BAND_BIAS.standard;
  for (const k of BAND_KEYS) w[k] *= pb[k];

  // ⚠️ w 是【在场人数】个权重之和，量级 ≈ 人数，所以 r 必须乘 total 再比。
  //    不乘的话 r(0–1) 永远小于 w[0]，于是每局都返回第一段 ——
  //    实测 mid/high/top 占比全 0%，分段选择退化成常量，而报表看着像配置生效了。
  const total = BAND_KEYS.reduce((s, k) => s + w[k], 0);
  if (total <= 0) return 'low';
  let r = Math.random() * total;
  for (const k of BAND_KEYS) { r -= w[k]; if (r <= 0) return k; }
  return 'low';
}

module.exports = { buildBands, rateInBand, fallbackBand, round2, quantile };
