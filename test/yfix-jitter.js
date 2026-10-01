'use strict';
/**
 * 【2026-10-02】离线验证「yMax 锁定」是否真的消除了纵向抖动。
 *
 * ⚠️ 为什么不用浏览器：headless 里强制显示 #app 会绕过登录流程，
 *    WebSocket 不会建立（页面停在「连接中…」），所以拿不到真实飞行数据。
 *    而这次改动的数学部分可以【脱离浏览器】精确验证：
 *    同样的 yMax 序列、同样的采样点，喂进同一套 yFor 公式，
 *    比较「改动前（逐帧追顶端）」与「改动后（每局锁定）」的像素抖动量。
 *
 * 量的指标：固定采样点的屏幕 y 坐标在飞行过程中的波动幅度（像素）。
 * 改动前 = 每帧重新映射 ⇒ 波动大；改动后 = yMax 恒定 ⇒ 波动 0。
 */
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var GL = require(path.join(ROOT, 'server', 'game-logic.js'));

var pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

var Y_FLOOR = 4.5, GH = 260;      // 与 chart.js 一致

/**
 * ⚠️⚠️ 我第一版这里有个致命测量错误：只生成 60 个 tick（6 秒），
 *    而 Y_FLOOR=4.5 要到 elapsed≈13.4s 才被超过 —— 也就是说
 *    前 6 秒里 yMax 恒为 4.5×1.04=4.68，【根本没有抖动可测】，
 *    量出来「策略 A 也是 0px」不是结论正确，是样本窗口选错了。
 *
 *    所以这里必须让飞行跨过 Y_FLOOR，并且要覆盖到爆点附近。
 *    100x 的局飞行 73.8s，所以 n 用「按倍率算」，不是固定 60。
 */
function makeTicks(n) {
  var out = [];
  for (var i = 0; i < n; i++) {
    var elapsed = i * 100;
    out.push({ sec: elapsed / 1000, rate: GL.rateAt(elapsed, 2.5) });
  }
  return out;
}
/** 给定爆点，算出它对应多少个 100ms tick（留 10% 余量） */
function ticksForBoom(boom) {
  var t = (Math.sqrt(40 * boom - 24) - 4) / 2;     // rateAt 的闭式反解
  var ms = t * 2500;                              // × FLIGHT_SCALE
  return Math.max(80, Math.ceil(ms / 100) + 8);
}

/** chart.js 的 yFor 线性映射 */
function yFor(rate, yMax) {
  var padT = Math.round(GH * 0.15), padB = Math.round(GH * 0.05);
  var gh = GH - padT - padB;
  return padT + gh - ((rate - 1) / (yMax - 1)) * gh;
}

console.log('=== 同一批真实 tick，两种 yMax 策略下的纵向抖动 ===');
console.log('倍率     策略A(旧·逐帧追顶端)   策略B(新·每局锁定)   抖动减少');

/**
 * ⚠️ 参照点必须选【靠后】的采样点，我第一版选 ticks[5]（很早期），
 *    量出来策略 A 也是 0px —— 因为前几帧 yMax 还被 Y_FLOOR=4.5 顶着，
 *    分母 (yMax-1) 不变，所以早期点的 y 坐标纹丝不动。
 *    真实观感里玩家看的是【整条曲线】，而抖动最明显的正是那些
 *    「已经画出来、但 yMax 还在长大」的中后段历史点。
 * 所以这里取最后一个点，并额外扫一遍所有点看总抖动幅度。
 */
[2, 6, 20, 100].forEach(function (boom) {
  var ticks = makeTicks(ticksForBoom(boom));
  var peak = Y_FLOOR;
  ticks.forEach(function (tk) { if (tk.rate > peak) peak = tk.rate; });

  // 参照点 = 曲线中段（55% 位置），它在 yMax 已经脱离 Y_FLOOR、仍在增长的那段里
  var refIdx = Math.min(Math.floor(ticks.length * 0.55), ticks.length - 1);
  var refRate = ticks[refIdx].rate;

  // 策略 A（旧）：每帧重算 yMax = 当前最后一个采样点 × 1.04
  var ysA = ticks.map(function (tk) {
    return yFor(refRate, Math.max(Y_FLOOR, tk.rate) * 1.04);
  });
  // 策略 B（新）：起飞时锁定一次，之后不变
  var yMaxLocked = peak * 1.04;
  var ysB = ticks.map(function () { return yFor(refRate, yMaxLocked); });

  var spanA = Math.max.apply(null, ysA) - Math.min.apply(null, ysA);
  var spanB = Math.max.apply(null, ysB) - Math.min.apply(null, ysB);

  // 另算「整条曲线在纵向的最大位移」= 同一时刻两策略的 y 差峰值
  var maxDiff = 0;
  for (var i = 0; i < ticks.length; i++) {
    var d = Math.abs(ysA[i] - ysB[i]);
    if (d > maxDiff) maxDiff = d;
  }

  console.log('  参照点 ' + refRate.toFixed(2) + 'x' +
    '  yMaxLocked=' + yMaxLocked.toFixed(2) +
    '  旧策略该点波动=' + spanA.toFixed(1) + 'px' +
    '  新策略=' + spanB.toFixed(1) + 'px' +
    '  两策略最大纵向差=' + maxDiff.toFixed(1) + 'px');

  t('爆点≈' + boom + 'x：锁定后参照点 y 完全不动（抖动=0）', spanB === 0, spanB.toFixed(3) + 'px');
  /**
   * ⚠️ 2x 这一档必须【豁免「旧策略在抖」】，而且这是正确结果不是漏测：
   *   2x 的局飞行仅 4.35 秒，全程倍率 < Y_FLOOR(4.5) ⇒
   *   yMax 恒为 4.5×1.04，【本来就没什么可抖的】。
   *   客户说的「6X 都卡」正对应下面 6x 那一档（44.4px 波动），
   *   与实测吻合 —— 这是我第一次量出与客户描述对得上的数字。
   */
  if (boom <= 2) {
    t('爆点≈' + boom + 'x：全程 < Y_FLOOR，旧策略本就无抖动（合理豁免）',
      spanA === 0 && maxDiff === 0, 'spanA=' + spanA.toFixed(3) + ' maxDiff=' + maxDiff.toFixed(3));
  } else {
    t('爆点≈' + boom + 'x：旧策略在同一参照点上确实在抖', spanA > 0.5, spanA.toFixed(3) + 'px');
    t('爆点≈' + boom + 'x：新旧策略存在可见纵向差（>1px）', maxDiff > 1, maxDiff.toFixed(2) + 'px');
  }
});

console.log('\n=== chart.js 源码核：yMax 只在起飞时算一次 ===');
var chart = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chart.js'), 'utf8');
t('存在 lockYMax() 并设置 yMaxLocked', /lockYMax\s*=\s*function/.test(chart) && /yMaxLocked\s*=/.test(chart));
t('draw() 优先用 yMaxLocked', /this\.yMaxLocked\s*\n?\s*\?\s*this\.yMaxLocked/.test(chart));
t('reset() 清空 yMaxLocked（每局重新锁）', /reset[\s\S]{0,400}yMaxLocked\s*=\s*0/.test(chart));
t('不再逐帧用 last.rate 算 yMax（除回退分支）',
  (chart.match(/Math\.max\(Y_FLOOR, last \? last\.rate : 0\) \* 1\.04/g) || []).length === 1,
  '出现次数=' + (chart.match(/Math\.max\(Y_FLOOR, last \? last\.rate : 0\) \* 1\.04/g) || []).length);

console.log('\n=== app.js 核：起飞时调用 lockYMax ===');
var app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
var iLock = app.indexOf('chart.lockYMax()');
t('onTakeoff 里调用 chart.lockYMax()', iLock >= 0);
/**
 * ⚠️ 判据必须用【函数定义位置】，不能用「文件里谁先出现」。
 * 文件里还有两处更早的 setState（:820 快照重连、:875 附近的 onTick 定义），
 * 那些是函数定义或重连路径，不在起飞流程里。
 * 真正要保证的是：onTakeoff 函数体内部，lockYMax 出现在 setPhase('flying')
 * 之前 —— 因为 setPhase 之后渲染循环就开始跑了。
 */
var iTakeoff = app.indexOf('function onTakeoff(d)');
var iSetPhase = app.indexOf("setPhase('flying')", iTakeoff);
var iTickBody = app.indexOf("chart.setState({ status: 'flying', sec: sec, rate: rate", iTakeoff);
t('lockYMax 在 onTakeoff 体内', iLock > iTakeoff, 'lock@' + iLock + ' takeoff@' + iTakeoff);
t('lockYMax 在 setPhase(\'flying\') 之前（渲染循环启动前）',
  iLock > iTakeoff && iLock < iSetPhase, 'lock@' + iLock + ' setPhase@' + iSetPhase);

console.log('\n=== 曲线数据来源核：只用服务端权威值 ===');
/**
 * ⚠️ 必须先剥注释再找那个公式 —— 注释里「原来这里是 rate = t/2 + …」
 * 正是在解释为什么删掉它，扫到它就误判成「还在」。
 * 这正是本项目反复踩的那条：静态断言扫到注释里的反面教材。
 */
var chartCode = chart.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
t('chart.js 不含本地反算公式（已剥注释）',
  chartCode.indexOf('t / 2 + (t * t - t) / 10 + 1') < 0 &&
  chartCode.indexOf('t/2 + (t*t-t)/10 + 1') < 0);
t('该公式只出现在注释里（说明是留档不是活代码）',
  chart.indexOf('rate = t/2 + (t*t-t)/10 + 1') >= 0);
t('chart.js 从 st.rate 取倍率', /st\.rate/.test(chart));
t('pushSample 对重复采样点去重（60fps 不会膨胀）',
  /pushSample[\s\S]{0,500}last\.sec - sec/.test(chart));

console.log('\n' + (fail ? '❌' : '✅') + ' 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
