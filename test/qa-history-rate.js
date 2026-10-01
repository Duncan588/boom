'use strict';
/**
 * 历史倍率口径闸门 —— 回答 @项目负责人 的那一条要求：
 *   「没有任何路径用新 decideRate() 重算历史展示」
 *
 * 采纳的口径（@项目负责人 转述 @全栈开发 的方案）：
 *   · 历史行读【当时落库的原始倍率】，只读不改
 *   · 分界线 = 换算法那一局的 rounds.id
 *   · rounds.rate  是每局落库的爆点值（权威）
 *   · bets.escape_rate / bets.profit 是结算时写死的（权威）
 *   · coin_logs.ref_id 已能定位到具体 bet 行
 *
 * 【为什么不靠读代码判断，而要自动化】
 * 「历史只读」不是一句约定：它是几十个读路径上的一个否定命题。
 * 只要有人日后加一句 `rows.map(r => ({...r, rate: decideRate(...)}))`，
 * 整个旧账会被静默重算成新分布，运营看到的「历史爆点」与真实历史不符，
 * 而没有任何报错。这类 bug 评审能抓到一次，抓不到第二次。
 * 所以本文件把「谁在读历史、用什么读」固化成可执行的断言：
 *   §1 静态：逐【路由】检查历史读接口不得调用定价函数
 *   §2 静态：历史读接口必须直读 bets.escape_rate / rounds.rate
 *   §3 动态：真起服务、真下注、真改算法，验证旧行逐字节不变
 *
 * ═══════════ 【踩过的坑：文件级 grep 会误伤预览接口】═══════════
 * 第一版按【文件】grep 定价函数，结果 admin.js:308 报错。
 * 查下去 308 行在 /admin/api/slot-preview —— 它调 decideRate 是为了
 * 「预览下一局会出什么」，那是【未来】局，不是历史，完全正当。
 * 同一个文件里 /admin/api/bets、/admin/api/rounds 才是历史读接口。
 * 文件粒度区分不了这两者，路由粒度才能。
 * ⇒ 本文件的静态检查改成按 router.get/post 的代码块切分。
 *
 * ═══════════ 【踩过的坑：机器人不写 bets 表】════════════════════
 * 第一版动态段等出了 3 局结算，却 bets=0 —— 因为 robots 只走广播，
 * 不 INSERT bets。于是「旧账」里没有任何 bet 行，比对对象是空的，
 * 断言会【空洞地通过】。凡是「等待某张表有行」都必须先确认那张表会被写。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + m + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + m + (extra ? '  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
 * 路由级切分
 * ============================================================ */
/** 把一个 routes 文件按 router.get/post 切成若干代码块 */
function splitRoutes(text) {
  const lines = text.split('\n');
  const marks = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\s*router\.(get|post)\(\s*'([^']+)'/);
    if (m) marks.push({ line: i, method: m[1], path: m[2] });
  });
  const blocks = [];
  for (let k = 0; k < marks.length; k++) {
    const start = marks[k].line;
    const end = k + 1 < marks.length ? marks[k + 1].line : lines.length;
    blocks.push({
      method: marks[k].method, path: marks[k].path,
      text: lines.slice(start, end).join('\n'),
      startLine: start + 1,
    });
  }
  return blocks;
}

/** 在代码块里找函数调用（跳过整行注释） */
function callSites(text, name) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    const re = new RegExp('(^|[^A-Za-z0-9_$.])' + name + '\\s*\\(');
    if (re.test(line)) out.push({ line: i + 1, text: line.trim().slice(0, 100) });
  });
  return out;
}

// 所有「能决定爆点倍率」的函数。出现在历史读接口里就是缺陷。
const PRICERS = [
  'decideRate', 'powerlawRate', 'powerlawDecide', 'powerlawReport',
  'tableRate', 'simulate', 'rateAt', 'flightMs',
];
// 「现算历史倍率」的辅助函数名（自造的反模式，一并禁止）
const BANNED_HISTORY_SOURCES = [
  'historyRate', 'recomputeRate', 'deriveRate', 'replayRate', 'simulateHistory',
];

/**
 * 历史倍率会被读到的地方 —— 逐【路由】列全，不靠通配符。
 * 新增历史页面时必须同步加进这张表（这是本闸门的价值所在）。
 */
const HISTORY_ROUTES = [
  { file: 'server/routes/api.js', path: '/api/game/history', why: '前台「我的·最近战绩」' },
  { file: 'server/routes/admin.js', path: '/admin/api/bets', why: '后台下注记录' },
  { file: 'server/routes/admin.js', path: '/admin/api/rounds', why: '后台开奖记录' },
];

console.log('\n=== §1 静态：逐路由检查 —— 历史读接口不得调用定价函数 ===');
const routeBlocks = [];
for (const hr of HISTORY_ROUTES) {
  const p = path.join(ROOT, hr.file);
  if (!fs.existsSync(p)) { ok(false, hr.file + ' 存在'); continue; }
  const blocks = splitRoutes(fs.readFileSync(p, 'utf8'));
  const blk = blocks.find((b) => b.path === hr.path);
  if (!blk) { ok(false, hr.path + ' 路由存在（' + hr.file + '）'); continue; }
  routeBlocks.push({ blk: blk, why: hr.why });

  const hits = [];
  for (const pr of PRICERS) for (const h of callSites(blk.text, pr)) hits.push(pr + ' @L' + (blk.startLine + h.line));
  ok(hits.length === 0, hr.path + ' 未调用任何定价函数（' + hr.why + '）', hits.length ? hits.join('  ') : '无');

  const bad = [];
  for (const b of BANNED_HISTORY_SOURCES) for (const h of callSites(blk.text, b)) bad.push(b + ' @L' + (blk.startLine + h.line));
  ok(bad.length === 0, hr.path + ' 没有「现算历史倍率」的辅助函数', bad.length ? bad.join('  ') : '无');
}

console.log('\n=== §2 静态：历史倍率必须直读 bets.escape_rate / rounds.rate ===');
/**
 * ⚠️ 不能断言「代码里出现过 escape_rate 这个词」。
 * /api/game/history 用的是 `SELECT b.*`，escape_rate 是随行带出来的，
 * 块里根本没有这个字符串；/admin/api/rounds 只读 rounds，根本不该碰 bets。
 * 第一版照字面断言，两条都红 —— 那是断言写错了，不是代码错了。
 * 真正要钉的是「查哪张表、怎么查」。
 */
const SRC_RULES = [
  { path: '/api/game/history', must: [/bets/, /b\.\*/, /JOIN\s+rounds/i], desc: '从 bets 直读整行并 JOIN rounds 取爆点' },
  { path: '/admin/api/bets', must: [/FROM\s+bets/i, /JOIN\s+rounds/i], desc: '从 bets 直读并 JOIN rounds' },
  { path: '/admin/api/rounds', must: [/FROM\s+rounds/i], desc: '从 rounds 直读（不需要 bets）' },
];
for (const rule of SRC_RULES) {
  const e = routeBlocks.find((x) => x.blk.path === rule.path);
  if (!e) { ok(false, rule.path + ' 已定位到路由块'); continue; }
  const miss = rule.must.filter((re) => !re.test(e.blk.text));
  ok(miss.length === 0, rule.path + ' ' + rule.desc, miss.length ? '缺 ' + miss.length + ' 项' : '');
  ok(/SELECT/.test(e.blk.text) && !/SELECT[\s\S]{0,40}(FROM\s+rounds[^;]*JOIN\s+bets[^;]*bets)[^;]*ORDER BY b\.id/i.test(e.blk.text.replace(/LEFT JOIN rounds r ON r\.id = b\.round_id/, '')),
    rule.path + ' 是直读 SQL（没有把 bets 反向 JOIN 进 rounds 再重排）', '');
}
const apiHist = routeBlocks.find((x) => x.blk.path === '/api/game/history');
ok(/WHERE b\.user_id/.test(apiHist.blk.text), '/api/game/history 只返回本人行', '');
ok(!/ORDER BY b\.id/i.test(apiHist.blk.text) || /DESC/.test(apiHist.blk.text),
  '/api/game/history 按 id 倒序取最近记录（不重排历史）', '');
const appJs = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
ok(/escape_rate/.test(appJs), '前台 app.js 读 escape_rate 展示历史倍率');

const hi = appJs.indexOf("api('/api/game/history')");
const histRender = hi >= 0 ? appJs.slice(hi) : '';
ok(histRender.length > 0, '前台存在历史渲染段', '');
ok(/Number\(b\.escape_rate\)/.test(histRender), '前台「最近战绩」直接展示 bets.escape_rate 原值', '');
ok(!/decideRate|powerlaw/.test(histRender), '前台历史渲染不含任何定价调用', '');

// ============================================================
// §3 动态：真起服务、真下注、真改算法
// ============================================================ */
const PORT = 18099, WSPORT = 18599;
const TMP_DB = path.join(ROOT, 'cache', 'qa-history-gate.db');

function startServer(env) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  p.stdout.on('data', (d) => log.push(d.toString()));
  p.stderr.on('data', (d) => log.push(d.toString()));
  return { proc: p, log };
}

async function waitUp(tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/me`); if (r.ok) return true; } catch (_) {}
    await sleep(300);
  }
  return false;
}

async function cf(url, cookie, method = 'GET', body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const ck = sc.length ? sc.map((c) => c.split(';')[0]).join('; ') : cookie;
  let js = null;
  try { js = await r.json(); } catch (_) {}
  return { cookie: ck, json: js, status: r.status };
}

(async function main() {
  console.log('\n=== §3 动态：独立实例（一次性 DB）+ 真实下注，验证换算法不改写历史 ===');
  try { fs.unlinkSync(TMP_DB); } catch (_) {}
  try { fs.mkdirSync(path.dirname(TMP_DB), { recursive: true }); } catch (_) {}

  const srv = startServer({
    PORT: String(PORT), WS_PORT: String(WSPORT), DB_FILE: TMP_DB,
    DEV_LOGIN: '1', INITIAL_COINS: '1000000', COOKIE_SECURE: '0',
  });

  try {
    if (!await waitUp()) { ok(false, '独立实例启动', srv.log.join('').slice(-500)); return; }
    ok(true, '独立实例已启动（一次性 DB，不碰开发库/生产）', 'port=' + PORT);

    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(TMP_DB);
    const q = {
      settled: () => db.prepare('SELECT COUNT(*) c FROM rounds WHERE status = 3').get().c,
      bets: () => db.prepare('SELECT COUNT(*) c FROM bets').get().c,
      current: () => db.prepare('SELECT id, status FROM rounds ORDER BY id DESC LIMIT 1').get(),
      settledAfter: (id) => db.prepare('SELECT COUNT(*) c FROM rounds WHERE status = 3 AND id > ?').get(id).c,
    };

    let ck = '';
    const login = await cf('/api/auth/dev-login', '', 'POST', { discordId: '999999999999999901', name: '闸门测试' });
    ck = login.cookie;
    ok(!!(login.json && login.json.user), 'dev-login 成功', '余额 ' + ((login.json.user || {}).coins));
    const adminS = await cf('/admin/api/dev-login', ck, 'POST', {});
    const ack = adminS.cookie;
    ok(!!ack, '取得后台会话');

    // ---- 阶段一：mode 5 作为「旧算法」，真实下注若干局 ----
    await cf('/admin/api/settings', ack, 'POST', { odds_mode: '5', min_rate: '1.10', max_rate: '50' });
    ok(true, '阶段一：赔率 = mode 5（五段加权，当作「旧算法」）');

    /** 在每一局的封盘前下注，直到 bet 数达标 */
    async function betRounds(target, deadlineMs) {
      const t0 = Date.now();
      let placed = 0;
      let lastRound = -1;
      while (Date.now() - t0 < deadlineMs && q.bets() < target) {
        const cur = q.current();
        if (cur && cur.status === 1 && cur.id !== lastRound) {   // 1 = 下注中
          const r = await cf('/api/game/bet', ck, 'POST', { roundId: cur.id, amount: 10 });
          if (r.json && r.json.ok) { placed++; lastRound = cur.id; }
        }
        await sleep(300);
      }
      return placed;
    }

    const placed1 = await betRounds(4, 80000);
    ok(placed1 > 0, '阶段一：真人下注成功（机器人不写 bets，必须自己下）', '下了 ' + placed1 + ' 注');

    const t0b = Date.now();
    while (Date.now() - t0b < 90000 && q.settled() < 2) await sleep(1000);
    ok(q.settled() >= 2, '阶段一：等到了 2 局以上结算', q.settled() + ' 局');
    ok(q.bets() >= 2, '阶段一：bets 表确有行（旧账不是空的）', q.bets() + ' 行');

    // 快照旧账 —— 边界必须取【最后一个已结算的 bet】所在的局。
        // ⚠️ 第一版边界取「最后一局已结算的 round」，于是新加的 bet 4 被算进旧账，
        // 而它结算前 rounds.rate 还是占位的 min_rate=1.10 → 结算后变 1.00，
        // 接口回读自然对不上 → 假红。边界要钉在「账已定」的那一局上。
        const snap = () => ({
          rr: db.prepare('SELECT id, rate, hash FROM rounds WHERE status = 3 ORDER BY id').all(),
          bb: db.prepare('SELECT id, round_id, amount, status, escape_rate, profit FROM bets ORDER BY id').all(),
          cc: db.prepare('SELECT id, user_id, delta, balance, reason, ref_id FROM coin_logs ORDER BY id').all(),
        });
        const settledBets = db.prepare('SELECT id, round_id FROM bets WHERE status IN (1,2) ORDER BY id').all();
        const settledRounds = db.prepare('SELECT id FROM rounds WHERE status = 3 ORDER BY id').all();
        const settledRoundIds = new Set(settledRounds.map((r) => Number(r.id)));
        const lastSettledBet = settledBets.length ? settledBets[settledBets.length - 1] : null;
        const boundary = lastSettledBet && settledRoundIds.has(Number(lastSettledBet.round_id))
          ? Number(lastSettledBet.round_id) : 0;
        const oldSnap = snap();
        const oldBets = oldSnap.bb.filter((b) => Number(b.round_id) <= boundary);
        const oldRounds = oldSnap.rr.filter((r) => Number(r.id) <= boundary);
        const oldLogs = oldSnap.cc.filter((l) => Number(l.ref_id) <= boundary || l.reason === 'initial_grant');
        ok(oldRounds.length >= 1 && oldBets.length >= 1,
          '快照「旧账」', 'rounds=' + oldRounds.length + ' bets=' + oldBets.length + ' coin_logs=' + oldLogs.length);
        console.log('  换算法分界线 rounds.id = ' + boundary + '（该局及之前视为旧账）');

    const histBefore = await cf('/api/game/history', ck);
    const beforeList = (histBefore.json && histBefore.json.list) || [];
    ok(beforeList.length > 0, '玩家侧 /api/game/history 读到历史', beforeList.length + ' 行');
    console.log('  旧账 escape_rate 样本：' + beforeList.map((b) => Number(b.escape_rate).toFixed(2) + 'x').join(' '));

    // ---- 阶段二：切到幂律 ----
    await cf('/admin/api/settings', ack, 'POST', { odds_mode: '9', powerlaw_rtp: '0.87', powerlaw_cap: '1000' });
    const st = await cf('/admin/api/settings', ack, 'GET');
    ok(st.json && st.json.settings && st.json.settings.odds_mode === '9',
      '阶段二：赔率已切到 mode 9', 'odds_mode=' + ((st.json.settings || {}).odds_mode));

    const placed2 = await betRounds(q.bets() + 3, 90000);
    ok(placed2 > 0, '阶段二：新算法下继续真实下注', '下了 ' + placed2 + ' 注');

    const t0c = Date.now();
    while (Date.now() - t0c < 90000 && q.settledAfter(boundary) < 2) await sleep(1000);
    ok(q.settledAfter(boundary) >= 2, '阶段二：等到了 2 局以上新算法结算', q.settledAfter(boundary) + ' 局');

    // ---- 逐字节比对旧账 ----
        const newSnap = snap();
        const roundDiff = [], betDiff = [], logDiff = [];
        const keptRounds = newSnap.rr.filter((r) => Number(r.id) <= boundary);
        for (const o of oldRounds) {
          const n = keptRounds.find((x) => Number(x.id) === Number(o.id));
          if (!n) { roundDiff.push('局 ' + o.id + ' 消失'); continue; }
          if (Number(n.rate) !== Number(o.rate)) roundDiff.push('局 ' + o.id + ' rate ' + o.rate + '→' + n.rate);
          if (n.hash !== o.hash) roundDiff.push('局 ' + o.id + ' hash 变了');
        }
        ok(roundDiff.length === 0, '【分界线之前】每局 rounds.rate / hash 逐字节不变', roundDiff.join('; ') || ('已核 ' + oldRounds.length + ' 局'));

        for (const o of oldBets) {
          const n = newSnap.bb.find((x) => Number(x.id) === Number(o.id));
          if (!n) { betDiff.push('bet ' + o.id + ' 消失'); continue; }
          if (Number(n.escape_rate) !== Number(o.escape_rate)) betDiff.push('bet ' + o.id + ' escape_rate ' + o.escape_rate + '→' + n.escape_rate);
          if (Number(n.profit) !== Number(o.profit)) betDiff.push('bet ' + o.id + ' profit ' + o.profit + '→' + n.profit);
          if (Number(n.amount) !== Number(o.amount)) betDiff.push('bet ' + o.id + ' amount 变了');
        }
        ok(betDiff.length === 0, '【分界线之前】每个 bet 的 escape_rate/profit/amount 逐字节不变', betDiff.join('; ') || ('已核 ' + oldBets.length + ' 行'));

        for (const o of oldLogs) {
          const n = newSnap.cc.find((x) => Number(x.id) === Number(o.id));
          if (!n) { logDiff.push('coin_log ' + o.id + ' 消失'); continue; }
          if (Number(n.delta) !== Number(o.delta) || Number(n.balance) !== Number(o.balance) || n.reason !== o.reason) {
            logDiff.push('coin_log ' + o.id + ' ' + o.delta + '/' + o.balance + '/' + o.reason + ' → ' + n.delta + '/' + n.balance + '/' + n.reason);
          }
        }
        ok(logDiff.length === 0, '【分界线之前】每条 coin_log 逐字节不变（钱账没被重算）', logDiff.join('; ') || ('已核 ' + oldLogs.length + ' 条'));

        // 玩家侧接口 —— 只比对【分界线之前】那几行
        const histBefore2 = beforeList.filter((b) => Number(b.round_id) <= boundary);
        const histAfter = await cf('/api/game/history', ck);
        const afterList = (histAfter.json && histAfter.json.list) || [];
        const afterOld = afterList.filter((b) => Number(b.round_id) <= boundary);
        ok(afterOld.length >= histBefore2.length, '换算法后历史行数未减少', histBefore2.length + ' → ' + afterOld.length);
        const apiDiff = [];
        for (const o of histBefore2) {
          const n = afterOld.find((x) => Number(x.id) === Number(o.id));
          if (!n) { apiDiff.push('bet ' + o.id + ' 不再返回'); continue; }
          if (Number(n.escape_rate) !== Number(o.escape_rate)) apiDiff.push('bet ' + o.id + ' escape_rate ' + o.escape_rate + '→' + n.escape_rate);
          if (Number(n.profit) !== Number(o.profit)) apiDiff.push('bet ' + o.id + ' profit ' + o.profit + '→' + n.profit);
          if (Number(n.boom) !== Number(o.boom)) apiDiff.push('bet ' + o.id + ' boom ' + o.boom + '→' + n.boom);
        }
        ok(apiDiff.length === 0, '玩家侧接口改算法后旧行逐字段不变（没被现算覆盖）', apiDiff.join('; ') || ('已核 ' + histBefore2.length + ' 行'));

    ok(roundDiff.length === 0 && betDiff.length === 0 && logDiff.length === 0 && apiDiff.length === 0,
      '§3 总判定：换算法不改写任何历史', '');

    // 后台两个历史接口同样验证
    const adminBets = await cf('/admin/api/bets', ack);
    const aBets = (adminBets.json && adminBets.json.list) || [];
    const abDiff = [];
    for (const o of aBets) {
      if (Number(o.round) > boundary) continue;
      const src = oldSnap.bb.find((x) => Number(x.id) === Number(o.id));
      if (!src) { abDiff.push('bet ' + o.id + ' 不在旧账里'); continue; }
      if (Number(o.rate) !== Number(src.escape_rate)) abDiff.push('bet ' + o.id + ' rate ' + src.escape_rate + '→' + o.rate);
    }
    ok(abDiff.length === 0, '/admin/api/bets 对旧行的倍率原样返回', abDiff.join('; ') || ('已核 ' + aBets.length + ' 行'));

    const adminRounds = await cf('/admin/api/rounds', ack);
    const aRounds = (adminRounds.json && adminRounds.json.list) || [];
    const arDiff = [];
    for (const o of aRounds) {
      if (Number(o.id) > boundary) continue;
      const src = oldSnap.rr.find((x) => Number(x.id) === Number(o.id));
      if (!src) continue;
      if (Number(o.rate) !== Number(src.rate)) arDiff.push('局 ' + o.id + ' rate ' + src.rate + '→' + o.rate);
    }
    ok(arDiff.length === 0, '/admin/api/rounds 对旧局的爆点原样返回', arDiff.join('; ') || ('已核 ' + aRounds.length + ' 局'));

    // 证明切换真的生效（不是「什么都没发生」）
    const fresh = newSnap.rr.filter((r) => Number(r.id) > boundary).map((r) => Number(r.rate));
    if (fresh.length) {
      console.log('  新算法局：' + fresh.map((v) => v.toFixed(2) + 'x').join(' ') + '　最高 ' + Math.max.apply(null, fresh).toFixed(2) + 'x');
      ok(fresh.every((v) => v >= 1 && v <= 1000), '新局倍率都在 [1, 1000] 内（幂律值域）', '');
      ok(fresh.length >= 2 && new Set(fresh).size > 1, '新局倍率不是恒定值（真的在抽新分布）', fresh.join(', '));
    }
  } finally {
    try { srv.proc.kill(); } catch (_) {}
    await sleep(400);
    try { fs.unlinkSync(TMP_DB); } catch (_) {}
  }

  console.log('\n' + '='.repeat(56));
  console.log('  通过 ' + pass + '  失败 ' + fail);
  console.log('='.repeat(56));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n§3 异常：', e);
  process.exit(1);
});