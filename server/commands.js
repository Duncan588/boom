/**
 * Discord slash 指令 + 红包交互处理器。
 *
 * 【为什么 /balance 之前完全没用】指令在开发者后台注册过，但注册 ≠ 能响应。
 * 交互必须经 Gateway 的 INTERACTION_CREATE 送达，进程不连 Gateway 就永远收不到；
 * 而 Bot 之前只做 REST（发消息、建 Scheduled Event），那些走 HTTP 所以一切正常。
 * 「指令存在但点了没反应」= 只做了 REST 没做 Gateway。修好连接后本文件才有意义。
 *
 * 所有指令都是 application command（斜杠指令）。/coin 已按要求移除。
 */

const db = require('./db');
const rp = require('./redpacket');
const { renderRedpacketCard, fmtAmount } = require('./card-image');

/* ---------- 小工具 ---------- */

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function fmtNum(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shortName(u) {
  if (!u) return '未知用户';
  return u.global_name || u.username || `用户${u.discord_id}`;
}

function nowIso() {
  return new Date().toISOString();
}

/** 取指令选项（application command 的参数） */
function opt(it, name) {
  const o = (it.data && it.data.options) || [];
  const f = o.find((x) => x.name === name);
  return f ? f.value : undefined;
}

/** 按钮交互里取按钮上的参数 */
function field(it, name) {
  const row = (it.data && it.data.message && it.data.message.components) || [];
  for (const r of row) for (const c of (r.components || [])) {
    for (const f of (c.fields || [])) if (f.name === name) return f.value;
  }
  return undefined;
}

/** 找到或创建该 Discord 用户的游戏内账号（只发指令不玩过的人也能领红包） */
function ensureUser(discordId, username, globalName, avatar) {
  let u = db.getUserByDiscord(discordId);
  if (u) return { user: u, created: false };
  // upsertUser 返回 {user, created, granted}，不是 user 本身
  const r = db.upsertUser({
    discordId,
    username: username || ('u' + discordId),
    globalName: globalName || username || null,
    avatar: avatar || null,
  });
  return { user: r.user, created: r.created };
}

/** 统一处理「该用户还没在游戏里出现过」 */
async function requireUser(interaction, bot) {
  const discordId = interaction.user.id;
  const { user, created } = ensureUser(discordId, interaction.user.username, interaction.user.global_name, interaction.user.avatar);
  if (created) {
    bot.log(`[bot] 新用户 ${user.username}(${discordId}) 首次通过指令进入，已发放 1000 QUN`);
  }
  return user;
}

/* ---------- 指令定义 ---------- */

/**
 * Discord application command 定义。register() 会 PUT 到 applications/{id}/commands。
 * 去掉 /launch（Discord 自带的内置 Activity 指令，删不掉也不该重复注册）
 * 和 /coin（用户要求删除的旧管理员指令）。
 */
function commandDefs({ activityUrl, clientId }) {
  const target = clientId ? `application_id=${clientId}` : 'the app';
  return [
    {
      name: 'boom', description: '打开爆点虚拟金币小游戏',
      integration_types: [0],   // 0=可安装到服务器
    },
    {
      name: 'activity', description: '打开爆点 Discord Activity 网页',
      integration_types: [0],
    },
    {
      name: 'balance', description: '查看自己的 QUN 余额',
      integration_types: [0],
    },
    {
      name: 'hongbao', description: '发一个 QUN 红包到当前频道',
      integration_types: [0],
      options: [
        {
          name: 'amount', type: 4, required: true,   // 4 = INTEGER
          description: '红包总金额（QUN）',
          min_value: 1,
        },
        {
          name: 'slots', type: 4, required: true,
          description: '领取人数（几份）',
          min_value: 1, max_value: 100,
        },
        {
          name: 'mode', type: 3, required: false,  // 3 = STRING
          description: '分配方式',
          choices: [
            { name: '平均分', value: 'even' },
            { name: '随机分', value: 'random' },
          ],
        },
      ],
    },
    {
      name: 'checkin', description: '每日签到领取 QUN',
      integration_types: [0],
    },
    {
      name: 'leaderboard', description: '查看 QUN 排行榜',
      integration_types: [0],
    },
    {
      name: 'help', description: '查看指令和玩法说明',
      integration_types: [0],
    },
  ].map((c) => {
    // 默认成员权限留空 = 所有人可用
    delete c.default_member_permissions;
    void target; void activityUrl;
    return c;
  });
}

/* ---------- 处理器 ---------- */

/** /balance —— 用户反馈「完全没用」的那个 */
async function cmdBalance(it, bot) {
  const u = await requireUser(it, bot);
  const row = db.get().prepare('SELECT COUNT(*) AS bets FROM bets WHERE user_id = ?').get(u.id);
  const rank = db.get().prepare('SELECT COUNT(*) + 1 AS r FROM users WHERE coins > ?').get(u.coins).r;

  await bot._reply(it, {
    embeds: [{
      title: '💰 我的余额',
      color: 0xffd166,
      fields: [
        { name: 'QUN 余额', value: `**${fmtNum(u.coins)}**`, inline: true },
        { name: '全服排名', value: `第 ${rank} 名`, inline: true },
        { name: '累计下注', value: `${row.bets} 局`, inline: true },
      ],
      footer: { text: 'QUN 仅为娱乐积分，不能充值或提现' },
    }],
  });
}

/** /checkin */
async function cmdCheckin(it, bot) {
  const u = await requireUser(it, bot);
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const got = db.get().prepare(
    "SELECT 1 AS x FROM coin_logs WHERE user_id=? AND reason='checkin' AND substr(created_at,1,10)=?"
  ).get(u.id, today);
  if (got) {
    return bot._reply(it, { content: '📅 今天已经签到过了，明天再来。', ephemeral: true });
  }
  const amount = 100;
  const after = db.addCoins(u.id, amount, 'checkin', today);
  await bot._reply(it, {
    embeds: [{
      title: '📅 签到成功',
      description: `获得 **${amount} QUN**`,
      color: 0x52c41a,
      fields: [{ name: '当前余额', value: `${fmtNum(after)} QUN`, inline: true }],
      footer: { text: '每日 00:00（北京时间）重置' },
    }],
  });
}

/** /leaderboard */
async function cmdLeaderboard(it, bot) {
  const rows = db.get().prepare('SELECT username, global_name, coins FROM users ORDER BY coins DESC LIMIT 10').all();
  const me = db.getUserByDiscord(it.user.id);
  const lines = rows.map((r, i) => {
    const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    return `${medal} **${r.global_name || r.username}** — ${fmtNum(r.coins)}`;
  });
  if (!lines.length) lines.push('还没有人上榜。');
  const content = lines.join('\n');
  if (me) {
    const rank = db.get().prepare('SELECT COUNT(*) + 1 AS r FROM users WHERE coins > ?').get(me.coins).r;
    await bot._reply(it, {
      content: `**🏆 QUN 排行榜 TOP 10**\n${content}\n\n你的排名：第 ${rank} 名（${fmtNum(me.coins)} QUN）`,
    });
  } else {
    await bot._reply(it, { content: `**🏆 QUN 排行榜 TOP 10**\n${content}` });
  }
}

/** /help */
async function cmdHelp(it, bot) {
  await bot._reply(it, {
    embeds: [{
      title: '爆点逃跑 · 指令帮助',
      color: 0x7c5cff,
      description: [
        '**/balance** — 查看余额与排名',
        '**/checkin** — 每日签到领 100 QUN',
        '**/leaderboard** — 排行榜 TOP 10',
        '**/hongbao** — 发红包（填金额、人数、分配方式）',
        '**/boom** · **/activity** — 打开游戏',
        '',
        '**玩法**：10 秒下单 → 5 秒封盘 → 起飞，倍率越高飞得越久。',
        '看到满意的倍率点「逃跑」即可落袋，倍数自动结算。',
        '',
        '*QUN 仅为娱乐积分，不能充值或提现。*',
      ].join('\n'),
    }],
    ephemeral: true,
  });
}

/* ---------- 红包 ---------- */

/** /hongbao */
async function cmdHongbao(it, bot) {
  const u = await requireUser(it, bot);

  const amount = Math.round((Number(opt(it, 'amount')) || 0) * 100) / 100;
  const slots = Math.floor(Number(opt(it, 'slots')) || 0);
  const mode = opt(it, 'mode') === 'random' ? 'random' : 'even';

  // 在频道里可见的报错（不是 ephemeral）—— 用户是发给别人领的，
  // 出错要让对方知道，别静默
  const fail = async (msg) => bot._patch(it, { content: `❌ ${msg}`, components: [] });

  if (!amount || amount <= 0) return fail('金额必须大于 0。');
  if (!slots || slots < 1) return fail('领取人数至少 1 人。');
  if (amount / slots < 0.01) return fail(`每人份额不足 0.01 QUN。\n${fmtNum(amount)} ÷ ${slots} 太少，请减少人数或加金额。`);

  let created;
  try {
    created = rp.create({ creatorId: u.id, channelId: String(it.channel_id), amountTotal: amount, slots, mode });
  } catch (e) {
    if (e instanceof rp.RedPacketError) return fail(e.message);
    throw e;
  }

  const png = await renderRedpacketCard({
    amountTotal: created.total, slots: created.slots, mode: created.mode,
    creatorName: shortName(u), claimed: 0, claimedSum: 0, status: 'open',
  });

  const filename = `hongbao-${created.id}.png`;
  const msg = await bot.rest('POST', `/channels/${it.channel_id}/messages`, {
    embeds: [{
      title: '🧧 有人发了一个红包',
      description: `<@${it.user.id}> 发出了 **${fmtNum(created.total)} QUN** · ${created.slots} 份 · ${mode === 'even' ? '平均分' : '随机分'}`,
      color: 0xe63946,
      image: { url: `attachment://${filename}` },
      footer: { text: 'QUN 仅为娱乐积分' },
    }],
    components: [{
      type: 1,
      components: [{
        type: 2, style: 1, label: '领取红包',
        custom_id: `hongbao:claim:${created.id}`,
      }],
    }],
    files: [{ name: filename, attachment: png.toString('base64') }],
  });

  // 回执：只对发包人可见，不刷屏
  await bot._patch(it, {
    content: `✅ 红包已发出 · 你的余额 **${fmtNum(created.balance)} QUN**`,
    components: [], embeds: [],
  });

  db.get().prepare('UPDATE redpackets SET message_id=? WHERE id=?').run(msg.id, created.id);
  bot.log(`[bot] 红包 #${created.id} 由 ${shortName(u)} 发出 ${fmtNum(created.total)} / ${created.slots} 份 / ${mode}`);
}

/** 领取按钮 */
async function onClaimButton(it, bot) {
  const id = Number(String(it.custom_id).split(':').pop());
  const u = await requireUser(it, bot);

  let res;
  try {
    res = rp.claim(id, u.id);
  } catch (e) {
    if (e instanceof rp.RedPacketError) {
      // 领过/领完：回一条只有自己可见的提示，不动原卡片
      return bot._patch(it, { content: `⚠️ ${e.message}`, components: [] });
    }
    throw e;
  }

  // 【核心需求】用户要收到「您已获得多少 qun币」的通知。
  // 用 ephemeral 回复：只有领取者自己看得到，不刷屏，且不会被别人误领。
  await bot._patch(it, {
    content: `🧧 您已获得 **${fmtNum(res.amount)} QUN**！\n余额：**${fmtNum(res.balance)} QUN**`,
    components: [],
  });

  // 领完就把卡片按钮下掉
  if (res.done) {
    const m = rp.get(id);
    if (m && m.message_id) {
      try {
        await bot.rest('PATCH', `/channels/${m.channel_id}/messages/${m.message_id}`, {
          components: [],
          embeds: [{
            title: '🧧 红包已被领完',
            description: `**${fmtNum(m.amount_total)} QUN** / ${m.slots} 份 已全部领取`,
            color: 0x808080,
          }],
        });
      } catch (e) { bot.log('[bot] 更新红包卡片失败: ' + e.message); }
    }
  }
}

/* ---------- 注册 ---------- */

/**
 * 建命令表 + 返回定义。
 * 组件 handler 以 '__component:' 为前缀，方便和指令名区分。
 */
function buildCommands(botOpts) {
  const cmds = new Map();
  cmds.set('balance', cmdBalance);
  cmds.set('checkin', cmdCheckin);
  cmds.set('leaderboard', cmdLeaderboard);
  cmds.set('help', cmdHelp);
  cmds.set('hongbao', cmdHongbao);
  cmds.set('boom', async (it) => {
    await botOpts.bot._reply(it, { content: `点击开始游戏 → ${botOpts.activityUrl}`, ephemeral: true });
  });
  cmds.set('activity', async (it) => {
    await botOpts.bot._reply(it, { content: `点击开始游戏 → ${botOpts.activityUrl}`, ephemeral: true });
  });
  cmds.set('__component:hongbao', onClaimButton);
  return cmds;
}

module.exports = { buildCommands, commandDefs, cmdBalance, cmdCheckin, cmdLeaderboard, cmdHelp, cmdHongbao, onClaimButton, fmtNum, CN_NUM, nowIso };
