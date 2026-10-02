'use strict';
/**
 * server/odds/event-window.js —— 限时活动时段判定（北京时间）
 *
 * ⚠️ 所有时钟读数必须显式换算 Asia/Shanghai —— 生产主机时区是 Etc/UTC，
 *   直接用 Date 的本地 getter 会整体差 8 小时，活动配对了也从不生效。
 * ⚠️ toMinutes 必须接受 "24:00"（= 1440），半开区间会让最后一小时不可达。
 */

// 本文件由 scripts/tmp-odds-migrate.js 从原 server/game-logic.js 按行号区间原样切出。
// 【不要手改算法】要改行为请改这里再重跑 node --check server/odds/*.js + test/odds-invariants.js

/**
 * "HH:MM" → 当日分钟数；非法返回 null。
 *
 * ⚠️ 必须接受 "24:00"（= 1440 = 当日末尾）。
 * 之前这里写的是 `if (h > 23) return null`，于是 "24:00" 被判非法返回 null，
 * 活动条目直接被 activeEvent() 跳过 —— 调用方只好把结束时间封到 "23:59"，
 * 绕了一圈才把"跨天/整点结束"这个坑填上。
 * 现在 24:00 合法，daily-activity.js 可以直接写 "22:00" 这种正常整点。
 */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 24 || mi > 59) return null;
  if (h === 24 && mi > 0) return null;   // 只允许精确的 24:00
  return h * 60 + mi;                    // "24:00" → 1440
}

/**
 * 取北京时间的「时:分」。
 *
 * ⚠️ 必须显式换算时区。服务器是 Etc/UTC，Date 的本地 getter
 * （getHours/getMinutes）返回的是 UTC 小时 —— 拿它和北京时间配置比对，
 * 会整体差 8 小时，导致活动配置永不生效。
 */
function beijingParts(d = new Date()) {
  const s = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return { hour: s.getHours(), minute: s.getMinutes() };
}

/**
 * 限时活动：指定时段内提高爆点（支持跨零点，如 23:00-01:00）
 * events_json 形如：
 * [{"name":"黄金时段","from":"19:00","to":"22:00","min":2,"max":30,"weight":0.8,"enabled":true}]
 */
function activeEvent(cfg, now = new Date()) {
  const raw = cfg && cfg.events_json;
  if (!raw) return null;
  let list;
  try { list = JSON.parse(raw); } catch (_) { return null; }
  if (!Array.isArray(list)) return null;

  /**
   * 【重大 bug：这里原来用 now.getHours()】
   *
   * 服务器时区是 Etc/UTC，而活动时段是按【北京时间】配置的。
   * daily-activity.js 写进 events_json 的是 "21:00"–"21:59"（北京时间），
   * 这里却拿 UTC 小时去比 —— 北京 21:00 = UTC 13:00，永远对不上，
   * 于是「每日高倍活动」配置正确却【从不生效】。
   *
   * 修法：和 daily-activity.js 一样显式换算北京时间。
   * 注意不要再用 Date 的本地 getter（getHours/getMinutes）—— 它们跟随
   * 进程时区，而进程时区是 UTC。
   */
  const bjParts = beijingParts(now);
  const cur = bjParts.hour * 60 + bjParts.minute;
  for (const ev of list) {
    if (!ev || ev.enabled === false) continue;
    const from = toMinutes(ev.from), to = toMinutes(ev.to);
    if (from == null || to == null) continue;

    /**
   * 时段命中判定。
   *
   * events_json 里活动的 to 历史上被写成 "21:59"（因为 toMinutes('24:00')
   * 会得到 1440，和引擎的 0-1439 比永远不命中，只能退而求其次封到 23:59）。
   * 现在 daily-activity.js 直接写 "22:00"，这里两者都支持：
   *   - to == 1440（"24:00"）→ 视为当天末尾 cur < 1440
   *   - 正常 "22:00" → cur < 1320
   *   - from > to（如 23:00-01:00）→ 跨零点
   */
  const end = to === 1440 ? 1440 : to;
  const hit = from <= end ? (cur >= from && cur < end) : (cur >= from || cur < end);
    if (!hit) continue;

    const lo = Math.max(1, Number(ev.min) || 1.10);
    const hi = Math.max(lo, Number(ev.max) || 10);
    const w = Math.max(0, Math.min(1, Number(ev.weight ?? 1)));
    // ⚠️ weight 不再用来「一次性抽一个固定倍率」—— 那个做法让整个活动时段
    // 都是同一个数，玩家看到一整小时都在爆 23.4x。
    // 现在 weight 只作为 v3 的兼容字段保留，倍率由 v3 每局独立抽取。
    // 瞬爆概率由 boom_rate（0–1，如 0.30 = 30%）控制。
    const boomRate = Math.max(0, Math.min(1, Number(ev.boom_rate ?? 0)));
    return {
      name: ev.name || '限时活动', min: lo, max: hi, weight: w, boom_rate: boomRate,
      width: ev.width,
      /**
       * 【2026-09-30】幂律（mode 9）下活动期唯一生效的字段。
       * 加法幅度，clamp 到 [0, 0.20]，且最终 RTP 硬 clamp 到 1.00。
       * ⚠️ 非幂律模式下这个字段【完全不被读取】 —— 那些模式仍走 v3 的
       *    min/max/boom_rate，所以「配了活动但没生效」要按当前模式排查。
       */
      rtp_bonus: ev.rtp_bonus,
    };
  }
  return null;
}
module.exports = { toMinutes, beijingParts, activeEvent };
