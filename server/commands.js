/**
 * Discord slash 指令 + 红包交互处理器。
 *
 * 【/balance 之前失效的根因】指令在开发者后台注册过，但进程只做 REST 调用，
 * 从未连接 Gateway —— 交互事件走 Gateway 的 INTERACTION_CREATE，不连就收不到。
 * 「注册」和「能响应」是两件事，这是最容易误判成配置问题的地方。
 *
 * 【本文件的铁律】所有回复都必须走 Responder（server/responder.js），
 * 不要直接调 bot._reply / bot._patch。理由见 responder.js 文件头：
 * interaction token 在 gateway 重连后会失效（404），DM/频道消息不会。
 */

const db = require('./db');
const rp = require('./redpacket');
const { buildRedpacketMessage } = require('./card-image');
const { Responder, fmtNum, actorOf } = require('./responder');

/**
 * 取（或懒创建）Responder。
 *
 * 不用 bot.responder 字段：那个挂载点要求 buildCommands 一定先跑过，
 * 单元测试直接调 handler 时就会拿到 undefined（线上表现为
 * 「Cannot read properties of undefined (reading 'err')」）。
 * 这里改成按需创建，handler 自身永远可用。
 */
function R_(bot) {
  if (!bot.__responder) bot.__responder = new Responder(bot);
  return bot.__responder;
}

/* ---------- 工具 ---------- */

function opt(it, name) {
  const o = (it.data && it.data.options) || [];
  const f = o.find((x) => x.name === name);
  return f ? f.value : undefined;
}

function shortName(u) {
  if (!u) return '匿名';
  return u.global_name || u.username || `用户${u.discord_id}`;
}

/** 找或建游戏内账号。upsertUser 返回 {user, created, granted}，不是 user 本身。 */
function ensureUser(discordId, username, globalName, avatar) {
  const exist = db.getUserByDiscord(discordId);
  if (exist) return { user: exist, created: false };
  const r = db.upsertUser({
    discordId,
    username: username || ('u' + discordId),
    globalName: globalName || username || null,
    avatar: avatar || null,
  });
  return { user: r.user, created: r.created };
}

/** 拿操作者的游戏账号，缺 user 字段时给出可读错误而不是 TypeError。 */
function actorUser(it, bot) {
  const d = actorOf(it);
  if (!d || !d.id) throw new Error('无法识别调用者，请在 Discord 频道里重新输入指令');
  const { user, created } = ensureUser(d.id, d.username, d.global_name, d.avatar);
  if (created) bot.log(`[bot] 新用户 ${user.username}(${d.id}) 首次通过指令进入，已发 1000 QUN`);
  return { user, d };
}

function rankOf(user) {
  return db.get().prepare('SELECT COUNT(*) + 1 AS r FROM users WHERE coins > ?').get(user.coins).r;
}

/* ---------- 指令定义 ---------- */

/**
 * 去掉 /launch（Discord 强制的 Entry Point，批量 PUT 不能删）
 * 和 /coin（用户要求删除的旧管理员指令）。
 */
function commandDefs({ activityUrl }) {
  void activityUrl;
  const raw = [
    { name: 'boom', description: '打开爆点虚拟金币小游戏' },
    { name: 'activity', description: '打开爆点 Discord Activity 网页' },
    { name: 'balance', description: '查看自己的 QUN 余额' },
    {
      name: 'hongbao', description: '发一个 QUN 红包到当前频道',
      options: [
        { name: 'amount', type: 4, required: true, min_value: 1, description: '红包总金额（QUN）' },
        { name: 'slots', type: 4, required: true, min_value: 1, max_value: 100, description: '领取人数（几份）' },
        {
          name: 'mode', type: 3, required: false, description: '分配方式',
          choices: [{ name: '平均分', value: 'even' }, { name: '随机分', value: 'random' }],
        },
      ],
    },
    { name: 'checkin', description: '每日签到领取 QUN' },
    { name: 'leaderboard', description: '查看 QUN 排行榜' },
    { name: 'help', description: '查看指令和玩法说明' },
  ];
  return raw.map((c) => ({ ...c, integration_types: [0] }));
}

/* ---------- 处理器 ---------- */

async function cmdBalance(it, bot) {
  const { user } = actorUser(it, bot);
  const bets = db.get().prepare('SELECT COUNT(*) AS c FROM bets WHERE user_id = ?').get(user.id).c;
  const card = R_(bot).balanceCard(user, rankOf(user), bets);
  await R_(bot).ok(it, '', [card]);
}

async function cmdCheckin(it, bot) {
  const { user } = actorUser(it, bot);
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const got = db.get().prepare(
    "SELECT 1 AS x FROM coin_logs WHERE user_id=? AND reason='checkin' AND substr(created_at,1,10)=?"
  ).get(user.id, today);
  if (got) return R_(bot).err(it, '今天已经签到过了，明天再来。');

  const amount = 100;
  const balance = db.addCoins(user.id, amount, 'checkin', today);
  await R_(bot).ok(it, '', [R_(bot).checkinCard(amount, balance)]);
}

async function cmdLeaderboard(it, bot) {
  const rows = db.get().prepare('SELECT username, global_name, coins FROM users ORDER BY coins DESC LIMIT 10').all();
  const me = db.getUserByDiscord((actorOf(it) || {}).id);
  const card = R_(bot).leaderboardCard(rows, me ? { rank: rankOf(me), coins: me.coins } : null);
  await R_(bot).channel(it.channel_id, { embeds: [card] });
}

const HELP_LINES = [
  '**/balance** — 查看余额与排名',
  '**/checkin** — 每日签到领 100 QUN',
  '**/leaderboard** — 排行榜 TOP 10',
  '**/hongbao** — 发红包（金额 / 领取人数 / 平均分或随机分）',
  '**/boom** · **/activity** — 打开游戏',
  '',
  '**玩法**：10 秒下单 → 5 秒封盘 → 起飞。倍率越高飞得越久。',
  '看到满意的倍率点「逃跑」即可落袋，倍数自动结算。',
  '',
  '*QUN 仅为娱乐积分，不能充值或提现。*',
];

async function cmdHelp(it, bot) {
  await R_(bot).ok(it, '', [R_(bot).helpCard(HELP_LINES)]);
}

async function cmdOpen(it, bot) {
  const url = bot.activityUrl;
  await R_(bot).ok(it, `点击开始游戏 → ${url}`);
}

/* ---------- 红包 ---------- */

/**
 * /hongbao
 *
 * 关键：卡片和回执都走 channels/messages（REST），不依赖 interaction token。
 * 之前用 PATCH /interactions 回执，gateway 一重连 token 就 404，
 * 表现为「红包建了但频道里没卡片、用户什么都没看到」。
 */
async function cmdHongbao(it, bot) {
  const { user, d } = actorUser(it, bot);
  const R = R_(bot);

  const amount = Math.round((Number(opt(it, 'amount')) || 0) * 100) / 100;
  const slots = Math.floor(Number(opt(it, 'slots')) || 0);
  const mode = opt(it, 'mode') === 'random' ? 'random' : 'even';

  if (!(amount > 0)) return R.err(it, '金额必须大于 0。');
  if (!(slots >= 1)) return R.err(it, '领取人数至少 1 人。');
  if (amount / slots < 0.01) {
    return R.err(it, `每人份额不足 0.01 QUN。\n${fmtNum(amount)} ÷ ${slots} 太少，请减少人数或加金额。`);
  }

  let created;
  try {
    created = rp.create({ creatorId: user.id, channelId: String(it.channel_id), amountTotal: amount, slots, mode });
  } catch (e) {
    if (e instanceof rp.RedPacketError) return R.err(it, e.message);
    throw e;
  }

  // 【按用户要求】卡片只有：用户的封面图 + 「来自 XX 的一个红包」+ 领取按钮。
  // 不渲染金额、份额、进度 —— 那些是我之前自作主张加的。
  const payload = buildRedpacketMessage({ creatorName: shortName(user), mode });
  let msg = null;
  try {
    msg = await R.channel(it.channel_id, payload);
    db.get().prepare('UPDATE redpackets SET message_id=? WHERE id=?').run(msg.id, created.id);
  } catch (e) {
    // 卡片发不出去：钱已经扣了，必须原路退回并告知，绝不吞币
    bot.log(`[bot] 红包 #${created.id} 卡片发送失败: ${e.message}`);
    db.addCoins(user.id, created.total, 'redpacket_refund', String(created.id));
    db.get().prepare("UPDATE redpackets SET status='refunded' WHERE id=?").run(created.id);
    try {
      await R.channel(it.channel_id, { content: `❌ <@${d.id}> 红包卡片发送失败（${e.message}），已原路退回 **${fmtNum(created.total)} QUN**。` });
    } catch (_) {}
    return;
  }

  await R.ok(it, `✅ 红包已发出 · 你的余额 **${fmtNum(created.balance)} QUN**`);
  bot.log(`[bot] 红包 #${created.id} 由 ${shortName(user)} 发出 ${fmtNum(created.total)} / ${created.slots} 份 / ${mode}`);
}

/**
 * 领取按钮。
 *
 * custom_id 固定是 'hongbao:claim'（不带 id），红包 id 通过【消息 ID】反查：
 * 用户在哪个红包上点的按钮，interaction 里的 message.id 就是那张卡片。
 * 这样卡片不用把 id 编进 custom_id，也避免 id 对不上导致点了没反应。
 */
async function onClaimButton(it, bot) {
  const msgId = it.message && it.message.id;
  const row = msgId
    ? db.get().prepare('SELECT id, creator_id FROM redpackets WHERE message_id=?').get(String(msgId))
    : null;
  if (!row) {
    bot.log(`[bot] 领取失败：找不到 message_id=${msgId} 对应的红包`);
    return R_(bot).err(it, '这个红包已失效，请让发包的人重新发一个。');
  }
  const id = row.id;
  const { user, d } = actorUser(it, bot);
  const R = R_(bot);

  let res;
  try {
    res = rp.claim(id, user.id);
  } catch (e) {
    if (e instanceof rp.RedPacketError) return R.err(it, e.message);
    throw e;
  }

  // 【用户明确要求】领取后收到「您已获得多少 QUN」的通知 → 私发，不刷屏
  await R.ok(it, `🧧 您已获得 **${fmtNum(res.amount)} QUN**！\n当前余额：**${fmtNum(res.balance)} QUN**`);

  /**
   * 更新卡片按钮。
   *
   * 【为什么必须改】原来只在 res.done（全部领完）时才更新。
   * 于是「没领完的红包」按钮一直可点 —— 用户点自己那份时
   * rp.claim 抛「你已经领过了」，看起来就是「领取失败」，
   * 而已领完的又因 message_id 缺失（PATCH 404）同样不生效。
   *
   * 现在每次领取后都更新：
   *   - 全部领完 → 去掉按钮，文案改为「已被领完」
   *   - 还有剩余 → 按钮改为 disabled，文案显示剩余份数
   */
  const m = rp.get(id);
  if (m && m.message_id) {
    try {
      if (res.done) {
        // 只去按钮，保留原图和「来自 @X 的一个红包」
        await bot.rest('PATCH', `/channels/${m.channel_id}/messages/${m.message_id}`, {
          components: [],
        });
      } else {
        /**
         * 【这里绝不能设 disabled】
         * 线上踩过：把按钮设成 disabled:true 想表达「你已领取」，
         * 结果只有第一个人领得到，剩下所有人都点不动 ——
         * 用户反馈「给多人发送的红包但只能领取一次」。
         *
         * 正确：按钮保持 enabled，由 rp.claim() 判定每人限领一次。
         * 只有全部领完才禁用。
         *
         * ⚠️ 另外这里【只能有一个 components 键】。之前误写成两个，
         * 后者覆盖前者，于是 disabled 的旧版本一直生效 —— 这就是
         * 「改了代码却没生效」的原因。
         */
        const left = m.slots - m.claimed;      // 表字段是 claimed，不是 claimed_count
        // 只改 components（按钮），不动 embeds / attachments ——
        // PATCH 消息时若省略 embeds，原有的图片和文案都会消失。
        await bot.rest('PATCH', `/channels/${m.channel_id}/messages/${m.message_id}`, {
          components: [{
            type: 1,
            components: [{
              type: 2,
              style: 2,
              label: `领取（剩 ${left} 份）`,
              custom_id: 'hongbao:claim',
              disabled: false,          // 还有份数就人人可点
            }],
          }],
        });
      }
    } catch (e) { bot.log('[bot] 更新红包卡片失败: ' + e.message); }
  }
  void d;
}

/* ---------- 注册 ---------- */

function buildCommands(bot) {
  const cmds = new Map();
  cmds.set('balance', cmdBalance);
  cmds.set('checkin', cmdCheckin);
  cmds.set('leaderboard', cmdLeaderboard);
  cmds.set('help', cmdHelp);
  cmds.set('hongbao', cmdHongbao);
  cmds.set('boom', cmdOpen);
  cmds.set('activity', cmdOpen);
  cmds.set('__component:hongbao', onClaimButton);
  // 模板挂在 bot 上：指令里统一用 R_(bot).*，不再各写各的
  bot.responder = new Responder(bot);
  return cmds;
}

module.exports = {
  buildCommands, commandDefs,
  cmdBalance, cmdCheckin, cmdLeaderboard, cmdHelp, cmdHongbao, cmdOpen, onClaimButton,
  fmtNum, ensureUser, actorUser, HELP_LINES,
};
