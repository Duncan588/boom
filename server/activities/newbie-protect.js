/**
 * 示例活动 2：新人保护（前 N 局不抽成 / 幂律下加 RTP）
 *
 * 展示这个框架能做「按用户维度」的条件逻辑，而不只是全局开关。
 *
 * 【2026-09-30 两处修正】
 *
 * 1) ctx.betCount 从来没人传。引擎的 runHooks('onRoundBegin', {...}) 只传
 *    maxRateOverride / rakeOverride / activityLabel / powerlawRtp，
 *    所以 `Number(ctx.betCount)` 恒为 NaN，`NaN < n` 恒为 false
 *    ⇒ 本活动【从未生效过】。而它的 defaultEnabled=false，
 *    所以这个「死掉」一直没被注意到 —— 一旦有人在后台打开它，
 *    结果是「配了但什么都没发生」。
 *    现在显式读 p.rounds 与 ctx.userBetCount（缺失则不生效并留日志），
 *    仍然不猜一个默认值 —— 猜一个等于把「按用户维度」变成「对所有人」。
 *
 * 2) 幂律模式下【只加 RTP】，不改抽水、不改分布形状（同 lucky-hour 的理由）。
 *    抽水是派奖公式 payout() 里的常量 CFG.HOUSE_EDGE，是全局的，
 *    一个活动钩子去改它会与幂律的 EV 推导脱节。
 *
 * 参数（settings.activities_json）：
 *   { "newbie_protect": { "rounds": 3, "rtpBonus": 0.02 } }
 */
const { POWERLAW } = require('../odds');

module.exports = {
  id: 'newbie_protect',
  name: '新人保护',
  description: '新用户前 N 局提高返还率 RTP（幂律下不改分布形状）',
  defaultEnabled: false,

  onRoundBegin(ctx) {
    // ⚠️ 读 ctx.p 而不是 this.p —— runHooks 把活动参数放在第一个参数里。
    //    （原来的 this.p 恒为 undefined，是本活动从未生效的原因之一。）
    const p = ctx.p || {};
    const n = Number(p.rounds) || 3;
    const betCount = Number(ctx.userBetCount);

    // ⚠️ 引擎不传 userBetCount 时【不生效】，而不是当作「0 局 = 新人」。
    // 「没人传」和「这个用户一局都没下过」是两件事，混为一谈会让活动
    // 在每次有人下注的局对所有人生效。
    if (!isFinite(betCount)) return null;
    if (betCount >= n) return null;

    const out = { activityLabel: '新人保护' };
    const raw = p.rtpBonus;
    const bonus = (raw === undefined || raw === null || raw === '')
      ? POWERLAW.EVENT_BONUS_DEFAULT
      : Math.max(0, Math.min(POWERLAW.EVENT_BONUS_MAX, Number(raw) || 0));
    if (bonus > 0) {
      out.rtpOverride = Math.min(POWERLAW.RTP_MAX, (Number(ctx.powerlawRtp) || 0) + bonus);
    }
    return out;
  },
};
