/**
 * 模式 5 迁移 —— 部署后必须执行。
 *
 * 背景：DEFAULT_SETTINGS 只在 settings 表为空时生效，已有数据库不会
 * 跟着新默认值更新。线上此前是 odds_mode=4（均匀分布）+ band 1.1–50，
 * 实测 81.8% 的局超过 10x、41% 超过 30x，10 局净赚 5 倍本金。
 * 所以光传代码不够，必须显式写库。
 *
 * 幂等：重复执行结果一致；已存在的值可被显式覆盖。
 *
 * 用法：
 *   node scripts/migrate-odds5.js              # 只看当前值
 *   node scripts/migrate-odds5.js --apply      # 写入
 *   node scripts/migrate-odds5.js --apply --force   # 连 odds_mode 一起改
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');

const dbPath = process.env.DB_FILE || path.join(__dirname, '..', '..', 'data', 'baodian.db');
const db = new DatabaseSync(path.resolve(dbPath));

const cur = {};
db.prepare('SELECT key, value FROM settings').all().forEach(r => { cur[r.key] = r.value; });

// 中位 10x + 1.01 瞬爆（20 万局模拟：中位 10.32x，平均 13.53x，
// 10x+ 占 51.8%，瞬爆 5.0%；2x 逃成功 71.2%，10x 逃成功 55.7%）
const PLAN = {
  w_low: '22', w_mid: '48', w_high: '25',
  w_lo_min: '1.10', w_lo_max: '1.70',
  w_mid_min: '6.00', w_mid_max: '15.00',
  w_high_min: '15.00', w_high_max: '50.00',
  w_boom: '5', w_boom_max: '1.04',
  max_rate: '50',
};
// 只有 --force 才动 odds_mode（它决定了整局节奏，不该被迁移脚本悄悄改掉）
if (FORCE) PLAN.odds_mode = '5';

const show = ['odds_mode', 'min_rate', 'max_rate', 'band_min', 'band_max', 'pool_balance', 'rake_percent'];
const planKeys = Object.keys(PLAN);

console.log('数据库:', path.resolve(dbPath));
console.log('\n=== 当前赔率相关配置 ===');
show.forEach(k => console.log('  ' + k.padEnd(16) + (cur[k] !== undefined ? cur[k] : '(未设置)')));

console.log('\n=== 目标值（方案 C）===');
planKeys.forEach(k => {
  const same = cur[k] === PLAN[k];
  console.log('  ' + k.padEnd(16) + PLAN[k].padEnd(10) + (same ? '已一致' : '当前 ' + (cur[k] !== undefined ? cur[k] : '(未设置)')));
});

if (!APPLY) {
  const need = planKeys.filter(k => cur[k] !== PLAN[k]);
  console.log('\n仅查看，未写入。' + (need.length
    ? `需要更新 ${need.length} 项，加 --apply 执行。`
    : '全部已一致，无需写入。'));
  if (!FORCE && cur.odds_mode !== '5') {
    console.log('提示：当前赔率模式 = ' + cur.odds_mode + '（非 5）。确认要切换时加 --force。');
  }
  process.exit(0);
}

const stmt = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
const tx = db.prepare('SELECT 1');
void tx;
db.exec('BEGIN');
let n = 0;
for (const [k, v] of Object.entries(PLAN)) {
  if (cur[k] === v) continue;
  stmt.run(k, v);
  console.log('  ✓ ' + k.padEnd(16) + (cur[k] !== undefined ? cur[k] : '(未设置)') + ' → ' + v);
  n++;
}
db.exec('COMMIT');

console.log('\n完成，更新 ' + n + ' 项。' + (n === 0 ? '（无变化）' : '下一局生效。'));
if (!FORCE) console.log('赔率模式未改动（需要时用 --force 切到模式 5）。');
db.close();
