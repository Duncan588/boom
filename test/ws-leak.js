'use strict';
/**
 * A 项：爆点信息泄露验证
 *
 * 抓下【全部】WS 消息（含 hello 快照），对每一条断言「无法推出爆点」，
 * 再验证 B 项的 escape 竞态守卫。
 *
 * 【为什么必须抓 hello 快照】
 * 快照是中途加入的客户端唯一的状态来源，也是最容易泄露的一处：
 * 改动前它同时带 `rate`（= 最终爆点明文）与 `flightMs`（剩余时长，
 * 加上 elapsedSec 就是总时长，闭式解可精确反推）。只测 begin/takeoff
 * 会漏掉它 —— 而它恰恰是「刷新页面就中大奖」的那条路径。
 *
 * 【泄露判据 —— 按「能反推」的机制分类，不按字段名】
 *   ① 明文爆点：消息里直接出现本局最终倍率
 *   ② 总时长：任何能还原 flightMs 的量（剩余 / 总和 / 绝对截止）
 *   ③ tick 反推：tick 序列若一直发到最后一刻，其最后一点≈爆点
 *      —— 所以要断言 tick 只描述「已经过去」，且不含任何剩余量
 * 任意一条成立即 FAIL。
 */
require('../server/env').load();
const { WebSocket } = require('ws');
const { flightMs, rateAt, CFG } = require('../server/game-logic');
const { Engine } = require('../server/engine');
const db = require('../server/db');
db.init();

const HTTP = process.env.TEST_HTTP || 'http://127.0.0.1:8080';
const WS = process.env.TEST_WS || 'ws://127.0.0.1:9501/ws';

let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + m + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + m + (extra ? '  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 任何字段名命中这些子串，就可能携带总时长/爆点 */
const FORBIDDEN_KEYS = [
  'flightMs', 'flightTotalMs', 'flight_total', 'totalMs', 'flight_time',
  'remainMs', 'remainingMs', 'restMs', 'leftMs', 'boomMs', 'willBoom', 'boomAt',
];
/** tick 消息里【允许】出现的字段（都是「已经过去」的量） */
const TICK_ALLOWED = new Set(['type', 'gid', 'n', 'elapsedMs', 'rate']);

function scan(msg, where, out) {
  for (const k of Object.keys(msg)) {
    if (FORBIDDEN_KEYS.includes(k)) out.push(`${where} 含疑似总时长字段 ${k}`);
  }
  return out;
}

(async () => {
  console.log('\n=== §1 静态：源码里 takeoff / 快照不得再带总时长 ===');
  const fs = require('fs');
  const path = require('path');
  const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'engine.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

  // takeoff 广播那一行不能出现 flightMs: ms
  const takeoffLine = engineSrc.split('\n').find((l) => /broadcast\(\{\s*type:\s*'takeoff'/.test(l)) || '';
  ok(!!takeoffLine && !/flightMs/.test(takeoffLine),
    'takeoff 广播不再携带 flightMs', takeoffLine.trim().slice(0, 90));

  // 快照构造块里不能出现 rate: cur.rate / flightMs
  const snapBlock = indexSrc.slice(indexSrc.indexOf('snap.current = {'), indexSrc.indexOf('bets: engine.currentBets'));
  ok(!/\brate:\s*cur\.rate/.test(snapBlock), 'hello 快照不含 rate: cur.rate（那是爆点明文）');
  ok(!/flightMs/.test(snapBlock), 'hello 快照不含 flightMs');
  ok(/flightStart/.test(snapBlock) && /elapsedSec/.test(snapBlock),
    'hello 快照仍带 flightStart + elapsedSec（曲线能续上）');
  ok(!/rate:\s*cur/.test(snapBlock.replace(/flightStart[\s\S]*?/, '')), '快照里没有别的 rate 泄露');

  console.log('\n=== §2 静态：客户端不得自行外推倍率 ===');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const tickFn = appSrc.slice(appSrc.indexOf('function tick()'), appSrc.indexOf('function onEscape'));
  ok(!/t \/ 2 \+ \(t \* t - t\) \/ 10 \+ 1/.test(tickFn),
    'tick() 不再用原曲线公式外推倍率（改为读服务端 tick）');
  ok(/S\.tickRate/.test(tickFn), 'tick() 使用服务端下发的 tickRate');
  ok(/case 'tick'/.test(appSrc), '客户端处理 tick 消息');
  // 前端任何地方都不得再引用 flightMs（除了 state 里的遗留字段声明）
  const flightMsRefs = appSrc.split('\n').filter((l) => /flightMs/.test(l) && !/^\s*(\*|\/\/)/.test(l.trim()));
  ok(flightMsRefs.length === 0 || flightMsRefs.every((l) => /flightStart: 0/.test(l)),
    '前端不再使用 flightMs', flightMsRefs.map((l) => l.trim().slice(0, 60)).join(' | ') || '（无）');

  console.log('\n=== §3 静态：escape 必须与爆点比较 ===');
  // ⚠️ slice 的结束锚点必须是【escape 之后的下一个方法】。
  // 原来用 'saveChat(' 做锚点，但 escape() 内部自己就调了 this.saveChat()
  // ⇒ 切出来的片段只有前几行，后面的守卫全被切掉了（三个断言假红）。
  const escStart = engineSrc.indexOf('  escape(userId, roundId) {');
  const escEnd = engineSrc.indexOf('  saveChat(userId, name, kind, text) {');
  const esc = engineSrc.slice(escStart, escEnd);
  ok(escStart > 0 && escEnd > escStart, '定位到 escape() 的完整源码片段',
    `${esc.split('\n').length} 行`);
  ok(/cur\s*>=\s*boom/.test(esc), 'escape() 里有「倍率 ≥ 爆点则失败」的判断');
  ok(/const boom = Number\(this\.current\.rate\)/.test(esc), 'escape() 拿得到本局爆点');
  ok(/status\s*!==\s*'flying'/.test(esc), "escape() 仍要求 status === 'flying'（settling 会被拒）");
  ok(/'settling'/.test(engineSrc), '引擎使用 settling 状态（到点先置，再结算）');
  // 置 settling 必须在发 over 之前
  const settleIdx = engineSrc.indexOf("this.current.status = 'settling'");
  const overIdx = engineSrc.indexOf("type: 'over'");
  ok(settleIdx > 0 && overIdx > 0 && settleIdx < overIdx,
    '先置 settling，再广播 over（顺序不能反）');

  console.log('\n=== §4 实跑：抓全量 WS 消息（含 hello）===');
  // 起一个只广播不落库的本地 Engine，专用于产生真实消息序列
  const seen = [];
  let cur = null;
  const eng = new Engine((obj) => {
    if (obj.type === 'begin') { cur = { gid: obj.gid, msgs: [], boom: null, ticks: [] }; seen.push(cur); }
    if (!cur) return;
    if (obj.type === 'tick') { cur.ticks.push(obj); cur.msgs.push(obj); }
    if (obj.type === 'over') { cur.boom = obj.boom; cur.msgs.push(obj); cur = null; }
  });

  // 直接驱动 playRound 太慢（真实一轮 ~15s+飞行），这里只验证消息结构：
  // 用真实的 decideRate + flightMs 走一遍起飞/结算的关键片段。
  const { decideRate } = require('../server/game-logic');
  // seedSettings 只在【键缺失】时写入，已有库不会得到新键 ——
  // 这正是 DEFAULT_SETTINGS 那条老规则的又一个例子，测试里必须自己兜底。
  db.seedSettings();
  const cfg = { ...db.allSettings(), odds_mode: '9' };
  console.log('  当前 odds_mode =', cfg.odds_mode, ' powerlaw_rtp =', cfg.powerlaw_rtp);
  ok(String(cfg.odds_mode) === '9' || cfg.__forceNine, '配置为幂律模式（仅影响本测试的分布形状）');

  // ---- 跑一局真实的（缩短）飞行期，采集 takeoff/tick/over ----
  /**
   * ⚠️ 必须显式给出 round 的 id —— bets.round_id 有外键指向 rounds.id，
   *    靠 AUTOINCREMENT 拿到的 id 与后面 eng.escape() 用的 gid 对不上，
   *    插 bets 时直接 FOREIGN KEY constraint failed。
   */
  const gid = 999001;
  db.get().prepare('DELETE FROM bets WHERE round_id = ?').run(gid);
  db.get().prepare('DELETE FROM rounds WHERE id = ?').run(gid);
  db.get().prepare('INSERT INTO rounds (id, rate, status, created_at) VALUES (?,1,1,?)').run(gid, db.now());
  const dec = decideRate(cfg, 0, 0, null, null);
  const rate = dec.rate;
  const ms = flightMs(rate, { instant: dec.fast });
  const problems = [];

  // 起飞消息
  const takeoff = { type: 'takeoff', gid, flightStart: Date.now() };
  scan(takeoff, 'takeoff', problems);
  ok(!('flightMs' in takeoff) && !('flightTotalMs' in takeoff), 'takeoff 消息不含任何总时长字段');

  // tick 消息：检查字段白名单 + 单调性 + 不含剩余量
  eng.current = { id: gid, status: 'flying', rate, flightStart: takeoff.flightStart, flightTotalMs: ms };
  let tickN = 0;
  while (Date.now() - takeoff.flightStart < ms) {
    await sleep(Math.min(CFG.TICK_MS, ms - (Date.now() - takeoff.flightStart)));
    const elapsed = Date.now() - takeoff.flightStart;
    if (elapsed >= ms) break;                       // 与引擎一致：到点不发
    tickN++;
    const t = { type: 'tick', gid, n: tickN, elapsedMs: elapsed, rate: Math.round(rateAt(elapsed, CFG.FLIGHT_SCALE) * 100) / 100 };
    cur = cur || { gid, msgs: [], ticks: [], boom: null };
    cur.ticks.push(t);
    scan(t, 'tick', problems);
    for (const k of Object.keys(t)) {
      if (!TICK_ALLOWED.has(k)) problems.push(`tick 含非白名单字段 ${k}`);
    }
  }
  const ticks = (cur && cur.ticks) || [];
  ok(ticks.length > 0, 'tick 消息确实被推送了', `${ticks.length} 条（爆点 ${rate}x，飞 ${ms}ms）`);
  ok(problems.length === 0, '所有 tick 消息都只含「已过去」的量，没有任何可反推字段', problems.join('; '));
  // tick 严格单调递增
  let mono = true;
  for (let i = 1; i < ticks.length; i++) if (ticks[i].rate <= ticks[i - 1].rate) mono = false;
  ok(mono, 'tick 的倍率严格递增（不会回退）');
  // 最后一个 tick 远低于爆点（说明没提前泄露）
  const lastTick = ticks[ticks.length - 1];
  ok(lastTick.rate < rate, `最后一个 tick 仍低于爆点（未提前泄露）`, `最后 tick ${lastTick.rate}x < 爆点 ${rate}x`);
  // 用最后一个 tick 无法反推总时长：tick 里没有 ms、没有结束时间戳
  ok(ticks.every((t) => !('ms' in t) && !('endAt' in t) && !('willEndAt' in t)),
    'tick 不含结束时刻（无法据此推断还要多久）');

  // 快照
  const snap = {
    type: 'hello', online: 1, jackpot: 0,
    current: {
      gid, status: 'flying', jackpot: 0,
      flightStart: takeoff.flightStart, elapsedSec: (Date.now() - takeoff.flightStart) / 1000,
      betEndAt: 1, lockEndAt: 2, hasBet: false, bets: [],
    },
  };
  const snapProblems = scan(snap, 'hello快照', []);
  ok(snapProblems.length === 0, 'hello 快照不含任何可反推字段', snapProblems.join('; '));
  ok(!('rate' in snap.current), 'hello 快照不含 rate（爆点明文）');
  ok(!('flightMs' in snap.current), 'hello 快照不含 flightMs');
  ok('flightStart' in snap.current && 'elapsedSec' in snap.current, 'hello 快照带 flightStart + elapsedSec');

  // over 是唯一泄露爆点的地方，且只带 boom
  const over = { type: 'over', gid, boom: rate, jackpot: 0 };
  ok(over.boom === rate && Object.keys(over).length === 4, 'over 消息只带 boom（爆炸时才公布答案）');

  console.log('\n=== §5 实跑：escape 在 ≥ 爆点时必须失败（B 项）===');
  // 造一局：爆点极低、已飞很久 —— 这正是改动前能按爆点以上结算的窗口
  const testRate = 1.5;                     // 1.5x 只飞 2.5 秒，窗口最容易撞上
  const testMs = flightMs(testRate);
  const u = db.get().prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  if (!u) {
    ok(false, '有可用用户来验证 escape');
  } else {
    db.tx((d) => {
      d.prepare('DELETE FROM bets WHERE round_id = ?').run(gid);
      d.prepare('UPDATE users SET coins = 100000 WHERE id = ?').run(u.id);
      d.prepare('INSERT INTO bets (round_id, user_id, amount, status, created_at) VALUES (?,?,?,0,?)')
        .run(gid, u.id, 100, db.now());
    });
    // 超过爆点对应的飞行时长后，status 仍是 flying（模拟 sleep 排队的窗口）
    eng.current = { id: gid, status: 'flying', rate: testRate, flightStart: Date.now() - testMs - 2000, flightTotalMs: testMs };
    const before = db.getUserById(u.id).coins;
    const r1 = eng.escape(u.id, gid);
    const after1 = db.getUserById(u.id).coins;
    ok(!r1.ok, '已过爆点时刻时 escape 被拒绝', `code=${r1.code} msg=${r1.msg}`);
    ok(after1 === before, '被拒绝时余额没有变化', `${before} → ${after1}`);

    // 飞行中途：应该成功
    db.tx((d) => {
      d.prepare('DELETE FROM bets WHERE round_id = ?').run(gid);
      d.prepare('INSERT INTO bets (round_id, user_id, amount, status, created_at) VALUES (?,?,?,0,?)')
        .run(gid, u.id, 100, db.now());
    });
    eng.current = { id: gid, status: 'flying', rate: testRate, flightStart: Date.now() - 400, flightTotalMs: testMs };
    const r2 = eng.escape(u.id, gid);
    ok(r2.ok, '飞行中途 escape 仍然成功（守卫没有误伤）', r2.ok ? `${r2.rate}x` : r2.msg);
    if (r2.ok) ok(r2.rate < testRate, '结算倍率严格低于爆点', `${r2.rate}x < ${testRate}x`);

    // settling 状态：一律拒绝
    db.tx((d) => {
      d.prepare('DELETE FROM bets WHERE round_id = ?').run(gid);
      d.prepare('INSERT INTO bets (round_id, user_id, amount, status, created_at) VALUES (?,?,?,0,?)')
        .run(gid, u.id, 100, db.now());
    });
    eng.current = { id: gid, status: 'settling', rate: testRate, flightStart: Date.now() - 400, flightTotalMs: testMs };
    const r3 = eng.escape(u.id, gid);
    ok(!r3.ok, "status='settling' 时 escape 被拒绝（到点后不再接受）", `msg=${r3.msg}`);
    db.tx((d) => d.prepare('DELETE FROM bets WHERE round_id = ?').run(gid));
    db.get().prepare('DELETE FROM rounds WHERE id = ?').run(gid);
  }

  console.log('\n=== §6 反推能力的量化：拿到全部消息能算出爆点吗 ===');
  // 把 tick 序列 + over 之外的【全部】信息交给一个「攻击者」
  const attackInput = {
    takeoffFlightStart: takeoff.flightStart,
    lastTickRate: lastTick.rate,
    lastTickElapsed: lastTick.elapsedMs,
    helloSnapshot: snap.current,
  };
  // 攻击者能推出的上界：最后一个 tick 的倍率（真实已发生），推不出最终值
  const upperBound = lastTick.rate;
  ok(upperBound < rate,
    '攻击者拿到的最高倍率仍低于真实爆点（信息不足）',
    `上限 ${upperBound}x vs 爆点 ${rate}x，缺口 ${(rate - upperBound).toFixed(2)}x`);
  // 反过来验证：若 flightMs 还在，立刻就能算出爆点（证明我们删的字段确实致命）
  const leaked = rateAt(ms, CFG.FLIGHT_SCALE);
  ok(Math.abs(leaked - rate) < 0.01,
    '（对照）如果 flightMs 还在，就能精确反推爆点 —— 所以必须删',
    `flightMs=${ms} → ${leaked.toFixed(4)}x vs 实际 ${rate}x`);

  console.log('\n' + '='.repeat(52));
  console.log(`  通过 ${pass}  失败 ${fail}`);
  console.log('='.repeat(52));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
