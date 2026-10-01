'use strict';
/**
 * 幂律分布（mode 9）验证
 *
 * 跑 100 万局，验证两条不变量 + 三个边界性质。
 *
 * 【为什么断言「毛赔付恒定」而不是「各逃跑点净 EV 相等」】
 * 两者都是真的，但后者是【本模式的结论】，前者是它成立的原因。
 * 而且净 EV 那条最容易在推导时漏掉「输掉的那一支」：
 *   错：EV(m) = P·(0.97m−1)            → 得出「逃得越高越好」的错误结论
 *   对：EV(m) = P·(0.97m−1) + (1−P)·(−1) = 0.97·m·P − 1 = 0.97·RTP − 1
 * 补上那一支之后 m 整个约掉。§2 用【仿真】而不是闭式来验证 EV，
 * 正是为了让这个减法写错时被抓住 —— 靠注释提醒是不够的。
 *
 * 【容差怎么来的 —— 不要拍脑袋】
 * 计数型估计 P̂ = k/N 的相对标准误是 sqrt((1−p)/(N·p))。
 * N=1e6、m=100 时 p≈0.0097 ⇒ σ_rel ≈ 1.02% ⇒ 3σ ≈ 3.1%。
 * 所以统一用 ±3.5%：既能抓住真实分布形状错误（那些偏差是 8%~83% 量级），
 * 又不会在纯采样噪声下随机红。floor 取整带来的系统性偏低在最靠近 cap 的
 * m=100 处约 −1%，也在这个带内。
 */
const G = require('../server/game-logic');
const { powerlawRate, payout, normRtp, POWERLAW } = G;

const N = 1_000_000;
const RTP = 0.97;
const CAP = 120;
const TOL = 0.035;               // ±3.5%，≈3σ @N=1e6,m=100
const TARGETS = [1.5, 2, 5, 10, 30, 100];

let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + m + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + m + (extra ? '  ' + extra : '')); }
};

console.log(`\n=== 幂律分布验证：${N.toLocaleString()} 局，RTP=${RTP}，上限=${CAP}x ===`);

// ---- 采样 ----
const rates = new Float64Array(N);
for (let i = 0; i < N; i++) rates[i] = powerlawRate(RTP, CAP);

/** 排序一次，之后用二分查 P(X >= m) */
const sorted = Array.prototype.slice.call(rates).sort((a, b) => a - b);
function pGe(m) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < m) lo = mid + 1; else hi = mid; }
  return (sorted.length - lo) / sorted.length;
}

// ---- §1 毛赔付恒定：P(X>=m)·m ≈ RTP ----
console.log('\n=== §1 不变量①：毛赔付 P(爆点≥m)×m 对所有 m 恒等于 RTP ===');
console.log('   m        P(爆点≥m)   理论 RTP/m    偏差      毛赔付 P·m');
let worstGross = 0, worstM = 0;
for (const m of TARGETS) {
  const p = pGe(m);
  const th = RTP / m;
  const rel = (p / th - 1);
  const gross = p * m;
  if (Math.abs(rel) > Math.abs(worstGross)) { worstGross = rel; worstM = m; }
  console.log(
    String(m).padStart(5),
    p.toFixed(5).padStart(12),
    th.toFixed(5).padStart(12),
    ((rel * 100).toFixed(3) + '%').padStart(9),
    gross.toFixed(4).padStart(12),
  );
  ok(Math.abs(rel) <= TOL, `m=${m}x 的 P 与理论 RTP/m 一致`, `偏差 ${(rel * 100).toFixed(3)}%`);
  ok(Math.abs(gross - RTP) <= RTP * TOL, `m=${m}x 的毛赔付 ≈ RTP`, gross.toFixed(4));
}
console.log(`   最大偏差 ${(worstGross * 100).toFixed(3)}% @ m=${worstM}x（容差 ±${(TOL * 100).toFixed(1)}%）`);

// ---- §2 不变量②：净期望恒定（必须含输掉那一支）----
console.log('\n=== §2 不变量②：净期望 EV 对所有 m 【完全相同】（含输掉那一支）===');
console.log('   m        P(爆点≥m)     净EV/注      毛赔付');
const evs = [];
for (const m of TARGETS) {
  const p = pGe(m);
  // ✅ 正确：赢的那一支 + 输掉的那一支
  const ev = p * (payout(1, m) - 1) + (1 - p) * (-1);
  evs.push({ m, ev });
  console.log(
    String(m).padStart(5),
    p.toFixed(5).padStart(12),
    ev.toFixed(5).padStart(12),
    (p * m).toFixed(4).padStart(12),
  );
}
const evVals = evs.map((x) => x.ev);
const evMin = Math.min(...evVals), evMax = Math.max(...evVals);
const evMean = evVals.reduce((a, b) => a + b, 0) / evVals.length;
console.log(`   净EV 区间 [${evMin.toFixed(5)}, ${evMax.toFixed(5)}]，跨度 ${((evMax - evMin) * 100).toFixed(3)}%`);
ok(evMax - evMin <= 0.03, '所有逃跑点的净期望差异 ≤ 3 个百分点（≈3σ）', `跨度 ${((evMax - evMin) * 100).toFixed(3)}%`);
// 与闭式解 0.97·RTP − 1 对照（这一条会抓住「漏了 (1−P)·(−1)」的写法）
const evTheory = payout(1, 1) * RTP - 1;
ok(Math.abs(evMean - evTheory) <= 0.01,
  '净期望均值 = 0.97×RTP − 1（漏掉输掉那一支会差约 1.0）',
  `实测 ${evMean.toFixed(5)} vs 理论 ${evTheory.toFixed(5)}`);
ok(evTheory < 0, '默认 RTP 下玩家净期望为负（庄家有优势）', evTheory.toFixed(4));

// ---- §3 固定逃跑点玩家之间无显著差异 ----
const PER = 100000;
console.log(`\n=== §3 「固定逃跑点」策略对比：各 ${PER} 局 ===`);
/**
 * 每个逃跑目标各 10 万局，比较平均净收益。
 *
 * 【阈值必须从 binomial σ 算出来，不能拍脑袋 —— 这是本节第一版踩的坑】
 * 第一版用固定 ±0.03，m=100 时那只有 1.0σ ⇒ 半数运行必然红。
 * 而实测分布毫无问题。σ 的算法：
 *   胜局数 ~ Binomial(N, p)，σ(胜局数) = sqrt(N·p·(1−p))
 *   每多赢一局，EV 变化 (payout(1,m) − 1 + 1) / N
 *   ⇒ σ(EV/注) = sqrt(N·p(1−p)) · payout(1,m) / N
 * 判据用 4σ：真实的分布形状错误会差 8%~83%，采样噪声不会。
 */
const strategies = TARGETS.map((m) => {
  let net = 0, wins = 0;
  for (let i = 0; i < PER; i++) {
    const x = powerlawRate(RTP, CAP);
    if (x >= m) { net += payout(1, m) - 1; wins++; } else { net -= 1; }
  }
  const p = wins / PER;
  const sigma = Math.sqrt(PER * p * (1 - p)) * payout(1, m) / PER;   // 单位：注
  return { m, net: net / PER, wins: p, sigma };
});
console.log('   逃跑点     平均净收益/注   胜率        理论胜率      σ(EV)    4σ 带');
for (const s of strategies) {
  const th = RTP / s.m;
  console.log(
    (s.m + 'x').padStart(7),
    s.net.toFixed(5).padStart(14),
    (s.wins * 100).toFixed(2) + '%',
    (th * 100).toFixed(2) + '%',
    s.sigma.toFixed(5).padStart(11),
    '±' + (4 * s.sigma).toFixed(5),
  );
}
const nets = strategies.map((s) => s.net);
const nMin = Math.min(...nets), nMax = Math.max(...nets);
// 逐个策略与闭式解比，带宽用它自己的 4σ（m 越大 σ 越大，不能共用一个带）
let allWithin = true;
for (const s of strategies) {
  if (Math.abs(s.net - evTheory) > 4 * s.sigma) allWithin = false;
}
ok(allWithin, '每个固定逃跑点的实测平均净收益都落在自己的 4σ 带内（= 0.97×RTP−1）',
  strategies.map((s) => `${s.m}x:${((s.net - evTheory) / s.sigma).toFixed(1)}σ`).join(' '));
// 策略间的最大差距，也按【最宽的那个 σ】judge
const widest = Math.max(...strategies.map((s) => s.sigma));
ok(nMax - nMin <= 4 * widest,
  '没有任何一个逃跑点显著优于其它（差距 ≤ 最宽策略的 4σ）',
  `最大差距 ${((nMax - nMin) * 100).toFixed(3)}% vs 4σ=${(4 * widest).toFixed(5)}`);

// ---- §4 边界性质 ----
console.log('\n=== §4 边界与实现约束 ===');
ok(sorted[0] >= 1, '最小倍率 ≥ 1.00', String(sorted[0]));
ok(sorted[N - 1] <= CAP + 1e-9, '最大倍率 ≤ 上限', String(sorted[N - 1]));
const atCap = sorted.filter((v) => v >= CAP).length / N;
const inst = sorted.filter((v) => v <= 1).length / N;
/**
 * ⚠️ 瞬爆率的【精确】公式是 1 − RTP/1.01，不是 1 − RTP。
 *
 * powerlawRate() 先 floor 到分再 max(1,·)，所以 X 恰好等于 1.00 的条件是
 *     floor(RTP/U × 100) ≤ 100  ⇔  RTP/U < 1.01  ⇔  U > RTP/1.01
 * 而 U 均匀分布在 (0,1) 上，所以 P(X = 1.00) = 1 − RTP/1.01。
 *
 * RTP=0.97 时旧公式给 3.00%，精确值是 3.96% —— 差 0.96 个百分点。
 * 第一版把判据写成 1−RTP，容差又被放到 0.02，于是这个系统性偏差
 * 长期藏在容差里：测试一直绿，但报的数是错的。
 * 正确的做法是把理论值换成闭式解，容差收紧到采样噪声量级。
 */
const BOOM_THEORY = 1 - RTP / 1.01;
console.log(`   触顶 ${(atCap * 100).toFixed(3)}%　瞬爆 ${(inst * 100).toFixed(2)}%（理论 ${(BOOM_THEORY * 100).toFixed(2)}% = 1 − RTP/1.01）`);
ok(Math.abs(inst - BOOM_THEORY) < 0.005, '瞬爆率 ≈ 1 − RTP/1.01（精确闭式，不是 1 − RTP）', `${(inst * 100).toFixed(2)}%`);
ok(atCap > 0, '上限之上确实存在被截断的质量（不是永远撞不到 cap）');

// RTP 上下限
ok(normRtp(0.01) === POWERLAW.RTP_MIN, 'RTP 下限 0.80 生效', String(normRtp(0.01)));
ok(normRtp(5) === POWERLAW.RTP_MAX, 'RTP 上限 1.00 生效（超过会给所有人保证盈利）', String(normRtp(5)));
ok(normRtp('abc') === POWERLAW.RTP_DEFAULT, '非法 RTP 落到默认 ' + POWERLAW.RTP_DEFAULT, String(normRtp('abc')));
// ⚠️ 这条钉住「默认值不会悄悄漂移」。0.87 是老板 2026-10-01 定案的运营默认值
// （曾一度写成 1.00，同日老板拍板改回）。改动它必须连同注释、
// admin 文案、migrate 脚本默认值一起改，不能只改数字。
ok(POWERLAW.RTP_DEFAULT === 0.87, '运营默认 RTP = 0.87（老板 2026-10-01 定案）', String(POWERLAW.RTP_DEFAULT));
ok(POWERLAW.CAP_DEFAULT === 1000, '倍率上限默认 = 1000', String(POWERLAW.CAP_DEFAULT));

// ---- §5 不用 Math.random ----
console.log('\n=== §5 随机源 ===');
let usedMathRandom = 0;
const orig = Math.random;
Math.random = function () { usedMathRandom++; return orig(); };
try {
  for (let i = 0; i < 2000; i++) powerlawRate(RTP, CAP);
} finally {
  Math.random = orig;
}
ok(usedMathRandom === 0, 'powerlawRate() 一次 Math.random 都没调用（必须走 CSPRNG）', `调用 ${usedMathRandom} 次`);

// 两个相邻样本必须不同（若用可预测序列会立刻暴露）
/**
 * ⚠️ 【不能用「200 局里有 >150 个不同值」当随机性判据 —— 那是错的】
 * 幂律把 35% 的概率质量压在 1.00–1.50 这 50 个分值上，
 * 所以 200 局里必然有大量碰撞。实测不同值 147/200，而这是【正确】的。
 *
 * 判据改成两条真正能抓住「不随机」的性质：
 *   ① 无周期性：任何短周期都不成立（常量、循环、往返都会被抓住）
 *   ② 分布形状：整体样本的 P(X≥m) 仍等于 RTP/m（§1 已断言，这里再抽查一次）
 */
const seq = [];
for (let i = 0; i < 2000; i++) seq.push(powerlawRate(RTP, CAP));

let periodicPeriod = null;
for (const per of [2, 3, 4, 5, 7, 10, 20, 50]) {
  let allSame = true;
  for (let i = per; i < seq.length; i++) if (seq[i] !== seq[i - per]) { allSame = false; break; }
  if (allSame) { periodicPeriod = per; break; }
}
ok(periodicPeriod === null, '2000 局序列无任何短周期（2/3/4/5/7/10/20/50）',
  periodicPeriod === null ? '确认无周期' : `⚠ 周期 ${periodicPeriod}`);

const distinct = new Set(seq).size;
const distinctPct = distinct / seq.length;
console.log(`   2000 局的不同值 ${distinct}（${(distinctPct * 100).toFixed(1)}%）`);
/**
 * ⚠️ 这个判据必须【随样本量缩放】，写死必然误报。
 *
 * 幂律把 35% 的质量压在 1.00–1.50 这 51 个格点上，每格约 0.7%，
 * 所以 2000 局里约 707 局挤在 51 个格子里 —— 碰撞是【正确形态】。
 * 实测不同值的占用率随 N 亚线性下降（2000→33%、10k→16%、50k→6.7%、300k→2.4%），
 * 所以固定阈值只会在某个 N 上碰巧通过，换个 N 就红。
 *
 * 真正想抓的是「输出退化成常量或少数几个值循环」，而那已经被
 * 上面的周期性检查覆盖了。这里只做一个宽松的、与 N 成正比的下界。
 */
ok(distinctPct > 0.15, '不同值占比 > 15%（不是常量/少数值循环）', `${(distinctPct * 100).toFixed(1)}%`);

// 1.00x 的占比应等于 1−RTP/1.01（瞬爆）。见 §4 里 BOOM_THEORY 的推导。
const oneCount = seq.filter((v) => v === 1).length / seq.length;
console.log(`   1.00x（瞬爆）占比 ${(oneCount * 100).toFixed(2)}%（理论 1−RTP/1.01 = ${((1 - RTP / 1.01) * 100).toFixed(2)}%）`);
ok(Math.abs(oneCount - (1 - RTP / 1.01)) < 0.015, '1.00x 的占比 ≈ 1 − RTP/1.01（由 floor 量化 + max(1,·) 共同产生）',
  `${(oneCount * 100).toFixed(2)}%`);

// 相邻完全相同的比例：应有下限（1.00 独占约 4%）但不该高
let adjSame = 0;
for (let i = 1; i < seq.length; i++) if (seq[i] === seq[i - 1]) adjSame++;
const adjPct = adjSame / (seq.length - 1);
console.log(`   相邻两局完全相同 ${adjSame}/${seq.length - 1} = ${(adjPct * 100).toFixed(2)}%`);
ok(adjPct < 0.10, '相邻重复率 < 10%（不是每两局就重样）', `${(adjPct * 100).toFixed(2)}%`);

// ============================================================
// §6 出厂默认值（2026-10-01 定稿：RTP=1.00 / cap=1000）
// ============================================================
//
// ⚠️【为什么 §1–§5 不能用出厂值】§1–§5 用 RTP=0.97/CAP=120，因为它检验的是
// 「公式本身对不对」，两个值都是任意选的。换成别的 RTP/cap 那些断言照样成立
// （不变量与参数无关），但【采样噪声会变大】：cap=1000 时 m=100 的胜率只有
// 同样的量级，N=1e6 下尾部各档的相对误差更大。
// 所以这里单独一节，用出厂值跑【产品口径】的断言，两者互不干扰。
//
// 【这一节钉的是「老板拍的那两个数字真的生效了」】
// 光有 §1–§5 时，把 POWERLAW.RTP_DEFAULT 误改回 0.97 不会有任何测试变红 ——
// 因为那些测试根本不读默认值。默认值就是【线上真实配置】，必须单独钉。
console.log(`\n=== §6 出厂默认值实测：RTP=${POWERLAW.RTP_DEFAULT} / cap=${POWERLAW.CAP_DEFAULT} ===`);

const M = 500_000;
const dflt = new Float64Array(M);
for (let i = 0; i < M; i++) dflt[i] = powerlawRate();     // 不传参 = 走出厂默认
const dSorted = Array.prototype.slice.call(dflt).sort((a, b) => a - b);
const dPct = (p) => dSorted[Math.min(M - 1, Math.floor(p * M))];
const dShare = (f) => dflt.filter(f).length / M;

console.log(`   p50=${dPct(0.5)}  p90=${dPct(0.9)}  p99=${dPct(0.99)}  最大=${dSorted[M - 1]}`);
console.log(`   瞬爆(<1.10x)=${(dShare(v => v < 1.10) * 100).toFixed(2)}%  ` +
  `≥50x=${(dShare(v => v >= 50) * 100).toFixed(2)}%  ≥125x=${(dShare(v => v >= 125) * 100).toFixed(2)}%`);

// 不传参时拿到的就是出厂值（这是「默认生效」的定义，不是数值巧合）
ok(dSorted[M - 1] > 120, '不传参时上限确实是 1000 量级（>120），出厂 cap 不是 120',
  `最大 ${dSorted[M - 1]}`);
ok(dPct(0.5) < 2.5, '出厂中位数 < 2.5x（日常不会天天见高倍）', String(dPct(0.5)));

// 瞬爆率必须跟 1 − RTP 挂钩。RTP=1.00 ⇒ 约 0.99%。
// 这条能抓住「只改了 RTP_DEFAULT 常量、忘了改别处」或「瞬爆被写死成 3%」。
//
// ⚠️【口径别搞混 —— 我第一版就写错了】瞬爆是 X ≤ 1.00（飞行 0ms），
// 它的概率是 1 − RTP/1.01（不是 1 − RTP，floor 到分 + max(1,·) 差这一点），
// 实测 13.9%。而上面打印的 <1.10x = 20.90% 是另一个量：1.00–1.10 这一档
// 加上瞬爆，窗口 0–1 秒。两个数字都对，但混用就会把断言写成永远红。
const instExact = dShare(v => v <= 1.00);
const instTh = 1 - POWERLAW.RTP_DEFAULT / 1.01;
console.log(`   真·瞬爆(X≤1.00)=${(instExact * 100).toFixed(2)}%  理论 ${(instTh * 100).toFixed(2)}%`);
// ⚠️【2026-10-01 收口：容差 0.02 → 0.005】原来写 0.02，在 N=50 万下相当于
// 41σ —— 那不是容差，是「什么都抓不到」。而 1−RTP 与 1−RTP/1.01 在低 RTP 时
// 差 0.86pp = 17.6σ，0.02 能盖住它、0.005 抓得住。
// σ = √(p(1−p)/N) = √(0.1386×0.8614/500000) = 4.9e-4 ⇒ 0.005 = 10σ。
ok(Math.abs(instExact - instTh) < 0.005,
  '出厂瞬爆率 ≈ 1 − RTP/1.01（1.00 → 0.99%，不是 1−RTP 的 0.00%）',
  `实测 ${(instExact * 100).toFixed(2)}%`);

/**
 * ⚠️【尾部可达性 —— §15b 那个盲点必须在这里钉住】
 *
 * 「配置了 1000 但实测最高只到 20」这个缺陷，读审计（分支有没有读这个键）
 * 完全查不出来 —— 分支读了、clamp 也对，只是【生成器】产出不到那么高。
 * 所以唯一有效的判据是尾部实测：≥125x 的局数必须非零，且量级接近 RTP/125。
 *
 * 理论 P(X≥m) = RTP/m ⇒ m=125 时 0.696%。N=50 万 ⇒ 期望 3480 局，
 * σ = √(3480) ≈ 59 ⇒ ±3σ 约 3.4%。用相对判据而不是绝对阈值。
 */
const tail125 = dShare(v => v >= 125);
const th125 = POWERLAW.RTP_DEFAULT / 125;
console.log(`   ≥125x 实测 ${(tail125 * 100).toFixed(3)}% / 理论 ${(th125 * 100).toFixed(3)}%`);
ok(tail125 > 0 && Math.abs(tail125 / th125 - 1) < 0.20,
  '尾部可达：≥125x 的局数与理论同量级（cap=1000 真的出得来高倍）',
  `实测 ${(tail125 * 100).toFixed(3)}% vs 理论 ${(th125 * 100).toFixed(3)}%`);

// 高倍档也要有，不能只有 125–200 这一段（八档直方图里 500–1000 曾是空档）
const tail500 = dShare(v => v >= 500);
ok(tail500 > 0, `最高档不是空的（≥500x 出现了 ${(tail500 * 100).toFixed(3)}%）`);

// 八档空档检查：任何一档低于 0.5% 就是玩家能看见的「习惯区间」边界
console.log('   --- 八档直方图 ---');
const BANDS = [[1, 1.1], [1.1, 2], [2, 5], [5, 10], [10, 50], [50, 100], [100, 500], [500, 1000.01]];
let holes = [];
for (const [a, b] of BANDS) {
  const p = dShare(v => v >= a && v < b);
  console.log(`     ${String(a).padStart(4)}–${String(b).padEnd(7)} ${(p * 100).toFixed(3).padStart(7)}%` +
    (p < 0.005 ? '  ❌ 空档' : ''));
  if (p < 0.005) holes.push(`${a}–${b}`);
}
// 最高档天然只有 0.19%，它是 cap 的截断面而不是「生成不到」—— 排除它，
// 剩下 7 档任何一档为空都说明分布被某个机制挖掉了。
const holesReal = holes.filter(h => !h.startsWith('500'));
ok(holesReal.length === 0, '前七档无空档（玩家看不见可辨识的区间边界）',
  holesReal.length ? holesReal.join(', ') : '确认无');

console.log('\n' + '='.repeat(52));
console.log(`  通过 ${pass}  失败 ${fail}`);
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);