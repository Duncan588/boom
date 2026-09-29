/**
 * Discord 交互回复模板层。
 *
 * 【为什么必须有这一层】之前每个指令各自调 bot._reply / bot._patch，
 * 结果同一个坑踩了三次：
 *   1. _patch 走 PATCH /interactions/{id}，gateway 重连导致
 *      INVALID_SESSION 后 interaction token 立刻失效 → 404，
 *      用户什么都收不到（红包「发了没反应」的真正原因）
 *   2. ephemeral 标记靠手写 flags，漏一个就变成公开消息刷屏
 *   3. 错误提示格式不统一，有的公开有的私聊
 *
 * 所以规则只有一条，集中在 responder 里：
 *   - 面向操作者个人的信息（成功/失败提示、领取通知）→ DM
 *   - 面向所有人的内容（红包卡片、排行榜）→ 频道消息
 *   - interaction 回复只作为最后兜底，因为它的 token 会过期
 *
 * DM 的额外好处：不会刷屏、不会被频道权限挡住、领取通知不会被
 * 其他人误认为是自己领的。
 */

const fmtNum = (n) => (Number(n) || 0).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const COLORS = {
  ok: 0x52c41a,
  err: 0xe5484d,
  warn: 0xf5a524,
  info: 0x7c5cff,
  coin: 0xffd166,
  redpack: 0xe63946,
};

/**
 * 操作者是谁。不同交互类型下 user 位置不同，统一在这里兜底。
 * 线上崩过 `Cannot read properties of undefined (reading 'id')`。
 */
function actorOf(it) {
  // 【按钮交互没有顶层 it.user】MESSAGE_COMPONENT 的用户只在
  // it.member.user 里。之前只认 it.user，导致领取按钮拿不到领取人。
  return (it && (it.user || (it.member && it.member.user))) || null;
}

class Responder {
  constructor(bot) {
    this.bot = bot;
    this._dm = new Map();      // discordId -> Promise，避免连点时重复开 DM 会话
  }

  /** 私发一条消息。失败不抛 —— 私发失败不该让整个操作失败。 */
  /**
   * 私发一条消息。
   *
   * 【关键：不能只调 POST /users/@me/channels 就以为发出去了】
   *
   * 线上实测：该端点对「带 embeds 的首条消息」会静默丢弃 embeds ——
   * API 返回 200，消息也确实创建了，但 embeds 数量为 0。
   * 表现为「私聊里只有一条空白消息，什么卡片都没有」，而且不报错。
   *
   * 正确做法：分两步
   *   1) POST /users/@me/channels  只为拿到（或复用）私聊频道 id
   *   2) POST /channels/{id}/messages  在该频道发真正的消息（带 embeds）
   */
  async dm(discordId, content, embeds) {
    this.bot.log(`  → 私发给 ${discordId}（内容${content ? content.length + '字' : '空'}，卡片${embeds ? embeds.length : 0}张）`);
    try {
      // 1) 取私聊频道
      const ch = await this.bot.rest('POST', '/users/@me/channels', { recipient_id: discordId });
      // 2) 在该频道发消息 —— embeds 只在这一步生效
      await this.bot.rest('POST', `/channels/${ch.id}/messages`, {
        content: content || undefined,
        embeds: embeds && embeds.length ? embeds : undefined,
      });
      this.bot.log(`  ✓ 私发成功 → ${discordId}（频道 ${ch.id}）`);
      return true;
    } catch (e) {
      this.bot.log(`[bot] 私发失败（${e.message}），回落到 interaction 回复`);
      return false;
    }
  }

  /**
   * 成功提示：私发给操作者。
   * @param content 文字（可为空串，嵌���卡片时用 embeds）
   * @param embeds  卡片数组
   * 私发不可用（用户关私信）时回落到 interaction 回复。
   */
  /**
   * 成功提示：私发给操作者。
   *
   * 【必须补这一步】_defer 发的是 type 5 (DEFERRED_CHANNEL_MESSAGE)，
   * Discord 会一直显示「爆点正在响应……」，直到收到一个【正式回复】
   * (type 4) 或等 token 过期（约 15 分钟）。
   *
   * 之前 DM 成功后就直接 return 了，从没发过 type 4，
   * 所以用户看到的是永远转圈的「正在响应」。
   * 现在 DM 成功后补发一个空的 type 4 关闭挂起状态。
   */
  async ok(it, content, embeds) {
    const a = actorOf(it);
    if (a && await this.dm(a.id, content, embeds)) {
      await this.closeDefer(it);
      return true;
    }
    return this.fallback(it, content, { embeds });
  }

  /**
   * 关闭 DEFERRED 状态：发一个内容为空的 type 4 回复。
   *
   * type 4 的 data.content 为空字符串是合法的 —— 效果是「结束转圈但不显示任何内容」。
   */
  async closeDefer(it) {
    if (!it || !it.token) return;
    try {
      /**
       * 【content 不能是空串】实测：发 type 4 + content:'' 会返回
       * 400 "Interaction has already been acknowledged."，
       * 挂起状态没关掉，用户看到的是永久的「爆点正在响应……」。
       *
       * 原因：DEFERRED 之后的第一条正式回复会被 Discord 认定为
       * 「响应已提交」；空 content 走不通，必须带实际内容。
       * 这里发一条 ephemeral 的「已处理，详情看私信」占位。
       */
      await this.bot.restAnon('POST', `/interactions/${it.id}/${it.token}/callback`, {
        type: 4,
        data: { content: '✅ 已处理，详情已发到你的私信。', flags: 64 },
      });
      this.bot.log(`  ✓ 已关闭挂起回复（用户不再看到「正在响应」）`);
    } catch (e) {
      // 40062（token 过期）/ 400「已响应」都不影响用户体验
      this.bot.log(`  · 关闭挂起回复失败（可忽略）: ${e.message}`);
    }
  }

  /** 失败提示：私发给操作者；DM 不可用时回落为 ephemeral 的 interaction 回复。 */
  async err(it, content) {
    const a = actorOf(it);
    const text = `❌ ${content}`;
    if (a && await this.dm(a.id, text)) {
      await this.closeDefer(it);
      return true;
    }
    return this.fallback(it, text, { ephemeral: true });
  }

  /**
   * 频道消息：给所有人看的内容。
   *
   * 【附件必须走 multipart】线上踩过的坑：用 JSON 发送 files[] 时
   * Discord 不报错、直接把附件丢掉（attachments: []），
   * 于是卡片发出去只有文字和按钮、图片永远不显示。
   * 正确做法是 multipart/form-data：payload_json 放消息体，
   * files[n] 放每个文件。attachment:// 引用才能解析。
   */
  async channel(channelId, payload) {
    const files = payload.files;
    if (!files || !files.length) {
      return this.bot.rest('POST', `/channels/${channelId}/messages`, payload);
    }
    const form = new FormData();
    const { files: _drop, ...body } = payload;
    form.set('payload_json', JSON.stringify(body));
    files.forEach((f, i) => {
      const buf = Buffer.isBuffer(f.attachment) ? f.attachment : Buffer.from(String(f.attachment), 'base64');
      form.set(`files[${i}]`, new Blob([new Uint8Array(buf)], { type: 'image/png' }), f.name);
    });
    return this.bot.restForm('POST', `/channels/${channelId}/messages`, form);
  }

  /**
   * 最后兜底：直接回复 interaction。
   *
   * 【404 的根因】之前用的是 POST /interactions/{id} —— 这个端点已被 Discord
   * 废弃，调用一律返回 404 Not Found。而 fallback 是 DM 失败后的唯一出路，
   * DM 一失败就必然 404，于是用户什么都收不到。
   *
   * 正确端点是 POST /interactions/{id}/callback。
   */
  async fallback(it, content, opts = {}) {
    try {
      const flags = opts.ephemeral ? 64 : 0;
      const body = { type: 4, data: { content, embeds: opts.embeds } };
      if (flags) body.data.flags = flags;
      await this.bot.rest('POST', `/interactions/${it.id}/callback`, body);
      return true;
    } catch (e) {
      this.bot.log(`[bot] interaction 回复失败 ${it.id}: ${e.message}`);
      return false;
    }
  }

  /* ---------- 常用卡片模板 ---------- */

  balanceCard(user, rank, bets) {
    return {
      title: '💰 我的余额',
      color: COLORS.coin,
      fields: [
        { name: 'QUN 余额', value: `**${fmtNum(user.coins)}**`, inline: true },
        { name: '全服排名', value: `第 ${rank} 名`, inline: true },
        { name: '累计下注', value: `${bets} 局`, inline: true },
      ],
      footer: { text: 'QUN 仅为娱乐积分，不能充值或提现' },
    };
  }

  checkinCard(amount, balance) {
    return {
      title: '📅 签到成功',
      description: `获得 **${amount} QUN**`,
      color: COLORS.ok,
      fields: [{ name: '当前余额', value: `${fmtNum(balance)} QUN`, inline: true }],
      footer: { text: '每日 00:00（北京时间）重置' },
    };
  }

  helpCard(lines) {
    return {
      title: '爆点逃跑 · 指令帮助',
      color: COLORS.info,
      description: lines.join('\n'),
    };
  }

  leaderboardCard(rows, me) {
    const medal = ['🥇', '🥈', '🥉'];
    const body = rows.length
      ? rows.map((r, i) => `${medal[i] || `${i + 1}.`} **${r.global_name || r.username}** — ${fmtNum(r.coins)}`).join('\n')
      : '还没有人上榜。';
    const tail = me ? `\n\n你的排名：第 ${me.rank} 名（${fmtNum(me.coins)} QUN）` : '';
    return {
      title: '🏆 QUN 排行榜 TOP 10',
      color: COLORS.coin,
      description: body + tail,
      footer: { text: 'QUN 仅为娱乐积分' },
    };
  }
}

module.exports = { Responder, fmtNum, COLORS, actorOf };
