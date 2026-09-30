/** 精确定位：antiPattern 每条规则各自把多少倍率推离原档 */
const M = require('../server/jev-rate');
const { normRange, normShape, buildZones, skewed, zonePower } = M;
const range = normRange({ minRate: 1.01, maxRate: 120 });
const shape = normShape({ low: 60, mid: 30, high: 10 });
const zones = buildZones(range, shape);
const zk = (v) => { const z = zones.find((x) => v >= x.min && x.max >= v); return z ? z.key : '??'; };

const N = 200000;
let stat = { low: 0, mid: 0, high: 0, '??': 0 };
let moved = 0, rule1 = 0, rule2 = 0, both = 0;
const hist = [];
for (let i = 0; i < N; i++) {
  let r = Math.random() * 100, z = zones[0];
  for (const c of zones) { r -= shape[c.key]; if (r <= 0) { z = c; break; } }
  const raw = skewed(0, z.min, z.max, zonePower(z));
  const before = zk(raw);

  // 复刻 antiPattern 的两条规则
  const last = hist.length ? hist[hist.length - 1] : null;
  let v = raw, h1 = false, h2 = false;
  if (last != null && last >= range.min) {
    const ratio = v / last;
    if (ratio > 0.88 && ratio < 1.14) {
      h1 = true;
      const z0 = zones.find((x) => v >= x.min && v <= x.max) || zones[0];
      const goUp = Math.random() < 0.5;
      const lo = goUp ? Math.min(z0.max, v * 1.18) : z0.min;
      const hi = goUp ? z0.max : Math.max(z0.min, v * 0.85);
      v = (hi > lo) ? skewed(0, lo, hi, 1.1) : (goUp ? z0.max : z0.min);
    }
    if (hist.length >= 2) {
      const a = zk(hist[hist.length - 1]), b = zk(hist[hist.length - 2]);
      const cur = zk(v);
      if (cur === a && a === b) {
        h2 = true;
        const cz = zones.find((x) => x.key === cur);
        const w = zones.map((x) => Math.max(0.01, shape[x.key]) * (x.key === cur ? 0.02 : 1));
        const tot = w.reduce((s, q) => s + q, 0);
        let pk = Math.random() * tot, target = zones[2];
        for (let j = 0; j < zones.length; j++) { pk -= w[j]; if (pk <= 0) { target = zones[j]; break; } }
        let nv = skewed(0, target.min, target.max, zonePower(target));
        if (v / last > 0.88 && v / last < 1.14) nv = Math.min(target.max, nv * 1.2);
        v = nv;
      }
    }
  }
  const after = zk(v);
  stat[after]++;
  if (after !== before) moved++;
  if (h1) rule1++;
  if (h2) rule2++;
  if (h1 && h2) both++;
  hist.push(v);
  if (hist.length > 6) hist.shift();
}

console.log(`样本 ${N}`);
console.log('落档分布：', stat);
console.log(`换档发生 ${moved} (${(moved/N*100).toFixed(1)}%)`);
console.log(`规则①触发 ${rule1} (${(rule1/N*100).toFixed(1)}%)`);
console.log(`规则②触发 ${rule2} (${(rule2/N*100).toFixed(1)}%)`);
console.log(`两条都触发 ${both} (${(both/N*100).toFixed(1)}%)`);
console.log(`配置目标  low 60 / mid 30 / high 10`);
