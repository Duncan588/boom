/**
 * 示例活动 2：新人保护（前 N 局不抽成）
 *
 * 展示这个框架能做「按用户维度」的条件逻辑，而不只是全局开关。
 * 引擎在结算时调用 onSettle(ctx)，ctx.userBet 带下注信息。
 *
 * 参数（settings.activities_json）：
 *   { "newbie_protect": { "rounds": 3, "rakePercent": 0 } }
 */

module.exports = {
  id: 'newbie_protect',
  name: '新人保护',
  description: '新用户前 N 局免除平台抽成',
  defaultEnabled: false,

  onRoundBegin(ctx) {
    const p = this.p || {};
    const n = Number(p.rounds) || 3;
    // ctx.betCount 是该用户历史下注局数（由引擎传入，未登录机器人不参与）
    if (Number(ctx.betCount) < n) {
      return { rakeOverride: Number(p.rakePercent) || 0, activityLabel: '新人保护' };
    }
    return null;
  },
};
