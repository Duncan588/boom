'use strict';
/**
 * 【2026-10-02 防爆点泄漏闸】
 *
 * 为什么这道闸比视觉平滑更重要：视觉只是难看，泄漏是【玩家能反推爆点】。
 * 一旦页面显示「还有 N 秒爆炸」或用总飞行时长反推倍率，玩家就能算出最终倍率。
 *
 * 三条断言：
 *   ① app.js / chart.js 里没有任何【读取】 flightMs / 剩余时长的活代码
 *   ② chart.js 不再用本地公式反算倍率（那本身就是一条泄漏路径）
 *   ③ 页面上不出现「剩余 N 秒」类倒计时文案
 *
 * ⚠️ 断言前必须剥注释 —— 注释里解释「为什么不能这样写」的那句话
 *    会包含被禁的关键词，扫到它就会永远红。
 */
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
function strip(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

var appJs = strip(fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8'));
var chartJs = strip(fs.readFileSync(path.join(ROOT, 'public', 'js', 'chart.js'), 'utf8'));
var html = strip(fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'));

console.log('=== ① 不得读取剩余飞行时长 ===');
// flightMs 只允许作为「已废弃的 state 字段」存在，不允许有读取点
var appReads = (appJs.match(/S\.flightMs/g) || []).length;
t('app.js 无 S.flightMs 读取点', appReads === 0, appReads + ' 处');
t('app.js 无 flightMs 参与倍率计算',
  !/flightMs[^;\n]*\*/.test(appJs), '有 flightMs 参与乘法的表达式');
// 其他可能的泄漏命名
['leftMs', 'remainingMs', 'restMs', 'timeLeft'].forEach(function (k) {
  t('app.js 无 ' + k, appJs.indexOf(k) < 0, '发现 ' + k);
});

console.log('\n=== ② chart.js 不再用本地公式反算倍率 ===');
t('无 t/2 + (t*t - t)/10 + 1 公式',
  chartJs.indexOf('t / 2 + (t * t - t) / 10 + 1') < 0 &&
  chartJs.indexOf('t/2 + (t*t-t)/10 + 1') < 0, '仍有本地反算公式');
t('无把 elapsed 反算成 rate 的 samples.push',
  !/samples\.push\([^)]*\/ 2 \+/.test(chartJs));
t('chart.js 只从 st.rate 取倍率（服务端权威值）',
  /st\.rate/.test(chartJs), '未见 st.rate，曲线可能仍无权威数据来源');

console.log('\n=== ③ 页面无「剩余 N 秒爆炸」倒计时 ===');
['还有', '剩余', '爆炸倒计时'].forEach(function (k) {
  var hit = html.indexOf(k);
  t('index.html 无「' + k + '」文案', hit < 0, hit >= 0 ? '命中：' + html.slice(Math.max(0, hit - 20), hit + 20) : '');
});
// multLbl / phase 是玩家能看到的两处
var lbl = appJs.match(/multLbl'\)\.textContent\s*=\s*'([^']*)'/g) || [];
var phaseTxt = appJs.match(/phase'\)\.textContent\s*=\s*'([^']*)'/g) || [];
console.log('   multLbl 文案: ' + (lbl.map(function (s) { return s.split('= ')[1]; }).join(' | ') || '（无直接赋值）'));
console.log('   phase   文案: ' + (phaseTxt.map(function (s) { return s.split('= ')[1]; }).join(' | ') || '（无直接赋值）'));
var leakLbl = lbl.concat(phaseTxt).filter(function (s) {
  return /秒|倒计时|剩余/.test(s);
});
t('倍率/阶段标签里没有「秒 / 倒计时 / 剩余」', leakLbl.length === 0,
  leakLbl.join(' | '));

console.log('\n=== ④ 插值提前量上限仍然存在（防泄漏的第二道保险）===');
t('app.js 保留 Math.min(since, TICK_MS) 上限',
  appJs.indexOf('Math.min(since, TICK_MS)') >= 0, '上限被删了！');
t('chart.js 的 yMax 是每局锁定而非逐帧追顶端',
  /yMaxLocked/.test(chartJs) && !/yMax = Math\.max\(Y_FLOOR, last \? last\.rate/.test(chartJs));

console.log('\n' + (fail ? '❌' : '✅') + ' 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
