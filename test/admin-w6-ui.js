/*
 * 后台「模式 6 百分比分布表」交互测试（jsdom 模拟）
 *
 * 【这个测试为什么存在 —— 2026-09-29 线上事故】
 * 用户反馈：赔率模式下拉里已经有「6 · 百分比分布表」，但切过去【没反应】，
 * 表格是空的、预览显示「占比全为 0」。
 *
 * 根因：w6RenderRows() 只在 loadSettings() 里被调用（页面加载时跑一次），
 * 而切换下拉走的是 syncW5() —— 它只管显示/隐藏面板，从不渲染表格。
 * 于是「切换模式」这条路径下表格永远是空的。
 *
 * 为什么之前的测试没抓到：
 *   - check-frontend-js.js 只做【语法】检查 —— 语法完全正确
 *   - 其他测试全是 Node 端逻辑，不碰 DOM
 *   - 我只 curl 了 HTTP 200，没在浏览器里点过
 * 也就是说：改了交互逻辑，却没有任何测试执行过这个交互。
 *
 * ⚠️ 本文件用 jsdom 模拟浏览器，直接跑 admin/index.html 里的真实 <script>，
 *    不复制逻辑 —— 复制的话就会重犯「mock 与真实结构不一致」的老毛病。
 *    跑法：node test/admin-w6-ui.js
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

let JSDOM;
try {
  // eslint-disable-next-line global-require
  JSDOM = require('jsdom').JSDOM;
} catch (_) {
  console.log('  ⚠️ 未安装 jsdom，跳过（npm i -D jsdom 后可运行）');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');

const OPEN = '<' + 'script';
const CLOSE = '<' + '/script' + '>';
const start = html.indexOf(OPEN + '>') + OPEN.length + 1;
const end = html.indexOf(CLOSE, start);
const inlineJs = html.slice(start, end);

// 只取「赔率相关」那一段脚本执行 —— 整个 script 会去请求后端。
// 截取从 script 开头的工具函数（$ / $$ / toast）到 btnSaveOdds 之前，
// 这样 eval 时上下文完整 —— 只截 w6 段会报 "$ is not defined"。
const w6Start = inlineJs.indexOf('var W6_DEFAULT');
// 不用字面量写 </script> 或带引号的 $('#...') —— 前者会被 HTML 解析器截断，
// 后者在拼进 JS 字符串时容易出错。用拼接表达。
// 截到「限时活动」那段之前，把 btnSaveOdds 的 handler 也包含进来
// （线上事故之一就是保存请求体不对，所以必须测到点击保存这一步）。
const w6End = inlineJs.indexOf('function renderEvents');
const w6EndFallback = (() => {
  const i = inlineJs.indexOf('/* ---- 限时活动');
  return i > 0 ? i : inlineJs.length;
})();
if (w6Start < 0 || w6End < 0) {
  console.log('  ❌ 找不到 w6 相关代码段（文件结构变了？）');
  process.exit(1);
}
/**
 * 只取 w6 那一段，前面补上 $ / $$ / toast / call 四个工具函数。
 *
 * 为什么不取 script 头部：头部里有一堆 $('#btnLogin').onclick 之类的
 * DOM 绑定，mock 页面里没有那些元素，一执行就抛
 * "Cannot set properties of null"，把真正要测的代码挡住。
 */
const PRELUDE = [
  'function $(s){return document.querySelector(s);}',
  'function $$(s){return Array.prototype.slice.call(document.querySelectorAll(s||\'*\'));}',
  'function toast(m,k){}',
  'function call(p,b,m){return Promise.resolve({});}',
  // syncW5 会调它；这里给个空实现，模式 5 的预览不在本测试范围
  'function syncW5Inner(){}',
].join('\n');
const SNIP_END = w6End > 0 ? w6End : w6EndFallback;
const w6Code = PRELUDE + '\n' + inlineJs.slice(w6Start, SNIP_END);

// 造一个最小的 DOM：s_mode 下拉 + w6 面板 + 容器
const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div class="panel-sub" id="w5Panel"></div>
  <div class="panel-sub" id="w6Panel"></div>
  <div id="w6Body">
    <div id="w6Rows"></div>
    <div class="f"><input data-f="min" /></div>
        <div class="f"><input data-f="max" /></div>
        <div class="f"><input data-f="pct" /></div>
        <div class="f"><input type="checkbox" data-f="boom" /></div>
        <div class="f"><span></span></div>
        <div class="f"><button data-del="0"></button></div>
    </div>
    <div class="f"><input id="s_w6sum" /></div>
    <div id="w6Preview" class="hint"></div>
  <div class="f"><input id="s_min" value="1.10"></div>
  <div class="f"><input id="s_max" value="1000"></div>
  <div class="f"><button id="btnAddRow"></button></div>
  <div class="f"><button id="btnDelRow"></button></div>
  <button id="btnSaveOdds">保存赔率设置</button>
  <!--
    【2026-09-30】Jev 面板（mode 7）的元素。
    这段 inline JS 现在也包含 $('#j_btn_save').onclick 等绑定，
    mock DOM 里缺任何一个都会抛 "Cannot set properties of null"，
    于是整个 admin-w6-ui 测试挂掉 —— 所以必须补全。
  -->
  <div class="panel-sub" id="w7Panel"></div>
  <div id="w7Body">
    <select id="j_enabled"><option value="0">0</option><option value="1">1</option></select>
    <select id="j_persona"><option value="standard">standard</option><option value="bodhisattva">bodhisattva</option></select>
    <input id="j_sample" value="100">
    <input id="j_cache" value="4">
    <input id="j_timeout" value="800">
    <input id="j_key" type="password">
    <input id="j_act_rounds" value="0">
    <input id="j_act_max" value="0">
    <input id="j_act_inst" value="0">
    <button id="j_btn_save"></button>
    <button id="j_btn_load"></button>
    <button id="j_btn_act"></button>
    <button id="j_btn_actoff"></button>
    <div id="j_status"></div>
    <div id="j_dist"></div>
  </div>
  <select id="s_mode">
    <option value="6">6</option><option value="5">5</option><option value="7">7</option>
  </select>
  ${['s_wlow','s_wmid','s_whigh','s_wtop','s_wboom','s_wboommax','s_wlomin','s_wlomax',
     's_wmidmin','s_wmidmax','s_whimin','s_whimax','s_wtopmin','s_wtopmax']
    .map((id) => `<div class="f"><input id="${id}"></div>`).join('')}
</body></html>`, { runScripts: 'outside-only' });

const win = dom.window;
const doc = win.document;

// 预置一个「已登录加载完成」的默认状态
doc.getElementById('s_mode').value = '5';

console.log('\n=== 1. 代码能在 DOM 环境里跑起来（无语法/引用错误）===');
let ran = true;
try {
  // 用 vm.Script + filename，这样报错能指到具体行
  const script = new vm.Script(w6Code, { filename: 'admin-w6-snippet.js' });
  script.runInContext(win);
} catch (e) {
  ran = false;
  ok(false, `syncW5 抛错: ${e.message}｜堆栈 ${(e.stack || '').split('\n').slice(0, 3).join(' ← ')}`);
  console.log('  ' + String(e.stack).split('\n').slice(0, 5).join('\n  '));
  // 打印出错的源码行
  const lineNo = (String(e.stack).match(/admin-w6-snippet\.js:(\d+)/) || [])[1];
  if (lineNo) {
    const src = w6Code.split('\n');
    console.log('  出错行: ' + src[+lineNo - 1]);
  }
}
if (ran) ok(true, 'w6 相关代码执行成功');
if (!ran) { console.log(`\n${'='.repeat(46)}\n❌ 1 项失败`); process.exit(1); }

console.log('\n=== 2. 关键回归：切换到模式 6 必须渲染出表格行 ===');
{
  const rows = doc.getElementById('w6Rows');
  rows.innerHTML = '';                       // 模拟「切过去还是空的」
  doc.getElementById('s_mode').value = '6';
  try { win.syncW5(); } catch (e) { ok(false, 'syncW5 抛错: ' + e.message); }
  const n = rows.querySelectorAll('[data-i]').length;
  ok(n === 6, `切到模式 6 后渲染出 6 行（实际 ${n}）`);
}

console.log('\n=== 3. 默认配置合计 = 100% ===');
{
  const sum = doc.getElementById('s_w6sum').value;
  ok(/100(\.0)?\s*✓/.test(sum), `合计框显示 100 且打勾（实际 "${sum}"）`);
}

console.log('\n=== 4. 预览不报「占比全为 0」===');
{
  const p = doc.getElementById('w6Preview').textContent;
  ok(p.indexOf('占比全为 0') < 0, '预览有实际分布（不是空表提示）');
  ok(/中位/.test(p), `预览含中位数：${p.slice(0, 60)}…`);
}

console.log('\n=== 5. 面板显隐正确 ===');
{
  doc.getElementById('s_mode').value = '6';
  win.syncW5();
  ok(doc.getElementById('w6Panel').style.display !== 'none', '模式 6 时 w6Panel 显示');
  ok(doc.getElementById('w5Panel').style.display === 'none', '模式 6 时 w5Panel 隐藏');

  doc.getElementById('s_mode').value = '5';
  win.syncW5();
  ok(doc.getElementById('w5Panel').style.display !== 'none', '模式 5 时 w5Panel 显示');
  ok(doc.getElementById('w6Panel').style.display === 'none', '模式 5 时 w6Panel 隐藏');
}

console.log('\n=== 6. 改输入框会更新合计与预览 ===');
{
  doc.getElementById('s_mode').value = '6';
  win.syncW5();
  const firstPct = doc.querySelector('#w6Rows [data-i="0"] [data-f="pct"]');
  ok(!!firstPct, '第一行的占比输入框存在（data-i 有效）');
  if (firstPct) {
    firstPct.value = '20';
    firstPct.dispatchEvent(new win.Event('input', { bubbles: true }));
    const sum = doc.getElementById('s_w6sum').value;
    ok(/110/.test(sum), `改 10→20 后合计变成 110（实际 "${sum}"）`);
    ok(/≠ 100|✗/.test(sum), '合计不等于 100 时有提示');
  }
}

console.log('\n=== 7. 加行 / 删行 ===');
{
  doc.getElementById('s_mode').value = '6';
  win.syncW5();
  const before = doc.getElementById('w6Rows').querySelectorAll('[data-i]').length;
  doc.getElementById('btnAddRow').dispatchEvent(new win.Event('click', { bubbles: true }));
  const after = doc.getElementById('w6Rows').querySelectorAll('[data-i]').length;
  ok(after === before + 1, `+ 加一行：${before} → ${after}`);
  doc.getElementById('btnDelRow').dispatchEvent(new win.Event('click', { bubbles: true }));
  const back = doc.getElementById('w6Rows').querySelectorAll('[data-i]').length;
  ok(back === before, `− 删最后一行：${after} → ${back}`);
}

console.log('\n=== 8. 加载时不隐藏 w6Body（按钮不会被藏掉）===');
{
  // 页面加载时 s_mode 还是数据库旧值（5），w6Preview() 会跑一次。
  // 如果那时把按钮 display:none，用户切到 6 之前按钮就是消失的。
  doc.getElementById('s_mode').value = '5';
  win.syncW5();
  const b1 = doc.getElementById('w6Body');
  ok(!!b1, 'w6Body 容器存在');
  doc.getElementById('s_mode').value = '6';
  win.syncW5();
  ok(b1.style.display !== 'none', '切到 6 后 w6Body（含按钮/合计/预览）显示');
  const addBtn = doc.getElementById('btnAddRow');
  ok(addBtn && addBtn.style.display !== 'none', '「+ 加一行」按钮本身未被 JS 单独隐藏');
}

console.log('\n=== 9. 切到模式 6 再切走再切回，行仍在 ===');
{
  doc.getElementById('s_mode').value = '5';
  win.syncW5();
  doc.getElementById('s_mode').value = '6';
  win.syncW5();
  const n = doc.getElementById('w6Rows').querySelectorAll('[data-i]').length;
  ok(n === 6, `来回切换后仍是 6 行（实际 ${n}）`);
}

console.log('\n=== 10. 下拉必须有 onchange 绑定（2026-09-29 事故根因）===');
{
  /**
   * 线上事故：这行绑定被我 patch 掉了 —— `$('#s_mode').onchange = ...`
   * 于是下拉能选能改 value，但切换时不触发任何刷新，
   * 表格不渲染、面板不显隐，表现为「切换没有用」。
   * 之前一直在 syncW5 函数体里找原因，问题却在函数外面那行绑定。
   */
  const sel = doc.getElementById('s_mode');
  const w6rows = doc.getElementById('w6Rows');
  ok(typeof sel.onchange === 'function', 's_mode 绑定了 onchange 处理器');

  // 模拟真实切换：改 value → 触发 change
  w6rows.innerHTML = '';
  sel.value = '6';
  let saved = null;
  win.call = function (path, body) { saved = { path, body }; return Promise.resolve({ ok: true }); };
  sel.dispatchEvent(new win.Event('change', { bubbles: true }));
  const n = doc.getElementById('w6Rows').querySelectorAll('[data-i]').length;
  ok(n === 6, `触发 change 后渲染出 6 行（实际 ${n}）`);
  ok(!!saved, '切换时自动发起保存请求（不用再手动点保存）');
  if (saved) {
    ok(saved.body.odds_mode === '6', `保存的 odds_mode = 6（实际 ${saved.body.odds_mode}）`);
    let t = null;
    try { t = JSON.parse(saved.body.odds_table_json); } catch (_) {}
    ok(Array.isArray(t) && t.length === 6, '同时保存了 6 行分布表');
  }
}

console.log('\n=== 11. 保存按钮路径仍然正确 ===');
{
  // 2026-09-29 线上事故：用户选了模式 6，保存后刷新又回到 5。
  // 根因之一是保存请求体没带上赔率字段（选择器取不到元素会抛错中断）。
  // 这里直接执行 onclick，检查发出去��� body。
  const btn = doc.getElementById('btnSaveOdds');
  // 让所有 $('s_xxx') 都有值，避免 undefined 抛错
  ['s_oddsval','s_min','s_max','s_bmin','s_bmax','s_baserand','s_rake','s_pool',
   's_wlow','s_wmid','s_whigh','s_wboom','s_wboommax','s_wlomin','s_wlomax',
   's_wmidmin','s_wmidmax','s_whimin','s_whimax','s_wtopmin','s_wtopmax',
   's_rmin','s_rmax'].forEach((id) => {
    if (!doc.getElementById(id)) {
      const d = doc.createElement('div');
      d.className = 'f';
      const i2 = doc.createElement('input');
      i2.id = id; i2.value = '1';
      d.appendChild(i2);
      doc.body.appendChild(d);
    }
  });
  let captured = null;
  win.call = function (path, body) {
    captured = { path, body };
    return Promise.resolve({ ok: true });
  };
  doc.getElementById('s_mode').value = '6';
  win.syncW5();
  // 给 mock 的表格填上真实的数值（w6RenderRows 会重建 DOM，填完再点）
  win.W6_DEFAULT = [
    { min: 1.00, max: 1.5, pct: 10, boom: true },
    { min: 1.5, max: 10, pct: 40 },
    { min: 10, max: 30, pct: 30 },
    { min: 30, max: 50, pct: 10 },
    { min: 50, max: 80, pct: 5 },
    { min: 80, max: 100, pct: 5 },
  ];
  win.w6RenderRows();
  try { btn.dispatchEvent(new win.Event('click', { bubbles: true })); }
  catch (e) { ok(false, '点击保存抛错: ' + e.message); }
  ok(!!captured, '保存请求已发出');
  if (captured) {
    ok(captured.path === '/admin/api/settings', 'POST 到 /admin/api/settings');
    ok(captured.body.odds_mode === '6', `body.odds_mode = 6（实际 ${captured.body.odds_mode}）`);
    let tbl = null;
    try { tbl = JSON.parse(captured.body.odds_table_json); } catch (_) {}
    ok(Array.isArray(tbl) && tbl.length === 6,
       `body.odds_table_json 是 6 行分布（实际 ${Array.isArray(tbl) ? tbl.length : '解析失败'}）`);
  }
}

console.log('\n=== 12. 手填下界真的生效（2026-09-30 新需求）===');
{
  /**
   * 用户要求「三列都手填」—— 以前下界是从上一行 max 推导的。
   * 这里验证下界框存在、值能读出来、能存进 body。
   */
  const sel = doc.getElementById('s_mode');
  sel.value = '6';
  win.syncW5();
  win.W6_DEFAULT = [
    { min: 1.00, max: 1.5, pct: 10, boom: true },
    { min: 1.5,  max: 10,  pct: 40 },
    { min: 10,   max: 30,  pct: 30 },
    { min: 30,   max: 50,  pct: 10 },
    { min: 50,   max: 80,  pct: 5 },
    { min: 80,   max: 100, pct: 5 },
  ];
  win.w6RenderRows();
  const first = doc.querySelector('#w6Rows [data-i="0"] [data-f="min"]');
  const second = doc.querySelector('#w6Rows [data-i="1"] [data-f="min"]');
  ok(!!first, '每行都有独立的下界输入框');
  ok(!!second, '第 2 行也有（不是只有第 1 行能填）');
  const read = win.w6Read();
  ok(read[0].min === 1.0 && read[1].min === 1.5,
     `w6Read() 读出下界（${read[0].min} / ${read[1].min}）`);
  // 改第 2 行下界为 2 → 读回应为 2
  second.value = '2';
  second.dispatchEvent(new win.Event('input', { bubbles: true }));
  ok(win.w6Read()[1].min === 2, '改第 2 行下界后 w6Read() 读到 2');
}

console.log('\n=== 13. 合计不等于 100 时前端必须拦下 ===');
{
  let cap = null;
  win.call = (path, body) => { cap = { path, body }; return Promise.resolve({ ok: true }); };
  win.W6_DEFAULT = [
    { min: 1.0, max: 1.5, pct: 10, boom: true },
    { min: 1.5, max: 10,  pct: 40 },
  ];
  win.w6RenderRows();
  doc.getElementById('s_mode').value = '6';
  doc.getElementById('btnSaveOdds').dispatchEvent(new win.Event('click', { bubbles: true }));
  ok(cap === null, `合计只有 50 时【没有】发请求（实际 ${cap ? '发了' : '已拦下'}）`);
}

console.log('\n=== 14. 上界不大于下界时前端必须拦下 ===');
{
  let cap = null;
  win.call = (path, body) => { cap = { path, body }; return Promise.resolve({ ok: true }); };
  win.W6_DEFAULT = [
    { min: 10, max: 5,  pct: 50, boom: false },
    { min: 10, max: 50, pct: 50 },
  ];
  win.w6RenderRows();
  doc.getElementById('s_mode').value = '6';
  doc.getElementById('btnSaveOdds').dispatchEvent(new win.Event('click', { bubbles: true }));
  ok(cap === null, `第 1 行上界 5 < 下界 10 时【没有】发请求（实际 ${cap ? '发了' : '已拦下'}）`);
}

console.log(`\n${'='.repeat(46)}`);
console.log(fail === 0 ? `✅ 全部通过：${pass}/${pass}` : `❌ ${fail} 项失败（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
