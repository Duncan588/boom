/**
 * 小活动插件框架（Mini-Activity Framework）
 *
 * 目的：让「限时活动 / 彩蛋 / 小玩法」可以独立成文件、按开关启停，
 * 不必每次都去改 engine.js 的主循环。
 *
 * 一个活动就是一个模块，导出：
 *
 *   module.exports = {
 *     id: 'lucky_hour',                 // 唯一 id（存 settings / admin 展示用）
 *     name: '幸运时段',                  // 展示名
 *     defaultEnabled: false,            // 默认是否开启
 *     // 下面 4 个钩子按需实现，全部可选
 *     onRoundBegin(ctx) {},             // 每局开始前（可改 ctx.rate / ctx.band / ctx.label）
 *     onRoundOver(ctx) {},              // 结算后
 *     onUserJoin(ctx) {},               // 有玩家下单
 *     onBroadcast(ctx) {},              // 广播前，可追加 WS 消息
 *   };
 *
 * 引擎侧只依赖 runHooks(name, ctx) —— 加活动 = 加一个文件 + 在 index 注册，
 * 不改主循环。任何钩子里抛错都会被吞掉并记日志（活动不该弄挂游戏）。
 *
 * 配置：
 *   activities          启用的活动 id 列表（settings 表，逗号分隔）
 *   activities_json     活动级参数覆盖（settings 表，JSON）
 */

// 本文件在 server/activities/ 子目录，db 在上一层 server/
const db = require('../db');

const registry = new Map();   // id -> module

/** 注册一个活动 */
function register(mod) {
  if (!mod || !mod.id) throw new Error('活动模块必须有 id');
  if (registry.has(mod.id)) {
    console.warn(`[activity] 重复注册，覆盖旧的: ${mod.id}`);
  }
  registry.set(mod.id, {
    enabledByDefault: !!mod.defaultEnabled,
    ...mod,
  });
  console.log(`[activity] 已注册 ${mod.id}（${mod.name || mod.id}）`);
  return mod;
}

/** 一次性注册一批 */
function registerAll(list) {
  for (const m of list) {
    try { register(m); } catch (e) { console.error('[activity] 注册失败:', e.message); }
  }
}

/** 列出全部已注册活动（含启停状态） */
function list() {
  const enabled = enabledIds();
  return [...registry.values()].map((m) => ({
    id: m.id, name: m.name || m.id, description: m.description || '',
    enabled: enabled.has(m.id),
    defaultEnabled: m.enabledByDefault,
  }));
}

/** 当前启用的活动 id 集合 */
function enabledIds() {
  const raw = db.getSetting('activities', null);
  let set;
  if (raw == null) {
    // 没配置过：用各模块的 defaultEnabled
    set = new Set([...registry.values()].filter((m) => m.enabledByDefault).map((m) => m.id));
  } else {
    set = new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean));
  }
  return new Set([...set].filter((id) => registry.has(id)));   // 过滤掉已下线的 id
}

/** 切换某个活动的启停，返回新的启用集合 */
function setEnabled(id, on) {
  if (!registry.has(id)) throw new Error(`未注册的活动: ${id}`);
  const set = enabledIds();
  if (on) set.add(id); else set.delete(id);
  db.setSetting('activities', [...set].join(','));
  return list();
}

/** 读取活动级参数覆盖 */
function params(id) {
  try {
    const j = JSON.parse(db.getSetting('activities_json', '{}') || '{}');
    return j[id] || {};
  } catch (_) { return {}; }
}

/**
 * 运行钩子。
 * @param {string} hook  onRoundBegin | onRoundOver | onUserJoin | onBroadcast
 * @param {object} ctx   传给活动的上下文（可读可改）
 * @returns {object} 汇总各活动返回的 ctx 变更
 */
function runHooks(hook, ctx) {
  const enabled = enabledIds();
  if (enabled.size === 0) return ctx;
  for (const id of enabled) {
    const mod = registry.get(id);
    const fn = mod && mod[hook];
    if (typeof fn !== 'function') continue;
    try {
      // 活动可以用 p.xxx 读自己的参数
      const ret = fn({ ...ctx, p: params(id), activityId: id });
      if (ret && typeof ret === 'object') Object.assign(ctx, ret);
    } catch (e) {
      // 活动出错不能影响主游戏
      console.error(`[activity] ${id}.${hook} 出错:`, e.message);
    }
  }
  return ctx;
}

/** 把启用状态写进 settings（首次启动时按 defaultEnabled 落库） */
function seed() {
  if (db.getSetting('activities', null) == null) {
    db.setSetting('activities', [...enabledIds()].join(','));
    console.log(`[activity] 初始化启用列表: ${db.getSetting('activities') || '(空)'}`);
  }
  if (db.getSetting('activities_json', null) == null) {
    db.setSetting('activities_json', '{}');
  }
}

module.exports = { register, registerAll, list, setEnabled, runHooks, params, seed, enabledIds };

/* ---- 载入内置活动（新增活动在这里加一行即可）---- */
registerAll([
  require('./lucky-hour'),
  require('./newbie-protect'),
]);
