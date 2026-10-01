'use strict';
/**
 * 【2026-10-02 防回归闸】曲线必须覆盖【整局】，而不是只有火箭后面那一段。
 *
 * ⚠️ 这个 bug 的形态：cap 从 120 提到 1000 后，一局能飞 100 秒（1000 个 tick），
 *   而 pushSample 的保留窗口写的是 200 个点（20 秒）⇒ 前 80 秒被丢掉。
 *   客户看到的「这个线会跟着火箭走」就是这个 —— 线只有火箭后面那一段。
 *
 *   ⚠️ 两个改动是【耦合】的：cap 放大了一局的长度，窗口没跟着放大。
 *   只测短局就发现不了，所以这道闸按【最坏情况 cap=1000】来测。
 *
 * 断言：采样点保留上限 ≥ cap=1000 整局的 tick 数。
 */
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var GL = require(path.join(ROOT, 'server', 'game-logic.js'));
var chart = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chart.js'), 'utf8');

var pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

// 从源码里读出实际保留上限，避免测试与实现漂移
var m = chart.match(/var keep = Math\.max\(\s*(\d+)\s*,\s*Math\.round\((\d+)\s*\/\s*STEP_MS\)\s*\)/);
t('能读出 pushSample 的保留窗口表达式', !!m, chart.slice(chart.indexOf('var keep'), chart.indexOf('var keep') + 90));
var KEEP = m ? Math.max(Number(m[1]), Math.round(Number(m[2]) / 100)) : 0;
console.log('  实际保留上限 = ' + KEEP + ' 个点（约 ' + (KEEP / 10).toFixed(0) + ' 秒）');

console.log('\n=== 各爆点下的整局 tick 数 vs 保留上限 ===');
var CAP = 1000;
[2, 6, 20, 100, 500, 1000].forEach(function (b) {
  var ms = GL.flightMs(b);
  var ticks = Math.ceil(ms / 100);
  var lost = Math.max(0, ticks - KEEP);
  console.log('  爆点 ' + String(b).padStart(4) + 'x  飞行 ' + String(Math.round(ms / 1000)).padStart(4) +
    's  ' + String(ticks).padStart(4) + ' tick  丢失 ' + String(lost).padStart(4) + ' tick' +
    (lost > 0 ? '  ❌' : '  ✅'));
  t('爆点 ' + b + 'x：整局不被截断', lost === 0, '丢 ' + lost + ' tick');
});

console.log('\n=== 曲线起点必须在 0 秒附近 ===');
t('第一条采样点来自服务端 tick 的真实 sec（不是本地反算）',
  /st\.sec != null && st\.rate != null/.test(chart));
t('没有用 while 循环按 STEP_MS 本地补点',
  !/while\s*\(this\.samples\.length\s*</.test(chart));
t('去重逻辑仍在（60fps 不会让 samples 6 倍膨胀）',
  /last\.sec - sec\)\s*<\s*1e-6/.test(chart));

console.log('\n=== 数量仍然有界（每帧遍历 1400 个点可接受）===');
t('保留上限是有限常量', KEEP > 0 && KEEP <= 5000, KEEP + ' 个点');

console.log('\n' + (fail ? '❌' : '✅') + ' 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
