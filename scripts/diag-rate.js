/** 诊断：high 档为什么超标？分别测「无 antiPattern」和「有」的分布 */
const { normRange, normShape, buildZones, skewed, zonePower, clamp, round2 } =
  require('../server/jev-rate');

const range = normRange({ minRate: 1.01, maxRate: 120 });
const shape = normShape({ low: 60, mid: 30, high: 10 });
const zones = buildZones(range, shape);

console.log('档位定义：');
zones.forEach((z) => console.log(`  ${z.key.padEnd(5)} ${z.min} – ${z.max}  跨度 ${(z.max - z.min).toFixed(2)}  power ${zonePower(z).toFixed(2)}`));

// A. 纯抽档（不做任何 antiPattern）
const N = 200000;
const cnt = { low: 0, mid: 0, high: 0 };
const zoneVal = { low: [], mid: [], high: [] };
for (let i = 0; i < N; i++) {
  let r = Math.random() * 100, z = zones[0];
  for (const c of zones) { r -= shape[c.key]; if (r <= 0) { z = c; break; } }
  cnt[z.key]++;
  const v = skewed(0, z.min, z.max, zonePower(z));
  zoneVal[z.key].push(v);
}
console.log('\nA. 纯抽档 + 档内取值（无 antiPattern）');
for (const k of ['low', 'mid', 'high']) {
  const a = zoneVal[k].slice().sort((x, y) => x - y);
  const med = a[Math.floor(a.length / 2)];
  console.log(`  ${k.padEnd(5)} 抽中 ${(cnt[k] / N * 100).toFixed(1)}%  档内中位 ${med.toFixed(2)}x`);
}

// B. antiPattern 的实际影响
const { antiPattern, fallbackRate } = require('../server/jev-rate');
const hist = [];
const cnt2 = { low: 0, mid: 0, high: 0 };
let triggers = 0;
for (let i = 0; i < N; i++) {
  const raw = (() => {
    let r = Math.random() * 100, z = zones[0];
    for (const c of zones) { r -= shape[c.key]; if (r <= 0) { z = c; break; } }
    return { v: skewed(0, z.min, z.max, zonePower(z)), z: z.key };
  })();
  const v = antiPattern(raw.v, hist, range, zones, shape);
  const zz = zones.find((z) => v >= z.min && v <= z.max);
  cnt2[zz ? zz.key : '?']++;
  hist.push(v);
  if (hist.length > 6) hist.shift();
}
console.log('\nB. + antiPattern');
for (const k of ['low', 'mid', 'high']) {
  console.log(`  ${k.padEnd(5)} ${(cnt2[k] / N * 100).toFixed(1)}%  (目标 ${shape[k]}%)  Δ${((cnt2[k]/N*100) - shape[k]).toFixed(1)}`);
}
