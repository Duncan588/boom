'use strict';
/**
 * 【2026-10-01】滑块「黏手」回归闸 —— 根因②的真实坐标模拟。
 *
 * ⚠️ 为什么不复制实现来测：上一版把 bindSlider() 的代码抄进测试文件，
 *    结果测试自己那份副本与源码悄悄漂移，测的是一个不存在的东西。
 *    正确形状是【读磁盘上真实的 app.js】、只提供 DOM 桩，让它自己跑。
 *
 * 覆盖三条根因：
 *   ① fill 的 transition: width  → 必须已删除（每帧追赶目标值 = 黏手）
 *   ② touchmove/mousemove 绑 window → 滑出边界后仍能继续拖
 *   ③ fill 缺 pointer-events:none → 手指压在填充层上时滑块按不动
 */
/**
 * 【2026-10-02 从 cache/ 迁到 test/】
 * ⚠️ 之前它放在 cache/ 下，而 cache/ 在 .gitignore 里 ——
 *    也就是说这个闸【从来没进过仓库】，只有本机跑得起来，别人拿不到。
 *    闸的价值在于别人也能跑，所以必须住在 test/。
 */
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

/* ---------- DOM 桩 ---------- */
var RECT = { left: 100, width: 200, top: 0, height: 52 };
var elHandlers = {};
var winHandlers = {};
var fillWidth = '0%';

function makeEl(id) {
  var el = {
    id: id,
    style: {},
    className: '',
    disabled: false,
    textContent: '',
    value: '',
    getBoundingClientRect: function () { return RECT; },
    setAttribute: function () {},
    addEventListener: function (ev, fn) {
      (elHandlers[id] = elHandlers[id] || {})[ev] = (elHandlers[id] || {})[ev] || [];
      elHandlers[id][ev].push(fn);
    }
  };
  Object.defineProperty(el.style, 'width', {
    set: function (v) { fillWidth = v; }, get: function () { return fillWidth; }
  });
  return el;
}
var els = {};
['betSlider', 'betSliderFill', 'betSliderLabel', 'actBtn', 'meCoins', 'meName', 'betsList', 'phase']
  .forEach(function (id) { els[id] = makeEl(id); });

function mkEvent(x, target, type) {
  var ev = {
    touches: [{ clientX: x, clientY: 10 }],
    changedTouches: [{ clientX: x, clientY: 10 }],
    clientX: x, clientY: 10, cancelable: true, target: target, type: type,
    prevented: false, key: '', shiftKey: false
  };
  ev.preventDefault = function () { this.prevented = true; };
  return ev;
}
function fireEl(id, evName, x) {
  var list = (elHandlers[id] || {})[evName] || [];
  var ev = mkEvent(x, els[id], evName);
  list.forEach(function (fn) { fn(ev); });
  return ev;
}
function fireWin(evName, x) {
  var list = winHandlers[evName] || [];
  var ev = mkEvent(x, null, evName);
  list.forEach(function (fn) { fn(ev); });
  return ev;
}

/* ---------- 全局桩 ---------- */
var S = { bet: 1, me: { coins: 1000 }, cfg: { flightScale: 2.5 } };
// ⚠️ Node 22+ 的 globalThis.navigator 是只读 getter，不能赋值。
//    这些桩只作为 new Function 的【形参】注入，不需要真的挂到 globalThis。
global.window = {
  addEventListener: function (ev, fn) { (winHandlers[ev] = winHandlers[ev] || []).push(fn); },
  removeEventListener: function () {},
  requestAnimationFrame: function () { return 0; },
  cancelAnimationFrame: function () {},
  performance: { now: function () { return 0; } },
  location: { hostname: '127.0.0.1', protocol: 'http:' },
  navigator: { userAgent: 'node' }
};
global.document = {
  activeElement: null,
  getElementById: function (id) { return els[id] || null; },
  /**
   * ⚠️ app.js 真正的 $ 是 `document.querySelector`（不是 getElementById）。
   *    桩只实现 getElementById 时，querySelector 返回 null ⇒
   *    `$('#betSlider')` 拿到 null ⇒ bindSlider 第一行就早退，
   *    一个监听都不注册 —— 而断言「el 上没有 touchmove」反而会通过，
   *    看起来像「修好了」。这正是「空样本恒真」那一类假绿。
   */
  querySelector: function (sel) {
    var m = /^#(.+)$/.exec(String(sel));
    return m ? (els[m[1]] || null) : null;
  },
  querySelectorAll: function () { return []; },
  createElement: function () { return makeEl('tmp'); },
  addEventListener: function () {},
  body: { classList: { add: function () {}, remove: function () {}, toggle: function () {} } }
};

/* ---------- 读磁盘上真实的 app.js，取出 bindSlider ---------- */
var src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
function extractFn(name) {
  var idx = src.indexOf('function ' + name + '(');
  if (idx < 0) throw new Error('app.js 里找不到 ' + name);
  var i = src.indexOf('{', idx), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(idx, j + 1);
}
var fnSrc = extractFn('bindSlider');

/* app.js 里 bindSlider 依赖的三个同级函数，按源码语义补齐（桩，不是副本） */
var deps = {
  sliderAmount: function sliderAmount(pct) {
    var c = (S.me && S.me.coins) || 0;
    if (c <= 0) return 0;
    if (pct >= 100) return c;
    return Math.round(c * pct / 100);
  },
  renderSlider: function renderSlider() {
    var c = (S.me && S.me.coins) || 0;
    var pct = c > 0 ? Math.max(0, Math.min(100, S.bet / c * 100)) : 0;
    els.betSliderFill.style.width = pct + '%';
    els.betSliderLabel.textContent = String(S.bet);
  },
  setBet: function setBet(v) { S.bet = Math.max(1, Math.round(v)); },
  applySlider: function applySlider(pct) {
    var p = Math.max(0, Math.min(100, pct));
    deps.setBet(deps.sliderAmount(p));
    deps.renderSlider();
  }
};

console.log('=== 前置：bindSlider 真的用了它依赖的东西（否则桩错了，测试无意义）===');
/**
 * ⚠️ sliderAmount 【不在】bindSlider 的源码里 —— 它由 applySlider 调用，
 * 而 applySlider 是模块级函数。写 /sliderAmount\(/ 去扫 bindSlider 会永远红，
 * 那是断言写错了，不是代码错了。要扫的是 applySlider 的源码。
 */
var applySrc = extractFn('applySlider');
t('bindSlider 调用了 applySlider', /applySlider\(/.test(fnSrc));
t('applySlider 调用了 sliderAmount', /sliderAmount\(/.test(applySrc), applySrc.trim());
t('源码里调用了 renderSlider', /renderSlider\(/.test(fnSrc));
t('applySlider 调用了 setBet', /setBet\(/.test(applySrc), applySrc.trim());
/**
 * ⚠️ 这里必须匹配 setBet( 而不是裸的 setBet：
 *   bindSlider 末尾是 `var origSetBet = setBet; setBet = function (v) {...}`
 *   —— 它【重新赋值】模块级 setBet 来做双向同步，源码里出现的是
 *   `origSetBet = setBet`（无左括号）。只查 /setBet\(/ 会漏掉这条，
 *   而这条正是「余额变化时填充要重绘」的实现。
 */
t('源码里包装了 setBet（双向同步）', /origSetBet\s*=\s*setBet/.test(fnSrc));
t('源码里给 setBet 重新赋值', /setBet\s*=\s*function/.test(fnSrc));

/**
 * ⚠️ 桩点唯一且必须是 document.querySelector：
 *   app.js 第 5 行 `var $ = function (s) { return document.querySelector(s); };`
 *   那个 var 遮蔽了任何同名形参。所以在工厂作用域里【重声明】一次 $，
 *   让它走我的 document 桩 —— 这样测的仍是「真实源码 + 真实选择器语义」。
 *   而 sliderAmount 必须一并注入：它不在 bindSlider 的作用域里。
 */
var factory = new Function(
  'window', 'document', 'navigator', 'performance', 'location',
  'requestAnimationFrame', 'cancelAnimationFrame', 'S', 'els', 'BET_MIN',
  'renderSlider', 'deps',
  'var $ = function (s) { return document.querySelector(s); };\n' +
  'var sliderAmount = deps.sliderAmount;\n' +
  'var applySlider = deps.applySlider;\n' +
  'var setBet = deps.setBet;\nvar sliderBound = false;\n' + fnSrc + '\nreturn bindSlider;'
);
var bindSlider = factory(
  global.window, global.document, { userAgent: 'node' },
  { now: function () { return 0; } },
  { hostname: '127.0.0.1', protocol: 'http:' },
  function () { return 0; }, function () {},
  S, els, 1,
  deps.renderSlider, deps
);

console.log('\n=== 根因②：move 监听必须绑 window，不是 el ===');
/* 显式调用并回报注册结果 —— 否则「一个监听都没注册」和「全部通过」
   在输出上长得一样，排查时要靠猜。 */
console.log('   [diag] typeof bindSlider = ' + typeof bindSlider +
  ', 传入 $ 的查询结果 = ' + (function (id) { return els[id] || null; })('betSlider'));
bindSlider();
console.log('   bindSlider() 已调用；window 监听：' +
  Object.keys(winHandlers).join(',') + ' / el 监听：' +
  Object.keys(elHandlers.betSlider || {}).join(','));
t('el 上没有 touchmove', !((elHandlers.betSlider || {}).touchmove || []).length,
  'el 上有 ' + ((elHandlers.betSlider || {}).touchmove || []).length + ' 个 ⇒ 滑出边界会卡住');
t('el 上没有 mousemove', !((elHandlers.betSlider || {}).mousemove || []).length);
t('window 上有 touchmove', (winHandlers.touchmove || []).length > 0);
t('window 上有 mousemove', (winHandlers.mousemove || []).length > 0);
t('touchstart 绑在 el 本体上', ((elHandlers.betSlider || {}).touchstart || []).length > 0);

console.log('\n=== 关键回归：手指滑出右边界后仍能继续拖 ===');
fireEl('betSlider', 'touchstart', RECT.left + RECT.width * 0.5);
var atPress = fillWidth;
fireWin('touchmove', RECT.left + RECT.width * 0.75);
var at75 = fillWidth;
fireWin('touchmove', 500);                 // 右边界 = 300，这里超出 200px
var afterOut = fillWidth;
console.log('   按下 50% → ' + atPress);
console.log('   拖到 75% → ' + at75);
console.log('   拖到 x=500（边界外 200px）→ ' + afterOut);
t('按下后填充 = 50%', atPress === '50%', atPress);
t('拖到 75% 后跟随', at75 === '75%', at75);
t('⚠️ 滑出右边界后仍跟随到 100%（黏手回归点）', afterOut === '100%', afterOut);
t('滑出边界后 S.bet = 全部余额 1000', S.bet === 1000, S.bet);

console.log('\n=== 左边界外同样跟随，且下限保 1 ===');
fireEl('betSlider', 'touchstart', RECT.left + RECT.width * 0.5);
fireWin('touchmove', -500);
console.log('   拖到 x=-500 → ' + fillWidth + ' / bet=' + S.bet);
/**
 * ⚠️ 这里【不能】断言 0% —— S.bet 有下限 1（客户要求 6），
 * 而余额是 1000，于是 1/1000 = 0.1%。「百分比趋零」与「百分比恰好 0」
 * 是两件事，前者才是需求。写死 0% 会得到一个永远红的假断言。
 */
t('拖到左边界外 → 填充趋零（≤0.5%，bet 已到下限 1）',
  parseFloat(fillWidth) <= 0.5, fillWidth);
t('下限保 1（不为 0）', S.bet === 1, S.bet);

console.log('\n=== touchmove 必须 preventDefault（防移动端页面滚动）===');
fireEl('betSlider', 'touchstart', RECT.left + RECT.width * 0.5);
var ev1 = fireWin('touchmove', RECT.left + RECT.width * 0.6);
t('touchmove 调用了 preventDefault', ev1.prevented === true, ev1.prevented);

console.log('\n=== 松手后不再跟随（不能一直黏着）===');
fireEl('betSlider', 'touchstart', RECT.left + RECT.width * 0.5);
fireWin('touchend', RECT.left + RECT.width * 0.5);
var before = fillWidth;
fireWin('touchmove', RECT.left + RECT.width);
t('touchend 后再 move 不再改变填充', fillWidth === before, before + ' → ' + fillWidth);

console.log('\n=== 鼠标同病 ===');
fireEl('betSlider', 'mousedown', RECT.left + RECT.width * 0.2);
fireWin('mousemove', RECT.left + RECT.width);
console.log('   mousedown 20% 后拖到最右 → ' + fillWidth);
t('鼠标拖到边界外仍跟随到 100%', fillWidth === '100%', fillWidth);

/**
 * ===== 客户实测追加的两条验收（2026-10-02）=====
 * ② 松手后滑块停在松手位置，不自己继续跑、不回弹
 * ③ 松手后重新按住还能继续拖（不要「一次拖完就失效」）
 * 上一版闸只验了「滑出边界仍跟随」，没验这两条 —— 它们是不同的失效形状。
 */
console.log('\n=== 验收②：松手后不回弹、不自己继续跑 ===');
fireEl('betSlider', 'touchstart', RECT.left + RECT.width * 0.3);
fireWin('touchmove', RECT.left + RECT.width * 0.6);
var atRelease = fillWidth;
fireWin('touchend', RECT.left + RECT.width * 0.6);
console.log('   松手时填充 = ' + atRelease);
// 松手后再来一批 move，填充必须纹丝不动
for (let x = RECT.left; x <= RECT.left + RECT.width; x += 20) {
  fireWin('touchmove', x);
  fireWin('mousemove', x);
}
console.log('   松手后再扫一遍全区间 → ' + fillWidth);
t('松手后填充不变（不回弹、不继续跑）', fillWidth === atRelease,
  atRelease + ' → ' + fillWidth);
t('松手后 S.bet 不变', S.bet === Math.round(1000 * 0.6), S.bet);

console.log('\n=== 验收③：重新按住能继续拖（不是一次拖完就失效）===');
fireEl('betSlider', 'touchstart', RECT.left + RECT.width * 0.15);
var rePress = fillWidth;
fireWin('touchmove', RECT.left + RECT.width * 0.45);
var afterReDrag = fillWidth;
console.log('   重新按下 15% → ' + rePress + '，再拖到 45% → ' + afterReDrag);
t('重新按下立即生效', rePress === '15%', rePress);
t('重新按住后能继续拖到 45%', afterReDrag === '45%', afterReDrag);

// 连续三轮「按下→拖→松手」，确认不是只有第一轮有效
var okRounds = 0;
for (let k = 0; k < 3; k++) {
  const p = 0.2 + k * 0.25;
  fireEl('betSlider', 'touchstart', RECT.left + RECT.width * p);
  fireWin('touchmove', RECT.left + RECT.width * p);
  fireWin('touchend', RECT.left + RECT.width * p);
  if (Math.abs(parseFloat(fillWidth) - p * 100) < 0.5) okRounds++;
}
console.log('   连续三轮 drag 命中 ' + okRounds + '/3');
t('连续三轮按下-拖-松手都生效', okRounds === 3, okRounds + '/3');

console.log('\n=== 根因①③：CSS 静态核（先剥注释再断言）===');
var css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'game.css'), 'utf8');
var cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');   // ⚠️ 不剥注释会被注释里的字面量命中
function body(sel) {
  var i = cssCode.indexOf(sel);
  if (i < 0) return '';
  var b = cssCode.indexOf('{', i), e = cssCode.indexOf('}', b);
  return cssCode.slice(b, e);
}
var fillBody = body('.ios-slider-fill'), labBody = body('.ios-slider-label'), slBody = body('.ios-slider');
t('fill 无 transition: width（黏手主因）', !/transition[^;]*width/.test(fillBody), fillBody.trim());
t('fill 有 pointer-events: none', /pointer-events:\s*none/.test(fillBody), fillBody.trim());
t('label 有 pointer-events: none', /pointer-events:\s*none/.test(labBody), labBody.trim());
t('滑块有 touch-action: none', /touch-action:\s*none/.test(slBody), slBody.trim());
t('滑块高度 52px（≥44px 触摸目标）', /height:\s*52px/.test(slBody), slBody.trim());

console.log('\n' + (fail ? '❌' : '✅') + ' 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
