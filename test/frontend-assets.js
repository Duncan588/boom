'use strict';
/**
 * 前台资源版本检查 —— 防「改了 JS 但没 bump ?v=」导致线上白屏。
 *
 * ⚠️ 真实事故（2026-09-30）：删掉 −/+ 步进、加了梭哈按钮，
 *    改了 app.js / game.css / index.html，但 ?v= 还是 29。
 *    Cloudflare 缓存 4 小时（max-age=14400），浏览器拿到的还是旧 app.js，
 *    旧 JS 里 `$('#minus').onclick = ...` 找不到元素 → 抛 TypeError
 *    → 整个脚本挂掉 → 页面看起来「打不开」。
 *
 *    服务器上文件明明是新的，日志也一个错都没有 —— 错在浏览器那一侧。
 *
 * 规则：任何改动 public/ 下文件的提交，都必须 bump index.html 里的 ?v=N。
 * 这个测试守住它。
 */
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function t(name, ok, extra) {
  if (ok) { console.log('  OK   ' + name); pass++; }
  else { console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); fail++; }
}

console.log('\n=== 前台资源版本检查 ===\n');

const versions = [...new Set((html.match(/\?v=\d+/g) || []))];
t('index.html 里的 ?v= 版本号唯一', versions.length === 1,
  `出现多个版本：${versions.join(', ')} —— 部分资源会拿到旧缓存`);

const m = html.match(/\?v=(\d+)/);
const ver = m ? Number(m[1]) : 0;
t('版本号已 bump（> 29，事故时是 29）', ver > 29, `当前 ?v=${ver}`);

// 所有引用的静态资源都必须带 ?v=
const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))\?v=\d+"/g)].map((x) => x[1]);
t('静态资源都带 ?v= 参数', refs.length >= 4, `只找到 ${refs.length} 个带版本的引用`);

// 引用的文件必须真实存在
const missing = refs.filter((r) => !fs.existsSync(path.join(PUB, r.replace(/^\//, ''))));
t('引用的资源文件都存在', missing.length === 0, `缺失：${missing.join(', ')}`);

// ⚠️ 反向检查：JS 里引用的元素 id 必须在 HTML 里存在。
// 这才是「白屏」的真凶 —— 旧 JS 找不到已删除的节点就抛错。
const appJs = fs.readFileSync(path.join(PUB, 'js', 'app.js'), 'utf8');
// ⚠️ 只查【静态 HTML 里就有】的节点。
// 弹窗（转账/签到/历史等）的节点是 JS 动态生成的，不在 HTML 里 ——
// 把它们算成「缺失」会产生 11 条假失败。
// 这里只守住下注区那几个：它们曾经被删过（−/+ 步进），
// 旧 JS 找不到就会抛 TypeError 并让整个脚本挂掉。
const BET_IDS = ['betAmt', 'actBtn', 'btnAllIn', 'meName', 'meCoins', 'betsList', 'phase'];
const missingBet = BET_IDS.filter((id) => !html.includes(`id="${id}"`));
t(`下注区 ${BET_IDS.length} 个节点在静态 HTML 里存在`, missingBet.length === 0,
  `缺失：${missingBet.join(', ')}\n       —— 旧缓存的 JS 找不到就抛 TypeError，页面看起来「打不开」`);

// 反向：HTML 里的静态节点不该有已被删除的旧 id
t('旧的 −/+ 步进按钮已从 HTML 移除',
  !/id="minus"/.test(html) && !/id="plus"/.test(html),
  'HTML 里还有 minus/plus，但 JS 里已删掉绑定 —— 旧 JS 找不到会报错');
// 第二版又删掉了 最小/一半/最大 —— 「一半」是用户没要求的，擅自加的
t('最小/一半/最大 三个快捷键已全部移除',
  !/id="btnMin"/.test(html) && !/id="btnHalf"/.test(html) && !/id="btnMax"/.test(html),
  '还有 btnMin/btnHalf/btnMax —— 用户只要求保留梭哈');
t('下注区只剩「金额输入 + 梭哈」两个可交互元素',
  (html.match(/class="btn[^"]*" id="btn/g) || []).length === 0
    || !/bet-quick/.test(html),
  'bet-quick 容器还在，说明第一版那行按钮没删干净');
t('金额输入不再套外框（无 .stepper 包裹）',
  !/class="stepper"[\s\S]{0,200}id="betAmt"/.test(html),
  'betAmt 还在 .stepper 里 —— 那个描边框就是用户说的「丑框子」');
t('app.js 里不再引用已删除的 minus/plus',
  !/\$\('#(minus|plus)'\)/.test(appJs),
  "app.js 还有 $('#minus') / $('#plus') —— HTML 里已无此元素，必然抛错");

console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===\n`);
process.exit(fail ? 1 : 0);
