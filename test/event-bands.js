'use strict';
/**
 * test/event-bands.js —— mode 11 活动档位引擎的验收
 *
 * 这个引擎【故意】不保证公平（运营 2026-10-02 拍板），所以断言分两类：
 *   ① 机制类：比例精确、随机源、隔离、护栏 —— 这些必须是恒真的性质
 *   ② 风险类：把「最赚的固定逃跑点」算出来并断言它【确实存在且为正】
 *      —— 断言它不存在就是在自欺欺人，那正是这个引擎被批准的原因
 *
 * ⚠️ 所有断言都是【性质】，不是具体数值。随机算法断言值 = 随机红。
 */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.join(__dirname, '..');

const EB = require(path.join(ROOT, 'server', 'odds', 'event-bands.js'));
const ODDS = require(path.join(ROOT, 'server', 'odds'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const CFG = {};                       // 空配置 = 默认 10/70/20

/* ---------- §1 三档比例必须精确 ---------- */
section('§1 三档比例（构造精确，不受区间长度影响）');
{
  const N = 200000;
  const rows = EB.normBands(EB.bandsFromCfg(CFG));
  ok('默认三档', rows.length === 3, rows.map(r => r.label).join(' / '));
  const cnt = rows.map(() => 0);
  for (let i = 0; i < N; i++) {
    const x = EB.eventRate(CFG);
    for (let b = 0; b < rows.length; b++) if (x >= rows[b].min && x <= rows[b].max) { cnt[b]++; break; }
  }
  rows.forEach((r, b) => {
    const p = cnt[b] / N * 100;
    const target = r.p * 100;
    // 容差 0.5 个百分点：二项噪声 σ(100%) 在 N=20 万下约 0.1pp，取 5σ
    ok(`${r.label} ≈ ${target.toFixed(0)}%`, Math.abs(p - target) < 0.5, `实测 ${p.toFixed(2)}%`);
  });
  // 三档必须覆盖满 100%（没有落在三档之外的局）
  const total = cnt.reduce((a, b) => a + b, 0);
  ok('没有局落在三档之外', total === N, total + '/' + N);

  // ⚠️ 这条是本次差点漏掉的【系统性偏差】的闸门。
  //    历史实测：高档 20.83%（目标 20%），偏差 0.83pp，
  //    而 0.5pp 容差 + 5σ 的组合让 1/6 次运行变红 —— 那是真缺陷不是抖动。
  //    根因是相邻档公共端点（30.00）归属不唯一，被「≥30」判据收走。
  //    容差 0.35pp ≈ 5σ（N=20 万、p=0.2 时 σ=0.089pp），比缺陷小 2 倍。
  const hi = cnt[2] / N * 100;
  ok('高档占比无系统性偏移（容差 0.35pp ≈ 5σ）', Math.abs(hi - 20) < 0.35,
     hi.toFixed(3) + '%（缺陷版本会到 20.8%）');
}

/* ---------- §2 区间与量级 ---------- */
section('§2 区间与量级');
{
  const N = 100000;
  let mn = Infinity, mx = 0, ge120 = 0, ge100 = 0;
  for (let i = 0; i < N; i++) {
    const x = EB.eventRate(CFG);
    if (x < mn) mn = x;
    if (x > mx) mx = x;
    if (x >= 120) ge120++;
    if (x >= 100) ge100++;
  }
  ok('最小 ≥ 1.00（不出现 0 倍局）', mn >= 1, 'min=' + mn);
  ok('最大 ≤ 120（高档上界被尊重）', mx <= 120, 'max=' + mx);
  ok('120x 真的会出现（对数抽样的意义）', ge120 > 0, '≥120x: ' + ge120 + ' 局');
  ok('100x 尾部不空（≈2.6%）', ge100 > N * 0.005, '≥100x ' + (ge100 / N * 100).toFixed(2) + '%');
  // 低档下界必须真的能到 1
  let atMin = 0;
  for (let i = 0; i < 50000; i++) if (EB.eventRate(CFG) < 1.5) atMin++;
  // ⚠️ 原来断言「<1.5x 的局占约 10%」是错的：对数/线性混合后 1-5x 档
  //    在 1.5x 以下只占该档的一部分（实测 2.4%），10% 是整个 1-5x 档。
  ok('低档线性到 1.00x（下界可达）', atMin > 0,
     '≤1.00x: ' + atMin + ' 局 / 5 万');
}

/* ---------- §3 随机源 ---------- */
section('§3 随机源（CSPRNG，无 Math.random）');
{
  const src = fs.readFileSync(path.join(ROOT, 'server', 'odds', 'event-bands.js'), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
  ok('代码里没有 Math.random', !/Math\.random/.test(code),
     '注释里 ' + (src.match(/Math\.random/g) || []).length + ' 处');
  ok('使用 crypto.randomBytes', /crypto\.randomBytes/.test(code));

  const orig = Math.random; let hit = 0;
  Math.random = () => { hit++; return orig(); };
  for (let i = 0; i < 20000; i++) EB.eventRate(CFG);
  Math.random = orig;
  ok('20000 次抽样中 Math.random 调用 0 次', hit === 0, '实际 ' + hit);
}

/* ---------- §4 纯函数 / 无状态 ---------- */
section('§4 纯函数 · 无状态 · 无记忆');
{
  const a = [];
  for (let i = 0; i < 500; i++) a.push(EB.eventRate(CFG));
  const b = [];
  for (let i = 0; i < 500; i++) b.push(EB.eventRate(CFG));
  // 同一个分布两次抽样：分布形态应一致（不是逐值一致）
  const rate = (arr) => arr.filter(x => x >= 30).length / arr.length;
  ok('两次抽样高档占比一致（无记忆）', Math.abs(rate(a) - rate(b)) < 0.10,
     (rate(a) * 100).toFixed(1) + '% vs ' + (rate(b) * 100).toFixed(1) + '%');

  // 签名里不能有 pot/pool/ctx —— 与幂律同一条纪律
  const src = fs.readFileSync(path.join(ROOT, 'server', 'odds', 'event-bands.js'), 'utf8');
  const fn = src.slice(src.indexOf('function eventRate'));
  ok('eventRate 不读 pot/pool/ctx',
     !/\b(pot|pool|ctx|seated|lastBoom)\b/.test(fn.slice(0, fn.indexOf('\n}'))),
     '引擎与房间状态完全解耦');
}

/* ---------- §5 配置归一化 ---------- */
section('§5 配置归一化（后台随便填都不崩）');
{
  ok('权重全 0 → 返回 null（由 eventDecide 兜底）',
     EB.normBands([{ min: 1, max: 5, w: 0 }, { min: 5, max: 30, w: 0 }, { min: 30, max: 120, w: 0 }]) === null);
  const d = EB.eventDecide({ event_bands_json: JSON.stringify([
    { label: 'a', min: 1, max: 5, w: 0 }, { label: 'b', min: 5, max: 30, w: 0 }, { label: 'c', min: 30, max: 120, w: 0 },
  ]) }, {});
  ok('权重全 0 时退到 1.00x 而不是崩', d.rate === 1 && d.misconfigured === true,
     d.rate + ' misconfigured=' + d.misconfigured);

  ok('非法 JSON → 回默认档位', EB.bandsFromCfg({ event_bands_json: '{oops' }) === EB.BANDS);
  ok('非数组 → 回默认档位', EB.bandsFromCfg({ event_bands_json: '"x"' }) === EB.BANDS);

  // 区间倒挂 / 越界
  const r = EB.normBands([{ label: 'x', min: 50, max: 10, w: 100 }]);
  ok('下界 > 上界被修正（min 拉齐到 max）', r[0].max >= r[0].min, r[0].min + '-' + r[0].max);
  const r2 = EB.normBands([{ label: 'y', min: 0.1, max: 99999, w: 100 }]);
  ok('倍率被夹到 [1,1000]', r2[0].min === 1 && r2[0].max === 1000, r2[0].min + '-' + r2[0].max);

  // 自定义比例可用
  const custom = { event_bands_json: JSON.stringify([
    { label: 'a', min: 1, max: 2, w: 50 }, { label: 'b', min: 2, max: 4, w: 30 }, { label: 'c', min: 4, max: 100, w: 20 },
  ]) };
  let hi = 0; const M = 50000;
  for (let i = 0; i < M; i++) if (EB.eventRate(custom) >= 4) hi++;
  ok('自定义比例生效（20% 在 4x+）', Math.abs(hi / M * 100 - 20) < 1, (hi / M * 100).toFixed(2) + '%');
}

/* ---------- §6 decideRate 接线 ---------- */
section('§6 decideRate 接线与护栏');
{
  const EV = { name: 't', min: 1, max: 120, to_min: 1320, from_min: 1260, unfair: true };
  const cfg11 = { odds_mode: '11' };

  const d = ODDS.decideRate(cfg11, 500, 0, EV, null);
  ok('mode 11 + 命中活动 → 走档位引擎', d.mode === '11-event-bands', d.mode);
  ok('返回 fair=false（明确告知不保证公平）', d.fair === false);
  ok('倍率在三档内', d.rate >= 1 && d.rate <= 120, d.rate);

  // 护栏一：没活动 → 回幂律
  const noEv = ODDS.decideRate(cfg11, 500, 0, null, null);
  ok('护栏一：mode 11 但没命中活动 → 回幂律（不是全天漏洞）',
     noEv.mode === '9-powerlaw', noEv.mode);

  // 护栏二：活动无结束时间 → 回幂律
  const noTo = ODDS.decideRate(cfg11, 500, 0, { name: 't', min: 1, max: 120 }, null);
  ok('护栏二：活动没有结束时间 → 回幂律',
     noTo.mode === '9-powerlaw', noTo.mode);

  // mode 10 优先级高于 11
  const cfg10 = { odds_mode: '10' };
  const d10 = ODDS.decideRate(cfg10, 500, 0, EV, null);
  ok('mode 10 优先于 11（两者同开时以 10 为准）', d10.mode !== '11-event-bands', d10.mode);

  // 日常路径不受影响
  const d9 = ODDS.decideRate({ odds_mode: '9' }, 500, 0, EV, null);
  ok('mode 9 不受影响（活动只加 RTP）', d9.mode === '9-powerlaw', d9.mode);
}

/* ---------- §7 风险：最赚的固定逃跑点（必须存在且为正）---------- */
section('§7 风险量化：最赚的固定逃跑点【必须】为正');
{
  const rep = EB.eventReport(CFG, 60000);
  console.log('  ' + rep.verdict);
  ok('确实存在正期望的固定逃跑点（这是本引擎被批准的前提）',
     rep.bestEscape.ev > 0, rep.bestEscape.m + 'x → ' + (rep.bestEscape.ev * 100).toFixed(0) + '%');
  ok('毛赔付远超零套利红线 ' + rep.grossHard,
     rep.bestEscape.gross > rep.grossHard, rep.bestEscape.gross + ' vs ' + rep.grossHard);
  ok('报告里 fair=false', rep.fair === false);
  // 三档占比也在报告里（后台要显示）
  ok('报告含三档占比', rep.bands.length === 3, rep.bands.map(b => b.label + ' ' + b.p + '%').join(' / '));
}

/* ---------- §8 独立性：空房 vs 真人局 ---------- */
section('§8 mode 11 不区分空房');
{
  const EV = { name: 't', min: 1, max: 120, to_min: 1320 };
  const cfg = { odds_mode: '11' };
  // ⚠️ 样本量是【量出来的】不是拍的：同一 pot 复现两次的中位偏差
  //    实测 N=3000 时最大 3.01%、N=20000 时 1.76%、N=50000 时 1.21%
  //    —— 那是纯抽样噪声。阈值必须【高于】噪声底，否则这条断言测的是
  //    运气而不是「decideRate 是否读 pot」。取 N=50000 / 阈值 3%（≈2.5σ）。
  const N = 50000;
  const shape = (pot) => {
    const a = []; for (let i = 0; i < N; i++) a.push(ODDS.decideRate(cfg, pot, 0, EV, null).rate);
    a.sort((x, y) => x - y);
    return { p10: a[(N * 0.1) | 0], p50: a[N >> 1], p90: a[(N * 0.9) | 0] };
  };
  const empty = shape(0), real = shape(5000);
  // ⚠️ 不能断言两次抽样的中位数【相等】—— 那是两次独立随机采样，
  //    差 0.01x 是必然的，写成 === 就是一条随机红的假闸门（实测 13.93 vs 13.94）。
  //    要证明的是「decideRate 不读 pot」，所以比【分布形态】而不是逐值。
  const drift = Math.abs(empty.p50 - real.p50) / real.p50;
  ok('空房与真人局分布形态相同（mode 11 不读 pot）', drift < 0.03,
     '中位 ' + empty.p50 + ' vs ' + real.p50 + '（偏差 ' + (drift * 100).toFixed(2) + '%）');
}

console.log('\n' + (fail ? '❌ ' : '✅ ') + '通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);