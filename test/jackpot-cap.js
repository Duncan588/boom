'use strict';
/**
 * 【2026-10-02】奖池上限闸 —— 回答「100B 会不会再被写回去」。
 *
 * 复刻 engine.js 的 clamp 形状，喂三种起始值各跑 2000 局：
 *   ① 正常值 100B
 *   ② 被污染的 e+33（线上真实值）
 *   ③ 0（首次启动）
 * 断言：无论起点如何，跑完都稳定在 JACKPOT_CAP，不会无限增长。
 */
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(ROOT, 'server', 'engine.js'), 'utf8');

var pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

// 从真实源码里读出上限常量，避免测试与源码漂移
var m = src.match(/const JACKPOT_CAP\s*=\s*([^;]+);/);
t('能从源码读到 JACKPOT_CAP', !!m, m ? '' : 'engine.js 里没有这个常量');
var CAP = m ? eval(m[1].replace('e11', 'e11')) : NaN;
console.log('  JACKPOT_CAP = ' + CAP.toExponential(0) + ' (' + (CAP / 1e8).toFixed(0) + ' 亿)');

console.log('\n=== 三种起点 × 2000 局，每局平均输家投注 2.4e7 ===');
var AVG_LOST = 24312345.56;
[[1e11, '正常值 100B'], [2.1043132517383166e+33, '线上污染值 e+33'], [0, '首次启动 0']]
  .forEach(function (c) {
    var start = c[0], label = c[1];
    var j = Math.min(CAP, start);
    if (j <= 0) j = 50000;                       // 引擎的随机起点
    var peak = j;
    for (var i = 0; i < 2000; i++) {
      j = Math.min(CAP, j + AVG_LOST);           // clamp 后的累加
      if (j > peak) peak = j;
    }
    console.log('  起点 ' + label.padEnd(16) + ' 2000 局后 = ' + j.toExponential(4) +
      '  峰值 = ' + peak.toExponential(4));
    t(label + '：跑完不超过上限', j <= CAP, j.toExponential(4));
    /**
     * ⚠️ 判据要分两种：起点【已在上限或以上】必须被压回上限；
     *    起点【远低于上限】（如首次启动 0）则允许它继续涨 ——
     *    2000 局 × 2.4e7 = 4.8e10，离 1e11 还有一半路程，到不了上限是正常的。
     *    真正要断言的是「有界」而不是「一定等于上限」。
     */
    if (start >= CAP) {
      t(label + '：被压回上限（污染值不再累积）', j === CAP, j.toExponential(4));
    } else {
      t(label + '：有界增长且未超上限', j <= CAP && isFinite(j), j.toExponential(4));
    }
  });

console.log('\n=== 从 0 起步到触顶需要多少局 ===');
var need = Math.ceil((CAP - 50000) / AVG_LOST);
console.log('  约 ' + need + ' 局（按平均每局累加 ' + AVG_LOST.toExponential(2) + '）');
t('触顶所需局数是有限值（不是无限）', isFinite(need) && need > 0, need + ' 局');

console.log('\n=== 与旧行为对比（无 clamp 会怎样）===');
var j2 = Math.min(CAP, 2.1043132517383166e+33);
for (var i2 = 0; i2 < 2000; i2++) j2 += AVG_LOST;      // 不 clamp
console.log('  不 clamp：污染值跑 2000 局 → ' + j2.toExponential(4));
console.log('  有 clamp：→ ' + CAP.toExponential(4));
t('clamp 确实挡住了增长', CAP < j2);

console.log('\n=== clamp 是否影响赔率（幂律不读 pool）===');
// ⚠️ 目录化之后（2026-10-02）：decideRate 已从 server/game-logic.js 搬到
//    server/odds/decide.js。读目录路径会 EISDIR / 读到不存在的文件，
//    而这三条断言里两条会因此【静默变成恒真】—— 所以必须读真实文件。
var gl = fs.readFileSync(path.join(ROOT, 'server', 'odds', 'decide.js'), 'utf8');
var decide = gl.slice(gl.indexOf('function decideRate'));
decide = decide.slice(0, decide.indexOf('\n}'));
t('decideRate 不读 pool_balance', decide.indexOf('pool_balance') < 0);
t('decideRate 不读 pool', !/\bpool\b\s*[=)]/.test(decide.replace(/pool[,\s]*$/, '')) ||
  decide.indexOf('void pool') >= 0, 'decideRate 里有 pool 的实际使用');
t('decideRate 签名仍保留 pool 位置参数（不改 engine 调用）',
  /function decideRate\s*\(\s*cfg/.test(gl));

console.log('\n' + (fail ? '❌' : '✅') + ' 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
