/**
 * 幂律（mode 9）迁移 —— 部署后【必须】执行。
 *
 * 背景：DEFAULT_SETTINGS 只在【键不存在】时写入（server/db.js 的 seedSettings），
 * 所以已有数据库不会跟着新的默认值更新。线上此前是 odds_mode=5（五段加权），
 * 它有一个可被玩家发现并稳定利用的区间 —— 这次的改动就是为了根除它。
 * 所以光传代码不够，必须显式写库。
 *
 * 幂等的：重复执行结果一致；已存在的值可被显式覆盖。
 *
 * 用法：
 *   node scripts/migrate-powerlaw.js                    # 只看当前值与目标值
 *   node scripts/migrate-powerlaw.js --apply            # 写入 powerlaw_rtp / powerlaw_cap
 *   node scripts/migrate-powerlaw.js --apply --force    # 连 odds_mode 一起切到 9
 *   node scripts/migrate-powerlaw.js --apply --force --rtp=0.95 --cap=200
 *
 * ⚠️ 部署顺序：先跑本脚本（写配置），【再】重启服务。
 *    顺序反了的话，进程读到的是旧配置，而 DEFAULT_SETTINGS 也不会补写
 *    —— 表现是「改了 odds_mode 但没生效」，且没有任何报错。
 *    这是本项目反复踩过的「配置写了但进程没读」那一类。
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const argOf = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};

const RTP = argOf('rtp', '0.90');
const CAP = argOf('cap', '1000');
const ACTIVITY_BONUS = argOf('bonus', '0.03');

// 校验：不合法就直接退出，不让坏值进库
const rtpN = Number(RTP), capN = Number(CAP), bonusN = Number(ACTIVITY_BONUS);
if (!isFinite(rtpN) || rtpN < 0.80 || rtpN > 1.00) {
  console.error(`✗ --rtp 必须在 0.80–1.00 之间（收到 ${RTP}）。`);
  console.error('  1.0309 是保本线，超过它玩家就是正期望；上限 1.00 留了 3 个点余量。');
  process.exit(1);
}
if (!isFinite(capN) || capN < 1.01) {
  console.error(`✗ --cap 至少 1.01（收到 ${CAP}）。`);
  process.exit(1);
}
if (!isFinite(bonusN) || bonusN < 0 || bonusN > 0.20) {
  console.error(`✗ --bonus 必须在 0–0.20 之间（收到 ${ACTIVITY_BONUS}）。`);
  process.exit(1);
}

const dbPath = process.env.DB_FILE || path.join(__dirname, '..', '..', 'data', 'baodian.db');
const db = new DatabaseSync(path.resolve(dbPath));

const cur = {};
db.prepare('SELECT key, value FROM settings').all().forEach((r) => { cur[r.key] = r.value; });

/**
 * 只写幂律自己的定价参数。
 * ⚠️ 不动 min_rate / max_rate / band_* / w_*：它们是别的模式的配置，
 *    切回那些模式时还要用。改坏了等于「切回去才发现配置没了」。
 */
const PLAN = {
  powerlaw_rtp: String(rtpN),
  powerlaw_cap: String(capN),
  // 每日高倍活动在幂律下的加成（+RTP，形状不变）
  daily_rtp_bonus: String(bonusN),
};
// 只有 --force 才动 odds_mode —— 它决定整局节奏，不该被迁移脚本悄悄改掉
if (FORCE) PLAN.odds_mode = '9';

const show = ['odds_mode', 'min_rate', 'max_rate', 'powerlaw_rtp', 'powerlaw_cap',
  'daily_rtp_bonus', 'daily_enabled', 'events_json', 'activities'];

console.log('数据库:', path.resolve(dbPath));

console.log('\n=== 当前赔率相关配置 ===');
show.forEach((k) => {
  let v = cur[k];
  if (v === undefined) v = '(未设置)';
  else if (k === 'events_json' && v.length > 60) v = v.slice(0, 60) + '…';
  console.log('  ' + k.padEnd(16) + v);
});

console.log('\n=== 目标值（幂律）===');
Object.keys(PLAN).forEach((k) => {
  const same = cur[k] === PLAN[k];
  console.log('  ' + k.padEnd(16) + PLAN[k].padEnd(10)
    + (same ? '已一致' : '当前 ' + (cur[k] !== undefined ? cur[k] : '(未设置)')));
});

if (!APPLY) {
  const need = Object.keys(PLAN).filter((k) => cur[k] !== PLAN[k]);
  console.log('\n仅查看，未写入。' + (need.length
    ? `需要更新 ${need.length} 项，加 --apply 执行。`
    : '全部已一致，无需写入。'));
  if (!FORCE && cur.odds_mode !== '9') {
    console.log(`提示：当前赔率模式 = ${cur.odds_mode || '(未设置)'}。幂律需要 odds_mode=9，确认切换时加 --force。`);
  }
  db.close();
  process.exit(0);
}

const stmt = db.prepare(
  'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
);
db.exec('BEGIN');
let n = 0;
for (const [k, v] of Object.entries(PLAN)) {
  if (cur[k] === v) continue;
  stmt.run(k, v);
  console.log('  ✓ ' + k.padEnd(16) + (cur[k] !== undefined ? cur[k] : '(未设置)') + ' → ' + v);
  n++;
}
db.exec('COMMIT');

console.log('\n完成，更新 ' + n + ' 项。' + (n === 0 ? '（无变化）' : ''));
if (!FORCE) {
  console.log('⚠ 赔率模式未改动（需要时用 --force 切到幂律 9）。');
} else {
  console.log('赔率模式已切到 9（幂律）。');
}
console.log('\n下一步：');
console.log('  1) 【现在】重启服务，让进程读到新配置 —— 顺序反了配置不生效且不报错');
console.log('  2) 打开后台「爆点赔率控制」确认赔率模式显示「幂律 · 恒定期望」');
console.log('  3) 点一次「保存赔率设置」，toast 会回真实分布（P(爆点≥m) / 净期望）');
console.log('  4) 确认 mode 7（Jev）仍是关闭状态：幂律下它本就不参与');
db.close();
