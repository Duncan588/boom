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
const { Responder, actorOf } = require('../server/responder');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

/**
 * 假 bot：只替换 REST 传输，其余（Responder 决策、handler 逻辑）全走真实代码。
 * dm 开关用来验证「DM 成功」和「DM 失败回落 interaction」两条路径。
 */
function makeBot({ dmFails = false } = {}) {
  const calls = [];
  const bot = {
    calls,
    log: () => {},
    activityUrl: 'https://boom.monster6324.me',
    _dmFails: dmFails,
    rest: async (m, path, body) => {
      calls.push({ kind: 'rest', m, path, body });
      if (path === '/users/@me/channels' && bot._dmFails) {
        const e = new Error('Cannot send messages to this user'); e.status = 403; throw e;
      }
      // 私聊是两步：先建频道拿 id，再在频道里发消息。
      // 线上实测：/users/@me/channels 会【静默丢弃 embeds】，
      // embeds 只在 POST /channels/{id}/messages 这一步生效。
      if (path === '/users/@me/channels') return { id: 'DMCHAN1' };
      if (m === 'POST' && path.includes('/messages')) return { id: 'MSG123' };
      return {};
    },
    // 带附件的消息走 multipart。这里记录表单内容，
    // 用来断言「图片确实作为文件上传了」而不是被静默丢弃。
    restForm: async (m, path, form) => {
      const pj = form.get('payload_json');
      const body = pj ? JSON.parse(pj) : {};
      const fileNames = [];
      for (let i = 0; i < 5; i++) {
        const f = form.get(`files[${i}]`);
        if (f) fileNames.push(f.name || f.constructor.name);
      }
      calls.push({ kind: 'rest', m, path, body, fileNames });
      return { id: 'MSG123' };
    },
    last: () => calls[calls.length - 1],
    // 找最近一条指定类型的调用
    find: (pred) => [...calls].reverse().find(pred),
  };
  return bot;
}

/** 取一条 DM 消息的正文（私聊走两步，正文在第二步） */
function dmText(bot) {
  const c = bot.find((x) => /\/messages$/.test(x.path) && x.m === 'POST');
  return (c && c.body && c.body.content) || '';
}
/** 取最近发出的卡片（embed） */
function embedOf(bot) {
  const c = bot.find((x) => x.body && x.body.embeds && x.body.embeds.length);
  return c ? c.body.embeds[0] : null;
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

/**
 * 构造一个【按钮】交互（MESSAGE_COMPONENT, type 3）。
 *
 * 【为什么要单独构造】按钮交互的字段位置和 slash 完全不同：
 *   - 按钮 id 在 it.data.custom_id（不是 it.custom_id）
 *   - 用户在 it.member.user（没有顶层 it.user）
 * 之前所有测试都用 slash 结构，从没测过按钮这条路径，
 * 所以线上「按钮点了没反应」这种问题一个都没暴露。
 */
function mkButton(customId, messageId) {
  return {
    id: 'BTN' + Math.random().toString(36).slice(2),
    type: 3,
    token: 'ITOKEN123',
    channel_id: '9999',
    member: { user: me },          // 按钮交互没有顶层 it.user
    data: { custom_id: customId },
    message: { id: messageId },
  };
}

(async () => {
  let bot = makeBot();
  let cmds = buildCommands(bot);

  console.log('\n=== 1. 指令表完整性 ===');
  const names = [...cmds.keys()];
  for (const n of ['balance', 'checkin', 'leaderboard', 'help', 'hongbao', 'boom', 'activity']) {
    ok(cmds.has(n), `/${n} 有处理器`);
  }
  ok(!cmds.has('coin'), '/coin 已移除');
  ok(cmds.has('__component:hongbao'), '红包领取按钮有处理器');

  console.log('\n=== 2. /balance —— 用户反馈失效的那个 ===');
  bot = makeBot(); cmds = buildCommands(bot);
  await cmds.get('balance')(mkIt('balance'), bot);
  const balCard = embedOf(bot);
  ok(!!balCard, '/balance 产生了回复（不是静默失败）');
  ok(balCard && balCard.title.includes('余额'), `标题: ${balCard && balCard.title}`);
  ok(balCard && balCard.fields.some((x) => x.name === 'QUN 余额'), '含 QUN 余额字段');
  ok(balCard && balCard.fields.some((x) => x.name === '全服排名'), '含排名字段');
  ok(balCard && balCard.footer.text.includes('不能充值'), '含娱乐积分声明');
  ok(!!bot.find((x) => x.path === '/users/@me/channels'), '通过私发送达（不依赖 interaction token）');
  // 【防回归】私聊必须分两步，embeds 必须挂在「发消息」那一步。
  // 线上踩过：把 embeds 塞进 /users/@me/channels，API 返回 200 但 embeds
  // 被静默丢弃 → 私聊里只有一条空白消息，卡片永远不显示。
  const dmChanCall = bot.find((x) => x.path === '/users/@me/channels');
  const dmMsgCall = bot.find((x) => /\/messages$/.test(x.path) && x.m === 'POST');
  ok(!!dmMsgCall, '第二步确实调用了 POST /channels/{id}/messages');
  ok(!!(dmMsgCall && dmMsgCall.body && dmMsgCall.body.embeds && dmMsgCall.body.embeds.length),
     'embeds 挂在发消息那一步（否则会被 Discord 静默丢弃）');
  ok(!(dmChanCall && dmChanCall.body && dmChanCall.body.embeds),
     '建频道那一步不再携带 embeds');

  console.log('\n=== 3. /checkin 每日一次 ===');
  bot = makeBot(); cmds = buildCommands(bot);
  await cmds.get('checkin')(mkIt('checkin'), bot);
  ok(/签到成功/.test((embedOf(bot) || {}).title || ''), '首次签到成功');
  bot = makeBot(); cmds = buildCommands(bot);
  await cmds.get('checkin')(mkIt('checkin'), bot);
  ok(/已经签到/.test(dmText(bot)), '重复签到被拒');
  ok(/❌/.test(dmText(bot)), '错误提示带 ❌ 前缀');

  console.log('\n=== 4. /hongbao 正常发包 ===');
  // 先给测试号充值
  const u = db.getUserByDiscord('777');
  db.get().prepare('UPDATE users SET coins=10000 WHERE id=?').run(u.id);
  bot = makeBot(); cmds = buildCommands(bot);
  await cmds.get('hongbao')(mkIt('hongbao', [
    { name: 'amount', type: 4, value: 500 },
    { name: 'slots', type: 4, value: 5 },
    { name: 'mode', type: 3, value: 'random' },
  ]), bot);
  const post = bot.calls.find((c) => c.kind === 'rest' && c.m === 'POST');
  ok(!!post, '调用了频道发消息接口');
  ok(post.path.includes('/channels/9999/messages'), '发在触发指令的频道');
  // 【回归】图片必须作为 multipart 文件上传。用 JSON 发 files[] 会被 Discord
  // 静默丢弃（attachments: []），卡片上永远不显示图片。
  ok(!!post.fileNames && post.fileNames.length === 1, `图片作为 multipart 文件上传: ${post.fileNames}`);
  ok(post.fileNames[0] === 'hongbao_cover.jpg', `用用户指定的封面原图: ${post.fileNames[0]}`);
  ok(/来自 \*\*/.test((post.body.embeds[0].description || '')), `卡片文字: ${post.body.embeds[0].description}`);
  ok(!/QUN/.test(post.body.embeds[0].description || ''), '卡片上不显示金额（用户没要求）');
  ok(!('files' in post.body), 'files 已从 payload_json 移除（否则会与 multipart 重复）');
  ok(/attachment:\/\/hongbao_cover\.jpg/.test((post.body.embeds[0].image || {}).url || ''), 'embed.image 引用上传的原图');
  const cid = post.body.components[0].components[0].custom_id;
  ok(cid === 'hongbao:claim', `按钮 custom_id 固定为 ${cid}（不带 id）`);
  ok(post.body.components[0].components[0].label === '领取', `按钮文案: ${post.body.components[0].components[0].label}`);
  const rpRow = db.get().prepare('SELECT * FROM redpackets ORDER BY id DESC LIMIT 1').get();
  ok(rpRow && rpRow.amount_total === 500 && rpRow.slots === 5 && rpRow.mode === 'random', `落库 500/5份/random`);
  ok(db.get().prepare('SELECT coins FROM users WHERE id=?').get(u.id).coins === 9500, '发送者已扣款 10000→9500');
  ok(/红包已发出/.test(dmText(bot)), `回执私发给发送者: ${dmText(bot)}`);

  console.log('\n=== 5. 领取按钮 → 到账通知 ===');
  const rid = rpRow.id;
  // 真实流程：发包后把 message_id 写回库，用户点按钮时 interaction 带 message.id
  db.get().prepare('UPDATE redpackets SET message_id=? WHERE id=?').run('MSG123', rid);
  const claim = {
    id: 'C1', type: 3, custom_id: 'hongbao:claim',
    message: { id: 'MSG123' },
    user: { id: '888', username: 'friend', global_name: '好友' },
    channel_id: '9999', data: {},
  };
  bot = makeBot(); cmds = buildCommands(bot);
  await cmds.get('__component:hongbao')(claim, bot);
  const note = dmText(bot);
  ok(/您已获得/.test(note), `私发通知: ${note.split('\n')[0]}`);
  ok(/余额/.test(note), '通知含新余额');
  const m = /您已获得 \*\*([\d,.]+)/.exec(note);
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
  bot = makeBot(); cmds = buildCommands(bot);
  await cmds.get('__component:hongbao')(claim, bot);
  ok(/已经领过/.test(dmText(bot)), `重复点击提示: ${dmText(bot)}`);
  const friend2 = db.getUserByDiscord('888');
  ok(friend2.coins === friend.coins, '重复点击余额未变');

  console.log('\n=== 7. 错误处理 ===');
  bot = makeBot(); cmds = buildCommands(bot);
  await cmds.get('hongbao')(mkIt('hongbao', [
    { name: 'amount', type: 4, value: 0.5 },
    { name: 'slots', type: 4, value: 100 },
  ]), bot);
  ok(/不足 0.01/.test(dmText(bot)), `份数过少: ${dmText(bot).split('\n')[0]}`);

  bot = makeBot(); cmds = buildCommands(bot);
  await cmds.get('hongbao')(mkIt('hongbao', [
    { name: 'amount', type: 4, value: 9999999 },
    { name: 'slots', type: 4, value: 1 },
  ]), bot);
  ok(/不足/.test(dmText(bot)), `余额不足: ${dmText(bot)}`);

  bot = makeBot(); cmds = buildCommands(bot);
  // 【用真实的按钮结构】custom_id 在 data 里，用户在 member 里。
  // 之前这里写的是 { custom_id: ..., user: me }（顶层），
  // 等于用错误的结构去测正确的代码，线上 bug 一个都测不出来。
  await cmds.get('__component:hongbao')(
    { id: 'X', type: 3, token: 'T1', message: { id: 'NO_SUCH_MSG' },
      member: { user: me }, channel_id: '1',
      data: { custom_id: 'hongbao:claim' } }, bot);
  ok(/失效/.test(dmText(bot)), `领取已失效的红包: ${dmText(bot)}`);

  console.log('\n=== 7b. 多人红包：三个人都要能领（防回归）===');
  /**
   * 【线上 bug】领取后更新卡片时我把按钮设成了 disabled:true，
   * 于是只有第一个人领得到 —— 用户反馈「给多人发送的红包但只能领取一次」。
   *
   * 正确：按钮保持 enabled，由 rp.claim() 判定每人限领一次。
   */
  bot = makeBot(); cmds = buildCommands(bot);
  {
    db.get().prepare("UPDATE users SET coins=50000 WHERE discord_id='777'").run();
    await cmds.get('hongbao')(mkIt('hongbao', [
      { name: 'amount', type: 4, value: 3000 },
      { name: 'slots', type: 4, value: 3 },
    ]), bot);
    const row = db.get().prepare('SELECT id FROM redpackets ORDER BY id DESC LIMIT 1').get();
    db.get().prepare('UPDATE redpackets SET message_id=? WHERE id=?').run('MSG_MULTI', row.id);

    // 三个不同的人依次点同一个按钮
    const pick = (id) => ({ id, type: 3, token: 'T', channel_id: '9999',
      member: { user: { id, username: 'u' + id, global_name: 'u' + id } },
      data: { custom_id: 'hongbao:claim' }, message: { id: 'MSG_MULTI' } });

    for (const uid of ['881', '882', '883']) {
      await cmds.get('__component:hongbao')(pick(uid), bot);
    }
    const n = db.get().prepare('SELECT COUNT(*) c FROM redpacket_claims WHERE redpacket_id=?').get(row.id).c;
    ok(n === 3, `三个人都领到了（领取记录 ${n} 条，应为 3）`);

    // 全部领完后：按钮应被移除（components 传空数组），
    // 而不是留一个 disabled 的按钮让用户以为还能点
    const pcs = bot.find((x) => x.m === 'PATCH' && /\/messages\//.test(x.path || ''));
    ok(!!pcs, '领取后更新了卡片按钮');
    ok(pcs && Array.isArray(pcs.body.components) && pcs.body.components.length === 0,
       '全部领完后移除按钮（components 为空数组）');
  }

  // 中途状态：只领 1/3 份时按钮必须仍可点
  bot = makeBot(); cmds = buildCommands(bot);
  {
    db.get().prepare("UPDATE users SET coins=50000 WHERE discord_id='777'").run();
    await cmds.get('hongbao')(mkIt('hongbao', [
      { name: 'amount', type: 4, value: 3000 },
      { name: 'slots', type: 4, value: 3 },
    ]), bot);
    const row = db.get().prepare('SELECT id FROM redpackets ORDER BY id DESC LIMIT 1').get();
    db.get().prepare('UPDATE redpackets SET message_id=? WHERE id=?').run('MSG_PART', row.id);
    await cmds.get('__component:hongbao')(
      { id: 'P1', type: 3, token: 'T', channel_id: '9999',
        member: { user: { id: '891', username: 'p1', global_name: 'p1' } },
        data: { custom_id: 'hongbao:claim' }, message: { id: 'MSG_PART' } }, bot);
    const pc = bot.find((x) => x.m === 'PATCH' && /\/messages\//.test(x.path || ''));
    const btn = pc && pc.body && pc.body.components
              && pc.body.components[0] && pc.body.components[0].components[0];
    ok(!!btn, '部分领取时也更新了按钮');
    ok(btn && btn.disabled !== true, '还有剩余份数时按钮【不】禁用（其他人还能领）');
    ok(btn && /剩 2/.test(btn.label || ''), `按钮显示剩余份数: ${btn && btn.label}`);
  }

  console.log('\n=== 8. 按钮交互字段位置（线上 bug 的根源）===');
  bot = makeBot(); cmds = buildCommands(bot);
  {
    // 真实 Discord 发来的 MESSAGE_COMPONENT 结构
    const real = {
      id: 'BTN1', type: 3, token: 'TOK1', channel_id: '9999',
      member: { user: me },
      data: { custom_id: 'hongbao:claim' },
      message: { id: 'MSG1' },
    };
    ok(real.custom_id === undefined, '顶层没有 custom_id（读顶层就永远是 undefined）');
    ok(real.user === undefined, '顶层没有 it.user（按钮用户只在 member.user）');
    ok(real.data.custom_id === 'hongbao:claim', '按钮 id 在 data.custom_id');
    const key = String(real.data.custom_id).split(':')[0];
    ok(!!cmds.get('__component:' + key), `按 data.custom_id 前段查到处理器: __component:${key}`);
    ok(!!actorOf(real), 'actorOf 从 member.user 取出用户');
    // 这就是 gateway 的分发逻辑，抽出来断言
    const dispatchKey = String((real.data && real.data.custom_id) || '').split(':')[0];
    ok(!!cmds.get('__component:' + dispatchKey), 'gateway 组件分发逻辑能命中处理器');
  }

  console.log('\n=== 9. 关闭 DEFERRED 挂起（否则一直显示「正在响应」）===');
  bot = makeBot();
  bot.restAnon = async (m, path, body) => { bot.calls.push({ kind: 'anon', m, path, body }); return {}; };
  cmds = buildCommands(bot);
  {
    const rr = new Responder(bot);
    const it2 = { id: 'I9', type: 2, token: 'TOK9', user: me, data: { name: 'balance' } };
    await rr.ok(it2, '内容', [{ title: '卡片' }]);
    const close = bot.find((x) => x.kind === 'anon' && x.body && x.body.type === 4);
    ok(!!close, 'DM 成功后补发 type 4 关闭挂起（否则用户看到永久「正在响应」）');
    ok(!!(close && /\/interactions\/I9\/TOK9\/callback$/.test(close.path)),
       '关闭回复路径含 interaction.token');
  }

  console.log('\n=== 10. 私发不可用时回落到 interaction ===');
  bot = makeBot({ dmFails: true }); cmds = buildCommands(bot);
  await cmds.get('__component:hongbao')({ ...claim, message: { id: '不存在的消息' } }, bot);
  const fb = bot.find((x) => x.path && x.path.startsWith('/interactions/'));
  ok(!!fb, 'DM 失败后改用 interaction 回复');
  ok(fb && fb.body.data.flags === 64, '回落回复标记为 ephemeral（不刷屏）');

  console.log(`\n${'='.repeat(46)}`);
  console.log(fail === 0 ? `✅ 全部通过：${pass}/${pass}` : `❌ ${fail} 项失败（通过 ${pass}）`);
  try { fs.unlinkSync(DB); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('崩溃: ' + e.stack); process.exit(1); });
