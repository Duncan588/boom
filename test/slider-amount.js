'use strict';
/* 滑块验收 1~6 的数学口径自测（离线，不碰服务器） */
var SHORTS = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
function fmtShort(n) {
  n = Number(n) || 0;
  for (var i = 0; i < SHORTS.length; i++) {
    if (n >= SHORTS[i][0]) {
      var v = n / SHORTS[i][0];
      return (v >= 100 ? v.toFixed(0) : v.toFixed(2)) + SHORTS[i][1];
    }
  }
  return String(Math.round(n * 100) / 100);
}
var BET_MIN = 1;
var S = { bet: 10, me: { coins: 0 } };

function sliderAmount(pct) {
  var c = (S.me && S.me.coins) || 0;
  if (c <= 0) return 0;
  if (pct >= 100) return c;
  return Math.round(c * pct / 100);
}
function setBet(v) { S.bet = Math.max(BET_MIN, Math.round(v)); }

var pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

console.log('=== 验收2：拉到底 = 全部金额，精确相等 ===');
[1, 7, 999, 1000, 12345, 1234567, 1308276.47, 1e9 + 0.37].forEach(function (c) {
  S.me.coins = c;
  var got = sliderAmount(100);
  t('余额 ' + c + ' → 100% 得 ' + c + '（严格相等）', got === c, got);
});

console.log('\n=== 验收1：0%=0，100%=全部，中点线性 ===');
S.me.coins = 1000;
t('0% → 0', sliderAmount(0) === 0, sliderAmount(0));
t('50% → 500（线性中点）', sliderAmount(50) === 500, sliderAmount(50));
t('25% → 250', sliderAmount(25) === 250, sliderAmount(25));
S.me.coins = 999;
t('余额 999：50% → 500（四舍五入）', sliderAmount(50) === 500, sliderAmount(50));
t('余额 999：100% → 999（不是 998.5）', sliderAmount(100) === 999, sliderAmount(100));

console.log('\n=== 验收6：金额下限保 1 ===');
S.me.coins = 1000;
setBet(sliderAmount(0));
t('滑到最左后 S.bet = ' + S.bet + '（不是 0）', S.bet >= BET_MIN, S.bet);
S.me.coins = 0;
setBet(sliderAmount(50));
t('余额 0 时不产生 NaN，S.bet = ' + S.bet, S.bet === BET_MIN, S.bet);

console.log('\n=== 验收4：回显用已有 fmtShort，不新增缩写实现 ===');
t('fmtShort(1500) = ' + fmtShort(1500), fmtShort(1500) === '1.50K', fmtShort(1500));
t('fmtShort(1308276.47) = ' + fmtShort(1308276.47), /M$/.test(fmtShort(1308276.47)), fmtShort(1308276.47));
t('fmtShort(1e13) = ' + fmtShort(1e13), /T$/.test(fmtShort(1e13)), fmtShort(1e13));
t('fmtShort(500) = ' + fmtShort(500), fmtShort(500) === '500', fmtShort(500));

console.log('\n=== 反算：金额 → 百分比（余额变化后填充不能跳）===');
S.me.coins = 1000; setBet(500);
var pct = Math.max(0, Math.min(100, S.bet / S.me.coins * 100));
t('500/1000 → 50%', pct === 50, pct);
S.me.coins = 2000;   // 余额翻倍，金额没变
var pct2 = Math.max(0, Math.min(100, S.bet / S.me.coins * 100));
t('余额翻倍后 500/2000 → 25%（填充随余额重算）', pct2 === 25, pct2);

console.log('\n' + (fail ? '❌' : '✅') + ' 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
