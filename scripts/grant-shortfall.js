/**
 * 给余额 < 阈值的玩家补足到阈值（单事务、幂等、可重复执行）。
 *
 * 用法：DB_FILE=/root/data/baodian.db node scripts/grant-shortfall.js [阈值] [--apply]
 *   不带 --apply 只预览
 *
 * 每笔都写 coin_logs（reason=admin_grant_shortfall），流水可追溯。
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const APPLY = process.argv.includes('--apply');
const THRESHOLD = Number(process.argv.find(a => /^\d+(\.\d+)?$/.test(a))) || 1000;

const dbPath = path.resolve(process.env.DB_FILE || path.join(__dirname, '..', '..', 'data', 'baodian.db'));
const db = new DatabaseSync(dbPath);

// 与 db.now() 同口径：北京时间
const now = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
}).format(new Date()).replace('T', ' ');

const targets = db.prepare(
  'SELECT id, username, global_name, coins FROM users WHERE coins < ? ORDER BY coins'
).all(THRESHOLD);

console.log('数据库:', dbPath);
console.log('阈值:', THRESHOLD);
console.log('符合条件:', targets.length, '人\n');

if (!targets.length) { console.log('无需发放。'); process.exit(0); }

let total = 0;
const rows = targets.map(r => {
  const need = Math.round((THRESHOLD - r.coins) * 100) / 100;
  total = Math.round((total + need) * 100) / 100;
  const name = r.global_name || r.username || ('#' + r.id);
  console.log('  ' + name.padEnd(22) + String(r.coins.toFixed(2)).padStart(12) + ' → ' + THRESHOLD.toFixed(2) +
    '  (+' + need.toFixed(2) + ')');
});
console.log('\n合计发放: ' + total.toFixed(2) + ' QUN');

if (!APPLY) {
  console.log('\n仅预览，未写入。确认后加 --apply。');
  process.exit(0);
}

const upd = db.prepare('UPDATE users SET coins = ? WHERE id = ?');
const log = db.prepare(
  'INSERT INTO coin_logs(user_id, delta, balance, reason, ref_id, created_at) VALUES(?,?,?,?,?,?)'
);
const ts = now();
db.exec('BEGIN');
try {
  for (const r of targets) {
    const need = Math.round((THRESHOLD - r.coins) * 100) / 100;
    upd.run(THRESHOLD, r.id);
    log.run(r.id, need, THRESHOLD, 'admin_grant_shortfall', 'shortfill:' + THRESHOLD, ts);
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('❌ 事务回滚：' + e.message);
  process.exit(1);
}

console.log('\n✅ 已发放 ' + targets.length + ' 笔，共 ' + total.toFixed(2) + ' QUN');
const after = db.prepare('SELECT COUNT(*) c FROM users WHERE coins < ?').get(THRESHOLD);
console.log('发放后仍低于 ' + THRESHOLD + ' 的玩家: ' + after.c + ' 人');
db.close();
