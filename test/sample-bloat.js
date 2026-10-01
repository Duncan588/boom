'use strict';
/**
 * 【2026-10-02 真根因闸】samples 膨胀率必须 = 1（1 个采样点 = 1 个 tick）。
 *
 * ⚠️ 客户报「线只跟着火箭走」「0~6 秒是空的」「曲线问题严重」，
 *   我前两次都改错了地方（先怪本地反算、再怪 keep=1400 太大）。
 *   真因是【采样粒度】：
 *
 *   app.js 渲染循环每帧（60fps）调 setState()，sec 是插值出来的 ⇒ 每帧都不同。
 *   而 pushSample 只丢弃「sec 和 rate 都完全相同」的重复 ——
 *   插值让 sec 每帧都变 ⇒ 【永远命中不了去重】⇒ 每 tick 塞进 6 个点。
 *
 *   实测（真实 setState 路径，60fps × 100ms tick）：
 *     10 秒局  100 tick → 600 个点 (6.00 倍)   firstSec 0.1
 *     30 秒局  300 tick → 1400 个点(撞上限)     firstSec 6.77  ← 客户的「0~6秒空」
 *     100 秒局 1000 tick → 1400 个点(撞上限)     firstSec 76.77
 *
 * ⚠️ 为什么两版闸都没抓到：
 *   curve-full-round 测的是 keep 上限够不够（够）；
 *   yfix-jitter 测的是 yMax（对）；
 *   两者都没测【填充速度】。而真正坏的正是填充速度。
 *
 * 修法：同一 100ms 桶内的新点【覆盖】桶尾（桶尾 rate = 服务端权威值），
 *      而不是 append ⇒ samples 长度 = tick 数。
 */
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');

// ---- 载入真实 chart.js（不复制实现，直接跑源码）----
function loadChart() {
  // ⚠️ 不用改写结尾：源码本来就是 `})(window);`，
  //   直接 new Function('window', src)(win) 就能把 BoomChart 装进沙箱。
  //   之前误把结尾替换成 `})(globalThis);` ⇒ 它把 BoomChart 挂到了真 globalThis 上，
  //   沙箱里当然读不到 —— 「载不入库」是这个原因，不是文件坏了。
  var src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chart.js'), 'utf8');
  var win = {
    document: { body: {}, createElement: function () { return canvasStub(); } },
    getComputedStyle: function () { return { fontFamily: 'sans-serif' }; },
    // ⚠️ draw() 里是【裸调用】getComputedStyle(...)，不是 window.getComputedStyle
    //   —— 只挂在 win 上取不到（new Function 里裸标识符解析到真 global）。
    //   这个坑我踩过一次：先漏了它，报「载不入库」，其实是 ReferenceError。
  };
  // ⚠️ chart.js 内部把 document / getComputedStyle 当【裸全局】用，
  //   new Function 里裸标识符不走传入的 win 参数，只看真 globalThis。
  //   ⇒ 必须挂到 globalThis 上（只挂 win 上会 ReferenceError）。
  //   这是我第三次在这道闸上栽：先「载不入库」、再 document is not defined。
  //   教训：给沙箱跑浏览器代码时，先把所有裸全局列全，别逐个补。
  globalThis.document = win.document;
  globalThis.getComputedStyle = function () { return { fontFamily: 'sans-serif' }; };
  new Function('window', src)(win);
  return win.BoomChart;
}

var BoomChart = loadChart();
if (typeof BoomChart !== 'function') {
  console.error('❌ 没能从 public/js/chart.js 载入 BoomChart');
  process.exit(1);
}

var pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

/**
 * 完整复刻 app.js 的每帧调用：60fps，一个 tick 间隔内跑 6 帧，
 * sec 由插值推进（与 app.js:989 同形：tickElapsed + min(since, TICK_MS)）。
 */
function play(ticks, fps) {
  var ch = new BoomChart(canvasStub(), ctxHolder());
  ch.w = 360; ch.h = 260; ch.status = 'flying';
  var TICK_MS = 100;
  var framesPerTick = Math.max(1, Math.round(fps / (1000 / TICK_MS)));
  for (var t = 1; t <= ticks; t++) {
    var tickElapsed = t * TICK_MS;
    for (var f = 0; f < framesPerTick; f++) {
      var since = f * (TICK_MS / framesPerTick);
      var sec = (tickElapsed + Math.min(since, TICK_MS)) / 1000;
      var rate = 1 + Math.pow(t / ticks, 2.2) * 99;     // 幂律形状
      ch.setState({ status: 'flying', sec: sec, rate: rate, scale: 2.5 });
    }
  }
  return ch.samples;
}
function ctxHolder() {
  var noop = function () {};
  return {
    canvas: { width: 360, height: 260 },
    globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', font: '',
    textAlign: '', textBaseline: '',
    clearRect: noop, beginPath: noop, closePath: noop, stroke: noop, fill: noop,
    moveTo: noop, lineTo: noop, fillText: noop, save: noop, restore: noop,
    setLineDash: noop, setTransform: noop, translate: noop, scale: noop, arc: noop,
    createLinearGradient: function () { return { addColorStop: noop }; },
    measureText: function (s) { return { width: s.length * 6 }; }
  };
}
/** canvas 元素桩：resize() 会读 getBoundingClientRect()，本闸不关心尺寸 */
function canvasStub() {
  return {
    width: 360, height: 260,
    style: {},
    getContext: function () { return ctxHolder(); },
    getBoundingClientRect: function () { return { width: 360, height: 260, left: 0, top: 0 }; }
  };
}

console.log('=== samples 膨胀率（60fps × 100ms tick，真实 setState 路径）===');
console.log(' 局        tick   期望点   实际点   倍率     samples[0].sec');
[[100, '10 秒局'], [300, '30 秒局'], [1000, '100 秒局']].forEach(function (c) {
  var S = play(c[0], 60);
  console.log('  ' + c[1].padEnd(8) + String(c[0]).padStart(5) + String(c[0]).padStart(9) +
    String(S.length).padStart(9) + (S.length / c[0]).toFixed(2).padStart(8) + 'x' +
    S[0].sec.toFixed(3).padStart(14));
  t(c[1] + '：samples 不超过 tick 数（不膨胀）', S.length <= c[0] * 1.05, S.length + ' vs ' + c[0]);
  t(c[1] + '：膨胀率 ≤ 1.05（1 点 = 1 tick）', S.length / c[0] <= 1.05, (S.length / c[0]).toFixed(2));
});

console.log('\n=== 客户截图那一条：曲线必须从 0 秒附近开始 ===');
[[100, '10 秒局'], [300, '30 秒局'], [1000, '100 秒局']].forEach(function (c) {
  var S = play(c[0], 60);
  var first = S[0].sec;
  console.log('  ' + c[1].padEnd(8) + ' samples[0].sec = ' + first.toFixed(3) + 's');
  t(c[1] + '：曲线起点在 0.15s 内（0~6 秒不再空）', first <= 0.15, first.toFixed(3) + 's');
});

console.log('\n=== 不同帧率下都成立（30fps / 60fps / 120fps）===');
[30, 60, 120].forEach(function (fps) {
  var S = play(300, fps);
  var ratio = S.length / 300;
  console.log('  ' + String(fps).padStart(3) + 'fps → ' + S.length + ' 点  比率 ' + ratio.toFixed(2) +
    'x  起点 ' + S[0].sec.toFixed(3) + 's');
  t(fps + 'fps：仍是 1 点 = 1 tick', ratio <= 1.05, ratio.toFixed(2));
});

console.log('\n=== 保留的上限仍然够（不能为了修膨胀又截断长局）===');
var GL = require(path.join(ROOT, 'server', 'game-logic.js'));
var capTicks = Math.ceil(GL.flightMs(1000) / 100);
var S2 = play(1000, 60);
t('1000x 局（' + capTicks + ' tick）不撞上限：' + S2.length + ' < 1400', S2.length < 1400);

console.log('\n' + (fail ? '❌' : '✅') + ' 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);