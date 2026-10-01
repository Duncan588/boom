'use strict';
/**
 * 【2026-10-02】专项实测：爆炸前最后 2 秒的抖动。
 *
 * 客户观察：「只有在爆炸之前他才会卡」。这与 yMax 逐帧追顶端的诊断一致
 * —— 爆炸前倍率接近峰值，yMax 长得最凶，历史点被重新映射最剧烈。
 *
 * 但爆炸前还有第二个来源：每 100ms 的倍率台阶在【绝对值】上最明显
 * （1.80x → 2.00x 的 0.2x 台阶，远大于 1.00x → 1.05x 的 0.05x）。
 * 那一部分由插值负责，与 yMax 无关 —— 本脚本把两者分开量，
 * 这样「锁定 yMax 之后还卡不卡」就有答案了。
 *
 * 量的三个数（全用真实引擎 tick，不用编的数据）：
 *   ① 爆炸前 2 秒内 yMax 的波动（策略A 旧 / 策略B 新）
 *   ② 爆炸前 2 秒内曲线顶端的 y 波动
 *   ③ 爆炸前 2 秒内「每 tick 的屏幕 y 位移」最大是多少像素（台阶大小）
 */
var path = require('path');
var ROOT = path.join(__dirname, '..');
var GL = require(path.join(ROOT, 'server', 'game-logic.js'));

var Y_FLOOR = 4.5, GH = 260, STEP = 100;
function yFor(rate, yMax) {
  var padT = Math.round(GH * 0.15), padB = Math.round(GH * 0.05);
  var gh = GH - padT - padB;
  return padT + gh - ((rate - 1) / (yMax - 1)) * gh;
}
function ticksUntil(boom) {
  var t = (Math.sqrt(40 * boom - 24) - 4) / 2;
  return Math.ceil(t * 2500 / STEP);          // 到爆点的 tick 数
}

var BOOMS = [1.8, 2, 6, 20, 100];
console.log('=== 爆炸前最后 2 秒（20 个 tick）实测 ===');
console.log('爆点   策略A旧: yMax波动/顶端y波动   策略B新: yMax波动/顶端y波动   每tick台阶(px)');

BOOMS.forEach(function (boom) {
  var n = ticksUntil(boom);
  var from = Math.max(0, n - 20);                      // 最后 2 秒
  var seg = [];
  for (var i = from; i <= n; i++) {
    var ms = i * STEP;
    seg.push({ sec: ms / 1000, rate: GL.rateAt(ms, 2.5) });
  }
  var peak = Y_FLOOR;
  seg.forEach(function (s) { if (s.rate > peak) peak = s.rate; });

  // 策略 A（旧）：每帧 yMax = 当前最后采样 × 1.04
  var yMaxA = seg.map(function (s) { return Math.max(Y_FLOOR, s.rate) * 1.04; });
  // 策略 B（新）：整段锁定一次
  var yMaxB = peak * 1.04;

  // ① yMax 波动
  var spanMaxA = Math.max.apply(null, yMaxA) - Math.min.apply(null, yMaxA);
  var spanMaxB = 0;

  // ② 曲线顶端（当前采样点）的屏幕 y 波动 —— 注意：策略 A 下它同时受
  //    「自身在涨」和「yMax 在涨」两件事影响，所以要把 yMax 的贡献剥掉。
  //    剥离方法：固定 rate，只让 yMax 变。
  var fixedRate = seg[0].rate;
  var yA = yMaxA.map(function (m) { return yFor(fixedRate, m); });
  var yB = yMaxA.map(function () { return yFor(fixedRate, yMaxB); });
  var spanYA = Math.max.apply(null, yA) - Math.min.apply(null, yA);
  var spanYB = Math.max.apply(null, yB) - Math.min.apply(null, yB);

  // ③ 每 tick 的屏幕 y 位移（新策略下 = 曲线真实爬升的像素步长）
  var stepPx = [];
  for (var k = 1; k < seg.length; k++) {
    stepPx.push(Math.abs(yFor(seg[k].rate, yMaxB) - yFor(seg[k - 1].rate, yMaxB)));
  }
  var maxStep = Math.max.apply(null, stepPx);
  var avgStep = stepPx.reduce(function (a, b) { return a + b; }, 0) / stepPx.length;

  console.log('  ' + String(boom).padStart(5) + 'x  ' +
    (spanMaxA / yMaxB * 100).toFixed(1).padStart(5) + '% /' +
    spanYA.toFixed(1).padStart(6) + 'px      ' +
    (spanMaxB / yMaxB * 100).toFixed(1).padStart(5) + '% /' +
    spanYB.toFixed(1).padStart(6) + 'px      ' +
    '最大 ' + maxStep.toFixed(1) + ' / 平均 ' + avgStep.toFixed(1));
});

console.log('\n=== 结论 ===');
console.log('· 策略 A 的 yMax 在爆炸前 2 秒内变化幅度见第一列 —— 锁定后恒为 0%。');
console.log('· 固定 rate 后 y 坐标的波动（第二列）就是「yMax 抖动」单独造成的纵向抽动，');
console.log('  锁定后为 0 ⇒ 这一类抖动已被完全消除。');
console.log('· 第三列是「每 tick 曲线真实爬升的像素步长」—— 它由 100ms 采样间隔与');
console.log('  rateAt 斜率决定，【与 yMax 无关】，由 app.js 的插值负责。');
console.log('  若客户反馈「仍卡」，先看这一列是否超过 ~8px（肉眼可见的跳变）。');
