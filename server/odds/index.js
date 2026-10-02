'use strict';
/**
 * server/odds/index.js —— 倍率算法【唯一入口】
 *
 * 全部倍率算法集中在本目录：
 *   flight-curve.js  飞行曲线（倍率 ↔ 毫秒）、CFG 全局常量、派奖、round2
 *   powerlaw.js      模式 9 幂律分布（恒定期望）
 *   shaped-rate.js   模式 10 零套利高倍率 + 空房独立区间
 *   event-window.js  限时活动时段判定（北京时间）
 *   decide.js        decideRate()：唯一参与定价的入口
 *   odds-validate.js 后台赔率表校验（唯一实现，前后端共用口径）
 *   v2/engine.js     历史引擎：按玩家逃跑阈值导出谱（现网已不接线）
 *   v3/engine.js     历史引擎：均值回归随机游走 / 老虎机（现网已不接线）
 *   jev*.js          历史引擎：AI 做庄（mode 7，需外部 API，现网已不接线）
 *
 * ⚠️ 外部代码只 require 本文件（`require('./odds')`），不要直接 require 子模块 ——
 *   这样重命名子模块时只需改这一处。子模块仍各自导出，供本目录内与测试使用。
 */

// 本文件由 scripts/tmp-odds-migrate.js 从原 server/game-logic.js 按行号区间原样切出。
// 【不要手改算法】要改行为请改这里再重跑 node --check server/odds/*.js + test/odds-invariants.js

const flight = require('./flight-curve');
const powerlaw = require('./powerlaw');
const shaped = require('./shaped-rate');
const evt = require('./event-window');
const decide = require('./decide');

module.exports = {
  // ── 定价 ──
  decideRate: decide.decideRate,
  // ── 飞行曲线 & 全局常量 ──
  CFG: flight.CFG,
  FLIGHT_SCALE: flight.FLIGHT_SCALE,
  flightMs: flight.flightMs,
  rateAt: flight.rateAt,
  payout: flight.payout,
  round2: flight.round2,
  sleep: flight.sleep,
  // ── 幂律 ──
  POWERLAW: powerlaw.POWERLAW,
  normRtp: powerlaw.normRtp,
  normCap: powerlaw.normCap,
  normEventBonus: powerlaw.normEventBonus,
  powerlawRate: powerlaw.powerlawRate,
  powerlawDecide: powerlaw.powerlawDecide,
  powerlawReport: powerlaw.powerlawReport,
  simulate: powerlaw.simulate,
  // ── 活动时段 ──
  activeEvent: evt.activeEvent,
  toMinutes: evt.toMinutes,
  beijingParts: evt.beijingParts,
  // ── 模式 10 ──
  shapedDecide: shaped.shapedDecide,
  // ── 命名空间：整块引入的子系统 ──
  shaped,
  validateTable: require('./odds-validate').validateTable,
  v2: require('./v2/engine'),
  v3: require('./v3/engine'),
  jev: require('./jev'),
  jevPersonas: require('./jev-personas'),
  jevRate: require('./jev-rate'),
};
