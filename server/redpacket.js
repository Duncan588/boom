/**
 * 红包：分配逻辑 + 原子领取。
 *
 * 三个必须做对的地方：
 *
 * 1) 钱在【发包时】一次性扣，不是领取时才扣。否则 10 个红包抢 3 个，
 *    前 3 个领取者拿到的总额就超过了发出额，凭空造币。
 *
 * 2) 领取必须单事务，且靠 UNIQUE(redpacket_id, user_id) 兜底。
 *    「先查有没有领过 → 再插记录」在并发下会双双通过（两个请求都读到 0 领），
 *    靠 INSERT 抛 UNIQUE 冲突回滚才是真保证。
 *
 * 3) 平均分有余数。total=100, slots=3 → 每人 33.33，最后一位拿 33.34，
 *    否则发出的 100 会变成 99.99，白丢 0.01。随机分同理。
 */

const db = require('./db');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

class RedPacketError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

/**
 * 算出「第 index 个领取者（0-based）拿多少」。
 * 必须与 claim() 用同一份算法，否则预览和实际派彩对不上。
 *
 * @param {string} mode  'even' | 'random'
 * @param {number} total 总额
 * @param {number} slots 总份数
 * @param {number} index 该领取者是第几位（0 起）
 * @param {number} claimedSum 前面的人已经拿走的总额
 */
function shareFor(mode, total, slots, index, claimedSum) {
  const remaining = round2(total - claimedSum);
  const left = slots - index;              // 还剩几份（含本份）
  if (left <= 0) return 0;

  if (mode === 'even') {
    const base = Math.floor(round2(total / slots) * 100) / 100;
    // 最后一份兜底吃掉余数，保证 sum(每人拿的) == total
    return left === 1 ? remaining : base;
  }

  // random
  if (left === 1) return remaining;         // 最后一份兜底
  // 上限取「剩余人均 × 2」—— 否则前面运气好的人把后面的人饿死成 0.00
  const fair = round2(remaining / left);
  const cap = round2(fair * 2);
  let v = round2(Math.floor(Math.random() * 100) / 100 * cap);   // 0.00~0.99 * cap
  const floor = 0.01;
  if (v < floor) v = floor;
  const maxAllowed = round2(remaining - floor * (left - 1));   // 后面每人至少 0.01
  if (v > maxAllowed) v = maxAllowed;
  return v;
}

/** 创建红包（立即扣除发送者余额） */
function create({ creatorId, channelId, amountTotal, slots, mode = 'even' }) {
  const total = round2(amountTotal);
  const n = Math.floor(Number(slots));
  if (!(total > 0)) throw new RedPacketError('金额必须大于 0', 'AMOUNT');
  if (!(n >= 1)) throw new RedPacketError('领取人数至少 1 人', 'SLOTS');
  if (total / n < 0.01) throw new RedPacketError('每人份额不足 0.01 QUN，请减少人数或增加金额', 'TOO_SMALL');
  if (mode !== 'even' && mode !== 'random') throw new RedPacketError('分配方式只能是 even 或 random', 'MODE');

  const result = db.tx((conn) => {
    const u = conn.prepare('SELECT coins FROM users WHERE id=?').get(creatorId);
    if (!u) throw new RedPacketError('用户不存在', 'NO_USER');
    if (u.coins < total) throw new RedPacketError('QUN 不足', 'POOR');

    // 【钱在发包时就扣掉】见文件头说明 1
    const newBal = round2(u.coins - total);
    conn.prepare('UPDATE users SET coins=? WHERE id=?').run(newBal, creatorId);
    conn.prepare('INSERT INTO coin_logs(user_id,delta,balance,reason,ref_id,created_at) VALUES(?,?,?,?,?,?)')
      .run(creatorId, -total, newBal, 'redpacket_send', String(channelId), db.now());

    const info = conn.prepare(
      'INSERT INTO redpackets(creator_id,channel_id,amount_total,slots,mode,claimed,claimed_sum,status,created_at) VALUES(?,?,?,?,?,0,0,?,?)'
    ).run(creatorId, String(channelId), total, n, mode, 'open', db.now());
    return { id: Number(info.lastInsertRowid), balance: newBal };
  });

  return { id: result.id, balance: result.balance, total, slots: n, mode };
}

/**
 * 领取。单事务：查红包 → 占位 claim（唯一索引兜底）→ 算份额 → 加钱 → 写流水 → 更新计数。
 * 任何一步抛错都整笔回滚，QUN 不会凭空多也不会凭空少。
 */
function claim(redpacketId, userId) {
  return db.tx((conn) => {
    const rp = conn.prepare('SELECT * FROM redpackets WHERE id=?').get(redpacketId);
    if (!rp) throw new RedPacketError('红包不存在或已过期', 'NOT_FOUND');

    // 先占位：UNIQUE 冲突说明这个用户已经领过（并发下第二个请求会撞这里）
    let already = false;
    try {
      conn.prepare('INSERT INTO redpacket_claims(redpacket_id,user_id,amount,created_at) VALUES(?,?,?,?)')
        .run(redpacketId, userId, 0, db.now());
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String(e && e.message))) already = true;
      else throw e;
    }
    if (already) throw new RedPacketError('你已经领过这个红包了', 'DUP');
    if (rp.status !== 'open') throw new RedPacketError('红包已被领完', 'DONE');

    const left = rp.slots - rp.claimed;
    if (left <= 0) throw new RedPacketError('红包已被领完', 'DONE');

    const amount = shareFor(rp.mode, rp.amount_total, rp.slots, rp.claimed, rp.claimed_sum);
    if (!(amount > 0)) throw new RedPacketError('红包已被领完', 'DONE');

    conn.prepare('UPDATE redpacket_claims SET amount=? WHERE redpacket_id=? AND user_id=?')
      .run(amount, redpacketId, userId);

    const u = conn.prepare('SELECT coins FROM users WHERE id=?').get(userId);
    if (!u) throw new RedPacketError('用户不存在', 'NO_USER');
    const newBal = round2(u.coins + amount);
    conn.prepare('UPDATE users SET coins=? WHERE id=?').run(newBal, userId);
    conn.prepare('INSERT INTO coin_logs(user_id,delta,balance,reason,ref_id,created_at) VALUES(?,?,?,?,?,?)')
      .run(userId, amount, newBal, 'redpacket_claim', String(redpacketId), db.now());

    const newClaimed = rp.claimed + 1;
    const newSum = round2(rp.claimed_sum + amount);
    const done = newClaimed >= rp.slots;
    conn.prepare('UPDATE redpackets SET claimed=?, claimed_sum=?, status=? WHERE id=?')
      .run(newClaimed, newSum, done ? 'done' : 'open', redpacketId);

    return {
      ok: true, amount, balance: newBal,
      claimed: newClaimed, slots: rp.slots, done,
      left: round2(rp.amount_total - newSum),
    };
  });
}

function get(id) {
  return db.get().prepare('SELECT * FROM redpackets WHERE id=?').get(id) || null;
}

function claims(id) {
  return db.get().prepare(
    `SELECT c.amount, c.created_at, u.global_name, u.username
     FROM redpacket_claims c LEFT JOIN users u ON u.id=c.user_id
     WHERE c.redpacket_id=? AND c.amount > 0 ORDER BY c.id ASC`
  ).all(id);
}

function hasClaimed(id, userId) {
  return !!db.get().prepare('SELECT 1 AS x FROM redpacket_claims WHERE redpacket_id=? AND user_id=? AND amount > 0')
    .get(id, userId);
}

module.exports = { create, claim, get, claims, hasClaimed, shareFor, RedPacketError, round2 };
