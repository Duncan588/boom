/**
 * 指令处理器测试：用 mock interaction 走真实 handler 逻辑。
 *
 * 已由 READY 事件证明的部分：Gateway 连接、心跳、意图被接受。
 * 本文件补上「指令逻辑本身对不对」——因为用户反馈是「/balance 完全没用」，
 * 光看连接正常不够，必须验证 handler 能产出正确回复。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const DB = path.join(os.tmpdir(), `cmd-test-${Date.now()}.db`);
const db = require('../server/db');
db.init(DB);
db.seedSettings();

const { buildCommands, fmtNum } = require('../server/commands');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

/** 记录每次 REST 调用的假 bot */
function makeBot() {
  const calls = [];
  return {
    calls,
    log: () => {},
    _reply: async (it, p) => { calls.push({ kind: 'reply', p }); },
    _patch: async (it, p) => { calls.push({ kind: 'patch', p }); },
    rest: async (m, path, body) => {
      calls.push({ kind: 'rest', m, path, body });
      if (m === 'POST' && path.includes('/messages')) return { id: 'MSG123' };
      return {};
    },
    last: () => calls[calls.length - 1],
  };
}

const me = { id: '777', username: 'tester', global_name: '测试者' };

function mkIt(name, options = {}) {
  return {
    id: 'INT' + Math.random().toString(36).slice(2),
    type: 2,
    channel_id: '9999',
    user: me,
    data: { name, options },
  };
}

(async () => {
  let bot = makeBot();
  const cmds = buildCommands({ get bot() { return bot; }, activityUrl: 'https://boom.monster6324.me' });

  console.log('\n=== 1. 指令表完整性 ===');
  const names = [...cmds.keys()];
  for (const n of ['balance', 'checkin', 'leaderboard', 'help', 'hongbao', 'boom', 'activity']) {
    ok(cmds.has(n), `/${n} 有处理器`);
  }
  ok(!cmds.has('coin'), '/coin 已移除');
  ok(cmds.has('__component:hongbao'), '红包领取按钮有处理器');

  console.log('\n=== 2. /balance —— 用户反馈失效的那个 ===');
  bot = makeBot(); cmds.commands = cmds;
  await cmds.get('balance')(mkIt('balance'), bot);
  const bal = bot.last();
  ok(bal && bal.kind === 'reply', '/balance 产生了回复（不是静默失败）');
  ok(bal && bal.p.embeds && bal.p.embeds[0].title.includes('余额'), `标题: ${bal && bal.p.embeds[0].title}`);
  const f = bal && bal.p.embeds[0].fields;
  ok(f && f.some((x) => x.name === 'QUN 余额'), '含 QUN 余额字段');
  ok(f && f.some((x) => x.name === '全服排名'), '含排名字段');
  ok(bal && bal.p.embeds[0].footer.text.includes('不能充值'), '含娱乐积分声明');

  console.log('\n=== 3. /checkin 每日一次 ===');
  bot = makeBot();
  await cmds.get('checkin')(mkIt('checkin'), bot);
  ok(/签到成功/.test(bot.last().p.embeds[0].title), '首次签到成功');
  bot = makeBot();
  await cmds.get('checkin')(mkIt('checkin'), bot);
  ok(/已经签到/.test(bot.last().p.content), '重复签到被拒');
  ok(bot.last().p.ephemeral === true, '重复签到提示只有自己可见');

  console.log('\n=== 4. /hongbao 正常发包 ===');
  // 先给测试号充值
  const u = db.getUserByDiscord('777');
  db.get().prepare('UPDATE users SET coins=10000 WHERE id=?').run(u.id);
  bot = makeBot();
  await cmds.get('hongbao')(mkIt('hongbao', [
    { name: 'amount', type: 4, value: 500 },
    { name: 'slots', type: 4, value: 5 },
    { name: 'mode', type: 3, value: 'random' },
  ]), bot);
  const post = bot.calls.find((c) => c.kind === 'rest' && c.m === 'POST');
  ok(!!post, '调用了频道发消息接口');
  ok(post.path.includes('/channels/9999/messages'), '发在触发指令的频道');
  ok(!!post.body.files && post.body.files[0].attachment.length > 1000, `附带 PNG 卡片（${post.body.files[0].attachment.length} 字节 base64）`);
  ok(!!post.body.components[0].components[0].custom_id.match(/^hongbao:claim:\d+$/), `按钮 custom_id: ${post.body.components[0].components[0].custom_id}`);
  const rpRow = db.get().prepare('SELECT * FROM redpackets ORDER BY id DESC LIMIT 1').get();
  ok(rpRow && rpRow.amount_total === 500 && rpRow.slots === 5 && rpRow.mode === 'random', `落库 500/5份/random`);
  ok(db.get().prepare('SELECT coins FROM users WHERE id=?').get(u.id).coins === 9500, '发送者已扣款 10000→9500');
  ok(bot.last().kind === 'patch' && /10,000|9,500|9500/.test(bot.last().p.content), `回执给发送者: ${bot.last().p.content}`);

  console.log('\n=== 5. 领取按钮 → 到账通知 ===');
  const rid = rpRow.id;
  const claim = { id: 'C1', type: 3, custom_id: 'hongbao:claim:' + rid, user: { id: '888', username: 'friend', global_name: '好友' }, channel_id: '9999', data: {} };
  bot = makeBot();
  await cmds.get('__component:hongbao')(claim, bot);
  const got = bot.last();
  ok(got.kind === 'patch' && /您已获得/.test(got.p.content), `通知文案: ${got.p.content.split('\n')[0]}`);
  ok(/余额/.test(got.p.content), '通知含新余额');
  const m = /您已获得 \*\*([\d,.]+)/.exec(got.p.content);
  ok(!!m, `解析出到账金额 ${m && m[1]}`);
  // 好友是新号：requireUser 建号时先发了 1000 QUN 欢迎金，
  // 所以余额 = 1000(注册) + 红包额，不能直接等于红包额
  const friend = db.getUserByDiscord('888');
  const gotAmt = parseFloat(m[1].replace(/,/g, ''));
  const claimed = db.get().prepare('SELECT amount FROM redpacket_claims WHERE redpacket_id=? AND user_id=?')
    .get(rid, friend.id).amount;
  ok(Math.abs(claimed - gotAmt) < 0.005, `领取记录金额 ${claimed} == 通知金额 ${gotAmt}`);
  ok(friend && Math.abs(friend.coins - (1000 + gotAmt)) < 0.005,
    `好友余额 ${friend && friend.coins} = 1000(注册礼) + ${gotAmt}(红包)`);
  ok(db.get().prepare("SELECT 1 x FROM coin_logs WHERE user_id=? AND reason='redpacket_claim'").get(friend.id), '写入领取流水');
  ok(db.get().prepare('SELECT 1 x FROM redpacket_claims WHERE redpacket_id=? AND user_id=?').get(rid, friend.id), '写入领取记录');

  console.log('\n=== 6. 重复点击同一按钮 ===');
  bot = makeBot();
  await cmds.get('__component:hongbao')(claim, bot);
  ok(/已经领过/.test(bot.last().p.content), `提示: ${bot.last().p.content}`);
  const friend2 = db.getUserByDiscord('888');
  ok(friend2.coins === friend.coins, '重复点击余额未变');

  console.log('\n=== 7. 错误处理 ===');
  bot = makeBot();
  await cmds.get('hongbao')(mkIt('hongbao', [
    { name: 'amount', type: 4, value: 0.5 },
    { name: 'slots', type: 4, value: 100 },
  ]), bot);
  ok(/不足 0.01/.test(bot.last().p.content), `份数过少: ${bot.last().p.content.split('\n')[0]}`);

  bot = makeBot();
  await cmds.get('hongbao')(mkIt('hongbao', [
    { name: 'amount', type: 4, value: 9999999 },
    { name: 'slots', type: 4, value: 1 },
  ]), bot);
  ok(/不足/.test(bot.last().p.content), `余额不足: ${bot.last().p.content}`);

  bot = makeBot();
  await cmds.get('__component:hongbao')({ id: 'X', type: 3, custom_id: 'hongbao:claim:99999', user: me, channel_id: '1', data: {} }, bot);
  ok(/不存在/.test(bot.last().p.content), `领取不存在的红包: ${bot.last().p.content}`);

  console.log(`\n${'='.repeat(46)}`);
  console.log(fail === 0 ? `✅ 全部通过：${pass}/${pass}` : `❌ ${fail} 项失败（通过 ${pass}）`);
  try { fs.unlinkSync(DB); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('崩溃: ' + e.stack); process.exit(1); });
