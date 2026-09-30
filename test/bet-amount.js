'use strict';
/**
 * 金额缩写 K/M/B/T —— 独立单测。
 *
 * 【2026-09-30 真实缺口】用户问：「如果后续用户超过 100B 那么显示栏不炸了？」
 * 当时的 fmtShort 只到 B，超过 100B 就显示成「1200.00B」——
 * 位数不会炸，但极难看且容易看错（1200B 还是 12B？）。补了 T 档。
 *
 * 这里把两个函数从 app.js 里抠出来跑，避免依赖整个页面。
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

// 从源码里抽出 fmtShort / parseShort / SHORT_UNITS 的真实实现，
// 保证测的是线上那份代码，不是复制品
function grab(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('app.js 里找不到 ' + name);
  // 花括号配平
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { i++; break; } }
  }
  return src.slice(start, i);
}
const units = (src.match(/var SHORT_UNITS = \[[\s\S]*?\];/) || [])[0];

// eslint-disable-next-line no-new-func
const factory = new Function(units + '\n' + grab('fmtShort') + '\n' + grab('parseShort') +
  '\nreturn { fmtShort, parseShort };');
const { fmtShort, parseShort } = factory();

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = String(got) === String(want);
  if (ok) { console.log(`  OK   ${name} → ${got}`); pass++; }
  else { console.log(`  FAIL ${name}\n       期望 ${want}，实际 ${got}`); fail++; }
}

console.log('\n=== 金额缩写 fmtShort ===\n');
t('0', fmtShort(0), '0');
t('10', fmtShort(10), '10');
t('999', fmtShort(999), '999');
t('1000 → K', fmtShort(1000), '1K');
t('12500 → K', fmtShort(12500), '12.5K');
t('999999 → K', fmtShort(999999), '1000K');
t('1000000 → M', fmtShort(1000000), '1M');
t('250000 → K 不进 M', fmtShort(250000), '250K');
t('12500000 → M', fmtShort(12500000), '12.5M');
t('1000000000 → B', fmtShort(1000000000), '1B');
// ⚠️ 用户担心的溢出：超过 100B 不能再显示成 1000B
t('100000000000 (100B) → B', fmtShort(100000000000), '100B');
t('1200000000000 (1.2T) → T', fmtShort(1200000000000), '1.2T');
t('120000000000000 (120T) → T', fmtShort(120000000000000), '120T');
t('999999999999999 (约1000T) → T', fmtShort(999999999999999), '1000T');

console.log('\n=== 超过 100B 不得再出现 4 位数字（用户原话「不炸」）===\n');
for (const n of [1e11, 5e11, 1e12, 9.99e14]) {
  const s = fmtShort(n);
  const digits = s.replace(/[^0-9.]/g, '').replace('.', '').length;
  t(`${n} 缩写后数字位数 ≤ 4（得 ${s}）`, digits <= 4, true);
}

console.log('\n=== parseShort 反解（用户直接打 12.5K）===\n');
t("'12.5K'", parseShort('12.5K'), 12500);
t("'1M'", parseShort('1M'), 1000000);
t("'2.5B'", parseShort('2.5B'), 2500000000);
t("'1.2T'", parseShort('1.2T'), 1200000000000);
t("'99999' 纯数字", parseShort('99999'), 99999);
t("'12.5k' 小写 k", parseShort('12.5k'), 12500);
// ⚠️ 数字中间的空格不做千分位处理：parseFloat('1 000') 只取到 1。
// 这是刻意的 —— 输入框的 input 处理器会剔掉非数字字符，
// 失焦时框里只剩纯数字，'1 000' 根本到不了 parseShort。
// 这里的正则只允许【数字+尾缀】之间有空格（'12.5 K' 这种手滑）。
t("'12.5 K' 数字与后缀间空格", parseShort('12.5 K'), 12500);
t("'1 000 K' 中间空格 → NaN（不支持千分位）", Number.isNaN(parseShort('1 000 K')), true);
t("'abc' → NaN", Number.isNaN(parseShort('abc')), true);

console.log('\n=== 往返一致性（缩写→数字→缩写 必须稳定）===\n');
for (const n of [12500, 1000000, 1250000000, 1200000000000]) {
  const back = parseShort(fmtShort(n));
  t(`${n} → ${fmtShort(n)} → ${back}`, back, n);
}

console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===\n`);
process.exit(fail ? 1 : 0);
