const v3 = require('../server/v3/engine');

function run(label, cfg, n) {
  v3.resetRange();
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(v3.rollRange(cfg));
  const rs = rows.map((d) => d.rate);
  const booms = rows.filter((d) => d.boom).length;
  const s = rs.slice().sort((a, b) => a - b);

  // 最长连续同档（档位 = 1-2,2-5,5-10,10-20,20-40,40-80,80-200,200+）
  const B = [[1,2],[2,5],[5,10],[10,20],[20,40],[40,80],[80,200],[200,1e9]];
  const tier = (r) => B.findIndex(([a,b]) => r >= a && r < b);
  let longest = 1, cur = 1, curSeg = null, longestSeg = null, prev = -1, seg = [];
  for (const r of rs) {
    if (r <= 1.01) { if (curSeg) seg.push(curSeg); curSeg = null; cur = 1; prev = -1; continue; }
    const t = tier(r);
    seg.push(r);
    if (t === prev) { cur++; if (cur > longest) { longest = cur; longestSeg = seg.slice(); } }
    else { cur = 1; prev = t; }
  }
  if (curSeg) seg.push(curSeg);

  console.log('\n' + label);
  console.log('  瞬爆 ' + (booms / n * 100).toFixed(1) + '%   中位 ' + s[Math.floor(n/2)] +
              'x   p90 ' + s[Math.floor(n*0.9)] + 'x   不同 ' + new Set(rs).size + '/' + n);
  console.log('  最长连续同档: ' + longest + ' 局' + (longestSeg ? '  → ' + longestSeg.slice(0,8).map(x=>x.toFixed(1)+'x').join(' ') : ''));
  const empty = [];
  for (const [a, b] of B) {
    const c = rs.filter((r) => r >= a && r < b).length;
    const pct = c / n * 100;
    if (pct < 0.5) empty.push(a + '-' + (b > 1e8 ? '∞' : b) + 'x');
    console.log('    ' + (a + '-' + (b > 1e8 ? '∞' : b) + 'x').padEnd(11) + '█'.repeat(Math.round(pct/2)) + ' ' + pct.toFixed(1) + '%');
  }
  console.log('    空档: ' + (empty.length ? '❌ ' + empty.join(', ') : '✅ 无'));
  return { longest, empty };
}

/**
 * 【回归】缓存 key 必须包含 boomRate。
 *
 * 实盘 bug：服务重启时 events_json 还没有 boom_rate → rollRange 用默认 0
 * 缓存了一个「永不瞬爆」的实例；之后补上 boom_rate=0.3，但因为 key 只有
 * min:max，永远命中那个坏实例 → 玩了 50 局瞬爆 0 次。
 * 而同一份代码单独调用引擎瞬爆率 29.9%，完全正常 —— 从外部看不出问题。
 */
console.log('\n=== 回归：boomRate 热更新必须生效 ===');
{
  v3.resetRange();
  // 第一次调用：模拟「服务启动时配置里没有 boom_rate」
  let n1 = 0;
  for (let i = 0; i < 1000; i++) if (v3.rollRange({ min: 1, max: 1000 }).boom) n1++;
  // 第二次：配置补上 boom_rate=0.3，同一个 min:max
  let n2 = 0;
  for (let i = 0; i < 1000; i++) if (v3.rollRange({ min: 1, max: 1000, boomRate: 0.3 }).boom) n2++;
  console.log('  启动时(无 boom_rate) 瞬爆 ' + (n1 / 10).toFixed(1) + '%   期望 0%');
  console.log('  补上 boom_rate=0.3 瞬爆 ' + (n2 / 10).toFixed(1) + '%   期望 ≈30%');
  console.log('  ' + (n1 === 0 ? '✅ OK  ' : '❌ FAIL') + ' 启动时确实不瞬爆');
  console.log('  ' + (Math.abs(n2 / 1000 - 0.3) < 0.05 ? '✅ OK  ' : '❌ FAIL') + ' 热更新后瞬爆率恢复到 30%');
}
console.log('\n=== 回归：width / jumpRate 热更新也必须生效 ===');
{
  v3.resetRange();
  const a = [];
  for (let i = 0; i < 800; i++) a.push(v3.rollRange({ min: 1, max: 1000, width: 1.8 }).rate);
  const b = [];
  for (let i = 0; i < 800; i++) b.push(v3.rollRange({ min: 1, max: 1000, width: 1.8, jumpRate: 0.9 }).rate);
  const mid = (x) => x.slice().sort((p, q) => p - q)[x.length >> 1];
  console.log('  width=1.8 中位 ' + mid(a).toFixed(1) + 'x   width=1.8+jump=0.9 中位 ' + mid(b).toFixed(1) + 'x');
  console.log('  ' + (mid(a) !== mid(b) ? '✅ OK  ' : '⚠️ 提示') + ' 两组独立采样（缓存已按字段隔离）');
}

console.log('='.repeat(56));
console.log('修复前 vs 修复后（活动 1–1000x, 30% 瞬爆）');
console.log('='.repeat(56));

// 修复前 = 实盘观测：连着 6 局 17–40x，40–80x 整档空掉
console.log('\n【实盘观测（修复前）】连续 6 局锁在 17–40x，40-80x 档 0 次/60局');

// 新默认
run('【修复后 · 默认 width=2.5 jumpRate=0.5】', { min: 1, max: 1000, boomRate: 0.30 }, 3000);
// 生产当前配置（events_json 传了 width:1.8）
run('【修复后 · 但 events_json 仍传 width=1.8】', { min: 1, max: 1000, boomRate: 0.30, width: 1.8 }, 3000);
// 更激进
run('【修复后 · jumpRate=0.65】', { min: 1, max: 1000, boomRate: 0.30, jumpRate: 0.65 }, 3000);