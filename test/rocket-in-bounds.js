'use strict';
/**
 * 【2026-10-02 防回归闸】火箭必须永远落在绘图区内。
 *
 * ⚠️ 这道闸是为了抓住我上一轮引入的连带 bug：
 *   lockYMax() 在 onTakeoff 里调用时 samples 还是空的 ⇒ yMaxLocked = 4.68，
 *   之后 rate 涨过 4.68，yFor(rate, 4.68) 算出【负数】⇒ 火箭飞出画布。
 *   客户截图里火箭贴在右上角边缘，就是这条路径。
 *
 * 量的是：把 chart.js 真实的 yMax 计算 + yFor 公式搬过来，
 * 扫所有倍率，断言 y 坐标恒在绘图区内。
 */
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var chart = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chart.js'), 'utf8');

var pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

var Y_FLOOR = 4.5, X_FLOOR = 10;
var W = 340, H = 260;
var padL = Math.round(W * 0.03) + 22, padR = Math.round(W * 0.04);
var padT = Math.round(H * 0.15), padB = Math.round(H * 0.05);
var gw = W - padL - padR, gh = H - padT - padB;

/** 复刻新版 draw() 的 yMax：历史最大值 × 1.04（每个 tick 一次，不是每帧） */
function yMaxFor(history) {
  var peak = Y_FLOOR;
  for (var i = 0; i < history.length; i++) if (history[i] > peak) peak = history[i];
  return peak * 1.04;
}
function yFor(rate, yMax) { return padT + gh - ((rate - 1) / (yMax - 1)) * gh; }

console.log('=== 绘图区几何 ===');
console.log('  画布 ' + W + '×' + H + '  绘图区 x:[' + padL + ',' + (padL + gw) + ']  y:[' + padT + ',' + (padT + gh) + ']');

console.log('\n=== 逐倍率扫描：模拟「历史最大值 = 当前 rate」的最坏情况 ===');
console.log(' 倍率     yMax      yFor      是否在绘图区内');
var bad = [];
[1.0, 1.5, 2, 2.95, 4.68, 5, 6, 10, 20, 50, 100, 200, 500, 1000].forEach(function (r) {
  var ym = yMaxFor([r]);            // 历史只有这一个点 ⇒ 峰值 = r
  var y = yFor(r, ym);
  var inRange = y >= padT - 0.5 && y <= padT + gh + 0.5;
  console.log('  ' + String(r).padStart(6) + 'x  ' + ym.toFixed(2).padStart(8) +
    '  ' + y.toFixed(1).padStart(8) + '  ' + (inRange ? '✅' : '❌ 越界 ' + y.toFixed(1)));
  if (!inRange) bad.push(r);
});
t('任何倍率下 yFor 都在绘图区内（火箭不会飞出）', bad.length === 0, bad.join(', '));

console.log('\n=== 历史最大值远大于当前 rate（曲线已冲到高倍、火箭在低倍段）===');
// 这是真实场景：曲线历史到 100x，火箭此刻在 1.2x
[1.2, 2, 5, 20].forEach(function (cur) {
  var ym = yMaxFor([100]);          // 历史峰值 100x
  var y = yFor(cur, ym);
  var ok = y >= padT - 0.5 && y <= padT + gh + 0.5;
  console.log('  当前 ' + String(cur).padStart(5) + 'x  历史峰值 100x  yMax=' + ym.toFixed(1) +
    '  y=' + y.toFixed(1) + '  ' + (ok ? '✅' : '❌'));
  t('历史峰值远大于当前 rate 时仍在区内（' + cur + 'x）', ok, y.toFixed(1));
});

console.log('\n=== x 轴：xFor 不会溢出 ===');
function xFor(sec, xMax) { return padL + (sec / xMax) * gw; }
[[0, 10], [5, 10], [10, 10], [30, 30], [100, 100]].forEach(function (c) {
  var x = xFor(c[0], c[1]);
  var ok = x >= padL - 0.5 && x <= padL + gw + 0.5;
  console.log('  sec=' + String(c[0]).padStart(4) + ' xMax=' + String(c[1]).padStart(4) +
    '  x=' + x.toFixed(1) + '  ' + (ok ? '✅' : '❌'));
  t('sec=' + c[0] + ' / xMax=' + c[1] + ' 时 x 在绘图区内', ok, x.toFixed(1));
});

console.log('\n=== 源码核：不再是「起飞锁死一个固定值」===');
var code = chart.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
t('lockYMax 不再写死一个数值（只置 0 交给 draw 按历史峰值算）',
  /lockYMax = function[\s\S]{0,200}yMaxLocked = 0/.test(code));
t('draw() 用历史最大值算 yMax（不是当前最后一个点）',
  /for \(var \w+ = 0; \w+ < S\.length; \w+\+\+\)[\s\S]{0,120}rate > peak/.test(code));
t('yMax 按 tick 签名缓存（每 tick 一次，不是每帧）',
  /_ymaxSig/.test(code));

console.log('\n' + (fail ? '❌' : '✅') + ' 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
