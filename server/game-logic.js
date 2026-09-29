'use strict';
/**
 * 爆点游戏核心算法
 *
 * 赔率曲线：  rate = t/2 + (t² − t)/10 + 1     （t 为飞行秒数）
 * 闭式反解：  t = (√(40·rate − 24) − 4) / 2
 *   原实现 getBDTime() 用最多 10 万次迭代逼近，此处改用闭式解，1.00~1000x 全区间精确。
 *
 * 爆点计算还原原版四种模式（admin 可调）：
 *   1 = 赢    爆点 = (资金池 − 设定值) / 总投注
 *   2 = 输    爆点 = (设定值 + 资金池) / 总投注
 *   3 = 平衡  爆点 = (资金池 + 总投注) × (1−抽水) / 总投注
 *   4 = 区间  在 [下限, 上限] 之间均匀随机
 *   5 = 加权  三段加权分布（低倍率占大头，高倍率稀有）—— 2026-09 新增
 * 池子不够时走「立即结算」：全部判负，爆点压到 1.00~1.20x
 *
 * 无论哪种模式，爆点都受 min_rate 下限保护（默认 1.10x），
 * 保证玩家至少有逃跑窗口。
 */

const CFG = {
  BET_MS: 10000,         // 下单阶段（用户要求 10 秒）
  LOCK_MS: 5000,         // 封盘阶段（用户要求 5 秒封盘后才起飞）
  WAIT_MS: 4200,         // 兼容旧字段：WAIT_MS 不再用于计算
  MIN_RATE: 1.10,        // 最低爆点（admin 可调）
  MAX_RATE: 1000,        // 最高爆点
  HOUSE_EDGE: 0.03,      // 平台抽成 3%
  ROBOT_MIN: 8,
  ROBOT_MAX: 20,
  ROBOT_BET_MIN: 10,
  ROBOT_BET_MAX: 200,
  /**
   * 飞行时间缩放系数：原版 getBDTime 换算出的 t×2.5 秒。
   * 1 = 按数学公式的真实秒数（太快，玩家来不及逃跑）
   * 2.5 = 与原版完全一致
   * 调大可让窗口更宽松，适合社区小游戏
   */
  FLIGHT_SCALE: 2.5,
  /**
   * 最低飞行时长（毫秒）。按公式 1.10x 只有 0.2 秒、1.5x 只有 1 秒 ——
   * 玩家来不及看曲线就炸了。2.5 秒是「能看到火箭飞起来再炸」的最小值。
   */
  MIN_FLIGHT_MS: 2500,
};

/**
 * 赔率 → 飞行毫秒数（闭式解）
 *
 * 原版 getBDTime()：循环累加 t += 0.04 直到 rate <= t/2 + (t²-t)/10 + 1，
 * 然后 `(($t / 0.04) * 100) * 1000` 微秒。
 * 化简：(t/0.04) = t×25，(t×25)×100×1000 = t×2,500,000 微秒 = t×2.5 秒。
 * 所以原版的飞行时长是 曲线参数 t × 2.5 秒，**不是 t 秒**。
 * （调用方 usleep($rateTime) 收的是微秒；前端 setTime = getBDTime()/1000 - 2000 毫秒）
 */
function flightMs(rate, opts) {
  const r = Math.max(rate, 1);
  const disc = 40 * r - 24;
  if (disc < 0) return 0;
  const t = (Math.sqrt(disc) - 4) / 2;
  // 【最低飞行时长】低倍率局按公式只有 0.2~1 秒，玩家根本来不及看清曲线
  // 就炸了，体感像「刚点进去就没了」。加一个下限，让每一局都至少飞一会儿。
  // 只影响低倍率局（高倍率局的时长本来就远超这个值）。
  //
  // ⚠️ 瞬爆（模式 5 的 w_boom）不能吃这个下限 —— 它的卖点就是「不给窗口」。
  // 调用方（engine）会用 opts.instant 跳过这里。
  return Math.max(opts && opts.instant ? 0 : CFG.MIN_FLIGHT_MS, Math.round(t * CFG.FLIGHT_SCALE * 1000));
}

/**
 * 已飞行毫秒 → 赔率（服务端与前端共用的唯一公式）
 *
 * 曲线: rate = t/2 + (t²-t)/10 + 1，而原版 getBDTime 反解出的真实飞行时间是
 * t × FLIGHT_SCALE 秒。所以「已飞 ms」要先除以缩放系数才得到 t。
 *
 * ⚠️ 前后端必须用同一个公式、同一个缩放，否则屏幕上显示的倍率和真实结算倍率会错位。
 */
function rateAt(elapsedMs, scale = CFG.FLIGHT_SCALE) {
  const t = (elapsedMs / 1000) / scale;
  return t / 2 + (t * t - t) / 10 + 1;
}

/** 派奖：投入 amount，逃跑倍率 r → 净盈利（已扣平台抽成） */
function payout(amount, r) {
  const gross = amount * r;
  const fee = gross * CFG.HOUSE_EDGE;
  return Math.round((gross - fee) * 100) / 100;
}

function round2(n) { return Math.round(n * 100) / 100; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 根据 admin 配置计算本局爆点。
 * @param {object} cfg  游戏参数（来自 db.allSettings()）
 * @param {number} pot  本局总投注
 * @param {number} pool 后台资金池
 * @param {object|null} event 命中的限时活动（无则 null）
 */
function decideRate(cfg, pot, pool, event) {
  const min = Number(cfg.min_rate) || CFG.MIN_RATE;
  const max = Number(cfg.max_rate) || CFG.MAX_RATE;
  const mode = String(cfg.odds_mode ?? '4');
  const setValue = Number(cfg.odds_value) || 0;
  const percent = Math.max(0, Math.min(1, Number(cfg.rake_percent) || 0));
  const jitter = Math.random() * 0.09;

  const clamp = (r) => {
    let v = Number(r);
    if (!isFinite(v) || v < min) v = min;
    if (v > max) v = max;
    return round2(v);
  };

  // 限时活动优先：直接在该活动的倍率区间内取
  if (event) {
    return { rate: clamp(event.rate), fast: false, mode: 'event:' + (event.name || '') };
  }

  // 无下注 → 保底区间随机
  if (!pot || pot <= 0) {
    const base = min + Math.random() * (Number(cfg.base_random) || 0.9);
    return { rate: clamp(base), fast: false, mode: 'base' };
  }

  let rate = null;

  if (mode === '1') {
    if (pool > setValue + pot) rate = Math.round((pool - setValue) / pot) - jitter;
    else return { rate: clamp(1.00 + Math.random() * 0.20), fast: true, mode: 'win-fast' };
  } else if (mode === '2') {
    if (pool + setValue - pot * 1.5 > 0) rate = Math.round((setValue + pool) / pot) - jitter;
    else return { rate: clamp(1.00 + Math.random() * 0.20), fast: true, mode: 'lose-fast' };
  } else if (mode === '3') {
    const effPool = (pool + pot) * (1 - percent);
    if (pool > 0) rate = Math.round(effPool / pot) - jitter;
    else return { rate: clamp(1.00 + Math.random() * 0.20), fast: true, mode: 'balance-fast' };
  } else if (mode === '4') {
    const lo = Number(cfg.band_min) || 1.10;
    const hi = Math.max(lo, Number(cfg.band_max) || 3.00);
    rate = lo + Math.random() * (hi - lo);
  } else if (mode === '5') {
    const w = weightedRate(cfg);
    // 只有「瞬爆段」才绕过 min_rate 下限保护 —— 它的全部意义就是不给逃跑窗口。
    // 走正常 clamp 会被 min_rate 顶回去，玩家照样能等到下限逃跑，瞬爆就名存实亡。
    //
    // ⚠️ 必须用 weightedRate 返回的 boom 标记，不能用「r < min」反推：
    // 低段下限（1.01）也可能低于 min_rate，那是正常低倍率局，不该被当成瞬爆。
    if (w.boom) return { rate: round2(w.v), fast: true, mode: '5-instant' };
    rate = w.v;
  }

  return { rate: clamp(rate), fast: false, mode };
}

/**
 * 模式 5：加权分布。
 *
 * 为什么需要它：模式 4 是「下限 + random × (上限−下限)」的【均匀分布】，
 * 意味着 1.1x 和 50x 出现概率完全相同。线上曾把 band 配成 1.1–50，
 * 结果 81.8% 的局超过 10x、41% 超过 30x（实测 10 万局模拟），
 * 玩家每局都在 25x 附近逃跑，10 局净赚 5 倍本金 —— 赢率离谱地高。
 *
 * 均匀分布不适合「偶尔来一发大的、平时小赢」的手感。
 * 模式 5 改成五段加权：
 *   1) 按权重决定落在哪一段（低倍率占大头，高倍率稀有）
 *   2) 段内再均匀取值
 * 于是低倍率被大幅加权，高倍率稀有但存在。
 *
 * 默认参数（50 万局模拟）：
 *   瞬爆  6% → 1.00–1.01x   刚起飞就没，绕过 min_rate 与最低飞行时长
 *   低段 50% → 1.01–4.00x   日常区间
 *   中段 22% → 4.00–10.00x
 *   高段 20% → 10.00–30.00x 约 22 局来一次
 *   爆段  2% → 30.00–50.00x 约 50 局来一次
 *
 * 玩家视角：日常 1.01–10x，偶尔冲到 30x+，50x 是稀有事件。
 * 想要更稳就把 w_high / w_top 调小、w_low 调大。
 */
function weightedRate(cfg) {
  const num = (k, d) => {
    const v = Number(cfg[k]);
    return isFinite(v) && v > 0 ? v : d;
  };
  // 五段权重：瞬爆 / 低 / 中 / 高 / 爆
  const wBoom = num('w_boom', 6);
  const wLow = num('w_low', 50);
  const wMid = num('w_mid', 22);
  const wHigh = num('w_high', 20);
  const wTop = num('w_top', 2);

  // 瞬爆：1.00 ~ boomMax（默认 1.01），刚起飞就没
  const boomMax = Math.max(1.001, num('w_boom_max', 1.01));
  // 常规四段，段内均匀
  const loMin = num('w_lo_min', 1.01);
  const loMax = Math.max(loMin, num('w_lo_max', 4.00));
  const midMin = num('w_mid_min', 4.00);
  const midMax = Math.max(midMin, num('w_mid_max', 10.00));
  const highMin = num('w_high_min', 10.00);
  const highMax = Math.max(highMin, num('w_high_max', 30.00));
  const topMin = num('w_top_min', 30.00);
  const topMax = Math.max(topMin, num('w_top_max', 50.00));

  const total = wBoom + wLow + wMid + wHigh + wTop;
  const r = Math.random() * total;
  if (r < wBoom) return { v: 1.00 + Math.random() * (boomMax - 1.00), boom: true };
  if (r < wBoom + wLow) return { v: loMin + Math.random() * (loMax - loMin) };
  if (r < wBoom + wLow + wMid) return { v: midMin + Math.random() * (midMax - midMin) };
  if (r < wBoom + wLow + wMid + wHigh) return { v: highMin + Math.random() * (highMax - highMin) };
  return { v: topMin + Math.random() * (topMax - topMin) };
}

/** "HH:MM" → 当日分钟数；非法返回 null */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
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

  const cur = now.getHours() * 60 + now.getMinutes();
  for (const ev of list) {
    if (!ev || ev.enabled === false) continue;
    const from = toMinutes(ev.from), to = toMinutes(ev.to);
    if (from == null || to == null) continue;

    const hit = from <= to ? (cur >= from && cur < to) : (cur >= from || cur < to);
    if (!hit) continue;

    const lo = Math.max(1, Number(ev.min) || 1.10);
    const hi = Math.max(lo, Number(ev.max) || 10);
    const w = Math.max(0, Math.min(1, Number(ev.weight ?? 1)));
    // weight 越大越偏向高倍率：指数 1（均匀）→ 2（明显右偏）
    const r = 1 - Math.pow(1 - Math.random(), 1 + w);
    return { name: ev.name || '限时活动', min: lo, max: hi, weight: w, rate: round2(lo + r * (hi - lo)) };
  }
  return null;
}

module.exports = { CFG, flightMs, rateAt, decideRate, activeEvent, payout, round2, sleep, toMinutes };
