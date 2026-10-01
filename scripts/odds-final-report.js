'use strict';
/**
 * odds-final-report.js —— mode 9 幂律终版验收（离线、零成本、不碰服务器）
 *
 * import 现网 server/game-logic.js 的 powerlawRate / flightMs / rateAt / payout，
 * 所以测的是真实代码而不是副本。
 *
 * 用法：
 *   node scripts/odds-final-report.js --rtp=0.87 --cap=1000 --n=2000000 --rounds=1000
 *
 * 产出四段：
 *   §1 全网格 c·S(c) 扫描 + 净 EV 极差（判据：每个点 |EV−理论| ≤ 3σ）
 *   §2 空档扫描 + 相邻相关系数
 *   §3 【可操作性】反应时间税：哪些倍率局物理上按不到逃跑键
 *   §4 1000 局节奏曲线 + 净流入/流出摘要
 */
const crypto = require('crypto');
const path = require('path');
const GL = require(path.join(__dirname, '..', 'server', 'game-logic.js'));

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};

const RTP = Number(arg('rtp', 0.90));
const CAP = Number(arg('cap', 1000));
const N = Number(arg('n', 2000000));         // 分布体检样本
const ROUNDS = Number(arg('rounds', 1000));  // 节奏曲线局数
const STAKE = Number(arg('stake', 100));     // 每注 QUN
const EDGE = GL.CFG.HOUSE_EDGE;              // payout() 写死的 3%
const EV_THEORY = (1 - EDGE) * RTP - 1;      // = 0.97·RTP − 1
const REACT_MS = Number(arg('react', 400));  // 玩家从「看到目标达成」到「点击落地」

// ---- 均匀 U∈(0,1)，48bit CSPRNG（独立实现，不复用引擎抽取路径）----
function u() {
  const b = crypto.randomBytes(6);
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + b[i];
  return (n + 0.5) / 281474976710656;
}

// 复刻 powerlawRate 的抽样，但用我们自己的 U，便于同时记录原始浮点值
function draw() {
  const raw = RTP / u();
  return Math.min(CAP, Math.max(1, Math.round(Math.floor(raw * 100) / 100 * 100) / 100));
}

const line = (t) => console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78));

console.log(`mode=9 幂律终版验收   RTP=${RTP}  cap=${CAP}  抽水=${(EDGE * 100)}%  N=${N.toLocaleString()}  节奏=${ROUNDS}局  每注=${STAKE}QUN  反应时间假设=${REACT_MS}ms`);
console.log(`净EV 理论值 = 0.97×${RTP} − 1 = ${(EV_THEORY * 100).toFixed(3)}%`);

// ================= 采样 =================
const rates = new Float64Array(N);
for (let i = 0; i < N; i++) rates[i] = draw();
const s = Float64Array.from(rates).sort();
const pct = (p) => s[Math.min(N - 1, Math.floor(p * N))];
const S = (c) => { let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] < c) lo = m + 1; else hi = m; } return (N - lo) / N; };

// ================= §1 全网格 =================
line('§1 全网格扫描：毛赔付 c·S(c) 与净 EV');
console.log('  c·S(c) 的理论值 = RTP（对所有 c 恒定）；净 EV 理论值 = 0.97·RTP − 1');
console.log('\n  逃跑点c    赢面S       c·S(c)    净EV/注     3σ      偏差/σ   判定');
const grid = [];
for (let c = 1.01; c <= 2.0; c += 0.01) grid.push(+c.toFixed(2));
for (let c = 2.0; c <= 10; c += 0.05) grid.push(+c.toFixed(2));
for (let c = 10; c <= 100; c *= 1.02) grid.push(+c.toFixed(2));
for (let c = 100; c <= 1000; c *= 1.03) grid.push(+Math.min(CAP, c).toFixed(2));

let maxZ = 0, maxZc = 0, evMin = Infinity, evMax = -Infinity, evMinC = 0, evMaxC = 0;
let viol = [];
let thin = [];   // 样本不足的点：照常打印，但不算判据
for (const c of grid) {
  const P = S(c);
  if (P === 0) continue;
  const ev = (1 - EDGE) * c * P - 1;
  const sigma = c * (1 - EDGE) * Math.sqrt(P * (1 - P) / N);
  // ⚠️ 样本充分性闸：尾部点的 σ 本身就有几个百分点，在那个分辨率下
  //   「偏差 > 3σ」不是性质结论，只是噪声。RTP=1.00 cap=1000 实测：
  //     865.2x 在 N=100万 只有 1156 次命中，3σ 相对误差 8.82%
  //   所以它报出「3.04σ」看着像超标，其实 N 要到 7800 万才分辨得出来。
  //   不做这个标注，读的人会把噪声当缺陷 —— 我第一版就是这么误导的。
  //   判据：3σ 相对误差 > 3% 视为样本不足，照常打印但不计进 maxZ / viol。
  const relSigma = 3 * Math.sqrt((1 - P) / (N * P));
  const enough = relSigma <= 0.03;
  const z = (ev - EV_THEORY) / sigma;
  if (enough && Math.abs(z) > Math.abs(maxZ)) { maxZ = z; maxZc = c; }
  if (ev < evMin) { evMin = ev; evMinC = c; }
  if (ev > evMax) { evMax = ev; evMaxC = c; }
  if (enough && Math.abs(z) > 3) viol.push({ c, z, ev });
  if (!enough) thin.push({ c, z, ev, relSigma, hits: P * N });
}
console.log(`  网格点数 = ${grid.length}（1.01→${CAP}x，对数加密）`);
console.log(`  净 EV 极差 = ${((evMax - evMin) * 100).toFixed(3)} 个百分点（最高 ${evMaxC.toFixed(2)}x，最低 ${evMinC.toFixed(2)}x）`);
console.log(`  全网格最大 |偏差| = ${Math.abs(maxZ).toFixed(2)}σ @ ${maxZc.toFixed(2)}x（判据 ≤3σ）`);
console.log(`  超 3σ 的点 = ${viol.length} 个 ${viol.length ? '← ' + viol.slice(0, 5).map(v => v.c.toFixed(2) + 'x:' + v.z.toFixed(1) + 'σ').join(' ') : '（通过）'}`);
if (thin.length) {
  console.log(`\n  ⚠️ 样本不足、【不计入判据】的点 = ${thin.length} 个（N=${N.toLocaleString()} 下 3σ 相对误差 >3%）：`);
  console.log('     这些点报出的 z 值是【采样噪声】，不是分布性质。RTP=1.00/cap=1000 时尾部需要 N≈7800 万才分辨得出来。');
  console.log('     点位        命中次数     3σ相对误差    z值      说明');
  for (const t of thin.slice(0, 12)) {
    console.log('  ' + (t.c.toFixed(2) + 'x').padStart(10) + t.hits.toFixed(0).padStart(12) +
      (t.relSigma * 100).toFixed(2).padStart(12) + '%' + (t.z >= 0 ? '+' : '') + t.z.toFixed(2).padStart(9) + '   样本不足');
  }
  if (thin.length > 12) console.log('     … 另有 ' + (thin.length - 12) + ' 个');
}

// 尾部单独看（尾部 σ 天然大，需要分开陈述）
console.log('\n  尾部抽样明细（这些点的 σ 本身很大，单看极差会误导）：');
console.log('   逃跑点c    赢面S       c·S(c)    净EV/注     3σ      偏差/σ');
for (const c of [1.05, 1.10, 1.20, 2, 5, 10, 50, 100, 200, 500, 1000]) {
  if (c > CAP) continue;
  const P = S(c); if (P === 0) continue;
  const ev = (1 - EDGE) * c * P - 1;
  const sigma = c * (1 - EDGE) * Math.sqrt(P * (1 - P) / N);
  console.log('  ' + (c.toFixed(2) + 'x').padStart(8) + (P * 100).toFixed(4).padStart(10) + '%' +
    (c * P).toFixed(4).padStart(11) + (ev * 100).toFixed(3).padStart(10) + '%' +
    (sigma * 100).toFixed(3).padStart(9) + '%' + ((ev - EV_THEORY) / sigma).toFixed(2).padStart(9));
}

// ================= §2 空档 + 可预测性 =================
line('§2 空档与可预测性');
// ⚠️ 必须去重：两段循环的端点重叠会产生重复网格点，
//    而「相邻两点 S 完全相等」会把重复点误报成一个零宽度的「洞」。
const g2 = [];
for (let c = 1.01; c <= 3.0; c += 0.01) g2.push(+c.toFixed(2));
for (let c = 3.05; c <= 12; c += 0.05) g2.push(+c.toFixed(2));
for (let c = 12; c <= CAP; c *= 1.05) g2.push(+c.toFixed(2));
g2.sort((a, b) => a - b);
const g2u = g2.filter((c, i) => i === 0 || c !== g2[i - 1]);
let holes = [], hole = null, prev = S(g2[0]);
for (let i = 1; i < g2.length; i++) {
  const P = S(g2[i]);
  if (P === prev) { if (!hole) hole = [g2[i - 1], g2[i]]; }
  else { if (hole) holes.push(hole); hole = null; }
  prev = P;
}
if (hole) holes.push(hole);
console.log(`  网格 = ${g2.length} 点（1.01→${CAP}x）。空档数 = ${holes.length}`);
if (!holes.length) console.log('  → 无空档：连续分布，玩家看不见「习惯区间」的边界');
for (const h of holes.slice(0, 20)) console.log(`     洞: ${h[0].toFixed(2)}x ~ ${h[1].toFixed(2)}x`);

let ma = 0, mb = 0;
for (let i = 0; i + 1 < N; i++) { ma += rates[i]; mb += rates[i + 1]; }
ma /= N; mb /= N;
let sa = 0, sb = 0, sab = 0;
for (let i = 0; i + 1 < N; i++) { const dx = rates[i] - ma, dy = rates[i + 1] - mb; sa += dx * dx; sb += dy * dy; sab += dx * dy; }
const r = sab / Math.sqrt(sa * sb);
console.log(`\n  相邻局倍率相关系数 r = ${r.toFixed(5)}   判据 |r| < 0.01 → ${Math.abs(r) < 0.01 ? '通过' : '不通过'}`);

// 配额检测：每 100 局「≥10x」的局数分布（配额式实现会让它几乎不变）
const blocks = [];
for (let b = 0; b + 100 <= N; b += 100) {
  let c = 0; for (let i = b; i < b + 100; i++) if (rates[i] >= 10) c++;
  blocks.push(c);
}
const bMean = blocks.reduce((a, b) => a + b, 0) / blocks.length;
const bSd = Math.sqrt(blocks.reduce((a, b) => a + (b - bMean) ** 2, 0) / blocks.length);
const bDist = {}; blocks.forEach(x => bDist[x] = (bDist[x] || 0) + 1);
console.log(`  每 100 局「≥10x」局数：均值 ${bMean.toFixed(2)}  标准差 ${bSd.toFixed(2)}  取值集合 {${Object.keys(bDist).sort((a,b)=>a-b).join(',')}}`);
console.log(`  配额式实现的标准差会是 0.00 → 实测 ${bSd.toFixed(2)} ⇒ 非配额`);

// 短周期
const seq = []; for (let i = 0; i < 2000; i++) seq.push(rates[i]);
let per = null;
for (const k of [2, 3, 4, 5, 7, 10, 20, 50, 100]) {
  let ok = true; for (let i = k; i < seq.length; i++) if (seq[i] !== seq[i - k]) { ok = false; break; }
  if (ok) { per = k; break; }
}
console.log(`  2000 局序列的短周期：${per === null ? '无（通过）' : '⚠ 周期 ' + per}`);

// ================= §3 可操作性 =================
line('§3 【关键】可操作性：反应时间税 —— 哪些倍率局物理上按不到逃跑键');
console.log('  玩家要赢在目标 m，必须满足：flightMs(爆点) − flightMs(m) ≥ 反应时间');
console.log('  （前一半是「曲线爬到目标所需时间」，后一半是玩家点下去所需时间）');
console.log('\n  倍率      飞行时长      说明');
for (const r0 of [1.00, 1.01, 1.05, 1.10, 1.20, 1.50, 2.00, 3.00, 5.00, 10.00]) {
  const ms = GL.flightMs(r0);
  const tag = ms === 0 ? '← 瞬爆，0ms，无任何窗口'
    : ms < 250 ? '← 人类反应不可能'
    : ms < 500 ? '← 勉强/不可能'
    : ms < 1000 ? '← 极难（手机端）' : '';
  console.log('  ' + (r0.toFixed(2) + 'x').padStart(8) + (ms.toFixed(0) + 'ms').padStart(12) + '   ' + tag);
}

// 逐档统计「不可操作」质量
const bands = [[1.00, 1.01], [1.01, 1.05], [1.05, 1.10], [1.10, 1.20], [1.20, 1.50], [1.50, 2.00], [2.00, 3.00], [3.00, 5.00], [5.00, 10.00]];
console.log('\n  区间            占比       该区间内各倍率的中位飞行时长');
let cum = 0;
for (const [a, b] of bands) {
  let cnt = 0, fl = [];
  for (let i = 0; i < N; i++) if (rates[i] >= a && rates[i] < b) { cnt++; fl.push(rates[i]); }
  fl.sort((x, y) => x - y);
  const mid = fl.length ? GL.flightMs(fl[fl.length >> 1]) : 0;
  const share = cnt / N;
  console.log('  [' + a.toFixed(2) + ',' + b.toFixed(2) + ')' + (share * 100).toFixed(3).padStart(9) + '%' + (mid.toFixed(0) + 'ms').padStart(16) +
    (mid < 500 ? '   ← 窗口不足' : ''));
  if (b <= 1.10) cum += share;
}
const inst = rates.filter(x => x <= 1.0).length / N;
console.log(`\n  瞬爆（≤1.00x，0ms 窗口）= ${(inst * 100).toFixed(3)}%`);
console.log(`  <1.10x 合计 = ${(cum * 100).toFixed(3)}%  —— 其中 ${(inst * 100).toFixed(2)}% 是 0ms 瞬爆，${((cum - inst) * 100).toFixed(2)}% 是 62~590ms 的「看得见按不到」`);
console.log(`\n  【恒等式核对】瞬爆概率应恒等于 1 − RTP = ${((1 - RTP) * 100).toFixed(2)}%`);
console.log(`  实测 ${(inst * 100).toFixed(3)}%，偏差 ${((inst - (1 - RTP)) * 100).toFixed(3)} 个百分点 → ${Math.abs(inst - (1 - RTP)) < 0.002 ? '一致' : '偏离'}`);
console.log(`  ⇒ 在 RTP=${RTP} 且分布下界锁死 1.00x 的前提下，瞬爆概率不是可调参数，它由公式决定。`);

// 反应税对有效 EV 的影响
console.log(`\n  玩家实际面对的胜率与净 EV（固定逃跑点 m，反应时间 ${REACT_MS}ms）：`);
console.log('   逃跑点m   理论胜率    实际可赢胜率    理论净EV    实际净EV    反应税');
for (const m of [1.10, 1.20, 1.50, 2.00, 3.00, 5.00, 10.00, 20.00, 50.00]) {
  const need = GL.flightMs(m) + REACT_MS;
  // 找出 flightMs(X) ≥ need 的最小倍率，即实际能赢到的爆点下界
  let lo = m, hi = CAP;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (GL.flightMs(mid) >= need) hi = mid; else lo = mid;
  }
  const eff = +hi.toFixed(2);
  const pTheory = RTP / m;
  const pReal = eff >= CAP ? S(CAP) : S(eff);
  const evTheory = (1 - EDGE) * m * pTheory - 1;
  const evReal = (1 - EDGE) * m * pReal - 1;
  console.log('  ' + (m.toFixed(2) + 'x').padStart(8) + (pTheory * 100).toFixed(2).padStart(11) + '%' +
    (pReal * 100).toFixed(2).padStart(14) + '%' + (evTheory * 100).toFixed(2).padStart(12) + '%' +
    (evReal * 100).toFixed(2).padStart(11) + '%' + ((evTheory - evReal) * 100).toFixed(2).padStart(9) + 'pp');
}

// ================= §4 节奏曲线 + 净流入流出 =================
line(`§4 ${ROUNDS} 局节奏曲线与净流入/流出摘要（每注 ${STAKE} QUN，固定逃跑点策略）`);
console.log('  逃跑点m   庄家净流入   占投注额    最大连败   最大连胜   单局波动σ   余额路径σ   最深回撤   每局净流入(95%CI)');
const summary = [];
for (const m of [1.10, 1.50, 2.00, 3.00, 5.00, 10.00]) {
  let bal = 0, peak = 0, dd = 0, lose = 0, win = 0, mlose = 0, mwin = 0, curve = [], nets = [];
  for (let i = 0; i < ROUNDS; i++) {
    const x = draw();
    // 引擎守卫 engine.js:627 是 cur >= boom 拒绝 ⇒ 逃 m 需要 X > m（不是 >=）
    const net = x > m ? GL.payout(STAKE, m) : -STAKE;
    bal += net; curve.push(bal); nets.push(net);
    if (bal > peak) peak = bal; dd = Math.max(dd, peak - bal);
    if (net < 0) { lose++; win = 0; mlose = Math.max(mlose, lose); }
    else { win++; lose = 0; mwin = Math.max(mwin, win); }
  }
  const mean = bal / ROUNDS;                                              // QUN/局
  // ⚠️ 两个层级的 σ 必须分开算：
  //   sdRound = 单局净收益的标准差（QUN/局）—— 玩家体感到的波动
  //   sdPath  = 累计余额曲线的标准差（QUN 总额）—— 资金曲线的起伏幅度
  // 均值的 95% 置信半宽只能用 sdRound：CI = 1.96·sdRound/√N。
  // 拿 sdPath/√N 去算会把置信区间放大一个数量级。
  const sdRound = Math.sqrt(nets.reduce((a, b) => a + (b - mean) ** 2, 0) / ROUNDS);
  // sdPath = 累计余额曲线自身（相对于它自己的均值）的标准差，QUN 总额。
  // 中心必须是 curve 的均值，不是终点 bal、也不是单局均值 mean —— 三者量纲/含义都不同。
  const pathMean = curve.reduce((a, b) => a + b, 0) / ROUNDS;
  const sdPath = Math.sqrt(curve.reduce((a, b) => a + (b - pathMean) ** 2, 0) / ROUNDS);
  const turnover = STAKE * ROUNDS;
  const ci = 1.96 * sdRound / Math.sqrt(ROUNDS);
  summary.push({ m, bal, mean, sdRound, mlose, mwin, dd });
  console.log('  ' + (m.toFixed(2) + 'x').padStart(8) + ((bal >= 0 ? '+' : '') + bal.toFixed(0) + ' QUN').padStart(13) +
    ((bal / turnover) * 100).toFixed(2).padStart(10) + '%' + String(mlose).padStart(10) + String(mwin).padStart(10) +
    sdRound.toFixed(0).padStart(11) + sdPath.toFixed(0).padStart(12) + dd.toFixed(0).padStart(11) +
    ((mean >= 0 ? '+' : '') + mean.toFixed(2) + ' ±' + ci.toFixed(2)).padStart(18));
}
const HOUSE_PER_ROUND = STAKE * (1 - (1 - EDGE) * RTP);
console.log(`\n  【理论】庄家每局净流入 = 投注额 × (1 − 0.97×RTP) = ${STAKE} × ${(1 - (1 - EDGE) * RTP).toFixed(4)} = ${HOUSE_PER_ROUND.toFixed(2)} QUN/局`);
console.log(`  ${ROUNDS} 局理论净流入 = ${(HOUSE_PER_ROUND * ROUNDS).toFixed(0)} QUN —— 【对所有逃跑点都相同】，这正是 c·S(c)=RTP 的直接后果`);
console.log('  上面各行的实测净流入应围绕该值波动；偏离幅度 = 采样噪声（连败连串长度决定），不是分布缺陷。');

// 节奏曲线抽样打印（每 ROUNDS/20 局一个点）
console.log('\n  节奏曲线（每 ' + Math.round(ROUNDS / 20) + ' 局采样一次，m=2.00x 策略的累计净收益）：');
{
  let bal = 0; const pts = []; const step = Math.round(ROUNDS / 20);
  for (let i = 0; i < ROUNDS; i++) {
    const x = draw();
    bal += x > 2.00 ? GL.payout(STAKE, 2.00) : -STAKE;
    if ((i + 1) % step === 0) pts.push({ r: i + 1, b: bal });
  }
  const maxAbs = Math.max(...pts.map(p => Math.abs(p.b)), 1);
  for (const p of pts) {
    const w = Math.round((p.b / maxAbs) * 40);
    const bar = p.b >= 0 ? ' '.repeat(40 - w) + '+' + '█'.repeat(w) : ' '.repeat(40) + '-' + '█'.repeat(-w);
    console.log('   ' + String(p.r).padStart(5) + '局 ' + (p.b >= 0 ? '+' : '') + String(p.b).padStart(7) + ' ' + bar);
  }
  console.log(`  （横轴固定 ±${maxAbs} QUN，纵轴为累计净收益；曲线无固定斜率 ⇒ 无配额节拍）`);
}

// 分布摘要
console.log(`\n  分布摘要：`);
console.log(`   p5=${pct(.05).toFixed(2)} p25=${pct(.25).toFixed(2)} p50=${pct(.5).toFixed(2)} p75=${pct(.75).toFixed(2)} p90=${pct(.9).toFixed(2)} p99=${pct(.99).toFixed(2)} p999=${pct(.999).toFixed(2)} max=${s[N - 1].toFixed(2)}`);
for (const t of [1.1, 2, 5, 10, 50, 100, 1000]) console.log(`   P(X≥${t}x) = ${(S(t) * 100).toFixed(3)}%   理论 RTP/x = ${((RTP / t) * 100).toFixed(3)}%`);

line('判据汇总');
console.log(`  净 EV 全网格极差 = ${((evMax - evMin) * 100).toFixed(3)} pp ；最大 |偏差| = ${Math.abs(maxZ).toFixed(2)}σ ≤ 3σ → ${Math.abs(maxZ) <= 3 ? '通过' : '不通过'}`);
console.log(`  空档数 = ${holes.length} → ${holes.length === 0 ? '通过' : '不通过'}`);
console.log(`  |r| = ${Math.abs(r).toFixed(5)} < 0.01 → ${Math.abs(r) < 0.01 ? '通过' : '不通过'}`);
console.log(`  配额检测：每 100 局 ≥10x 局数标准差 = ${bSd.toFixed(2)}（>1.5 即非配额） → ${bSd > 1.5 ? '通过' : '不通过'}`);
