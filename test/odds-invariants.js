'use strict';
/**
 * 幂律分布的不变量验收（离线、零成本、不碰服务器）。
 *
 * 判据全部是【不变量】不是具体数值 —— 断言「逃 1.5x 赢面 = 66.7%」这种
 * 会在换 RTP 时红，而换 RTP 不是回归。
 *
 * ⚠️ 三个我自己踩过、且第一版全红的坑，都写在对应断言旁边了：
 *   ① `for (c = 1.01; c += 0.01; c++)` 浮点累加 → c 变成 1.4999999999999998，
 *      所有恰好等于 1.50 的局被判输，凭空造出 0.5pp 的「偏差」。必须用整数分。
 *   ② 判「偏差方向」不能只数符号。高倍区单个分点的 σ 就有 1.4pp
 *      （P(X=400) 一次点质量 ~1e-7 × N=2e6 ⇒ 相对 σ ~14%），
 *      不设阈值时符号纯噪声，「高于 14254 / 低于 18」就是这么来的。
 *      必须先按 σ 过滤（≥2σ）再数方向。
 *   ③ 「空档」不能用 0.01 宽度判。X 取整到分，30x 处每个分点的期望命中数
 *      只有 0.5 个，相邻两点同时为 0 是正常抽样结果，不是「区间里没有落点」。
 *      玩家能感知的是「一段倍率范围内一个落点都没有」，粒度必须 0.10x 起。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const G = require(path.join(__dirname, '..', 'server', 'game-logic.js'));

const RTP = Number(process.argv[2] || 0.87);
const CAP = Number(process.argv[3] || 1000);
const N = Number(process.argv[4] || 2000000);
const EDGE = G.CFG.HOUSE_EDGE;
const THEORY_EV = (1 - EDGE) * RTP - 1;      // 玩家每注期望，与逃跑点无关

let pass = 0, fail = 0;
const ok = (c, name, detail = '') => {
  if (c) { pass++; console.log('  PASS  ' + name + '  ' + detail); }
  else { fail++; console.log('  FAIL  ' + name + '  ' + detail); }
  return c;
};
/** 独立实现，绝不复用引擎的抽取路径（否则同一个 bug 被测两次都过） */
function u() { const b = crypto.randomBytes(6); let n = 0; for (let i = 0; i < 6; i++) n = n * 256 + b[i]; return (n + 0.5) / 281474976710656; }
function surv(arr, n, c) { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < c) lo = m + 1; else hi = m; } return (n - lo) / n; }

const cfg = { odds_mode: '9', powerlaw_rtp: String(RTP), powerlaw_cap: String(CAP), min_rate: '1.10', max_rate: '50' };
const x = new Float64Array(N);
for (let i = 0; i < N; i++) x[i] = Math.min(CAP, Math.max(1, Math.floor(RTP / u() * 100) / 100));
const s = Float64Array.from(x).sort();
const S = c => surv(s, N, c);

console.log('='.repeat(64));
console.log('幂律不变量验收   RTP=' + RTP + '  cap=' + CAP + '  N=' + N.toLocaleString() +
  '  理论每注 EV=' + (THEORY_EV * 100).toFixed(2) + '%');
console.log('='.repeat(64));

/* ---------- §1 生产实现 = 独立实现 ---------- */
console.log('\n§1 生产 decideRate() 与独立实现同分布');
{
  const M = 200000;
  const prod = new Float64Array(M);
  for (let i = 0; i < M; i++) prod[i] = G.decideRate(cfg, 1000, 0, null, null).rate;
  const ps = Float64Array.from(prod).sort();
  let worst = 0, wc = 0;
  for (const c of [1.10, 1.50, 2.00, 3.00, 5.00, 10.00, 50.00, 100.00]) {
    const P = surv(ps, M, c);
    const z = Math.abs(P - S(c)) / Math.sqrt(P * (1 - P) / M);
    if (z > worst) { worst = z; wc = c; }
  }
  ok(worst < 4, '生产与独立实现在同一分布', '最大 ' + worst.toFixed(2) + 'σ @ ' + wc + 'x（判据 4σ）');
}

/* ---------- §2 不变量①：毛赔付恒定 ---------- */
console.log('\n§2 不变量①：毛赔付恒定  c·S(c) = RTP');
/**
 * ⚠️⚠️ 网格点【不独立】，所以不能在 14272 个点上逐点判 3σ、也不能数方向。
 *
 * S(c) 是同一个有序数组的单调函数 —— 尾部某一段运气不好，会让【连续几百个】
 * 相邻 c 的 S(c) 一起偏。这不是 1010 个独立偏差，是【一个】偏差被复制了 1010 遍。
 * 我第一版因此报「50~200x 段高 1010/期望 48.9」，看着像系统性套利，实际是
 * 「最大 |z| ≈ 3.3σ」在相关点集上的正常表现（14272 点下的理论最大值就有 ~3.8σ）。
 *
 * 正确做法：判据只放在【少量互不重叠的大区间】上，每个区间一次抽样误差，
 * 区间数 ≪ 网格点数 ⇒ 独立假设成立。
 */
const devs = [];
for (let cc = 101; cc <= CAP * 100; cc += 7) {     // 整数分网格，步长 7 分（仅供 §3 空档用）
  const c = cc / 100, P = S(c);
  if (P <= 0) break;
  devs.push({ c, dev: c * P - RTP, sig: c * Math.sqrt(P * (1 - P) / N) });
}
{
  /* 用 12 个对数间隔的独立采样点做逐点 3σ 判据 */
  const pts = [];
  for (let i = 0; i < 12; i++) {
    const c = 1.02 * Math.pow(CAP / 1.02, i / 11);
    const P = S(c);
    pts.push({ c, dev: c * P - RTP, sig: c * Math.sqrt(P * (1 - P) / N) });
  }
  let worst = 0, wc = 0;
  for (const d of pts) { const z = Math.abs(d.dev) / d.sig; if (z > worst) { worst = z; wc = d.c; } }
  /* ⚠️ 12 个独立点的阈值也必须做多重比较修正，否则必然偶发红：
       P(单点 |z| > 3) = 0.0027 ⇒ P(12 点里至少一个) = 1−(1−0.0027)^12 = 3.2%
       也就是每跑 30 次就会撞上一次 —— 那不是回归，是判据本身的假阳性率。
       Bonferroni：单点显著性取 0.0027/12 ⇒ z ≈ 3.5；这里用 4σ，
       实际假阳性率 12×6.3e-5 = 7.6e-4（约 1300 次一次）。 */
  ok(worst < 4, '12 个对数间隔采样点逐点对 RTP 判 4σ（Bonferroni 修正，12 次比较）',
    '最大 ' + worst.toFixed(1) + 'σ @ ' + wc.toFixed(2) + 'x');

  /* 方向性：同样只用这 12 个独立点，多重比较按 12 个算 */
  const hi = pts.filter(d => d.dev > 2 * d.sig).length;
  const lo = pts.filter(d => d.dev < -2 * d.sig).length;
  ok(hi <= 3 && lo <= 3, '独立采样点超 2σ 的：高于 ' + hi + ' / 低于 ' + lo +
    '（完美分布预期各 ' + (12 * 0.0228).toFixed(1) + '）', '无系统性方向');

  /* 分段方向性：每段【整段一个】偏差均值，各段互不重叠 ⇒ 8 个独立检验 */
  const segs = [];
  let dirBad = [];
  for (const [a, z] of [[1, 1.1], [1.1, 2], [2, 5], [5, 10], [10, 50], [50, 200], [200, 500], [500, CAP]]) {
    const seg = devs.filter(d => d.c >= a && d.c < z);
    if (!seg.length) continue;
    const mean = seg.reduce((p, d) => p + d.dev, 0) / seg.length;
    // 整段均值的 σ：各点相关，用【段内 P 的极差】给出保守尺度
    const scale = Math.max(...seg.map(d => d.sig));
    segs.push({ a, z, mean, z: Math.abs(mean) / scale });
    if (Math.abs(mean) > 2 * scale) dirBad.push(a + '~' + z + 'x(均值' + (mean * 100).toFixed(3) + 'pp)');
  }
  ok(dirBad.length === 0, '八个倍率段的整段偏差均值都不超 2×段内最大σ',
    dirBad.length ? dirBad.join(' ') : 'OK（最大 ' + Math.max(...segs.map(s => s.z)).toFixed(2) + 'σ @ ' +
      segs.reduce((a, b) => b.z > a.z ? b : a).a + '~' + segs.reduce((a, b) => b.z > a.z ? b : a).z + 'x）');
}

/* ---------- §3 空档（玩家可感知粒度）---------- */
console.log('\n§3 空档扫描（粒度 0.10x —— 更细的「空」是取整到分的抽样噪声）');
{
  const holes = [];
  for (let c = 1.00; c <= Math.min(CAP, 50); c = +(c + 0.10).toFixed(2)) {
    const P = S(c), P2 = S(+(c + 0.10).toFixed(2));
    const theory = Math.max(0, RTP / c - RTP / (c + 0.10)) * N;
    if (theory < N * 0.0005) continue;          // 理论质量可忽略的区间不算洞
    if (Math.round(P * N) - Math.round(P2 * N) === 0) holes.push(c.toFixed(2));
  }
  const seen = new Set(x);
  let maxGap = 0, gapAt = 0;
  for (let c = 1.00; c <= Math.min(CAP, 50); c = +(c + 0.10).toFixed(2)) {
    if (RTP / c * N * 0.001 < 1) break;
    let k = 0;
    while (k < 500) { const v = +(c + k * 0.01).toFixed(2); if (v > CAP || seen.has(v)) break; k++; }
    if (k * 0.01 > maxGap) { maxGap = k * 0.01; gapAt = c; }
  }
  ok(holes.length === 0, '1.00~50x 内无 0.10x 宽的空档', holes.length ? holes.slice(0, 8).join(', ') : '连续');
  ok(maxGap <= 0.10, '相邻落点最大间隔 ≤ 0.10x', maxGap.toFixed(2) + 'x @ ' + gapAt.toFixed(2) + 'x');
}

/* ---------- §4 不变量②：净 EV 与逃跑点无关 ---------- */
console.log('\n§4 不变量②：净 EV 与逃跑点无关');
{
  const rows = [];
  for (const m of [1.02, 1.10, 1.50, 2.00, 3.00, 5.00, 10.00, 20.00, 50.00, 100.00, 200.00, CAP]) {
    const P = S(m); if (P <= 0) continue;
    const ev = P * (m * (1 - EDGE) - 1) - (1 - P);
    const sig = m * (1 - EDGE) * Math.sqrt(P * (1 - P) / N);
    rows.push({ m, ev, sig });
    console.log('    ' + m.toFixed(2).padStart(7) + 'x  赢面 ' + (P * 100).toFixed(4).padStart(8) +
      '%  净EV ' + (ev * 100).toFixed(3).padStart(7) + '%  ±σ ' + (sig * 100).toFixed(3).padStart(6) +
      '%  偏差 ' + ((ev - THEORY_EV) / sig).toFixed(1).padStart(5) + 'σ');
  }
  const bads = rows.filter(r => Math.abs(r.ev - THEORY_EV) > 3 * r.sig);
  ok(bads.length === 0, '12 个逃跑点全部在 3σ 内', bads.length ? bads.map(r => r.m + 'x').join(',') : 'OK');
  /* ⚠️「没有任何逃跑点是正期望」这一条【只能对主体段断言】。
     尾部 P(X≥1000)≈0.1%，N=200 万 ⇒ σ=2.2pp，而真值只有 −3.0pp ——
     σ 比信号还大，所以尾部 EV 的【符号】是噪声：实测 12 次里有 1 次报出
     「1000x 正期望」，同一分布重跑就消失。拿噪声的符号当判据 = 造一条每 12 次红一次的测试。
     尾部改判【它可被解析证明的东西】：P(X≥cap) = RTP/cap。
     而 EV(cap) = 0.97·cap·(RTP/cap) − 1 = 0.97·RTP − 1 = −3.00%，恒为负，无需抽样。 */
  const body = rows.filter(r => r.m < 500);
  const posBody = body.filter(r => r.ev > 0);
  ok(posBody.length === 0, '主体段（<500x）没有任何逃跑点是正期望',
    posBody.length ? posBody.map(r => r.m + 'x').join(',') : 'OK（σ≤0.5pp，真值 −3% 判别力充足）');
  const tailRows = rows.filter(r => r.m >= 500);
  const capP = S(CAP), capTheory = RTP / CAP;
  ok(Math.abs(capP - capTheory) < 3 * Math.sqrt(capTheory * (1 - capTheory) / N),
    '尾部用解析恒等式判：P(X≥' + CAP + ') = RTP/cap（⇒ EV 恒为 0.97·RTP−1 = ' + (THEORY_EV * 100).toFixed(2) + '%）',
    '实测 ' + (capP * 100).toFixed(4) + '% vs ' + (capTheory * 100).toFixed(4) + '%');
}

/* ---------- §5 独立性 ---------- */
console.log('\n§5 独立性');
{
  let ma = 0, mb = 0;
  for (let i = 0; i + 1 < N; i++) { ma += x[i]; mb += x[i + 1]; }
  ma /= N; mb /= N;
  let sa = 0, sb = 0, sab = 0, dup = 0;
  for (let i = 0; i + 1 < N; i++) {
    const a = x[i] - ma, b = x[i + 1] - mb;
    sa += a * a; sb += b * b; sab += a * b;
    if (Math.abs(x[i] - x[i + 1]) / Math.max(x[i], x[i + 1]) < 0.08) dup++;
  }
  const r = sab / Math.sqrt(sa * sb);
  ok(Math.abs(r) < 0.01, '相邻局相关系数 |r| < 0.01', 'r = ' + r.toFixed(5));
  ok(dup / (N - 1) < 0.15, '相邻两局差 <8% 的比例 < 15%（无记忆）', (dup / (N - 1) * 100).toFixed(2) + '%');
  const head = x.slice(0, 2000);
  const cyc = [2, 3, 4, 5, 7, 10, 20, 50, 100].filter(k => {
    for (let i = k; i < head.length; i++) if (head[i] === head[i - k]) return false;
    return true;
  });
  ok(cyc.length === 0, '2000 局序列无任何短周期', cyc.length ? '有周期 ' + cyc.join(',') : '确认无周期');
  ok(new Set(x).size > 1000, '不同取值 > 1000（非少数值循环）', new Set(x).size.toLocaleString() + ' 个');
  const gaps = [];
  let run = 0;
  for (let i = 0; i < N; i++) { if (x[i] < 2) { run++; } else { if (run) gaps.push(run); run = 0; } }
  if (run) gaps.push(run);
  const kinds = new Set(gaps).size;
  /* ⚠️ 不要用 Math.max(...gaps) —— gaps 在 200 万局下有 ~70 万个元素，
     展开成函数参数会直接 RangeError: Maximum call stack size exceeded。 */
  let longest = 0;
  for (const g of gaps) if (g > longest) longest = g;
  ok(kinds >= 8, '低于 2x 的连败段长有 ≥8 种取值（配额节拍只会有 1~2 种）',
    kinds + ' 种，最长 ' + longest + ' 局，共 ' + gaps.length + ' 段');
}

/* ---------- §6 边界 ---------- */
console.log('\n§6 边界');
{
  ok(s[0] >= 1 && s[N - 1] <= CAP, '所有倍率 ∈ [1.00, ' + CAP + ']', s[0] + ' ~ ' + s[N - 1]);
  ok(x.every(v => isFinite(v)), '无 NaN / Infinity', '');
  /* ⚠️ 瞬爆的精确式是 1 − RTP/1.01，不是 1 − RTP：
     floor₂ 让 X ≤ 1.00 的条件是 RTP/U < 1.01（不是 < 1），< 1 那段也被 max(1,·) 兜上来。 */
  const bt = 1 - RTP / 1.01;
  const b = x.filter(v => v <= 1.00).length / N;
  ok(Math.abs(b - bt) < 3 * Math.sqrt(bt * (1 - bt) / N), '瞬爆率 ≈ 1 − RTP/1.01（不是 1−RTP）',
    (b * 100).toFixed(3) + '% vs ' + (bt * 100).toFixed(3) + '%');
  /* X < 1.10 ⟺ floor₂(RTP/U) < 1.10 ⟺ RTP/U < 1.10 ⟺ U > RTP/1.10
     ⇒ P = 1 − RTP/1.10。
     ⚠️ 我第一版写成 1 − RTP/1.11（以为「1.10 上取整到分是 1.11」）—— 那是错的：
     floor₂ 只在【下侧】取整，floor₂(1.099)=1.09 < 1.10 成立，floor₂(1.10)=1.10 不成立，
     所以阈值就是 1.10 本身。RTP=1 时正确值 9.09%，1.11 那版算出 9.91%，差 0.8pp。 */
  const st = 1 - RTP / 1.10;
  const sub = x.filter(v => v < 1.10).length / N;
  ok(Math.abs(sub - st) < 3 * Math.sqrt(st * (1 - st) / N), '<1.10x（按不到按钮）= 1 − RTP/1.10',
    (sub * 100).toFixed(3) + '% vs ' + (st * 100).toFixed(3) + '%');
  const atCap = x.filter(v => v >= CAP).length / N;
  ok(atCap > 0, '上限之上确实有被截断的质量（不是永远撞不到 cap）', (atCap * 100).toFixed(3) + '%');
  /* ⚠️⚠️ 我曾在这里断言「cap 截断会把超界质量堆到一个点，造成单向 EV 梯度」。
     那是错的，而且错在没做算术：
 *       X = min(cap, floor₂(RTP/U))
 *       X ≥ cap  ⟺  floor₂(RTP/U) ≥ cap  ⟺  RTP/U ≥ cap  ⟺  U ≤ RTP/cap
 *     min() 对「≥ cap」这个事件是【恒等】的 —— 被截断的那部分质量本来就落在
 *     cap 这一个点上，而 cap 本身就在每个 m 的赢面内。所以
 *       P(X ≥ cap) = RTP/cap 精确成立，c·S(cap) = RTP 精确成立。
 *     我实测到的「逃 1000x 比逃 2x 多赚 0.6~3.4pp」全部是抽样噪声：
 *     P(X≥1000)≈0.1%，N=200 万 ⇒ 该点 σ ≈ 2.2pp，实测值在 ±1.5σ 内。
 *     这就是为什么尾部的所有判据都必须带 σ，不能用绝对阈值。 */
  const evAt = m => 0.97 * m * S(m) - 1;
  const grad = evAt(CAP) - evAt(2.0);
  const gradSig = CAP * 0.97 * Math.sqrt(S(CAP) * (1 - S(CAP)) / N);
  ok(Math.abs(grad) < 3 * gradSig, 'cap 处不构成套利（偏差在 3σ 内，且 cap 仍是负期望）',
    '逃 ' + CAP + 'x 比逃 2x 多赚 ' + (grad * 100).toFixed(3) + 'pp = ' + (grad / gradSig).toFixed(2) +
    'σ（σ=' + (gradSig * 100).toFixed(2) + '%），且 ' + (evAt(CAP) * 100).toFixed(2) + '% 仍为负');
  let mono = true;
  for (let c = 1; c < CAP; c += 1) if (G.flightMs(c + 1) < G.flightMs(c)) mono = false;
  ok(mono, 'flightMs 在 [1, ' + CAP + '] 上单调不减', 'flightMs(' + CAP + ')=' + (G.flightMs(CAP) / 1000).toFixed(1) + 's');
  let rt = 0;
  for (const c of [1.5, 2, 5, 10, 50, 100, 200, 500, CAP]) {
    rt = Math.max(rt, Math.abs(G.rateAt(G.flightMs(c)) - c) / c);
  }
  ok(rt < 0.001, 'flightMs → rateAt 往返误差 < 0.1%（显示倍率 = 结算倍率）', (rt * 100).toFixed(4) + '%');
}

/* ---------- §7 无状态 ---------- */
console.log('\n§7 无状态');
{
  const M = 100000;
  const a = new Float64Array(M), b = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    a[i] = G.decideRate(cfg, 0, 0, null, null).rate;
    b[i] = G.decideRate(cfg, 999999, -500, { name: 'ev', rtp_bonus: 0 }, { seated: [{ ar: 1, thr: 2 }], lastBoom: 50 }).rate;
  }
  const sa = Float64Array.from(a).sort(), sb = Float64Array.from(b).sort();
  let worst = 0;
  for (const c of [1.10, 2.00, 5.00, 20.00]) {
    const Pa = surv(sa, M, c), Pb = surv(sb, M, c);
    /* ⚠️ σ 必须是【两个样本之差】的 σ：Var(Pa−Pb) = P(1−P)(1/M + 1/M)，
       即 σ = sqrt(2·P(1−P)/M)。只算一个样本会让 σ 小 √2 倍，z 虚高 1.41 倍 ——
       4σ 的门实际只相当于 2.83σ，假阳性率从 2.5e-4 涨到 1.8%（实测 15 次里撞上一次）。 */
    worst = Math.max(worst, Math.abs(Pa - Pb) / Math.sqrt(2 * Pa * (1 - Pa) / M));
  }
  ok(worst < 4, 'pot / pool / ctx / 上一局 / 活动对象 全都不影响分布（σ 取两样本之差）',
    '最大 ' + worst.toFixed(2) + 'σ（判据 4σ，假阳性率 ~2.5e-4）');
  let bad = 0;
  for (let i = 0; i < 2000; i++) {
    G.powerlawRate(RTP, CAP); G.powerlawReport(cfg, 1000); G.simulate(cfg, 1000);
    const v = G.decideRate(cfg, 0, 0, null, null).rate;
    if (!isFinite(v) || v < 1 || v > CAP) bad++;
  }
  ok(bad === 0, '先跑 6000 次其它调用后仍正常（无进程内缓存残留）', bad === 0 ? 'OK' : bad + ' 次越界');
  ok(G.POWERLAW.RTP_DEFAULT === 0.87, '运营默认 RTP = 0.87', String(G.POWERLAW.RTP_DEFAULT));
  ok(G.POWERLAW.CAP_DEFAULT === 1000, '默认 cap = 1000', String(G.POWERLAW.CAP_DEFAULT));
  ok(G.POWERLAW.RTP_MAX === 1.00 && G.POWERLAW.RTP_MIN === 0.80, 'RTP 护栏 [0.80, 1.00] 未动', '');
  ok(G.normRtp(0.5) === 0.80 && G.normRtp(5) === 1.00, 'RTP 越界被夹紧', '');
  ok(G.normCap(0.1) === G.POWERLAW.CAP_DEFAULT && G.normCap(99999) === 99999, 'cap 越界被夹紧', '');
}

/* ---------- §8 随机源 ---------- */
console.log('\n§8 随机源');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'game-logic.js'), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
  ok(!/Math\.random/.test(code), '代码里没有 Math.random（注释里 ' + (src.match(/Math\.random/g) || []).length + ' 处）', '');
  ok(/crypto\.randomBytes/.test(code), '使用 crypto.randomBytes（CSPRNG）', '');
  ok(!/require\('\.\/(jev|v3)/.test(code), '不再 require jev / v3 引擎', '');
  ok(!/mode === /.test(code), 'decideRate 内无任何 mode 分支', '');
  ok(typeof G.tableRate === 'undefined' && typeof G.weightedRate === 'undefined', 'tableRate / weightedRate 已删除', '');
  const orig = Math.random; let hit = 0;
  Math.random = () => { hit++; return orig(); };
  for (let i = 0; i < 20000; i++) G.powerlawRate(RTP, CAP);
  Math.random = orig;
  ok(hit === 0, '20000 次抽样中 Math.random 调用 0 次', '实际 ' + hit + ' 次');
}

/* ---------- §9 一千局整场 ---------- */
console.log('\n§9 一千局整场（逃 1.5x，注 100）');
{
  const R = 1000, STAKE = 100, ESC = 1.5;
  const r = new Float64Array(R);
  for (let i = 0; i < R; i++) r[i] = G.decideRate(cfg, 300, 0, null, null).rate;
  const net = v => (v >= ESC) ? (G.payout(STAKE, ESC) - STAKE) : -STAKE;
  let tot = 0;
  for (let i = 0; i < R; i++) tot += net(r[i]);
  /* ⚠️ 坑：E[净] = P·(stake·c·0.97 − stake) + (1−P)·(−stake)
     = 0.97·stake·P·c − stake = stake·(0.97·RTP − 1)。
     写 (1−EDGE)·RTP·R·STAKE 会漏掉那个 −1，于是「理论」比实测大两个数量级。 */
  const theory = STAKE * ((1 - EDGE) * RTP - 1) * R;
  const pEsc = S(ESC);
  const sd = Math.sqrt(R) * STAKE * ESC * (1 - EDGE) * Math.sqrt(pEsc * (1 - pEsc));
  const z = (tot - theory) / sd;
  ok(Math.abs(z) < 3, '一千局净额与理论同阶（不是单向漂移）',
    '实测 ' + tot.toFixed(0) + ' vs 理论 ' + theory.toFixed(0) + ' = ' + z.toFixed(2) + 'σ');
  let pos = 0;
  for (let b = 0; b < R; b += 50) { let s2 = 0; for (let i = b; i < b + 50; i++) s2 += net(r[i]); if (s2 > 0) pos++; }
  /**
   * ⚠️【2026-10-01 老板把默认 RTP 从 1.00 改回 0.87，这条阈值随之失效】
   *
   * 原来写 `pos >= 3 && pos <= 17`，那组数字是按 RTP=1.00 定的：
   *   段均值 −150，P(段>0) ≈ 37.9% ⇒ 20 段里期望 7.6 段为正。
   * 改成 0.87 后段均值变成 −780.5，P(段>0) ≈ 6.2% ⇒ 期望只剩 1.25 段为正。
   * 于是「1 正 / 19 负」在 0.87 下是【正常结果】，而旧断言必然红。
   *
   * ⚠️ 这类「阈值必须跟着分布参数走」的坑，和历史上四个阈值被拍脑袋
   *   算错是同一类。正确做法是从 binomial 正态近似自己算期望与 σ：
   *     期望正段 = 20 × P(段>0)，σ = √(20·q·(1−q))
   *   下界取 max(0, 期望 − 3σ)，上界取 min(20, 期望 + 3σ)。
   *   0.87 ⇒ 期望 1.25、σ 1.08 ⇒ 3σ 覆盖 [0, 4] —— 实测 1 正正好落在里面。
   *
   * 闸的【本意】是「净额没有单向趋势」，而不是「必须有 3 段为正」：
   * 段期望是负的（庄家优势），正段本来就该是少数，出现少数正段才是对的。
   */
  const pBlk = RTP / ESC;
  const blk = 50;                                  // 每段的局数
  const blkWin = G.payout(STAKE, ESC) - STAKE;      // 赢一段的净（+45.50）
  const blkLoss = -STAKE;                            // 输一段的净（−100）
  /**
   * ⚠️ 段均值必须用【段局数 blk=50】，不是总局数 R=1000。
   *    我第一版写的 `STAKE * ((1-EDGE)*RTP-1) * R` 用的是 R，
   *    于是段均值变成 −15610（真值 −780.5，差 20 倍 = R/blk），
   *    z 算出 30.7，qPos 被压成 0 ⇒ 3σ 带塌成 [0,0]。
   *    同一个量在上一条断言里用 R 是对的（那里算的是【总净额】），
   *    复制过来就错 —— 变量名相同、含义不同，是最难查的一类。
   */
  const blkMean = blk * (pBlk * blkWin + (1 - pBlk) * blkLoss);
  /**
   * ⚠️ 段 σ 必须是【两点分布的方差】p(1−p)·(赢段−输段)²，
   *    不能写成 √(n·p·(1−p))·ESC·0.97 ——
   *    那个式子算的是「倍率」的标准差，不是「净额」的；
   *    赢段净 +45.50 与输段净 −100 的差是 145.50，差了一个数量级。
   *    我第一版就写错了：段 σ 被算成 390，真值 507.8 ⇒ z 从 2.0 变 1.54，
   *    整条 3σ 带跟着错。
   */
  const blkSd = Math.sqrt(blk * pBlk * (1 - pBlk) * Math.pow(blkWin - blkLoss, 2));
  /**
   * ⚠️ 标准正态 CDF。
   * ⚠️ 这里【不能】用「0.5 + 从 −8 到 z 的积分」—— 那是错的：
   *     ∫_{−∞}^{z} φ(t)dt 已经包含了 [−∞, 0] 那 0.5，再加一次就变成 1.0。
   *     实测那个版本 cdf(0) 返回 1.000000、cdf(1.54) 返回 1.438220，
   *     于是 1−cdf 得到负概率 → 期望正段数变成负数 → σ 变 NaN。
   *
   * 正确写法：从 0 积到 |z|，再用对称性。
   *     Φ(z) = 0.5 + 0.5·sgn(z)·∫_0^{|z|} φ(t)dt
   * 数值积分用 Simpson（n=200 区间，对这个取值精度绰绰有余）。
   */
  function normCdf(z) {
    const f = (t) => Math.exp(-t * t / 2);
    const az = Math.abs(z);
    const n = 200, h = az / n;
    let s = f(0) + f(az);
    for (let i = 1; i < n; i++) s += f(i * h) * (i % 2 ? 4 : 2);
    const half = (s * h / 3) / Math.sqrt(2 * Math.PI);   // ∫_0^{|z|} φ
    return z >= 0 ? 0.5 + half : 0.5 - half;
  }
  const qPos = Math.max(1e-9, Math.min(1, 1 - normCdf((0 - blkMean) / blkSd)));
  const blocks = R / 50;
  const expPos = blocks * qPos;
  const sdPos = Math.sqrt(blocks * qPos * (1 - qPos));
  const loPos = Math.max(0, Math.round(expPos - 3 * sdPos));
  const hiPos = Math.min(blocks, Math.round(expPos + 3 * sdPos));
  ok(pos >= loPos && pos <= hiPos, '正段数落在 3σ 带内（阈值随 RTP 推导，不是拍脑袋）',
    `${pos} 正 / ${blocks - pos} 负，期望 ${expPos.toFixed(2)}，3σ 带 [${loPos}, ${hiPos}]`);
  let run = 0, mx = 0;
  for (let i = 0; i < R; i++) { if (r[i] < ESC) { run++; if (run > mx) mx = run; } else run = 0; }
  ok(mx <= 10, '连续低于逃 1.5x 最长 ≤ 10 局（随机尾部）', mx + ' 局');
  const hi = r.filter(v => v >= 10).length;
  ok(hi > 0 && hi < R * 0.3, '高倍局存在但不成节拍（10x 以上 2%~25%）', hi + ' / ' + R + ' = ' + (hi / R * 100).toFixed(1) + '%');
}

console.log('\n' + '='.repeat(64));
console.log('  通过 ' + pass + '   失败 ' + fail);
console.log('='.repeat(64));
process.exit(fail ? 1 : 0);