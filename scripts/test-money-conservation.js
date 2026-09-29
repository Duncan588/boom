/**
 * 钱不能凭空产生 —— 结算守恒测试。
 *
 * 根因：爆点结算里给输家「退本金」，而下注时已经扣过一次。
 * 于是 0 → -1000 → +1000 → 0，每局白嫖一次，流水看起来像凭空造币。
 *
 * 判定：跑完 N 局后，总流水（initial_grant 之外）必须严格 ≤ 0。
 * 赢家派奖（escape）只从输家的注额里出，所以净和不可能为正。
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// db.js 里 DB_FILE 相对 __dirname/../.. 解析，实际落在 E:\爆点\data\baodian.db
const DB = process.env.TEST_DB
  || path.join(__dirname, '..', '..', process.env.DB_FILE || 'data', 'baodian.db');
const db = new DatabaseSync(DB);

const before = db.prepare('SELECT COALESCE(SUM(coins),0) c FROM users').get().c;
const bets = db.prepare('SELECT COUNT(*) c FROM bets').get().c;

console.log('起点：用户总余额 =', before, '| 历史注单 =', bets);

// 观察若干局的流水净额（只看游戏产生的，排除 initial_grant / checkin / 转账）
const SQL = `SELECT reason, SUM(delta) s, COUNT(*) n FROM coin_logs
             WHERE reason IN ('bet','boom','escape') GROUP BY reason`;
const beforeLog = {};
for (const r of db.prepare(SQL).all()) beforeLog[r.reason] = r.s;

function snap() {
  const o = {};
  for (const r of db.prepare(SQL).all()) o[r.reason] = r.s;
  return o;
}

const t0 = Date.now();
const ROUNDS = 4;
let seen = 0;

// 轮询 rounds 表，等新局结算
function wait() {
  return new Promise((r) => setTimeout(r, 1000));
}

(async () => {
  const startRound = db.prepare('SELECT MAX(id) m FROM rounds').get().m;
  while (Date.now() - t0 < 190000) {
    await wait();
    const maxR = db.prepare('SELECT MAX(id) m FROM rounds').get().m;
    seen = maxR - startRound;
    process.stdout.write(`\r已结算 ${seen} 局 (${Math.round((Date.now()-t0)/1000)}s)   `);
    if (seen >= ROUNDS) break;
  }
  console.log('\n');

  const after = snap();
  const diff = {};
  for (const k of ['bet', 'boom', 'escape']) {
    diff[k] = (after[k] || 0) - (beforeLog[k] || 0);
  }
  const net = diff.bet + diff.boom + diff.escape;

  console.log('=== 本次测试新增流水 ===');
  console.log('  bet    (下注扣款):', diff.bet.toFixed(2));
  console.log('  boom   (爆点结算):', diff.boom.toFixed(2), diff.boom === 0 ? '← 正确：爆掉不退钱' : '← 错误：又在退本金！');
  console.log('  escape (逃赢派奖):', diff.escape.toFixed(2));
  console.log('  ─────────────────────');
  console.log('  净额:', net.toFixed(2));

  const afterCoins = db.prepare('SELECT COALESCE(SUM(coins),0) c FROM users').get().c;
  const totalGranted = db.prepare("SELECT COALESCE(SUM(delta),0) s FROM coin_logs WHERE reason IN ('initial_grant','checkin','invite_reward','invite_newcomer','admin')").get().s;
  console.log('');
  console.log('  用户总余额变化:', (afterCoins - before).toFixed(2));
  console.log('  累计外部发放:', totalGranted.toFixed(2));

  const pass = diff.boom === 0 && net <= 0;
  console.log('');
  console.log(pass ? '✅ 通过：没有凭空造币' : '❌ 失败');
  process.exit(pass ? 0 : 1);
})();
