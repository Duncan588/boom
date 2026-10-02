/**
 * 示例活动 1：幸运时段（幂律模式下只上调 RTP）
 *
 * 【2026-09-30 语义变更 —— 为什么不抬高倍率上限了】
 *
 * 原来这个活动做的是「把 max_rate 抬高，让高倍局更容易出现」。在幂律下
 * 这条路是错的，有两个独立的原因：
 *
 * 1) 幂律的定价参数是 powerlaw_rtp / powerlaw_cap，max_rate 不参与定价，
 *    所以「抬高上限」在幂律下【根本不生效】—— 活动看起来开了却什么也没做。
 * 2) 更本质的：抬高上限会改变分布形状。幂律的全部价值是
 *    「任何逃跑点的毛赔付都是 RTP」，一旦活动期换一个形状，
 *    玩家只要玩过一次活动时段就能识别出「这段时间的爆点不一样」，
 *    于是存在一个「只在活动期稳定赚钱」的区间 —— 正是本模式要消灭的东西。
 *
 * 所以：幂律模式下活动只做一件事 —— 加 RTP。分布形状一字不改。
 *
 * 【加法而非乘法】RTP + bonus（默认 +0.03），最终硬 clamp 到 1.00。
 * 保本线其实是 RTP = 1/0.97 = 1.0309，所以 1.00 仍留 3 个百分点余量；
 * 超过 1.0309 才是给所有人保证盈利（见 game-logic.js 的 POWERLAW.RTP_MAX）。
 *
 * 【非幂律模式】仍返回 maxRateOverride，由 engine 抬 max_rate，
 * 行为与改动前一致 —— 只是它现在终于会真的生效了
 * （见 activities/index.js 里 this 绑定的修复说明）。
 *
 * 参数（settings.activities_json）：
 *   { "lucky_hour": { "from": "20:00", "to": "23:00", "maxRate": 8, "rtpBonus": 0.03 } }
 *   rtpBonus 留空 = 默认 0.03；配 0 = 活动期不加成（形状仍不变）
 */

const { POWERLAW } = require('../odds');

function inRange(now, from, to) {
  const m = now.getHours() * 60 + now.getMinutes();
  const p = (s) => {
    const [h, mi] = String(s || '0:0').split(':').map(Number);
    return h * 60 + (mi || 0);
  };
  const a = p(from), b = p(to);
  // 跨零点（23:00 → 01:00）也要能匹配
  if (a <= b) return m >= a && m < b;
  return m >= a || m < b;
}

module.exports = {
  id: 'lucky_hour',
  name: '幸运时段',
  description: '指定时段内提高返还率 RTP（幂律下不改分布形状）',
  defaultEnabled: false,

  onRoundBegin(ctx) {
    /**
     * ⚠️ 参数从【参数对象】读，不是 this.p。
     *
     * 这就是本活动从未生效过的第二个原因（第一个是 this 绑定）：
     * runHooks 传的是 `fn.call(mod, { ...ctx, p: params(id) })`，
     * 也就是 p 在【第一个参数】里。原来的 `this.p` 恒为 undefined。
     * 修 this 绑定不等于修好参数 —— 两处都要改成读 ctx.p。
     */
    const p = ctx.p || {};
    if (!p.from || !p.to) return null;
    if (!inRange(new Date(), p.from, p.to)) return null;

    // 【幂律模式：只加 RTP，分布形状不变】见文件头的说明
    const raw = p.rtpBonus;
    const bonus = (raw === undefined || raw === null || raw === '')
      ? POWERLAW.EVENT_BONUS_DEFAULT
      : Math.max(0, Math.min(POWERLAW.EVENT_BONUS_MAX, Number(raw) || 0));
    const out = { activityLabel: '幸运时段' };
    if (bonus > 0) {
      // ⚠️ ctx.powerlawRtp 由 engine 传入（该局的 baseRtp）。
      //    硬 clamp 到 1.00（保本线是 1.0309，所以 1.00 仍有 3 个点余量）。
      out.rtpOverride = Math.min(POWERLAW.RTP_MAX, (Number(ctx.powerlawRtp) || 0) + bonus);
    }

    // 【非幂律模式】仍然返回 maxRateOverride，由 engine 抬 max_rate
    const cap = Number(p.maxRate) || 0;
    if (cap > 0 && (ctx.maxRateOverride == null || cap > ctx.maxRateOverride)) {
      out.maxRateOverride = cap;
    }
    return out;
  },
};
