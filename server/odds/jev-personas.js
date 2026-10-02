'use strict';
/**
 * Jev 人格定义（TypeSafe System One）
 *
 * ⚠️ criteria 必须【一句一义】。jev-1.13 是字面阅读的（官方文档 § Literal reading）：
 *   早先 high 写成「高段。只够喂饱赌高倍型，其余人都亏。偶尔制造名场面，不要连续用」，
 *   模型照字面执行 —— 标准人格平均赢面被压到 33%，赌高倍型胜率 0%。
 *   删掉语气词、每项只陈述【谁在这个段能逃跑】之后，赢面回到 49%。
 *   结论：state 压缩省的是钱，criteria 改写改的是行为。
 *
 * 人格差异 = 下面这几行措辞（Jev 选段倾向）+ jev-bands.js 里的分段边界（代码算赢面）。
 * 「目标赢面多少」绝不问 Jev —— 它不做算术（官方文档 § Math and Numbers）。
 */

const PERSONAS = {
  standard: {
    key: 'standard',
    label: '标准人格',
    desc: '有输有赢。稳健/贪财/梭哈型多数能跑掉，赌高倍型常态亏损，偶尔来一发高倍名场面。',
    ask: '这一局应该爆在哪个倍率段，才能让在场这十个人有输有赢、总体感觉既刺激又公平？',
    crit: {
      instant: '瞬爆。全场没有人能逃跑，所有人都归零',
      low: '低段。阈值最低的一半人能逃跑',
      mid: '中段。阈值较高的那两三成人能逃跑',
      high: '高段。只有赌高倍型能逃跑',
      top: '爆段。极少数人能逃跑',
    },
  },
  bodhisattva: {
    key: 'bodhisattva',
    label: '菩萨人格',
    desc: '约八成人能带着利润离场。倍率中上段，赌高倍型也有机会，但不追求全员免灾。',
    ask: '这一局应该爆在哪个倍率段，才能让在场大部分人都能带着利润离场，同时倍率够刺激、不能太平淡？',
    crit: {
      instant: '瞬爆。所有人都亏光，最不该出现的结果',
      low: '低段。倍率偏低，刺激感不足，而且只有阈值最低的人能赢',
      mid: '中段。阈值中段以上的人都能赢，大多数人能带着钱走，倍率也够看',
      high: '高段。让赌高倍型和梭哈型也抓得住，几乎所有人都能赢',
      top: '爆段。倍率极高，虽然只有赌高倍型能跑，但场面刺激',
    },
  },
};

/** 人格 → 下段边界的整体缩放。1 = 不动。压低边界 → 覆盖更多阈值 → 赢面上升。 */
const PERSONA_EDGE_SCALE = {
  standard: 1,
  bodhisattva: 1,
};

const BAND_KEYS = ['instant', 'low', 'mid', 'high', 'top'];
const BAND_LABEL = {
  instant: '瞬爆', low: '低段', mid: '中段', high: '高段', top: '爆段',
};

/** 段 → 这个段里谁跑得掉。用于 state 里告诉模型答案空间的语义。 */
const BAND_SEMANTIC = {
  instant: '没有人能逃跑',
  low: '阈值最低的一半人能逃跑',
  mid: '阈值较高的那两三成人能逃跑',
  high: '只有赌高倍型能逃跑',
  top: '极少数人能逃跑',
};

function getPersona(key) {
  return PERSONAS[key] || PERSONAS.standard;
}

/** 组装 Choice 问题。只问一个 —— output 免费，但每个问题的 instructions+criteria 计入 input。 */
function buildQuestions(personaKey) {
  const p = getPersona(personaKey);
  const criteria = {};
  for (const k of BAND_KEYS) criteria[k] = p.crit[k];
  return { band: { type: 'choice', instructions: p.ask, criteria } };
}

module.exports = {
  PERSONAS, PERSONA_EDGE_SCALE, BAND_KEYS, BAND_LABEL, BAND_SEMANTIC,
  getPersona, buildQuestions,
};
