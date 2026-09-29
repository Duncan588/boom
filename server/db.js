'use strict';
/**
 * SQLite 数据层 —— 使用 Node 内置 node:sqlite，零外部依赖。
 *
 * 表设计说明（原 13 张表精简为 6 张）：
 *   users      玩家（discord_id 唯一）
 *   rounds     奖期（开奖循环）
 *   bets       下注记录
 *   coin_logs  金币流水（所有加减都留痕，便于对账）
 *   robots     机器人（假人下注）
 *   admins     后台账号
 *   invites    邀请关系
 * 删掉的：pay/withdraw/tixian/yjjl/opend/paihang/touzhu/agent 层级
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

let db = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id     TEXT    NOT NULL UNIQUE,
  username       TEXT    NOT NULL DEFAULT '',
  global_name    TEXT    NOT NULL DEFAULT '',
  avatar         TEXT    NOT NULL DEFAULT '',
  coins          REAL    NOT NULL DEFAULT 0,
  frozen         INTEGER NOT NULL DEFAULT 0,
  is_bot         INTEGER NOT NULL DEFAULT 0,
  inviter_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL,
  last_seen_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_inviter ON users(inviter_id);

CREATE TABLE IF NOT EXISTS rounds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rate        REAL    NOT NULL DEFAULT 1.00,
  status      INTEGER NOT NULL DEFAULT 1,   -- 0待开始 1下注中 2飞行中 3已结算
  hash        TEXT,
  created_at  TEXT    NOT NULL,
  settled_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_rounds_status ON rounds(status, id);

CREATE TABLE IF NOT EXISTS bets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id   INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     REAL    NOT NULL,
  status     INTEGER NOT NULL DEFAULT 0,  -- 0未结算 1已逃跑 2已爆(输)
  escape_rate REAL   NOT NULL DEFAULT 0,
  profit     REAL    NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bets_round  ON bets(round_id);
CREATE INDEX IF NOT EXISTS idx_bets_user   ON bets(user_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bets_uniq ON bets(round_id, user_id);

CREATE TABLE IF NOT EXISTS coin_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta      REAL    NOT NULL,
  balance    REAL    NOT NULL,
  reason     TEXT    NOT NULL,             -- checkin/invite/bet/escape/boom/admin_grant/...
  ref_id     TEXT,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coinlogs_user ON coin_logs(user_id, id DESC);

CREATE TABLE IF NOT EXISTS robots (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT    NOT NULL,
  avatar   TEXT    NOT NULL DEFAULT '',
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  inviter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rewarded   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  UNIQUE(inviter_id, invitee_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 红包：/hongbao 发出的领取卡片。
-- amount_total 是总额（一次性从发包人扣除），mode 决定每个领取者拿多少：
--   even  平均分 —— 每人 total/slots（四舍五入到分，余数留给下一位）
--   random 随机分 —— 从剩余池子里抽，首领者额外拿余数，保证「发出的=领完的」
CREATE TABLE IF NOT EXISTS redpackets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id   TEXT    NOT NULL,
  message_id   TEXT,
  amount_total REAL    NOT NULL,
  slots        INTEGER NOT NULL,
  mode         TEXT    NOT NULL DEFAULT 'even',
  claimed      INTEGER NOT NULL DEFAULT 0,
  claimed_sum  REAL    NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'open',   -- open | done
  created_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS redpacket_claims (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  redpacket_id INTEGER NOT NULL REFERENCES redpackets(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount       REAL    NOT NULL,
  created_at   TEXT    NOT NULL,
  -- 一个人只能领一次 —— 领取与派彩在同一事务里，靠这个唯一索引兜底
  UNIQUE(redpacket_id, user_id)
);

-- 登录会话持久化：进程重启后登录态不丢（之前只放内存 Map）
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exp        INTEGER NOT NULL,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 聊天记录：带时间戳，历史查询可按时间翻看
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name       TEXT    NOT NULL DEFAULT '系统',
  kind       TEXT    NOT NULL DEFAULT 'user',   -- user / system / escape / bet
  text       TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_time ON chat_messages(id DESC);
`;

function now() {
  // 【必须是北京时间】
  // 之前直接 toISOString()，那是 UTC —— 服务器 timedatectl 显示 Etc/UTC，
  // 于是流水/聊天/下注时间全部比玩家本地时间少 8 小时。
  // toLocaleString 带 en-CA 就是稳定的 YYYY-MM-DD HH:mm:ss，不用手搓时区偏移。
  return new Date().toLocaleString('en-CA', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  }).replace(',', '');
}

function init(file) {
  const p = file || process.env.DB_FILE || path.join(__dirname, '..', '..', 'data', 'baodian.db');
  const abs = path.isAbsolute(p) ? p : path.join(__dirname, '..', '..', p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  db = new DatabaseSync(abs);
  db.exec(SCHEMA);
  return db;
}

function get() {
  if (!db) init();
  return db;
}

function tx(fn) {
  const d = get();
  d.exec('BEGIN IMMEDIATE');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

/* ---------- users ---------- */

function getUserByDiscord(discordId) {
  return get().prepare('SELECT * FROM users WHERE discord_id = ?').get(String(discordId)) || null;
}

function getUserById(id) {
  return get().prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

/** 保留两位小数（避免浮点误差进账）。db.js 内部自持，不依赖 game-logic。 */
function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * 登录时 upsert：更新资料，不覆盖金币余额。
 *
 * 首次创建时自动发放 INITIAL_COINS（.env，默认 1000）。
 * 发放在【同一个事务】里做，并且靠「用户不存在 → 创建」这个事实判定首次，
 * 所以重放 upsert 不会二次发放（幂等）。
 */
function upsertUser({ discordId, username, globalName, avatar, inviterId }) {
  const d = get();
  const existing = getUserByDiscord(discordId);
  const ts = now();
  if (existing) {
    d.prepare(`UPDATE users SET username=?, global_name=?, avatar=?, last_seen_at=?, frozen=0 WHERE id=?`)
      .run(username || existing.username,
           globalName || existing.global_name,
           avatar || existing.avatar,
           ts, existing.id);
    return { user: getUserById(existing.id), created: false };
  }

  // 新用户初始金币。1000 是用户指定的福利；不通过 addCoins 是因为
  // 这里的 INSERT 还没提交，用一次事务把建号+发钱+记流水写在一起最干净。
  // ⚠️ INVITE_NEWCOMER_COINS 只在【确实有邀请人】时发 —— 之前无条件发放，
  // 导致自然注册的新人凭空多拿 1000（实测余额 2000 而非 1000）。
  const initial = round2(Number(process.env.INITIAL_COINS) || 1000);
  const newcomer = inviterId ? round2(Number(process.env.INVITE_NEWCOMER_COINS) || 0) : 0;

  const result = tx((t) => {
    const info = t.prepare(
      `INSERT INTO users (discord_id, username, global_name, avatar, coins, frozen, inviter_id, created_at, last_seen_at)
       VALUES (?,?,?,?,?,0,?,?,?)`
    ).run(String(discordId), username || '', globalName || username || '', avatar || '',
          initial + newcomer, inviterId || null, ts, ts);
    const id = Number(info.lastInsertRowid);

    // 流水：拆成两条，审计时能看出「新人福利」和「邀请奖励」各发了多少
    t.prepare('INSERT INTO coin_logs (user_id, delta, balance, reason, ref_id, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, initial, initial, 'initial_grant', null, ts);
    if (newcomer > 0) {
      t.prepare('INSERT INTO coin_logs (user_id, delta, balance, reason, ref_id, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, newcomer, initial + newcomer, 'invite_newcomer', inviterId == null ? null : String(inviterId), ts);
    }

    // 记录邀请关系
    if (inviterId) {
      try {
        t.prepare('INSERT OR IGNORE INTO invites (inviter_id, invitee_id, rewarded, created_at) VALUES (?,?,0,?)')
          .run(inviterId, id, ts);
      } catch (_) {}
    }
    return { id, invited: !!inviterId };
  });

  // 邀请人奖励：新人建号成功后再发，避免半个事务
  let inviterRewarded = 0;
  if (inviterId && Number(inviterId) !== result.id) {
    const amt = round2(Number(process.env.INVITE_REWARD_COINS) || 0);
    if (amt > 0) {
      try {
        addCoins(Number(inviterId), amt, 'invite_reward', result.id);
        inviterRewarded = amt;
      } catch (e) {
        console.error('[upsert] 邀请人奖励失败:', e.message);
      }
    }
  }

  return {
    user: getUserById(result.id),
    created: true,
    granted: { initial, newcomer, inviterRewarded },
  };
}

/* ---------- 金币 ---------- */

/** 唯一的金币变动入口：自动写流水，返回新余额 */
function addCoins(userId, delta, reason, refId = null) {
  return tx((d) => {
    const u = d.prepare('SELECT coins FROM users WHERE id = ?').get(userId);
    if (!u) throw new Error('用户不存在');
    const next = Math.round((u.coins + delta) * 100) / 100;
    if (next < 0) throw new Error('金币不足');
    d.prepare('UPDATE users SET coins = ? WHERE id = ?').run(next, userId);
    d.prepare('INSERT INTO coin_logs (user_id, delta, balance, reason, ref_id, created_at) VALUES (?,?,?,?,?,?)')
      .run(userId, Math.round(delta * 100) / 100, next, reason, refId == null ? null : String(refId), now());
    return next;
  });
}

/* ---------- 转账 ---------- */

/**
 * 用户间转账 QUN。
 *
 * ⚠️ 必须在【一个事务】里完成：检查 → 扣款 → 入账 → 两侧流水。
 * 分两次 addCoins 的话，第二步失败就是凭空扣钱（和下注重复扣是同一类漏洞）。
 *
 * 规则：
 *   - 不能转给自己
 *   - 双方都不能是 frozen（冻结中）
 *   - 金额 > 0，最多 2 位小数
 *   - 流水记 'transfer_out' / 'transfer_in'，ref_id 存对方 id（成对可查）
 */
function transfer(fromUserId, toUserId, amount) {
  const amt = round2(amount);
  if (!(amt > 0)) return { ok: false, code: 10010, msg: '转账金额必须大于 0' };
  const from = Number(fromUserId);
  const to = Number(toUserId);
  if (from === to) return { ok: false, code: 10011, msg: '不能转给自己' };

  return tx((d) => {
    const a = d.prepare('SELECT id, coins, frozen FROM users WHERE id = ?').get(from);
    const b = d.prepare('SELECT id, coins, frozen FROM users WHERE id = ?').get(to);
    if (!a) throw Object.assign(new Error('付款方不存在'), { code: 10012 });
    if (!b) throw Object.assign(new Error('收款方不存在'), { code: 10013 });
    if (a.frozen) throw Object.assign(new Error('你的账号已被冻结，无法转账'), { code: 10014 });
    if (b.frozen) throw Object.assign(new Error('对方账号已被冻结，无法收款'), { code: 10015 });
    if (a.coins < amt) {
      throw Object.assign(new Error('QUN 不足'), { code: 10001, have: round2(a.coins), need: amt });
    }

    const aNext = round2(a.coins - amt);
    const bNext = round2(b.coins + amt);
    d.prepare('UPDATE users SET coins = ? WHERE id = ?').run(aNext, from);
    d.prepare('UPDATE users SET coins = ? WHERE id = ?').run(bNext, to);

    const ts = now();
    d.prepare('INSERT INTO coin_logs (user_id, delta, balance, reason, ref_id, created_at) VALUES (?,?,?,?,?,?)')
      .run(from, -amt, aNext, 'transfer_out', String(to), ts);
    d.prepare('INSERT INTO coin_logs (user_id, delta, balance, reason, ref_id, created_at) VALUES (?,?,?,?,?,?)')
      .run(to, amt, bNext, 'transfer_in', String(from), ts);

    return { ok: true, amount: amt, fromBalance: aNext, toBalance: bNext };
  });
}

/** 查余额：自己不传 id 就是自己；传 id 查他人（只暴露余额，不暴露其他信息） */
function balanceOf(discordId) {
  const u = getUserByDiscord(String(discordId));
  if (!u) return null;
  return {
    id: u.id,
    discordId: u.discord_id,
    name: u.global_name || u.username,
    avatar: u.avatar,
    coins: round2(u.coins),
    frozen: !!u.frozen,
  };
}

/** 转账记录（最近的） */
function transferHistory(userId, limit = 20) {
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  return get().prepare(
    `SELECT cl.*, 
            CASE WHEN cl.reason = 'transfer_out' THEN u2.global_name
                 ELSE u1.global_name END AS peer_name,
            CASE WHEN cl.reason = 'transfer_out' THEN u2.discord_id
                 ELSE u1.discord_id END AS peer_id
     FROM coin_logs cl
     LEFT JOIN users u1 ON u1.id = cl.user_id
     LEFT JOIN users u2 ON u2.id = CAST(cl.ref_id AS INTEGER)
     WHERE cl.user_id = ? AND cl.reason IN ('transfer_out','transfer_in')
     ORDER BY cl.id DESC LIMIT ?`
  ).all(userId, n).map((r) => ({
    id: r.id, delta: r.delta, balance: r.balance,
    reason: r.reason, peerId: r.peer_id, peerName: r.peer_name,
    at: r.created_at,
  }));
}

/* ---------- settings ---------- */

function getSetting(key, def = null) {
  const r = get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : def;
}

function setSetting(key, value) {
  get().prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
  return value;
}

function allSettings() {
  const rows = get().prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/* ---------- 默认配置（首次启动写入，admin 可改） ---------- */

const DEFAULT_SETTINGS = {
  // 赔率控制（原版四种模式 + 2026-09 新增的加权模式）
  odds_mode: '5',          // 1=赢 2=输 3=平衡 4=区间均匀随机 5=三段加权
  odds_value: '0',         // 模式 1/2 的设定值（原 setValue）
  min_rate: '1.10',        // 最低爆点 —— 决定最短逃跑窗口
  max_rate: '50',          // 最高爆点（上限保护）
  band_min: '1.10',        // 模式 4 区间下限
  band_max: '3.00',        // 模式 4 区间上限
  // 模式 5 三段加权（方案 C：10 万局模拟中位 1.99x，10x+ 占 9.6%）
  // ⚠️ 模式 4 是【均匀分布】，1.1x 和 50x 概率一样 —— 曾把 band 配成 1.1–50，
  //    结果 81.8% 的局超过 10x，玩家 10 局净赚 5 倍本金，赢率离谱地高。
  //    想要「平时小赢、偶尔来一发大的」必须用模式 5。
  w_boom: '6',             // 瞬爆权重 6% —— 1.00~1.01，刚起飞就没（约 17 局一次）
  w_low: '50',             // 低段权重 50%（1.01–4.00x，日常区间）
  w_mid: '22',             // 中段权重 22%（4–10x）
  w_high: '20',            // 高段权重 20%（10–30x，约 5 局一次）
  w_top: '2',              // 爆段权重 2%（30–50x，约 50 局一次）
  w_boom_max: '1.01',      // 瞬爆爆点上限
  w_lo_min: '1.01',        // 低段下限
  w_lo_max: '4.00',        // 低段上限
  w_mid_min: '4.00',       // 中段下限
  w_mid_max: '10.00',      // 中段上限
  w_high_min: '10.00',     // 高段下限
  w_high_max: '30.00',     // 高段上限
  w_top_min: '30.00',      // 爆段下限
  w_top_max: '50.00',      // 爆段上限
  base_random: '0.90',     // 无下注时在 min~min+base_random 之间随机
  pool_balance: '0',       // 后台资金池（决定 1/2/3 模式爆点）
  rake_percent: '0.03',    // 平台抽成
  events_json: '[]',       // 限时高倍率活动（赔率侧）
  activities: '',           // 小活动插件启停（server/activities/）
  activities_json: '{}',    // 小活动参数覆盖
  // 机器人
  robot_bet_min: '10',
  robot_bet_max: '200',
  // 展示
  max_flight_ms: '120000',  // 单局飞行物理上限（100x≈73.8s，所以要 >74s）
  jackpot: '0',
};

function seedSettings() {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    const r = get().prepare('SELECT value FROM settings WHERE key = ?').get(k);
    if (!r) setSetting(k, v);
  }
}

/* ---------- robots ---------- */

function listRobots(limit = 20) {
  // 注意：SQLite 的 LIMIT 0 表示"不返回任何行"，不是"不限制"
  const n = Math.max(1, Number(limit) || 20);
  return get().prepare('SELECT * FROM robots WHERE active = 1 ORDER BY RANDOM() LIMIT ?').all(n);
}

function allRobots() {
  return get().prepare('SELECT * FROM robots ORDER BY id').all();
}

module.exports = {
  init, get, tx, now,
  getUserByDiscord, getUserById, upsertUser,
  addCoins, transfer, balanceOf, transferHistory,
  getSetting, setSetting, allSettings, seedSettings,
  listRobots, allRobots,
};
