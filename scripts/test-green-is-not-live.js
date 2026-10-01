'use strict';
/**
 * test-green-is-not-live.js —— 「测试全绿」不等于「线上生效」
 *
 * 【为什么这个脚本存在】
 * 第 6 节（出厂默认值断言）钉的是 POWERLAW.RTP_DEFAULT / CAP_DEFAULT，
 * 它读的是【代码常量】，不是【线上 settings 表】。
 *
 * 而 server/db.js 的 seedSettings() 只在【键不存在】时写入。
 * 线上库已经有 powerlaw_rtp / powerlaw_cap 这两个键，所以：
 *   · 代码常量   = 0.87 / 1000   ⇒ §6 全绿
 *   · 线上真实值 = 0.97 / 120    ⇒ 玩家实际玩的是旧值
 *
 * 两者可以同时成立，而且没有任何报错。§6 越绿，这个陷阱越危险 ——
 * 因为它给了「已经搞定了」的错觉。
 *
 * 所以本脚本只做一件事：把【代码常量】与【settings 表】并排读出来对照。
 * 它是纯只读的，不写库。
 *
 * 用法：
 *   node scripts/test-green-is-not-live.js                          # 自动定位库
 *   DB_FILE=<绝对路径> node scripts/test-green-is-not-live.js       # 指定库
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const GL = require(path.join(__dirname, '..', 'server', 'game-logic.js'));

const line = t => console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78));

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + m + (extra ? '  ' + extra : '')); } else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + m + (extra ? '  ' + extra : '')); } };

// ⚠️ 库路径：db.js:165 是 path.join(__dirname,'..','..','data','baodian.db')
//   server/db.js 的 __dirname = <repo>/server ⇒ 上溯两级 = <repo> 的父目录
//   所以库在 baodian/ 的【上一级】：E:\爆点\data\baodian.db
//   我上一轮写成了 baodian/data/baodian.db（多一层），拿到 unable to open
//   并把「我的路径错误」误报成「本地库不存在」。教训记在下面。
const DB_PATH = path.resolve(process.env.DB_FILE || path.join(__dirname, '..', '..', 'data', 'baodian.db'));

line('§1 代码常量 vs settings 表：并排对照');
console.log('  库路径: ' + DB_PATH);
console.log('  ⚠️ 上一轮我把这个路径写错了一层，误报成「本地库不存在」。');
console.log('     正确形状是 baodian/ 的上一级。核查方法：文件存在 + 有表 + 有历史行数。');
console.log('     「报错就说目录不存在」是错的推断方向 —— 先分清是路径错还是库空。');

let db = null;
try {
  db = new DatabaseSync(DB_PATH, { readOnly: true });
} catch (e) {
  console.error('\n❌ 打不开库：' + e.message);
  console.error('   传 DB_FILE=<绝对路径> 指定。先确认路径，别把路径错误当成库缺失。');
  process.exit(1);
}

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
const rowOf = (t) => { try { return db.prepare('SELECT COUNT(*) c FROM ' + t).get().c; } catch (_) { return null; } };
console.log('\n  表 (' + tables.length + '): ' + tables.join(', '));
const rounds = rowOf('rounds'), users = rowOf('users'), bets = rowOf('bets');
console.log('  rounds=' + rounds + '  users=' + users + '  bets=' + bets);
ok(rounds > 0 && users > 0, '这是一个【有历史的真库】，不是脚本自建的空库',
  'rounds=' + rounds + ' users=' + users);

const cur = {};
db.prepare('SELECT key, value FROM settings').all().forEach(r => { cur[r.key] = r.value; });
db.close();

line('§2 三个定价参数：代码常量 vs 线上实际');
console.log('  参数'.padEnd(20) + '代码常量'.padEnd(14) + 'settings 表'.padEnd(14) + '一致?');
const rows = [
  ['powerlaw_rtp', String(GL.POWERLAW.RTP_DEFAULT), cur.powerlaw_rtp],
  ['powerlaw_cap', String(GL.POWERLAW.CAP_DEFAULT), cur.powerlaw_cap],
];
let mismatch = 0;
for (const [k, code, dbv] of rows) {
  const same = code === String(dbv);
  if (!same) mismatch++;
  console.log('  ' + k.padEnd(20) + code.padEnd(14) + (dbv === undefined ? '(未设置)' : dbv).padEnd(14) + (same ? '是' : '否 ← 不一致'));
}
console.log('\n  当前赔率模式 odds_mode = ' + (cur.odds_mode || '(未设置)') +
  (cur.odds_mode === '9' ? '  ✅ 幂律' : '  ← 还没切到幂律 9'));
ok(cur.odds_mode === '9', '线上赔率模式已是幂律 9', '当前 ' + cur.odds_mode);

line('§3 结论');
if (mismatch === 0 && cur.odds_mode === '9') {
  console.log('  ✅ 代码常量与 settings 表一致，且模式已切到幂律。');
  console.log('     此时「测试全绿」与「线上生效」是一致的。');
} else {
  console.log('  ⚠️【测试全绿 ≠ 线上生效】当前存在 ' + mismatch + ' 处不一致：');
  if (cur.powerlaw_rtp !== String(GL.POWERLAW.RTP_DEFAULT)) {
    console.log('     · 线上 powerlaw_rtp = ' + cur.powerlaw_rtp +
      '，代码常量 = ' + GL.POWERLAW.RTP_DEFAULT);
  }
  if (cur.powerlaw_cap !== String(GL.POWERLAW.CAP_DEFAULT)) {
    console.log('     · 线上 powerlaw_cap = ' + cur.powerlaw_cap +
      '，代码常量 = ' + GL.POWERLAW.CAP_DEFAULT);
  }
  if (cur.odds_mode !== '9') {
    console.log('     · 线上 odds_mode = ' + cur.odds_mode + '，幂律需要 9');
  }
  console.log('\n  原因：server/db.js 的 seedSettings() 只在【键不存在】时写入，');
  console.log('        而线上库这几个键都存在 ⇒ DEFAULT_SETTINGS 的新默认值不会补写进去。');
  console.log('\n  修法（写生产 settings 表，属于部署动作，我一条不碰）：');
  console.log('     node scripts/migrate-powerlaw.js                 # 只读，先看清当前值');
  console.log('     node scripts/migrate-powerlaw.js --apply --force # 写入并切到幂律');
  console.log('     【然后必须重启服务】—— 顺序反了配置不生效且不报错');
  console.log('\n  ⇒ 这就是为什么 §6 出厂默认值断言全绿也救不了线上：');
  console.log('     它读的是代码常量，而决定玩家体验的是 settings 表。');
}
console.log('\n  通过 ' + pass + '  失败 ' + fail);
process.exit(fail ? 1 : 0);
