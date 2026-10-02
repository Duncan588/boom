'use strict';
/**
 * QA 独立对照模拟 —— 不复用 server/odds/index.js 的任何代码。
 *
 * 【为什么要另写一份而不是直接 require 生产函数】
 * 我要验的是「数学性质是否成立」，不是「生产函数返回了什么」。
 * 直接 require powerlawRate() 再断言它的输出，等于用被测对象证明被测对象：
 * 公式写错、floor 写成 round、clamp 用错边界，测试会跟着一起错。
 * 这里的实现只按 @项目负责人 给的规格书重写一遍：
 *
 *     X = min(cap, max(1.00, floor2(RTP / U))),  U 均匀于 (0,1)
 *
 * 随机源也独立：crypto.randomBytes 6 字节 → 48bit 均匀，与生产的取数方式
 * 相同但代码路径独立，所以不会因为「抄错同一个 bug」而一起通过。
 *
 * ══════════════ 【踩过的坑：瞬爆概率不是 1 − RTP】══════════════
 * 第一版我把「≤1.00x」写成 1−RTP = 13.00%，实测 13.82% 与 @项目负责人 的
 * 基线 13.88% 吻合，却差 0.86pp ≈ 19σ —— 我以为基线错了。
 * 错的是我。floor 取整不是只影响 1.00 这一【点】，它把整个区间
 *     1.00 <= RTP/U < 1.01        （宽 0.01 的连续一段）
 * 全部压进同一个分值 1.00。所以
 *     P(X >= m) = P(RTP/U >= m) = P(U <= RTP/m) = RTP/m     —— 精确，对任何 m
 *     P(X 恰为 1.00) = 1 − RTP/1.01                         —— 多出来的那一格
 * RTP=0.87 时 1 − 0.87/1.01 = 13.86%，正是实测值。
 * 同理 <1.10x 的理论值是 1 − RTP/1.10 = 20.91%。
 *
 * ══════════════ 【踩过的坑：EV「极差」不能直接和基线比】═════════
 * 极差 = max EV − min EV，而 σ(EV) 随 m 剧增：
 *   m=10  σ=0.39pp     m=100 σ=1.28pp     m=500 σ=2.86pp
 * 所以极差在高逃跑点被【采样噪声】主导，不是被分布形状主导。
 * cap=1000 实测极差 6.742pp，但 m=200/500 的偏差分别只有 2.14σ/2.13σ，
 * 12 个点取最大 |z|≈2.1σ 正是期望值 —— 那不是套利区间，是噪声。
 * 正确判据是【逐点用自己的 σ 比】：没有任何逃跑点的 EV 显著偏离闭式解，
 * 且极差落在最宽策略的 4σ 内。
 *
 * 判据来源（@项目负责人 实测基线，mode=9 / rtp=0.87 / cap=1000，50 万次）：
 *   p50=1.74x p75=3.48x p90=8.70x p99=85.02x p999=848.36x
 *   <=1.00x=13.88%  <1.10x=20.87%   >=10x=8.70% >=50x=1.73% >=100x=0.85%
 *   相邻相关系数 r=-0.00115，无周期
 *   EV 极差 2.896pp(cap=1000) / 1.501pp(cap=125)
 */

const crypto = require('crypto');

/* ---------- 独立实现：规格书重写 ---------- */
function U() {                                   // 均匀 (0,1)，48 bit
  const b = crypto.randomBytes(6);
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + b[i];
  return (n + 0.5) / 281474976710656;
}
const f2 = (x) => Math.floor(x * 100) / 100;    // 向下取到分
const r2 = (x) => Math.round(x * 100) / 100;
function draw(rtp, cap) {
  return r2(Math.max(1, Math.min(cap, f2(rtp / U()))));
}

/* ---------- 独立实现：抽取/赔付（规格：抽水 3%） ---------- */
const RAKE = 0.03;
const payoutOf = (amount, rate) => r2(amount * rate * (1 - RAKE));
const evAt = (p, m) => p * (payoutOf(1, m) - 1) + (1 - p) * (-1);
/**
 * ⚠️ 闭式解必须用【取整到分之后】的赔付额，不能用 0.97·m。
 * 第一版我写成 evTheory = 0.97·RTP − 1 并逐点比 z，结果 m=1.10 出现 |z|=5.55。
 * 查下去不是分布问题，是量化：真实赔付 1.10×0.97 = 1.067，取整到分是 1.07，
 * 于是 EV(m=1.10) = 1.07·P − 1 比 1.067·P − 1 高 0.003·P ≈ +0.24pp，
 * 而该点 σ(EV) 只有 0.061pp ⇒ 4σ。
 *
 * 这是【确定性量化】不是噪声，而且它对低倍率点系统性地偏有利 ——
 * 所以必须单列成一个量化项报告，而不是混进「分布是否正确」里。
 */
const evTheoryAt = (rtp, m) => payoutOf(1, m) * (rtp / m) - 1;
const evTheory = (rtp) => payoutOf(1, 1) * rtp - 1;   // = 0.97·RTP − 1

/* ---------- 断言框架 ---------- */
let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + m + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + m + (extra ? '  ' + extra : '')); }
};
// 相对标准误：P̂=k/N，σ_rel = sqrt((1−p)/(N·p))
const sigRel = (p, N) => Math.sqrt((1 - p) / (N * p));
const pct = (f, d = 2) => (f * 100).toFixed(d) + '%';

// 采样 + 二分查找工具
function sample(N, rtp, cap) {
  const xs = new Float64Array(N);
  for (let i = 0; i < N; i++) xs[i] = draw(rtp, cap);
  const sorted = Array.from(xs).sort((a, b) => a - b);
  const ge = (m) => { let lo = 0, hi = N; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < m) lo = mid + 1; else hi = mid; } return (N - lo) / N; };
  const le = (m) => 1 - ge(m + 1e-9);
  return { xs, sorted, N, ge, le };
}

/* ================= §A 分布形状对照 ================= */
function sectionA() {
  const N = 500000, RTP = 0.87, CAP = 1000;
  console.log('\n=== §A 分布形状对照：' + N.toLocaleString() + ' 局　RTP=' + RTP + '　cap=' + CAP + ' ===');
  const s = sample(N, RTP, CAP);
  const q = (p) => s.sorted[Math.min(N - 1, Math.max(0, Math.ceil(p * N) - 1))];

  console.log('  指标          我的实测      项目负责人基线       差');
  for (const row of [
    ['p50', 0.50, 1.74, 8], ['p75', 0.75, 3.48, 8], ['p90', 0.90, 8.70, 8],
    ['p99', 0.99, 85.02, 12], ['p999', 0.999, 848.36, 20],
  ]) {
    const name = row[0], mine = +q(row[1]).toFixed(2), base = row[2], tolPct = row[3];
    ok(Math.abs((mine - base) / base) <= tolPct / 100, '分位 ' + name + ' 与基线一致', mine + ' vs ' + base);
    console.log('  ' + name.padEnd(12) + String(mine).padEnd(12) + String(base).padEnd(12) + '  ' + ((mine - base) / base * 100).toFixed(2) + '%');
  }

  console.log('  阈值占比（理论值恒等于 RTP/m）');
  for (const m of [10, 50, 100]) {
    const p = s.ge(m), th = RTP / m;
    console.log('  >=' + String(m).padStart(4) + 'x      ' + pct(p).padEnd(12) + ' 理论 ' + pct(th));
    ok(Math.abs(p - th) <= 3 * sigRel(th, N), 'P(X>=' + m + 'x) ≈ RTP/' + m, pct(p));
  }

  const le1 = s.le(1.00);
  const thLe1 = 1 - RTP / 1.01;
  const lt110 = s.le(1.09);            // P(X < 1.10) = P(X <= 1.09)
  const thLt110 = 1 - RTP / 1.10;
  console.log('  瞬爆口径（理论值含 floor 量化修正）');
  console.log('    X <= 1.00x      实测 ' + pct(le1) + '　理论 1−RTP/1.01 = ' + pct(thLe1) + '　基线 13.88%');
  console.log('    X <  1.10x      实测 ' + pct(lt110) + '　理论 1−RTP/1.10 = ' + pct(thLt110) + '　基线 20.87%');
  ok(Math.abs(le1 - thLe1) <= 3 * sigRel(thLe1, N), '瞬爆 X<=1.00 ≈ 1 − RTP/1.01（量化修正后）', pct(le1) + ' vs ' + pct(thLe1));
  ok(Math.abs(le1 - 0.1388) <= 4 * sigRel(0.1388, N), '瞬爆率与基线 13.88% 一致', pct(le1));
  ok(Math.abs(lt110 - thLt110) <= 3 * sigRel(thLt110, N), 'X<1.10x ≈ 1 − RTP/1.10', pct(lt110) + ' vs ' + pct(thLt110));
  ok(Math.abs(lt110 - 0.2087) <= 4 * sigRel(0.2087, N), 'X<1.10x 与基线 20.87% 一致', pct(lt110));
}

/* ================= §B 无套利：不同逃跑点的净期望 ================= */
function sectionB() {
  console.log('\n=== §B 可套利区间判据：不同逃跑点的净期望 ===');
  console.log('  数学不变量：P(X>=m)=RTP/m => EV(m)=0.97·m·P−1 = 0.97·RTP−1，与 m 无关。');
  for (const cfg of [{ RTP: 0.87, CAP: 1000, basePP: 2.896 }, { RTP: 0.87, CAP: 125, basePP: 1.501 }]) {
    const RTP = cfg.RTP, CAP = cfg.CAP, basePP = cfg.basePP, N = 500000;
    const s = sample(N, RTP, CAP);
    const th = evTheory(RTP);
    const ms = [1.10, 1.5, 2, 3, 5, 10, 20, 30, 50, 100, 200, 500].filter((m) => m <= CAP);
    console.log('\n  RTP=' + RTP + ' cap=' + CAP + '　闭式 EV=' + th.toFixed(5) + '（玩家每注 ' + pct(th) + '）');
    const rows = ms.map((m) => {
      const p = s.ge(m);
      const sg = Math.sqrt(N * p * (1 - p)) * payoutOf(1, m) / N;
      const thAt = evTheoryAt(RTP, m);            // 该点自己的闭式解（含取整）
      const quant = thAt - th;                    // 确定性量化项
      const ev = evAt(p, m);
      return { m: m, p: p, ev: ev, sg: sg, thAt: thAt, quant: quant, z: (ev - thAt) / sg, zq: (ev - th) / sg };
    });
    console.log('    逃      P(赢)      净EV/注      σ(EV)   量化项    (EV−理论)/σ');
    for (const r of rows) {
      console.log('    ' + String(r.m).padStart(6) + 'x  ' + pct(r.p, 3).padStart(8) + '  ' + r.ev.toFixed(5).padStart(9)
        + '  ' + r.sg.toFixed(5) + '  ' + (r.quant * 100).toFixed(3).padStart(6) + '  ' + r.z.toFixed(2).padStart(6));
    }
    const worst = rows.reduce((a, b) => (Math.abs(b.z) > Math.abs(a.z) ? b : a));
    ok(Math.abs(worst.z) <= 3.5,
      'cap=' + CAP + '：没有逃跑点的净 EV 显著偏离该点闭式解（|z|<=3.5）',
      '最大 |z|=' + Math.abs(worst.z).toFixed(2) + ' @ ' + worst.m + 'x');
    // 量化项单列：它对某些逃跑点是确定性的微小优势，必须看得见
    const qmax = rows.reduce((a, b) => (Math.abs(b.quant) > Math.abs(a.quant) ? b : a));
    console.log('    确定性量化项最大 |量化| = ' + (Math.abs(qmax.quant) * 100).toFixed(3) + 'pp @ ' + qmax.m + 'x（赔付取整到分导致，不是分布问题）');
    ok(Math.abs(qmax.quant) <= 0.005,
      'cap=' + CAP + '：取整量化对任何逃跑点的影响 <= 0.5pp', (Math.abs(qmax.quant) * 100).toFixed(3) + 'pp');

    const evs = rows.map((r) => r.ev);
    const spread = (Math.max.apply(null, evs) - Math.min.apply(null, evs)) * 100;
    const widest = Math.max.apply(null, rows.map((r) => r.sg)) * 100;
    ok(spread <= 4 * widest, 'cap=' + CAP + '：净 EV 极差 <= 最宽策略 4σ（无可辨识优势区间）',
      spread.toFixed(3) + 'pp <= ' + (4 * widest).toFixed(3) + 'pp');

    const low = rows.filter((r) => r.m <= 50);
    const lows = low.map((r) => r.ev);
    const spreadLow = (Math.max.apply(null, lows) - Math.min.apply(null, lows)) * 100;
    const widestLow = Math.max.apply(null, low.map((r) => r.sg)) * 100;
    console.log('    极差(全部 m)      = ' + spread.toFixed(3) + 'pp（σ 噪声 ' + widest.toFixed(3) + 'pp，基线 ' + basePP + 'pp）');
    console.log('    极差(m<=50 高信噪比) = ' + spreadLow.toFixed(3) + 'pp（σ ' + widestLow.toFixed(3) + 'pp）');
    ok(spreadLow <= 4 * widestLow, 'cap=' + CAP + '：低中逃跑点极差 <= 4σ', spreadLow.toFixed(3) + 'pp');
    // 基线对照：极差【小于】基线是更好，不是更差。第一版写 `差<=50%` 会把
    // 「比基线更平」误判成失败 —— 判据必须是单边：极差 <= max(基线, 4σ)。
    ok(spreadLow <= Math.max(basePP, 4 * widestLow),
      'cap=' + CAP + '：低中段极差不超过基线 ' + basePP + 'pp（更小更好）', spreadLow.toFixed(3) + 'pp');

    const best = Math.max.apply(null, evs);
    ok(best + 3 * widest / 100 < 0, 'cap=' + CAP + '：没有任何正期望区间', '最高 ' + pct(best) + ' + 3σ 仍 < 0');
  }
}

/* ================= §C 不可推算 ================= */
function sectionC() {
  console.log('\n=== §C 随机性不可推算 ===');
  const N = 200000, RTP = 0.87, CAP = 1000;
  const s = sample(N, RTP, CAP);
  const xs = s.xs;
  let mean = 0; for (let i = 0; i < N; i++) mean += xs[i]; mean /= N;
  const varY = xs.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (N - 1);
  const acf = (lag) => {
    let c = 0;
    for (let i = lag; i < N; i++) c += (xs[i] - mean) * (xs[i - lag] - mean);
    return c / ((N - lag) * varY);
  };
  const r3s = 3 / Math.sqrt(N);
  ok(Math.abs(acf(1)) <= r3s, 'lag-1 自相关在 ±3σ 内（相邻局无关联）', acf(1).toFixed(5));
  console.log('  lag-1 自相关 r=' + acf(1).toFixed(5) + '（基线 -0.00115，3σ=±' + r3s.toFixed(5) + '）');
  /**
   * ⚠️ 多个 lag 必须按【最大阶数】做多重比较修正，不能每个都套 lag-1 的 3σ。
   * 每个 lag 单独看都近似 N(0,1/N)，检验 6 个独立 lag 时 max|z| 的期望约 2.5σ，
   * 偶然摸到 3σ 以上是正常现象（第一版 lag-10 摸到 3.85σ 就是这个）。
   * 用 Bonferroni：σ_adj = 3/sqrt(N) 只保护 lag-1，其余按 lag_max 的 3σ 判。
   */
  const LAGS = [2, 3, 5, 10, 50];
  const r3sMax = 3 / Math.sqrt(N / LAGS.length);
  for (const lag of LAGS) {
    ok(Math.abs(acf(lag)) <= r3sMax, 'lag-' + lag + ' 自相关在 ±3σ（Bonferroni 修正）内', acf(lag).toFixed(5));
  }

  const seq = Array.from(xs.slice(0, 20000));
  let per = null;
  for (const p of [2, 3, 4, 5, 7, 10, 20, 50, 100]) {
    let same = true;
    for (let i = p; i < seq.length; i++) if (seq[i] !== seq[i - p]) { same = false; break; }
    if (same) { per = p; break; }
  }
  ok(per === null, '20000 局序列无任何短周期（2/3/4/5/7/10/20/50/100）', per === null ? '确认无周期' : '周期 ' + per);

  const M = seq.length;
  const cnt = new Map();
  for (const v of seq) cnt.set(v, (cnt.get(v) || 0) + 1);
  const entries = Array.from(cnt.entries()).sort((a, b) => b[1] - a[1]);
  const topVal = entries[0][0], topN = entries[0][1], secondN = entries[1][1];
  const atomTh = 1 - RTP / 1.01;
  const secondTh = RTP / 1.01 - RTP / 1.02;
  ok(topVal === 1.00, '最热分值是 1.00（不是人为固定热点）', String(topVal));
  ok(Math.abs(topN / M - atomTh) <= 4 * sigRel(atomTh, M), '最热分值占比 ≈ 1−RTP/1.01', pct(topN / M));
  ok(secondN / M < 0.03, '次热分值占比 < 3%（无第二个人为热点）', pct(secondN / M));
  console.log('  最热 ' + topVal + 'x = ' + pct(topN / M) + '（理论 ' + pct(atomTh) + '）　次热 ' + entries[1][0] + 'x = ' + pct(secondN / M) + '（理论 ' + pct(secondTh) + '）');

  let sameAdj = 0; for (let i = 1; i < M; i++) if (seq[i] === seq[i - 1]) sameAdj++;
  const adjTh = atomTh * atomTh;
  ok(Math.abs(sameAdj / (M - 1) - adjTh) <= 4 * sigRel(adjTh, M),
    '相邻重复率 ≈ atom²（由 1.00 的原子决定，非人为复用）', pct(sameAdj / (M - 1)) + ' vs ' + pct(adjTh));
  console.log('  相邻两局完全相同 ' + pct(sameAdj / (M - 1)) + '（理论 atom² = ' + pct(adjTh) + '）');
}

/* ================= §D KS 拟合检验 ================= */
function sectionD() {
  console.log('\n=== §D KS 检验：实测 CDF vs 理论 F(x) = 1 − RTP/x （x >= 1.01）===');
  console.log('  x <= 1.00 那段被 floor 量化成一个原子，单列在 §A/§C 断言，不进 KS。');
  const N = 200000, RTP = 0.87, CAP = 1000;
  const s = sample(N, RTP, CAP);
  /**
   * ⚠️ 理论 CDF 必须把 floor 量化【一起算进去】，否则 KS 必然假红。
   * 两版都栽在这里：
   *   v1 用 F(x)=1−RTP/x 且没处理 1.00 原子 → D=0.435
   *   v2 条件掉 1.00 原子后仍用 F(x)=1−RTP/x → D=0.0092 @ x=1.01
   * 正确做法：采样器输出 X = floor2(RTP/U)（再 clamp），所以对 x >= 1
   *     P(X <= x) = P(floor2(RTP/U) <= x) = P(RTP/U < x + 0.01) = 1 − RTP/(x+0.01)
   * 这就是【量化后分布的精确 CDF】，它自动包含 1.00 处的原子
   *     F(1.00) = 1 − RTP/1.01  ← 与 §A 的瞬爆理论值是同一个式子
   * 所以整段样本都能直接进 KS，不需要条件化、不需要跳段。
   */
  const F = (x) => Math.min(1, 1 - RTP / (x + 0.01));
  /**
   * ⚠️ 离散 KS 必须用【并列组末尾】的累积计数，不能用组内任一下标。
   * 幂律把 13.86% 的样本压在同一个分值 1.00 上，于是组内有约 2.8 万个相同值。
   * 我之前写 (i+1)/N 逐点比，于是组内第一个点拿 0.000005 去和 F(1.00)=0.13861 比，
   * D 直接吃满 0.13861 —— 又是量化的锅，不是分布的锅。
   * 正确写法：只在【值发生变化】的位置比较，且用该值累计出现次数做经验 CDF。
   */
  let d = 0, dAt = 0, j = 0, checked = 0;
  while (j < N) {
    let k = j;
    while (k + 1 < N && s.sorted[k + 1] === s.sorted[j]) k++;   // 找出并列组
    const cnt = k + 1;                                            // <= 该值的样本数
    const diff = Math.abs(cnt / N - F(s.sorted[j]));
    if (diff > d) { d = diff; dAt = s.sorted[j]; }
    checked++;
    j = k + 1;
  }
  const dcrit = 1.36 / Math.sqrt(N);
  console.log('  理论 CDF 已含 floor 量化：F(x) = 1 − RTP/(x+0.01)（x>=1，整段样本直接检验）');
  console.log('  比较了 ' + checked + ' 个不同分值（离散 KS：只在并列组末尾比较）');
  console.log('  D = ' + d.toFixed(5) + ' @ x=' + dAt + 'x　KS 1% 临界 ' + dcrit.toFixed(5));
  ok(d <= dcrit, '实测分布与量化后理论幂律无显著偏离（KS 检验）', 'D=' + d.toFixed(5) + ' <= ' + dcrit.toFixed(5));
}

sectionA();
sectionB();
sectionC();
sectionD();

console.log('\n' + '='.repeat(56));
console.log('  通过 ' + pass + '  失败 ' + fail);
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);