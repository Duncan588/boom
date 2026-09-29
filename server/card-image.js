/**
 * 红包卡片图（SVG → PNG）。
 *
 * 为什么用 SVG + sharp：服务器上没有 PIL、没有 ImageMagick，手写位图绘制代价太高。
 * SVG 直接排版文字，sharp 光栅化成 PNG，一次几十毫秒。
 *
 * 设计约束（用户要求）：
 *  - 卡片要在 Discord 消息里一眼看清金额和份数，不能花哨到读不出数字
 *  - 领完/已领的状态要能体现在图上（因为消息是静态的，后续状态靠改按钮）
 *  - 中文用系统的 Noto Sans CJK，缺字时 sharp 会回退，不会崩
 */

const sharp = require('sharp');

const W = 720;
const H = 360;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** 金额千分位 + 两位小数；超过 1e6 用 M / 1e9 用 B（与游戏内显示一致） */
function fmtAmount(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const MODE_TEXT = { even: '平均分', random: '随机分' };

/**
 * @param {object} o
 *   amountTotal  总额
 *   slots        份数
 *   mode         'even' | 'random'
 *   creatorName  发送者显示名
 *   claimed      已领份数
 *   claimedSum   已领金额
 *   status       'open' | 'done'
 * @returns {Promise<Buffer>} PNG
 */
async function renderRedpacketCard(o) {
  const total = Number(o.amountTotal) || 0;
  const slots = Math.max(1, Math.floor(Number(o.slots) || 1));
  const mode = o.mode === 'random' ? 'random' : 'even';
  const claimed = Math.max(0, Math.floor(Number(o.claimed) || 0));
  const claimedSum = Number(o.claimedSum) || 0;
  const done = o.status === 'done' || claimed >= slots;

  const perHead = total / slots;
  const rateText = done
    ? '已被领完'
    : `已领取 ${claimed}/${slots} 份`;

  // 主色：已领完转灰，未领完是红金
  const c1 = done ? '#4a4a55' : '#e63946';
  const c2 = done ? '#2a2a33' : '#8b1a2b';
  const gold = done ? '#9a9aa5' : '#ffd166';

  // 领了人之后画小圆点示意
  const dots = [];
  const perRow = 10;
  for (let i = 0; i < slots; i++) {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const rows = Math.ceil(slots / perRow);
    const totalW = perRow * 18;
    const startX = (W - totalW) / 2 + 9;
    const y = 250 + row * 24;
    const cx = startX + col * 18;
    const filled = i < claimed;
    dots.push(
      `<circle cx="${cx}" cy="${y}" r="6" fill="${filled ? gold : 'rgba(255,255,255,.12)'}" ${filled ? '' : 'stroke="rgba(255,255,255,.25)" stroke-width="1"'}/>`
    );
    if (row === 0 && rows > 3) { /* 预留 */ }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="38%" r="60%">
      <stop offset="0%" stop-color="rgba(255,255,255,.20)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- 顶部标签 -->
  <rect x="${W / 2 - 46}" y="26" width="92" height="26" rx="13" fill="rgba(0,0,0,.30)"/>
  <text x="${W / 2}" y="45" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif"
        font-size="15" font-weight="600" fill="${gold}" text-anchor="middle">${esc(MODE_TEXT[mode])}红包</text>

  <!-- 金额（大字，最重要） -->
  <text x="${W / 2}" y="146" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif"
        font-size="68" font-weight="800" fill="#ffffff" text-anchor="middle"
        style="paint-order:stroke;stroke:rgba(0,0,0,.28);stroke-width:2px">${esc(fmtAmount(total))}</text>
  <text x="${W / 2}" y="172" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif"
        font-size="16" fill="rgba(255,255,255,.82)" text-anchor="middle">QUN</text>

  <!-- 分隔线 -->
  <line x1="70" y1="200" x2="${W - 70}" y2="200" stroke="rgba(255,255,255,.20)" stroke-width="1"/>

  <!-- 份数 / 每人 / 状态 -->
  <text x="110" y="228" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif"
        font-size="15" fill="rgba(255,255,255,.85)" text-anchor="middle">${slots} 份</text>
  <text x="${W / 2}" y="228" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif"
        font-size="15" fill="rgba(255,255,255,.85)" text-anchor="middle">${done ? '已领完' : '每人约 ' + esc(fmtAmount(perHead))}</text>
  <text x="${W - 110}" y="228" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif"
        font-size="15" fill="${done ? gold : 'rgba(255,255,255,.85)'}" text-anchor="middle">${esc(rateText)}</text>

  ${dots.join('\n  ')}

  <!-- 发送者 -->
  <text x="${W / 2}" y="${H - 22}" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif"
        font-size="14" fill="rgba(255,255,255,.70)" text-anchor="middle">来自 ${esc(o.creatorName || '匿名')} 的红包</text>
</svg>`;

  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

module.exports = { renderRedpacketCard, fmtAmount };
