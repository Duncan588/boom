'use strict';
/**
 * jev-decide.js —— 用 jev 做形态选型决战（客户明确要求）
 *
 * 流程纠正：技术选型不再上报负责人，直接问 jev，只把最终结论交出去。
 * 成本纪律：单次 <$0.5 不中断报备（本次约 1-2k token input，$42/Btok ⇒ <$0.1）。
 *
 * 【jev 只做选择，绝不进生产】结论会落成静态参数 + 纯函数。
 * 本脚本是一次性决策工具，不属于线上引擎。
 *
 * 用法：node scripts/jev-decide.js
 */
const fs = require('fs');
const path = require('path');

const API = 'https://api.typesafe.ai/v1/systemone';
const KEY = process.env.TYPESAFE_API_KEY || '';
const PRICE_PER_MTOK_INPUT = 42;

if (!KEY) {
  console.error('❌ TYPESAFE_API_KEY 未设置，无法调用 jev。');
  process.exit(1);
}

/** 把 constraint-probe.js 的实测结论打包成决策包（数字全部来自那次实测） */
const brief = {
  role: '你是一个 Discord crash 游戏的赔率算法选型专家。玩家下注后看到倍率持续上涨，点「逃跑」按当前倍率结算，否则血本无归。',
  currentEngine: '幂律：X = min(cap, max(1, floor(RTP/U)))，U 均匀分布。它的性质是「任意逃跑点净期望相同 = 0.97·RTP−1」。',
  customerDemand: [
    '50% 的局落在 5x–30x',
    '中位数明显抬到 5x 以上',
    '客户已授权去掉「不存在最优逃跑点」这条约束',
  ],
  mathFactsMeasured: {
    formula: '玩家固定逃 m 的净 EV = 0.97·m·P(X>m) − 1；负期望要求 m·P(X>m) < 1.0309',
    consequence: 'm=5 处要求 P(X>5) < 20.62%，而客户要 50% —— 超出 29.4 个百分点，数学上无解',
    breakevenMultiplier: '若「50% 的局 ≥ M」且玩家不亏，则 M < 2.0618',
    arbitrageByTarget: {
      '2x': '净EV -3.00%（偏紧但安全）',
      '3x': '净EV +45.5%/注（稳定暴利）',
      '5x': '净EV +142.5%/注（稳定暴利）',
    },
    measuredCeiling: '我用 144 个参数组合实测，找到 137 个「零套利」形状，但中位数天花板只有 2.04x，5-30x 占比最高 17.2%。「中位数 5x 以上」在零套利前提下达不到。',
  },
  hardConstraints: [
    '玩家固定任意逃跑点的净期望必须为负（全网格 1.01~1000x 无正期望点）',
    '无空档（玩家看得见的「习惯区间」边界）',
    '无配额节拍（每 100 局 ≥10x 局数标准差 > 1.5）',
    '相邻局相关系数 |r| < 0.01',
  ],
  deliverable: '一个纯函数 + 静态参数（可逆变换采样，无状态、单次抽样、CSPRNG），能被现有 decideRate 调用。不改 engine.js，不改 flightMs 闭式解。',
  options: [
    { id: 'A', name: '严格照客户原话', shape: '50% 在 5-30x', cost: '玩家固定逃 5x 稳赚 +142.5%/注，几天内必然被找到并套利' },
    { id: 'B', name: '降档位', shape: '50% 的局 ≥ 2x', cost: '中位数仅 ~2x，观感提升有限，但数学安全' },
    { id: 'C', name: '改口径', shape: '中位数 2x + 20% 的局在 5x 以上', cost: '数字诚实、零套利，但客户可能觉得没满足「50%」' },
  ],
  question: '请做决策：① 在 A/B/C 中选一个并说明理由；② 或者提出一个我上面没列出的、同时满足全部硬约束、且中位数尽可能高的具体形状（给出数学表达式和参数）。请直接给结论，不要反问。',
};

/**
 * questions 必须是【对象】不是数组 —— 这是实测踩到的：
 *   传数组会得到 HTTP 422 {"loc":["body","questions"],"msg":"Input should be a valid dictionary"}
 * 格式参照 server/jev-personas.js 的 buildQuestions()：
 *   { <key>: { type:'choice', instructions, criteria:{...} } }
 */
const QUESTIONS = {
  shape: {
    type: 'choice',
    instructions: brief.question,
    criteria: {
      A: '严格遵守客户原话：50% 的局落在 5x-30x。代价：玩家固定逃 5x 净 EV +142.5%/注，几天内必然被套利。选它等于用游戏 longevity 换客户满意度。',
      B: '把档位降到 2x：50% 的局 ≥ 2x。数学安全（约束 P(X>2) < 51.55%，50% 刚好通过），但中位数仅约 2x，观感提升有限。',
      C: '改口径：中位数 2x + 20% 的局在 5x 以上。零套利、数字诚实，但客户可能觉得没满足「50%」这个字面要求。',
      D: '提出第四个方案：给出具体数学表达式与参数，同时满足零套利且中位数 > 2.04x。如果你认为这在数学上不可能，请直接说明并解释为什么。',
    },
  },
};

async function main() {
  const prompt = JSON.stringify(brief);
  const estTokens = Math.ceil(prompt.length / 4);
  const estCost = (estTokens / 1e6) * PRICE_PER_MTOK_INPUT;
  console.log('=== jev 选型决战 ===');
  console.log('决策包 ' + estTokens + ' tokens，预估成本 $' + estCost.toFixed(4) + '（单次 <$0.5 阈值，按流程直接跑）');
  console.log('');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  try {
    const res = await fetch(API, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
      body: JSON.stringify({ model: 'jev-latest', state: brief, questions: QUESTIONS }),
    });
    const text = await res.text();
    clearTimeout(timer);
    console.log('HTTP ' + res.status);
    if (!res.ok) {
      console.error('jev 调用失败：' + text.slice(0, 500));
      process.exit(2);
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }
    // ⚠️ data/ 在仓库的【上一级】（与生产库同一个父目录约定），本地不存在时要先建。
    const outDir = path.join(__dirname, '..', '..', 'data');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'jev-decision.json'),
      JSON.stringify({ at: new Date().toISOString(), brief, questions: QUESTIONS, response: parsed }, null, 2));
    console.log('');
    console.log('=== jev 的决策 ===');
    console.log(JSON.stringify(parsed, null, 2).slice(0, 5000));
    console.log('\n（已存 ' + path.join(outDir, 'jev-decision.json') + '）');
  } catch (e) {
    clearTimeout(timer);
    console.error('调用异常：' + e.message);
    process.exit(3);
  }
}
main();
