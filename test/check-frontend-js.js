/*
 * 前端页面内联 JS 语法检查
 *
 * 【这个测试为什么存在 —— 2026-09-29 线上白屏事故】
 * 我给 admin/index.html 加「模式 6 百分比分布表」时，patch 把一个
 * 一百多行的函数体截断了，少了一个 '}'，整个内联 <script> 语法错误。
 * 浏览器遇到语法错误会【整段不执行】，页面只剩 HTML 骨架 —— 表现为白屏。
 * 游戏界面正常，因为 public/ 下的 JS 是独立文件，没被改坏。
 *
 * 为什么没测出来：当时跑的那几个测试（odds-table / e2e-commands / …）
 * 全是 Node 端逻辑测试，**没有一个碰过 admin/index.html**。
 * 前端文件完全没有测试覆盖，等于改完直接上线赌运气。
 *
 * ⚠️ 本文件只做静态语法检查，不读数据库、不连网络。
 *
 * 运行：node test/check-frontend-js.js
 */
/*
 * 只做语法解析，不发请求、不读数据库。
 * ⚠️ 【本文件所有数据均为构造的测试数据，不是线上真实数据】
 *   赔率配置、倍率、mock 响应全部是写死的样例。
 *   测试不读系统当前时间、不连生产数据库、不发真实 Discord 请求。
 *   生产真实值请查 /root/data/baodian.db 的 settings 表（仅服务器可访问）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

const ROOT = path.join(__dirname, '..');

// 1) HTML 内联 <script>
const htmlFiles = ['admin/index.html', 'public/index.html'];
for (const rel of htmlFiles) {
  console.log(`\n=== ${rel} · 内联 script ===`);
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { ok(false, `文件不存在: ${rel}`); continue; }
  const html = fs.readFileSync(p, 'utf8');

  const OPEN = '<' + 'script';
  const CLOSE = '<' + '/script' + '>';
  const re = new RegExp(OPEN + '(?![^>]*\\ssrc=)([^>]*)>([\\s\\S]*?)' + CLOSE, 'g');
  let m;
  let n = 0;
  let any = false;
  while ((m = re.exec(html)) !== null) {
    n++;
    any = true;
    const code = m[2];
    const line = html.slice(0, m.index).split('\n').length;
    if (!code.trim()) { ok(true, `script #${n}（HTML 第 ${line} 行）是空的，跳过`); continue; }
    try {
      // eslint-disable-next-line no-new
      new vm.Script(code, { filename: rel + '#inline' + n });
      ok(true, `script #${n}（HTML 第 ${line} 行，${code.split('\n').length} 行）语法正确`);
    } catch (e) {
      ok(false, `script #${n}（HTML 第 ${line} 行）语法错误: ${e.message}`);
      console.log(`       ${String(e.stack).split('\n')[1] || ''}`);
    }
  }
  if (!any) console.log('  （该文件没有内联 script）');
}

// 2) 独立的 public/js/*.js
console.log('\n=== public/js/*.js ===');
const jsDir = path.join(ROOT, 'public', 'js');
if (fs.existsSync(jsDir)) {
  for (const f of fs.readdirSync(jsDir).filter((x) => x.endsWith('.js'))) {
    const p = path.join(jsDir, f);
    try {
      // eslint-disable-next-line no-new
      new vm.Script(fs.readFileSync(p, 'utf8'), { filename: 'public/js/' + f });
      ok(true, `public/js/${f} 语法正确`);
    } catch (e) {
      ok(false, `public/js/${f} 语法错误: ${e.message}`);
    }
  }
} else {
  ok(false, 'public/js/ 目录不存在');
}

console.log(`\n${'='.repeat(46)}`);
console.log(fail === 0 ? `✅ 全部通过：${pass}/${pass}` : `❌ ${fail} 项失败（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
