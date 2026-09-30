'use strict';
/**
 * mode 8（老虎机）配置解析的回归测试。
 *
 * 这些断言全部来自实盘踩过的坑：
 *   · 缓存 key 漏字段 → 改配置不重启就静默失效
 *   · undefined → 0 → 后台留空 = 永不瞬爆
 *   · 默认值被多除100 → 瞬爆率 0.1%
 */
const GL = require('../server/game-logic');
const v3 = require('../server/v3/engine');

let pass = 0, fail = 0;
function t(name, ok, got) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (got !== undefined ? '   ' + got : '')); }
}

function boomPct(cfg, n = 3000) {
  v3.resetRange();
  let b = 0;
  for (let i = 0; i < n; i++) if (GL.decideRate(cfg, 100, 0, null, {}).event?.boom) b++;
  return b / n * 100;
}

const base = { odds_mode: '8', min_rate: '1.01', max_rate: '120' };

console.log('\n=== 1. 瞬爆率解析 ===');
t('留空 → 默认 10%', Math.abs(boomPct({ ...base, slot_boom_rate: '' }) - 10) < 2.5, boomPct({ ...base, slot_boom_rate: '' }).toFixed(1) + '%');
t('没有这个键 → 默认 10%', Math.abs(boomPct(base) - 10) < 2.5, boomPct(base).toFixed(1) + '%');
t('配 20 → 20%', Math.abs(boomPct({ ...base, slot_boom_rate: '20' }) - 20) < 3, boomPct({ ...base, slot_boom_rate: '20' }).toFixed(1) + '%');
t('配 35 → 35%', Math.abs(boomPct({ ...base, slot_boom_rate: '35' }) - 35) < 4, boomPct({ ...base, slot_boom_rate: '35' }).toFixed(1) + '%');
t('配 0 → 真的 0%（不是默认值）', boomPct({ ...base, slot_boom_rate: '0' }) === 0, boomPct({ ...base, slot_boom_rate: '0' }).toFixed(1) + '%');
t('配 100 → 100%', boomPct({ ...base, slot_boom_rate: '100' }) > 99, boomPct({ ...base, slot_boom_rate: '100' }).toFixed(1) + '%');
t('配 150 → 钳到 100%', boomPct({ ...base, slot_boom_rate: '150' }) > 99, boomPct({ ...base, slot_boom_rate: '150' }).toFixed(1) + '%');
t('配 abc → 回默认 10%（不能变成 0）', Math.abs(boomPct({ ...base, slot_boom_rate: 'abc' }) - 10) < 2.5, boomPct({ ...base, slot_boom_rate: 'abc' }).toFixed(1) + '%');

console.log('\n=== 2. 倍率边界（走 min_rate / max_rate）===');
function stats(cfg, n = 3000) {
  v3.resetRange();
  const rs = [];
  for (let i = 0; i < n; i++) rs.push(GL.decideRate(cfg, 100, 0, null, {}).rate);
  return rs;
}
{
  const rs = stats({ ...base, max_rate: '120' });
  t('全部落在 1.01–120', rs.every((r) => r >= 1.01 && r <= 120), '越界 ' + rs.filter((r) => r < 1.01 || r > 120).length + ' 局');
}
{
  const rs = stats({ ...base, min_rate: '2.00', max_rate: '120' });
  const below = rs.filter((r) => r < 2.00).length;
  t('min_rate=2 时只有瞬爆能低于 2', below === rs.filter((r) => r <= 1.01).length, '低于2的非瞬爆 ' + (below - rs.filter((r) => r <= 1.01).length) + ' 局');
}
{
  const rs = stats({ ...base, min_rate: '1.01', max_rate: '1000' });
  const over100 = rs.filter((r) => r >= 100).length / rs.length;
  t('max_rate=1000 时高倍局出现（≥100x 占比 >3%）', over100 > 0.03, (over100 * 100).toFixed(1) + '%');
  t('出现 ≥500x 的局', rs.filter((r) => r >= 500).length > 0, '最高 ' + Math.max(...rs) + 'x');
}

console.log('\n=== 3. 缓存隔离（改配置必须立刻生效）===');
{
  v3.resetRange();
  const a = stats({ ...base, slot_boom_rate: '10' }, 1500);
  const b = stats({ ...base, slot_boom_rate: '60' }, 1500);
  const ba = a.filter((r) => r <= 1.01).length / a.length;
  const bb = b.filter((r) => r <= 1.01).length / b.length;
  t('同一进程内 10% → 60% 立即生效', bb > ba * 3, ba.toFixed(1) + '% → ' + bb.toFixed(1) + '%');
}

console.log('\n=== 4. 档位无空缺（千倍活动形态）===');
{
  const B = [[1, 2], [2, 5], [5, 10], [10, 20], [20, 40], [40, 80], [80, 200], [200, 1e9]];
  const rs = stats({ odds_mode: '8', min_rate: '1.01', max_rate: '1000', slot_boom_rate: '30' }, 20000);
  const empty = B.filter(([a, b]) => rs.filter((r) => r >= a && r < b).length === 0);
  t('20000 局八档全部有量', empty.length === 0, empty.length ? '空档 ' + empty.map(([a, b]) => a + '-' + b + 'x').join(',') : '');
  const s = rs.slice().sort((a, b) => a - b);
  console.log('       中位 ' + s[10000] + 'x  p90 ' + s[18000] + 'x  不同倍率 ' +
    (new Set(rs).size / rs.length * 100).toFixed(0) + '%');
}

console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===\n`);
process.exit(fail ? 1 : 0);