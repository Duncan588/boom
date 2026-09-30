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