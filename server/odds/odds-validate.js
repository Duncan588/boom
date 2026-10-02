/**
 * 分布表校验（模式 6）
 *
 * 【为什么要有这个文件】
 * 2026-09-30 之前，POST /admin/api/settings 是无脑 setSetting：
 * 非法数据（合计≠100、上界不递增、上界<下界）照样入库，
 * 而被删除的 tableRate() 会【静默丢弃】非法行 ——
 * 用户看到「保存成功」，实际分布和填的完全不一样，且没有任何提示。
 *
 * 现在校验只有一份实现，三处共用：
 *   1. 后台前端保存前（提前提示，不用等请求往返）
 *   2. POST /admin/api/settings（防止绕过、防止旧页面缓存）
 *   3. test/odds-validate.js（回归）
 *
 * 校验失败时返回 { ok:false, error:'人话原因' }，
 * 前端直接 toast 出来，不需要再翻译一遍。
 */

/**
 * @param {Array} rows  [{min, max, pct, boom}]
 * @returns {{ok: boolean, error?: string, rows?: Array}}
 */
function validateTable(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return { ok: false, error: '分布表不能为空' };
  }

  let sum = 0;
  let prevMax = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const hasMin = r.min != null && r.min !== '';
    const lo = Number(r.min);
    const hi = Number(r.max);
    const pct = Number(r.pct);

    if (!isFinite(hi) || hi <= 0) {
      return { ok: false, error: `第 ${i + 1} 行的上界无效` };
    }
    if (!isFinite(pct) || pct < 0) {
      return { ok: false, error: `第 ${i + 1} 行的次数无效` };
    }
    if (hasMin && !isFinite(lo)) {
      return { ok: false, error: `第 ${i + 1} 行的下界无效` };
    }

    // 下界缺省时按旧规则推导：首行取 min_rate，瞬爆行取 1.00
    const effLo = hasMin
      ? lo
      : (i === 0 ? (r.boom ? 1.00 : 0) : prevMax);

    if (i === 0 && !hasMin && r.boom) {
      // 瞬爆行下界隐含 1.00，跳过上下界比较
    } else if (hi <= effLo) {
      return { ok: false, error: `第 ${i + 1} 行：上界 ${hi}x 必须大于下界 ${effLo}x` };
    }

    if (hi <= prevMax) {
      return { ok: false, error: `第 ${i + 1} 行的上界 ${hi}x 必须大于上一行的 ${prevMax}x（行不能交叉）` };
    }

    sum += pct;
    prevMax = hi;
  }

  // 容忍浮点误差（0.02 + 99.98 = 100），不容忍真实偏差
  if (Math.abs(sum - 100) > 0.05) {
    return { ok: false, error: `次数合计 ${sum.toFixed(1)}，必须等于 100` };
  }

  return { ok: true };
}

module.exports = { validateTable };
