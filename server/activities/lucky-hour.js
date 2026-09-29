/**
 * 示例活动 1：幸运时段（放大上限）
 *
 * 在指定时段内把爆点上限抬高，让长倍局更容易出现。
 * 用法：server/activities/index.js 里 registerAll([...]) 引入，
 *       或在本文件里直接 module.exports 后由注册中心加载。
 *
 * 参数（settings.activities_json）：
 *   { "lucky_hour": { "from": "20:00", "to": "23:00", "maxRate": 8 } }
 */

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
  description: '指定时段内抬高爆点上限，更容易出高倍局',
  defaultEnabled: false,

  onRoundBegin(ctx) {
    const p = this.p || {};
    if (!p.from || !p.to) return null;
    if (!inRange(new Date(), p.from, p.to)) return null;
    const cap = Number(p.maxRate) || 0;
    if (cap <= 0) return null;
    // 抬高引擎层上限；具体抽多少仍由引擎的 band / odds 决定
    if (ctx.maxRateOverride == null || cap > ctx.maxRateOverride) {
      return { maxRateOverride: cap, activityLabel: '幸运时段' };
    }
    return null;
  },
};
