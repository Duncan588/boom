/**
 * 造一批机器人，让结算守恒测试真的跑起来。
 * 没有机器人 → 没人下注 → 结算分支不执行 → 测试假通过。
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB = process.env.TEST_DB
  || path.join(__dirname, '..', '..', process.env.DB_FILE || 'data', 'baodian.db');
const db = new DatabaseSync(DB);

const N = Number(process.argv[2] || 12);
const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
const names = ['阿虎', '小鹿', '老K', '阿豹', '喵喵', '大熊', '阿飞', '小美', '阿海', '球球', '阿灰', '小七', '阿宝', '小花'];

let added = 0;
for (let i = 0; i < N; i++) {
  const did = '9000000000000' + String(1000 + i);
  const exists = db.prepare('SELECT id FROM users WHERE discord_id = ?').get(did);
  if (exists) continue;
  db.prepare(`INSERT INTO users (discord_id, username, global_name, avatar, coins, frozen, is_bot, inviter_id, created_at, last_seen_at)
              VALUES (?,?,?,'',?,0,1,NULL,?,?)`)
    .run(did, names[i % names.length] + (i + 1), names[i % names.length] + (i + 1), 100000, now, now);
  db.prepare('INSERT INTO coin_logs (user_id, delta, balance, reason, ref_id, created_at) VALUES (?,?,?,?,?,?)')
    .run(db.prepare('SELECT id FROM users WHERE discord_id = ?').get(did).id, 100000, 100000, 'initial_grant', null, now);
  added++;
}
console.log('新增机器人:', added, '| 当前总数:', db.prepare('SELECT COUNT(*) c FROM users WHERE is_bot=1').get().c);
