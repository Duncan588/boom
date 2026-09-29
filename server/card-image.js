/**
 * 红包卡片。
 *
 * 【用户要求】只要三样东西：
 *   1. 一张图（用户指定的封面，原图直接用）
 *   2. 一句「来自 XX 的一个红包」
 *   3. 一个「领取」按钮
 *
 * 不要自己渲染金额、份额、进度圆点 —— 那些是我自作主张加的。
 * 所以这里不生成任何图片，只负责组装消息体，由 Responder 走 multipart 发出。
 */

const fs = require('fs');
const path = require('path');

// 用户指定的封面图（火星 + 祥云 + 火箭），原图直接上传，不裁切不加工。
const COVER = path.join(__dirname, '..', 'public', 'assets', 'img', 'hongbao_cover.jpg');

function readCover() {
  return fs.readFileSync(COVER);
}

const MODE_TEXT = { even: '平均分', random: '随机分' };

/**
 * 构造 Discord 消息体：embed（文字 + 图）+ components（按钮）+ files（原图）。
 *
 * @param {object} o
 *   creatorName 发送者显示名
 *   mode        'even' | 'random'（仅用于日志，不在卡片上显示）
 */
function buildRedpacketMessage({ creatorName, mode }) {
  void mode;
  return {
    embeds: [{
      description: `🧧 来自 **${creatorName}** 的一个红包`,
      color: 0xe63946,
      image: { url: 'attachment://hongbao_cover.jpg' },
    }],
    components: [{
      type: 1,
      components: [{ type: 2, style: 1, label: '领取', custom_id: 'hongbao:claim' }],
    }],
    files: [{ name: 'hongbao_cover.jpg', attachment: readCover() }],
  };
}

module.exports = { buildRedpacketMessage, readCover, COVER, MODE_TEXT };
