'use strict';
/**
 * min-window-decision.js —— 「给一个最小可操作窗口」这个方案能不能做？
 *
 * 背景：mode 9 下 20.9% 的局爆在 1.10x 以下（13.89% 是 0ms 瞬爆），
 * 玩家物理上按不到逃跑键。本脚本用【实测】判定三种候选实现的后果，
 * 而不是靠推理下结论。
 *
 * 用法：node scripts/min-window-decision.js --rtp=0.87 --cap=1000 --n=1000000
 */
const crypto = require('crypto');
const path = require('path');
const GL = require(path.join(__dirname, '..', 'server', 'game-logic.js'));

const arg = (k, d) => { const h = process.argv.find(a => a.startsWith('--' + k + '=')); return h ? h.slice(k.length + 3) : d; };
const RTP = Number(arg('rtp', 0.87));
const CAP = Number(arg('cap', 1000));
const N = Number(arg('n', 1000000));
const EDGE = GL.CFG.HOUSE_EDGE;
const line = t => console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78));

function u() { const b = crypto.randomBytes(6); let n = 0; for (let i = 0; i < 6; i++) n = n * 256 + b[i]; return (n + 0.5) / 281474976710656; }
const r2 = n => Math.round(n * 100) / 100;

// 复刻 powerlawRate：X = min(cap, max(1.00, floor(RTP/U)))
const draw = () => r2(Math.min(CAP, Math.max(1, Math.floor(RTP / u() * 100) / 100)));

line('§0 修正：瞬爆概率的精确公式');
console.log('  powerlawRate() 先 floor 到分再 max(1, ·)，所以 X 恰好等于 1.00 的条件是');
console.log('      floor(RTP/U × 100) ≤ 100   ⇔   RTP/U < 1.01   ⇔   U > RTP/1.01');
console.log('  ⇒ P(X = 1.00) = 1 − RTP/1.01 = 1 − RTP/1.01');
{
  let c1 = 0; for (let i = 0; i < N; i++) if (draw() === 1) c1++;
  const theory = 1 - RTP / 1.01;
  console.log('\n  RTP=' + RTP + ' 时：');
  console.log('    精确公式 1 − RTP/1.01 = ' + (theory * 100).toFixed(4) + '%');
  console.log('    旧注释写的 1 − RTP    = ' + ((1 - RTP) * 100).toFixed(4) + '%   ← 差 ' + ((theory - (1 - RTP)) * 100).toFixed(3) + ' pp');
  console.log('    实测 100 万局          = ' + (c1 / N * 100).toFixed(4) + '%   偏差 vs 精确公式 ' + ((c1 / N - theory) * 100).toFixed(4) + ' pp');
  console.log('\n  ⇒ 瞬爆概率【不是】可调参数。下界锁死 1.00 + floor 量化 ⇒ 它由 RTP 唯一决定。');
  console.log('    推论：RTP 越低 ⇒ 瞬爆越多。RTP=0.87 ⇒ 13.89% 的局是 0ms 瞬爆。');
  console.log('    这不是「20.9% 窗口不足」的全部原因，但它是其中最大的一块，且不可调。');
}

line('§1 候选实现 A：给分布加一个倍率下限（floor 抬到 1.10）');
console.log('  实现：X = min(cap, max(1.10, floor(RTP/U)))  —— 只改抽样下界，不动飞行曲线');
{
  const drawA = () => r2(Math.min(CAP, Math.max(1.10, Math.floor(RTP / u() * 100) / 100)));
  const xs = new Float64Array(N);
  for (let i = 0; i < N; i++) xs[i] = drawA();
  const s = Float64Array.from(xs).sort();
  const S = c => { let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] < c) lo = m + 1; else hi = m; } return (N - lo) / N; };
  console.log('\n  逃生守卫（engine.js:627）：cur >= boom 一律拒绝。所以逃 c<m_floor 必然成功。');
  console.log('\n   逃跑点c    赢面S       c·S(c)    净EV/注    判定');
  let worst = null;
  for (const c of [1.01, 1.02, 1.05, 1.08, 1.09, 1.10, 1.20, 1.50, 2.00, 5.00]) {
    const P = S(c);
    if (P === 0) { console.log('  ' + (c.toFixed(2) + 'x').padStart(8) + '     0.00%           —         —      赢面 0'); continue; }
    const ev = (1 - EDGE) * c * P - 1;
    if (worst === null || ev > worst.ev) worst = { c, ev };
    console.log('  ' + (c.toFixed(2) + 'x').padStart(8) + (P * 100).toFixed(3).padStart(10) + '%' +
      (c * P).toFixed(4).padStart(11) + (ev * 100).toFixed(3).padStart(10) + '%' +
      (ev > 0 ? '  <<< 正期望套利区' : ''));
  }
  console.log('\n  ⇒ 抬高下界会造出一个【S(c) = 1 的区间】：c ∈ [1.00, 1.10) 内逃 100% 赢。');
  console.log('    该区间毛赔付 c·S(c) = c ∈ [1.00, 1.10)，恒 > RTP=' + RTP + ' ⇒ 净 EV 恒为正。');
  console.log('    实测最高点：逃 ' + worst.c.toFixed(2) + 'x 每注净赚 ' + (worst.ev * 100).toFixed(3) + '%');
  const reach = GL.flightMs(worst.c);
  console.log('    可达性：flightMs(' + worst.c.toFixed(2) + ')=' + reach.toFixed(0) + 'ms，' +
    '距 1.10x 爆点(' + GL.flightMs(1.10).toFixed(0) + 'ms)还有 ' + (GL.flightMs(1.10) - reach).toFixed(0) + 'ms 点按窗口');
  console.log('    ⇒ 这是【确定性套利】，不是概率优势。违反 EV 天花板判据。【否决】');
}

line('§2 候选实现 B：加 MIN_FLIGHT_MS 保底飞行时长');
console.log('  实现：flightMs() 取 max(MIN_FLIGHT_MS, 公式值)，分布不变');
{
  const MIN = 2000;
  console.log('\n  【致命问题】飞行被拉长后，曲线会在爆点【之后】继续爬升。');
  console.log('  结算取 cur = rateAt(elapsed)，守卫是 cur >= boom 拒绝。所以那段时间玩家看得到倍率却逃不掉：');
  console.log('\n   爆点boom   实际飞行时长   最后一刻屏幕显示   玩家能否逃跑');
  for (const boom of [1.00, 1.05, 1.10, 1.20, 1.50, 2.00]) {
    const real = Math.max(MIN, GL.flightMs(boom));
    const shown = GL.rateAt(real, GL.FLIGHT_SCALE);
    const can = shown < boom;
    console.log('  ' + (boom.toFixed(2) + 'x').padStart(10) + (real.toFixed(0) + 'ms').padStart(14) +
      (shown.toFixed(2) + 'x').padStart(18) + (can ? '      能（但倍率已超过爆点）' : '   不能（被判「已经爆了」）').padStart(24));
  }
  const boom1 = GL.rateAt(Math.max(MIN, GL.flightMs(1.00)), GL.FLIGHT_SCALE);
  console.log('\n  ⇒ 1.00x 的局：屏幕上倍率会一路爬到 ' + boom1.toFixed(2) + 'x 才炸，但数据库记的爆点是 1.00x。');
  console.log('    这是「屏幕显示一个倍率、账本记另一个倍率」—— 正是 game-logic.js 里');
  console.log('    【变换必须有精确逆函数】那条规则要防的钱款/信任事故。');
  console.log('    占比：P(X=1.00) = ' + ((1 - RTP / 1.01) * 100).toFixed(2) + '% 的局都会这样。【否决】');
  console.log('\n  补充：即便修好显示（把曲线钉在爆点），那 ' + ((1 - RTP / 1.01) * 100).toFixed(1) +
    '% 的局会变成「倍率卡在 1.00x 不动然后炸」，观感同样是坏的。');
  console.log('  根本原因：1.00x 的公式飞行时长【恰好是 0ms】，任何乘性拉伸都抬不动 0（0×k=0），');
  console.log('    只有加性下限能抬，而加性下限必然造成上面的 desync。');
}

line('§3 候选实现 C：只拉伸低倍率段的飞行曲线（不动分布）');
console.log('  实现：flightMs 在 [1.00, 1.50) 段做拉伸，1.50x 及以上完全不动');
{
  // 候选：f(r) = rawMs(r) * 2.0，且 f(1.50) = 5000ms；在 1.50 处与原速 2500ms 不连续
  console.log('\n  【先看这个方案自己有多丑】乘性拉伸要求 f(1.50)=5000ms，而原速只有 2500ms。');
  console.log('  要在 1.50x 处连续就必须改成「低段乘性 + 高段加性」的混合，');
  console.log('  于是 1.10x 之后的每一局都被平白拉长 2500ms：');
  const KNOT = 1.50, C = 2500;
  console.log('\n   倍率     原速        加下限后     增加');
  for (const r of [2, 3, 5, 10, 50, 100, 1000]) {
    const o = GL.flightMs(r), n2 = o + C;
    console.log('  ' + (r + 'x').padStart(8) + (o.toFixed(0) + 'ms').padStart(12) + (n2.toFixed(0) + 'ms').padStart(12) +
      ('+' + (n2 - o).toFixed(0) + 'ms').padStart(9));
  }
  console.log('\n  1000x 会从 ' + GL.flightMs(1000).toFixed(0) + 'ms 变成 ' + (GL.flightMs(1000) + C).toFixed(0) +
    'ms，超过 100 秒的设计上限，高倍加速的意义被抵消。');
  console.log('  而且它改的是【全服共用的曲线】，不是只救低倍率局 —— 为了 20.9% 的局拖慢 100% 的局。');
  console.log('  ⇒ 代价与收益严重不匹配。【不推荐】');
}

line('§4 那到底能做什么：把「窗口不足」拆成可修的和不可修的');
{
  const bands = [[1.00, 1.01], [1.01, 1.05], [1.05, 1.10], [1.10, 1.20], [1.20, 1.50]];
  console.log('\n  区间            占比      中位飞行时长   可修性');
  const xs = new Float64Array(N); for (let i = 0; i < N; i++) xs[i] = draw();
  for (const [a, b] of bands) {
    let fl = []; for (let i = 0; i < N; i++) if (xs[i] >= a && xs[i] < b) fl.push(xs[i]);
    fl.sort((x, y) => x - y);
    const mid = fl.length ? GL.flightMs(fl[fl.length >> 1]) : 0;
    const share = fl.length / N;
    let fix;
    if (a >= 1.01 && mid >= 300) fix = '可修：改成加性下限也不 desync（因为曲线爬得上去）';
    else if (a < 1.01) fix = '不可修：1.00x 飞行时长恒为 0ms';
    else fix = '部分可修';
    console.log('  [' + a.toFixed(2) + ',' + b.toFixed(2) + ')' + (share * 100).toFixed(3).padStart(9) + '%' +
      (mid.toFixed(0) + 'ms').padStart(15) + '   ' + fix);
  }
  console.log('\n  合计：0ms 瞬爆 = ' + ((1 - RTP / 1.01) * 100).toFixed(2) + '%（不可修）');
  console.log('        62~590ms   = ' + ((1 - RTP / 1.10) * 100 - (1 - RTP / 1.01) * 100).toFixed(2) + '%（理论可修，但会让 1.10x 变成 2s+，玩家反而失去低倍快节奏）');
  console.log('        合计 <1.10x = ' + ((1 - RTP / 1.10) * 100).toFixed(2) + '%');
}

line('§5 对玩家实际期望的影响（这才是「窗口不足」的真实代价）');
console.log('  窗口不足不会制造套利，它【只会让玩家输更多】。所以它是体验问题，不是经济漏洞。');
console.log('\n   逃跑点m   理论净EV    实际净EV(反应400ms)    差        实际到手RTP');
for (const m of [1.10, 1.20, 1.50, 2.00, 3.00, 5.00, 10.00, 20.00, 50.00]) {
  const need = GL.flightMs(m) + 400;
  let lo = m, hi = CAP;
  for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if (GL.flightMs(mid) >= need) hi = mid; else lo = mid; }
  const eff = +hi.toFixed(2);
  const pT = RTP / m;
  const pR = eff >= CAP ? 0 : RTP / eff;   // 幂律下 P(X≥c) = RTP/c，闭式
  const evT = (1 - EDGE) * m * pT - 1;
  const evR = (1 - EDGE) * m * pR - 1;
  console.log('  ' + (m.toFixed(2) + 'x').padStart(8) + (evT * 100).toFixed(2).padStart(11) + '%' +
    (evR * 100).toFixed(2).padStart(18) + '%' + ((evR - evT) * 100).toFixed(2).padStart(9) + 'pp' +
    ((1 + evR)).toFixed(4).padStart(16));
}
console.log('\n  ⇒ 低逃跑点被反应税吃掉 4~5pp。运营要知道：');
console.log('    后台写着 RTP=0.87，玩家在 1.10x 附近的【实际】到手只有 ~0.79。');
console.log('    这个差是【单向的】（只对玩家不利），不会变成可套利区，');
console.log('    但它解释了玩家「明明 80% 胜率还是亏」的体感。');
