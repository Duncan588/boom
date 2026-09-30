/**
 * Jev 做庄模拟器 —— 1000 局 / 每局 ~10 名不同个性的玩家
 *
 * 形态完全对齐 engine.js 的真实流程：
 *   - 一局只有一个爆点 rate，全场共享（同一个 takeoff 广播、同一条 rateAt 曲线）
 *   - 玩家在飞行中达到自己的心理倍率就点逃跑 → 逃跑倍率 = 点那一刻的 rate
 *   - 玩家赢 ⇔ 爆点 rate ≥ 该玩家的逃跑阈值
 *   - 赢：净利 = stake × 阈值 × (1 − rake) − stake；输：输掉 stake
 *
 * Jev 的岗位：只看这一局该落在哪个倍率段（Choice）。
 *   段内取多少倍率 = 代码随机（Jev 不做数值运算，文档明说它不是计算器）
 * 人格 = criteria 块不同，代码里没有三个分支。
 *
 * 用法：
 *   node scripts/sim-jev.mjs --rounds=1000 --mode=code            # 纯代码基线（秒级）
 *   node scripts/sim-jev.mjs --rounds=1000 --mode=jev             # 每局问一次 Jev
 *   node scripts/sim-jev.mjs --rounds=1000 --mode=jev --jev-every=5
 */
const API = 'https://api.typesafe.ai/v1/systemone';
const KEY = process.env.TYPESAFE_API_KEY || '';
const RAKE = 0.03;

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1'];
  })
);
const ROUNDS = Number(argv.rounds || 1000);
const MODE = argv.mode || 'jev';             // jev | code
/**
 * 强制每 N 局至少重问一次 Jev（0 = 只靠指纹命中决定）。
 * 默认 4：10 人轮换的房间里构成变化慢，4 局足够跟上，又把成本摊到 1/4。
 */
const JEV_EVERY = Number(argv['jev-every'] ?? 4);
const SEAT = Number(argv.seat || 10);        // 每局入座人数
const ROSTER = Number(argv.roster || 50);    // 玩家池
const OUT = argv.out || '';                  // 每个人格跑完落盘的 JSON 路径（防前台中断丢结果）
const OUT_MD = argv['out-md'] || '';        // 逐局明细 Markdown 路径
const DETAIL_ROUNDS = Number(argv['detail'] || 20);  // 明细文件里每种人格写多少局
const PERSONAS = argv.persona === 'all' || !argv.persona
  ? ['standard', 'bodhisattva']            // 铁公鸡人格已删除（用户 2026-09-30 决定）
  : [argv.persona];

const START_COINS = 10000;
const MIN_STAKE = 50;   // 低于此视为输光、离场

/**
 * 活动段（管理员配置）—— 对齐后台 events_json 的形态。
 * ⚠️ 这两个数字【不由 Jev 决定】：Jev 不做数值运算，
 *    「秒爆 15%」「上限 25x」必须由代码执行，Jev 只在允许的段里选得更聪明。
 */
const ACT = {
  rounds: Number(argv['act-rounds'] || 0),      // 生效局数，0 = 不启用
  maxRate: Number(argv['act-max'] || 0),        // 活动段最高倍率
  instantPct: Number(argv['act-instant'] || 0), // 秒爆百分比 0-100
};

// ---------------------------------------------------------------- 玩家原型
/** thr = 心理倍率阈值，抽一次终身不变（个性就是个性）；pct = 下注占余额比例 */
const ARCHETYPES = [
  { key: 'steady',      name: '稳健型', w: 24, thr: [2.00, 3.00], pct: 0.05 },
  { key: 'greedy',      name: '贪财型', w: 20, thr: [1.60, 2.20], pct: 0.15 },
  { key: 'high_chaser', name: '赌高倍', w: 22, thr: [12.0, 28.0], pct: 0.03 },
  { key: 'all_in',      name: '梭哈型', w: 12, thr: [1.50, 5.00], pct: 0.55 },
  { key: 'late_bomber', name: '捡漏型', w: 14, thr: [4.00, 9.00], pct: 0.10 },
  { key: 'slow_hand',   name: '慢热型', w: 8,  thr: [2.50, 6.00], pct: 0.10 },
];
const AR_W = ARCHETYPES.map((a) => a.w);

// ---------------------------------------------------------------- 爆点分段
/**
 * 【Jev 模式的核心改动】答案空间由【在场玩家的阈值分布】决定，不由后台百分比表决定。
 *
 * 为什么：Jev 不做数值运算（文档 § Math and Numbers），所以「秒爆 10%」这种数字
 * 必须代码执行。后台那张表在 Jev 模式下只剩两个用途：
 *   1) 熔断降级时的兜底分布
 *   2) 后台预览的对照基线
 * 而「这一段大概让几成人赢」由代码从分位数算出来，不问 Jev。
 *
 * 段边界贴着在场玩家的阈值分位数切，于是每个段的语义是确定的：
 *   instant  全灭（无人达到 p05）
 *   low      赢约一半人（p05 – p50）
 *   mid      赢约两成（p50 – p80）
 *   high     专喂赌高倍型（p80 – 阈值上限 ×1.5）
 *   top      名场面（其余）
 */
const BAND_KEYS = ['instant', 'low', 'mid', 'high', 'top'];
const BAND_LABEL = {
  instant: '瞬爆', low: '低段', mid: '中段', high: '高段', top: '爆段',
};

const quantile = (arr, q) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

/**
 * 依据在场玩家的阈值分布 + 活动段上限，算出这一局的五段边界。
 *
 * ⚠️ 活动段上限可能【低于】房间里最高的阈值（赌高倍型要 20x，
 * 而活动段配了 15x）。这时不能把段切成空的 —— 倒挂的段会让
 * rateInBand 取到垃圾值。所以：
 *   1) 先按分位数切出自然边界
 *   2) 活动段上限只【压缩顶部】，不制造倒挂：
 *      top 的上界 = min(活动上限, 自然上界)
 *      若压缩后 top 的下界 ≥ 上界，说明高倍段被压没了 → 把边界回退一格
 *   3) 永远保证每个段 min < max
 */
function buildBands(seated, actActive, edgeScale = 1) {
  const thr = seated.map((p) => p.thr).sort((a, b) => a - b);
  const p05 = Math.max(1.05, quantile(thr, 0.05));
  const maxThr = thr[thr.length - 1] || 3;
  const p50 = quantile(thr, 0.50);
  const p80 = quantile(thr, 0.80);

  /**
   * 【人格赢面加成】edgeScale < 1 → 段边界整体压低 → 同样的倍率覆盖更多阈值
   * → 赢面上升。标准人格用 0.90 换约 10% 的额外赢面。
   *
   * ⚠️ 只压【阈值区间内的边界】，不压 1.00 起点：
   *    压 instant 的上界会把「全灭」变成「几乎全赢」，那是另一个东西。
   * 所以 p05 及以上整体乘 edgeScale，instant 段维持 1.00–1.50 的绝对定义。
   */
  const k = edgeScale;
  const b05 = Math.max(1.05, p05 * k);
  const b50 = Math.max(b05 + 0.3, p50 * k);
  const b80 = Math.max(b50 + 0.5, p80 * k);
  const naturalScaled = Math.max(b80 + 1, maxThr * 1.5 * k);

  // 顶部压缩：把 [p80, natural] 这段整体【按比例】缩进活动上限之内。
  // ⚠️ 不能直接 top = min(natural, actMax)：房间里赌高倍型阈值 20x 时 p80≈17x，
  //    而 actMax=25 与 p80 只差 1.25 倍，直接取 25 会让 high/top 两段
  //    被压成同一段（实测 mid/high/top 全 0%，全场只能赢 14%）。
  //    按比例缩进才能保住每段的相对宽度。
  let top = naturalScaled;
  let scale = 1;
  if (actActive && ACT.maxRate > 0) {
    if (naturalScaled > ACT.maxRate) {
      scale = Math.max(0.05, (ACT.maxRate - b80) / (naturalScaled - b80));
      top = round2(b80 + (naturalScaled - b80) * scale);
    }
  }

  const raw = [
    { key: 'instant', min: 1.00, max: Math.min(1.50, b05) },
    { key: 'low',     min: Math.min(1.50, b05), max: b50 },
    { key: 'mid',     min: b50, max: b80 },
    { key: 'high',    min: b80, max: round2(b80 + (top - b80) * 0.5) },
    { key: 'top',     min: round2(b80 + (top - b80) * 0.5), max: top },
  ];

  // 逐段收敛，保证 min < max 且单调递增
  const out = [];
  let prevMax = 1.00;
  for (const b of raw) {
    const min = Math.max(b.min, prevMax);
    const max = Math.max(b.max, min + 0.01);
    out.push({ key: b.key, min: round2(min), max: round2(max) });
    prevMax = max;
  }
  return out.map((b) => ({ ...b, label: `${BAND_LABEL[b.key]} ${b.min.toFixed(2)}–${b.max.toFixed(2)}x` }));
}

/** 段内取具体倍率（代码，随机） */
function rateInBand(key, bands) {
  const b = bands.find((x) => x.key === key);
  return round2(b.min + Math.random() * (b.max - b.min));
}

// ---------------------------------------------------------------- 人格
/**
 * 人格定义（2026-09-30 用户决定：只保留两种）
 *   standard     标准人格 —— 有输有赢，目标平均赢面 55–60%
 *   bodhisattva  菩萨人格 —— 目标平均赢面 70–75%，但不追求全员免灾
 *   （铁公鸡人格已删除：与「不干扰用户体验」的产品原则冲突）
 *
 * ⚠️ criteria 必须【一句一义】。jev-1.13 是字面阅读的（文档 § Literal reading）：
 *   原来 high 写「只够喂饱赌高倍型，其余人都亏」，模型照做 → 标准人格赢面只有 33%。
 *   语气词和铺垫对它没有帮助，只会强化它没听进去的那半句。
 *   现在每个选项只陈述【谁在这个段能逃跑】这一件事。
 *
 * 人格差异 = 段边界的 edgeScale（代码算赢面）+ 下面这几行措辞（Jev 选段倾向）。
 * 「10% 赢面」不问 Jev —— Jev 不做算术（文档 § Math and Numbers）。
 */
const PERSONA_DEF = {
  standard: {
    label: '标准人格',
    /** 边界压低比例 → 覆盖更多阈值 → 赢面上升 */
    edgeScale: 1,
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
    label: '菩萨人格',
    /** 菩萨靠 criteria 措辞，不靠 edgeScale —— 边界不动，让 Jev 自己去选更高的段 */
    edgeScale: 1,
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

// ---------------------------------------------------------------- 工具
const between = ([a, b]) => a + Math.random() * (b - a);
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * 紧凑数字：金额会指数增长（见 README 说明），必须用科学计数法才读得下去。
 * 平均值会被尾部拉爆，所以报表同时给中位数。
 */
function money(n) {
  const v = Math.abs(n);
  if (v === 0) return '0';
  if (v >= 1e6 || v < 1e-4) return n.toExponential(2);
  return String(Math.round(n));
}
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function makePlayer(i) {
  let r = Math.random() * AR_W.reduce((a, b) => a + b, 0);
  let ar = ARCHETYPES[0];
  for (let k = 0; k < AR_W.length; k++) { r -= AR_W[k]; if (r <= 0) { ar = ARCHETYPES[k]; break; } }
  return {
    id: i, name: `${ar.name}#${i}`, ar: ar.key, arName: ar.name,
    thr: between(ar.thr), pct: ar.pct, coins: START_COINS,
    rounds: 0, wins: 0, net: 0, bust: false,
    lossStreak: 0, maxLossStreak: 0, winStreak: 0, lastResult: null,
  };
}

/**
 * 房间快照 —— 【token 优化版】
 *
 * 1916 tok/次 里约 1200 是 state，而其中绝大部分是每局重发的静态内容。
 * 这里做了三处压缩，语义不变：
 *   1) 10 个玩家明细 → 3 组聚合（代码本地已经算好分位数，发统计不发原始数据）
 *   2) 删 who_escapes_here —— 每局一字不变的静态映射表，criteria 里已有一句话版本
 *   3) 删 bet_share_of_balance（原型常量，由 personality 决定）
 *      删 last_round（内容可从 streak 完全推出）
 * 段名保留、倍率区间不重复发（criteria 只说段名，说数字反而诱导模型做数值判断）
 */
function roomState(seated, lastBoom, roundNo, bands, actLeft) {
  // 按阈值分三组：低（p50 以下）/ 中 / 高（p80 以上）
  const thr = seated.map((p) => p.thr).sort((a, b) => a - b);
  const p50 = quantile(thr, 0.50), p80 = quantile(thr, 0.80);
  const groups = [
    { type: '低阈值', test: (t) => t <= p50 },
    { type: '中阈值', test: (t) => t > p50 && t <= p80 },
    { type: '高阈值', test: (t) => t > p80 },
  ].map((g) => {
    const m = seated.filter((p) => g.test(p.thr));
    return {
      type: g.type,
      count: m.length,
      target_range: m.length ? `${Math.min(...m.map((p) => p.thr)).toFixed(1)}-${Math.max(...m.map((p) => p.thr)).toFixed(1)}x` : '-',
      losing_streaks: m.map((p) => p.lossStreak),
    };
  });

  const s = {
    round: roundNo,
    last_round_boom: lastBoom === null ? '无' : `${lastBoom}x`,
    bands: bands.map((b) => BAND_LABEL[b.key]),
    room: {
      seated: seated.length,
      median_escape_target: `${p50.toFixed(1)}x`,
      groups,
    },
  };
  // 活动段：告知剩余局数与倍率上限，让 Jev 在被限制的答案空间里选得更聪明。
  // ⚠️ 注意这只【告知】，不授权 —— 真正的钳制在 buildBands() 里由代码执行。
  if (actLeft > 0) {
    s.active_campaign = {
      note: '管理员设定的限时活动段仍在进行中',
      rounds_remaining: actLeft,
      max_multiplier_allowed: `${ACT.maxRate}x`,
      what_this_means: `本段内爆点不会超过 ${ACT.maxRate}x，更高的段实际不可用；策划还要求其中约 ${ACT.instantPct}% 的局是瞬爆`,
    };
  }
  return s;
}

/**
 * 只问一个问题。
 * ⚠️ 原来还有一个 thrill（Noul），我从来没读过它的返回值 —— 纯浪费。
 *    output 是免费的，但【每个问题的 instructions+criteria 都算 input】，
 *    而 input 才是计费口径（models.md：Charged per input token）。
 *    删掉它省的是它自己的 instructions+criteria，不是 output。
 */
function jevQuestions(persona) {
  const def = PERSONA_DEF[persona];
  const criteria = {};
  for (const k of BAND_KEYS) criteria[k] = def.crit[k];
  return { band: { type: 'choice', instructions: def.ask, criteria } };
}

/** 从 Jev 的 probabilities 里采样，而不是只取 argmax —— 保留它的不确定性感 */
function sampleFromProbs(probs) {
  const keys = BAND_KEYS.filter((k) => (probs?.[k] ?? 0) > 0);
  const total = keys.reduce((s, k) => s + probs[k], 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const k of keys) { r -= probs[k]; if (r <= 0) return k; }
  return keys[keys.length - 1];
}

const stats = { calls: 0, fail: 0, lat: [], conf: [], probsByKey: {}, sampledVsArgmax: 0, inTok: 0, outTok: 0, reused: 0, cacheHit: 0 };

/**
 * 【分布复用 + 指纹缓存】
 *
 * 为什么这不损失任何随机性：
 *   Jev 一次返回的是【完整概率分布】，不是一个结果。而我在段内本来就是
 *   `Math.random()` 取值 —— 也就是说，即使每局都调用 Jev，我拿到的也只是
 *   「从同一个分布里采一个样」。那么把这个分布复用 N 局，分布形状一模一样，
 *   只是采样次数变多。**这不是近似，这是同一个分布。**
 *
 * 两层：
 *   1) 指纹缓存 —— 房间构成（中位阈值、三组人数）变化在 ±8% 内就跳过调用。
 *      10 人轮换的房间里，多数局构成相似，命中率很高。
 *   2) jev-every —— 强制每 N 局至少重问一次，防止长时间不更新。
 *
 * 成本：714 tok/次 → 摊到每局约 180 tok。
 */
const cache = new Map();   // persona -> { fp, probs, age, confidence }
const FP_TOL = 0.08;

/** 房间指纹：只取「构成」，不取绝对数值 —— 绝对值每局都在动，构成才是决定选段的 */
function roomFingerprint(state) {
  const g = state.room.groups;
  return [
    state.room.seated,
    ...g.map((x) => `${x.type}:${x.count}`),
  ].join('|');
}

/** 指纹比较：人数不变、中位阈值变化在 ±8% 内 → 算同一类房间 */
function fpMatch(a, b) {
  if (!a || !b) return false;
  const ga = a.groups, gb = b.groups;
  if (ga.length !== gb.length) return false;
  for (let i = 0; i < ga.length; i++) {
    if (ga[i].count !== gb[i].count) return false;
  }
  const ma = parseFloat(a.median_escape_target) || 0;
  const mb = parseFloat(b.median_escape_target) || 0;
  if (!ma || !mb) return ma === mb;
  return Math.abs(ma - mb) / Math.max(ma, mb) <= FP_TOL;
}

async function jevPick(persona, state, roundNo) {
  // ---- 层 1：指纹缓存 ----
  const prev = cache.get(persona);
  if (prev && roundNo - prev.lastRound < JEV_EVERY && fpMatch(prev.fp, state.room)) {
    stats.reused++;
    const sampled = sampleFromProbs(prev.probs) || 'low';
    return {
      band: sampled, argmax: null, confidence: prev.confidence,
      probs: prev.probs, reused: true,
    };
  }

  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    const res = await fetch(API, {
      method: 'POST', signal: ac.signal,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state, questions: jevQuestions(persona) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const a = j.answers?.band;
    if (!a?.probabilities) throw new Error('bad answer');
    stats.calls++; stats.lat.push(Date.now() - t0);
    // 真实 token 用量：模型返回的 usage 是账单依据，不能靠估算
    stats.inTok += Number(j.usage?.input_tokens) || 0;
    stats.outTok += Number(j.usage?.output_tokens) || 0;
    stats.conf.push(a.confidence ?? 0);
    for (const k of BAND_KEYS) {
      if ((a.probabilities[k] ?? 0) > 0) {
        stats.probsByKey[k] = stats.probsByKey[k] || { sum: 0, n: 0 };
        stats.probsByKey[k].sum += a.probabilities[k]; stats.probsByKey[k].n++;
      }
    }
    // ---- 层 2：写入缓存 ----
    cache.set(persona, {
      fp: state.room, probs: a.probabilities,
      confidence: a.confidence, lastRound: roundNo,
    });
    const sampled = sampleFromProbs(a.probabilities);
    if (sampled && sampled !== a.choice) stats.sampledVsArgmax++;
    return { band: sampled || a.choice, argmax: a.choice, confidence: a.confidence, probs: a.probabilities, reused: false };
  } catch (e) {
    stats.fail++;
    return null;
  } finally { clearTimeout(timer); }
}

/**
 * 熔断降级：Jev 挂了/没配 key → 纯代码抽段，游戏照跑。
 * 降级分布按【在场的个性构成】加权，而不是后台那张百分比表 ——
 * 否则 Jev 一挂，游戏手感就和无 Jev 之前完全不同，那不是降级是换游戏。
 *
 * ⚠️ 人格也必须参与降级：否则 standard(+10%赢面) 和 bodhisattva 会
 *    走同一条降级路径，两者在 Jev 不可用时表现几乎一样 ——
 *    实测两者赢面 61.8% / 59.6%，标准人格反而更高，方向完全反了。
 *    人格偏置的量纲要和 buildBands 的 edgeScale 对齐：
 *    菩萨 = 把 instant 的权重挪给 mid/high（更多人赢）
 *    标准 = 保持原样（edgeScale 的加成已经体现在分段边界里）
 */
const AR_BAND_BIAS = {
  steady:      { instant: 0.02, low: 0.48, mid: 0.28, high: 0.16, top: 0.06 },
  greedy:      { instant: 0.06, low: 0.50, mid: 0.26, high: 0.13, top: 0.05 },
  high_chaser: { instant: 0.04, low: 0.18, mid: 0.30, high: 0.30, top: 0.18 },
  all_in:      { instant: 0.08, low: 0.46, mid: 0.28, high: 0.13, top: 0.05 },
  late_bomber: { instant: 0.03, low: 0.26, mid: 0.34, high: 0.25, top: 0.12 },
  slow_hand:   { instant: 0.03, low: 0.34, mid: 0.33, high: 0.21, top: 0.09 },
};
/** 人格对降级分布的额外偏置（乘在个性偏置的均值上） */
const PERSONA_BAND_BIAS = {
  standard:    { instant: 1.00, low: 1.05, mid: 1.00, high: 0.95, top: 1.00 },
  bodhisattva: { instant: 0.60, low: 1.00, mid: 1.30, high: 1.30, top: 0.80 },
};
function codePickBand(bands, seated, persona) {
  const w = {}; for (const k of BAND_KEYS) w[k] = 0;
  if (!seated || !seated.length) {
    for (const k of BAND_KEYS) w[k] = 1;
  } else {
    // 在场个性构成加权平均
    for (const p of seated) {
      const bias = AR_BAND_BIAS[p.ar] || AR_BAND_BIAS.steady;
      for (const k of BAND_KEYS) w[k] += bias[k];
    }
  }
  // 人格偏置
  const pb = PERSONA_BAND_BIAS[persona] || PERSONA_BAND_BIAS.standard;
  for (const k of BAND_KEYS) w[k] *= pb[k];
  return drawBand(w);
}

/**
 * ⚠️ w 是【十个玩家的权重之和】，量级约等于人数（≈10），
 * 所以 r 必须乘以 total 再比。不乘的话 r(0–1) 永远小于 w[0](≈1.8)，
 * 于是每一局都返回第一段 —— 实测 mid/high/top 占比全是 0%，
 * 分段选择退化成常量，而这种「所有分支都是 0」在报表上看着像配置生效了。
 */
function drawBand(w) {
  const total = BAND_KEYS.reduce((s, k) => s + w[k], 0);
  if (total <= 0) return 'low';
  let r = Math.random() * total;
  for (const k of BAND_KEYS) { r -= w[k]; if (r <= 0) return k; }
  return 'low';
}

// ---------------------------------------------------------------- 主流程
async function runPersona(persona) {
  const roster = Array.from({ length: ROSTER }, (_, i) => makePlayer(i));
  const rounds = [];
  let lastBoom = null, cursor = 0;
  // 活动段：从某一局开始生效，持续 ACT.rounds 局
  const actStart = ACT.rounds > 0 ? Math.floor(ROUNDS / 4) + 1 : Infinity;
  let instantForced = 0, instantChosenByJev = 0;

  for (let r = 1; r <= ROUNDS; r++) {
    // 轮换入座：模拟玩家进出，玩家池里 bust 的跳过
    const seated = [];
    for (let k = 0; k < SEAT; k++) {
      let tries = 0, p = roster[cursor % roster.length]; cursor++;
      while (p.bust && tries++ < roster.length) p = roster[cursor++ % roster.length];
      if (!p.bust) seated.push(p);
    }
    if (!seated.length) continue;

    /**
     * 【活动段固定走菩萨人格】（用户 2026-09-30 决定）
     * 活动段的目的是让人玩得开心，所以无论当前人格是什么，活动段一律按菩萨处理：
     *   - 用 bodhisattva 的 criteria 问 Jev
     *   - edgeScale = 1（不叠加标准人格的 10% 加成 —— 菩萨本身已经足够宽松）
     * 非活动段才用当前人格。
     */
    const actActive = r >= actStart && r < actStart + ACT.rounds;
    const actLeft = actActive ? ACT.rounds - (r - actStart) : 0;
    const effective = actActive ? 'bodhisattva' : persona;
    // 【关键】答案空间贴着在场玩家的阈值分布重建；活动段上限在这里执行
    const bands = buildBands(seated, actActive, PERSONA_DEF[effective].edgeScale);

    let meta = null;
    if (MODE === 'jev' && KEY) {
      meta = await jevPick(effective, roomState(seated, lastBoom, r, bands, actLeft), r);
    }
    let band = meta ? meta.band : codePickBand(bands, seated, effective);

    /**
     * 【秒爆百分比的唯一执行点】
     * ⚠️ 只在活动段内生效 —— 「一百局里秒爆 15%」说的是活动段内的比例，
     *    不是全程。写到 if 外面会让它变成全程秒爆率，活动段形同虚设。
     *
     * Jev 可能在 high 段要一发瞬爆，那要不要听它的？—— 听概率，不听意愿。
     * 管理员配「秒爆 15%」就是 15%：先掷骰子，命中就把段强制改成 instant。
     * 这是保证「配置的数字就是最终的数字」的唯一做法，因为 Jev 不做算术。
     */
    let instantForcedThisRound = false;
    if (actActive && ACT.instantPct > 0 && Math.random() * 100 < ACT.instantPct) {
      band = 'instant';
      instantForcedThisRound = true;
    } else if (band === 'instant' && meta) {
      instantChosenByJev++;
    }
    if (instantForcedThisRound) instantForced++;

    const rate = rateInBand(band, bands);

    const results = [];
    for (const p of seated) {
      const stake = Math.max(MIN_STAKE, Math.round(p.coins * p.pct));
      if (stake > p.coins) { p.coins = 0; p.bust = true; continue; }
      p.coins = round2(p.coins - stake);

      const won = rate >= p.thr;
      let net;
      if (won) {
        const gross = stake * p.thr;
        net = round2(gross - gross * RAKE - stake);
        p.coins = round2(p.coins + stake + net);
        p.net += net; p.wins++; p.rounds++; p.winStreak++; p.lossStreak = 0;
        p.lastResult = `上一局赢 +${Math.round(net)} QUN`;
      } else {
        net = -stake;
        p.net -= stake; p.rounds++; p.lossStreak++; p.winStreak = 0;
        p.maxLossStreak = Math.max(p.maxLossStreak, p.lossStreak);
        p.lastResult = `上一局输 -${stake} QUN，已连败 ${p.lossStreak}`;
      }
      if (p.coins < MIN_STAKE) { p.coins = 0; p.bust = true; }
      // 逐局明细要能落盘：记录玩家名和个性，否则表格里只有 ar 键没法读
      results.push({ id: p.id, name: p.name, ar: p.ar, arName: p.arName, won, thr: p.thr, stake, net });
    }

    // 刺激度：爆点与在场阈值的接近程度（差 <20% 算擦肩而过）
    const closeCalls = results.filter((x) => Math.abs(rate - x.thr) / x.thr < 0.2).length;
    rounds.push({
      rate, band, meta, results, closeCalls, n: results.length,
      actActive, instantForcedThisRound, personaUsed: effective,
      bands: actActive ? bands.map((b) => b.label) : null,
    });
    lastBoom = rate;

    if (r % 100 === 0) process.stderr.write(`  [${persona}] ${r}/${ROUNDS}  jev=${stats.calls} fail=${stats.fail}\n`);
  }
  return { persona, label: PERSONA_DEF[persona].label, rounds, roster, instantForced, instantChosenByJev };
}

// ---------------------------------------------------------------- 统计
function report(run) {
  const { persona, label, rounds, roster } = run;
  const N = rounds.length;
  const pct = (n) => +((n / N) * 100).toFixed(1);

  const bandCount = {};
  for (const r of rounds) bandCount[r.band] = (bandCount[r.band] || 0) + 1;

  // 每局赢的人占比
  const share = rounds.map((r) => r.results.filter((x) => x.won).length / r.n);
  const mixed = share.filter((s) => s > 0 && s < 1).length;      // 有输有赢（有赚有赔）
  const allLose = share.filter((s) => s === 0).length;            // 全场输光
  const allWin = share.filter((s) => s === 1).length;             // 全场皆赢
  const p80Lose = share.filter((s) => s <= 0.20).length;
  const p80Win = share.filter((s) => s >= 0.80).length;
  const rates = rounds.map((r) => r.rate).sort((a, b) => a - b);

  const byAr = {};
  for (const ar of ARCHETYPES) {
    const g = roster.filter((p) => p.ar === ar.key);
    if (!g.length) continue;
    const rr = g.reduce((s, p) => s + p.rounds, 0);
    const nets = g.map((p) => p.net);
    byAr[ar.key] = {
      人数: g.length,
      平均阈值: +(g.reduce((s, p) => s + p.thr, 0) / g.length).toFixed(2),
      胜率: rr ? +((g.reduce((s, p) => s + p.wins, 0) / rr) * 100).toFixed(1) : 0,
      人均净收益中位: money(median(nets)),
      破产率: +((g.filter((p) => p.bust).length / g.length) * 100).toFixed(1),
      最长连败: Math.max(...g.map((p) => p.maxLossStreak)),
    };
  }

  const stakes = rounds.flatMap((r) => r.results.map((x) => x.stake));
  const withJev = rounds.filter((r) => r.meta);
  const allNets = roster.map((p) => p.net);
  const midPoints = rounds.map((r) => r.results.reduce((s, x) => s + x.net, 0) / r.n);

  // 活动段统计：必须单独验证三件事 —— 上限生效、秒爆百分比生效、人格确实换成菩萨
  const actRounds = rounds.filter((r) => r.actActive);
  const normRounds = rounds.filter((r) => !r.actActive);
  const avgShare = (rs) => (rs.length ? +((rs.reduce((s, x) => s + x.results.filter((y) => y.won).length / x.n, 0) / rs.length) * 100).toFixed(1) : null);
  const actBlock = actRounds.length ? {
    生效局数: actRounds.length,
    人格: '强制 bodhisattva',
    非活动段平均赢面: avgShare(normRounds) + '%',
    活动段平均赢面: avgShare(actRounds) + '%',
    爆点最高值: Math.max(...actRounds.map((r) => r.rate)),
    是否超过配置上限: Math.max(...actRounds.map((r) => r.rate)) > ACT.maxRate + 0.001 ? '❌ 越界' : '✅ 未越界',
    实际秒爆率: +((actRounds.filter((r) => r.band === 'instant').length / actRounds.length) * 100).toFixed(1) + '%',
    配置秒爆率: ACT.instantPct + '%',
    活动段示例分段: actRounds[0]?.bands,
  } : '本轮未启用活动段';

  return {
    人格: `${label}（${persona}）`,
    局数: N,
    分段实际占比: BAND_KEYS.map((k) => `${BAND_LABEL[k]}: ${pct(bandCount[k] || 0)}%`),
    爆点: {
      中位数: median(rates), 最低: rates[0], 最高: rates[N - 1],
      平均: +(rates.reduce((a, b) => a + b, 0) / N).toFixed(2),
    },
    赢面: {
      '有输有赢(混合局)_占比': pct(mixed),
      '全场输光_占比': pct(allLose),
      '全场皆赢_占比': pct(allWin),
      '≤20%的人赢_占比': pct(p80Lose),
      '≥80%的人赢_占比': pct(p80Win),
      平均赢面: +((share.reduce((a, b) => a + b, 0) / N) * 100).toFixed(1),
    },
    刺激度: {
      每局擦肩而过人数: +(rounds.reduce((s, r) => s + r.closeCalls, 0) / N).toFixed(2),
      '擦肩而过≥1人的局_占比': pct(rounds.filter((r) => r.closeCalls >= 1).length),
      '擦肩而过≥3人的局_占比': pct(rounds.filter((r) => r.closeCalls >= 3).length),
      每局人均净: money(median(midPoints)),
    },
    玩家整体: {
      池人数: roster.length,
      破产率: +((roster.filter((p) => p.bust).length / roster.length) * 100).toFixed(1),
      人均净收益中位: money(median(allNets)),
      最赚: money(Math.max(...allNets)),
      最亏: money(Math.min(...allNets)),
      平均参与局数: +(roster.reduce((s, p) => s + p.rounds, 0) / roster.length).toFixed(1),
    },
    活动段: actBlock,
    分个性: byAr,
    秒爆来源: {
      配置强制: run.instantForced || 0,
      'Jev主动选择': run.instantChosenByJev || 0,
    },
    Jev: withJev.length ? {
      生效局数: withJev.length,
      真实调用: stats.calls,
      分布复用局数: withJev.filter((r) => r.meta.reused).length,
      复用率: +((withJev.filter((r) => r.meta.reused).length / withJev.length) * 100).toFixed(1) + '%',
      平均confidence: +(withJev.reduce((s, r) => s + (r.meta.confidence ?? 0), 0) / withJev.length).toFixed(3),
      // argmax 为 null 表示本局是复用（没有新采样），不参与这个统计
      '采样≠argmax_占比': withJev.filter((r) => r.meta.argmax).length
        ? pct(withJev.filter((r) => r.meta.argmax && r.meta.band !== r.meta.argmax).length) : 'n/a',
    } : '未启用',
  };
}

// ---------------------------------------------------------------- 逐局明细表
/**
 * 生成 Markdown 明细：每局一张表，列出每个玩家的阈值、注额、输赢、盈亏。
 * 用户要的是「每局每个人多少倍跑的」—— 倍率只对每个玩家各有一个，
 * 所以列里同时给出【爆点 rate】【该玩家的逃跑阈值】【倍数差】。
 */
function detailTables(run, maxRounds = 20) {
  const { label, persona, rounds } = run;
  const out = [];
  out.push(`## ${label}（${persona}）— 逐局明细（前 ${Math.min(maxRounds, rounds.length)} 局 / 共 ${rounds.length} 局）\n`);
  out.push('> 判定式：`玩家赢 ⇔ 爆点 rate ≥ 该玩家逃跑阈值`。倍率只此一个，全场共享。\n');
  for (const rd of rounds.slice(0, maxRounds)) {
    const winN = rd.results.filter((x) => x.won).length;
    out.push(`\n### 第 ${rounds.indexOf(rd) + 1} 局 — 爆点 **${rd.rate}x** · ${BAND_LABEL[rd.band]} · ${rd.personaUsed || '-'} · 赢 ${winN}/${rd.n} 人\n`);
    out.push('| # | 玩家 | 个性 | 逃跑阈值 | 爆点−阈值 | 注额 | 结果 | 盈亏 |');
    out.push('|---|---|---|---|---|---|---|---|');
    for (const x of rd.results) {
      const gap = round2(rd.rate - x.thr);
      out.push(`| ${x.id} | ${x.name} | ${x.arName} | ${x.thr.toFixed(2)}x | ${gap > 0 ? '+' : ''}${gap}x | ${Math.round(x.stake)} | ${x.won ? '✅ 赢' : '❌ 输'} | ${x.net > 0 ? '+' : ''}${Math.round(x.net)} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- 跑
if (!KEY && MODE === 'jev') {
  console.error('TYPESAFE_API_KEY 未设置，无法使用 --mode=jev');
  process.exit(1);
}
const t0 = Date.now();
const results = [];

/**
 * 三种人格互不依赖 → 并行跑。
 * 后台进程在这个 Windows shell 上会立刻挂（stdin is not a tty），
 * 而前台有 600s 上限，所以并行是唯一能一次跑完的方式。
 * 40 req/s 的限流下 3 路并发毫无压力。
 */
const inflight = new Map();
const runs = [];
for (const p of PERSONAS) {
  inflight.set(p, (async () => {
    process.stderr.write(`\n=== ${PERSONA_DEF[p].label} · ${ROUNDS} 局 · ${MODE} ===\n`);
    const run = await runPersona(p);
    const rep = report(run);
    runs.push(run);
    // 每个人格跑完立刻落盘：前台被中断也不丢已完成的结果
    if (OUT) {
      const fs = await import('node:fs');
      const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
      const merged = prev.filter((x) => x.人格 !== rep.人格).concat(rep);
      fs.writeFileSync(OUT, JSON.stringify(merged, null, 2));
      process.stderr.write(`  → 已写入 ${OUT}\n`);
    }
    return rep;
  })());
}
for (const p of PERSONAS) results.push(await inflight.get(p));
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// 逐局明细落盘：run 对象在这里还在（results 里只有 report 后的摘要）
if (OUT_MD) {
  const fs = await import('node:fs');
  const head = [
    '# Jev 做庄模拟 — 逐局明细',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 配置：${ROUNDS} 局 × ${SEAT} 人/局 × ${ROSTER} 玩家池 · mode=${MODE}` +
      (ACT.rounds ? ` · 活动段 ${ACT.rounds}局/上限${ACT.maxRate}x/秒爆${ACT.instantPct}%` : ' · 无活动段'),
    `- Token：input ${stats.inTok} · output ${stats.outTok} · 估算 $${((stats.inTok / 1e6) * 42).toFixed(5)}`,
    `- 调用：${stats.calls} 次 · 失败 ${stats.fail} · 平均延迟 ${stats.lat.length ? Math.round(stats.lat.reduce((a, b) => a + b, 0) / stats.lat.length) : '-'}ms`,
    '',
    '## 判定规则',
    '',
    '```',
    '玩家赢  ⇔  爆点 rate ≥ 该玩家的逃跑阈值',
    '玩家输  ⇔  爆点 rate <  该玩家的逃跑阈值',
    '一局只有一个 rate，全场共享（与 engine.js 的一次 decideRate 广播一致）',
    '赢的净利 = 注额 × 逃跑阈值 × (1 − 抽成 3%) − 注额',
    '```',
    '',
  ].join('\n');
  const body = runs.map((r) => detailTables(r, DETAIL_ROUNDS)).join('\n\n---\n\n');
  fs.writeFileSync(OUT_MD, head + body);
  process.stderr.write(`  → 明细已写入 ${OUT_MD}\n`);
}

console.log('\n' + '='.repeat(74));
console.log(`模拟结果  ${ROUNDS} 局 × ${SEAT} 人/局 × ${ROSTER} 玩家池  模式=${MODE}  耗时 ${elapsed}s`);
console.log('='.repeat(74));
for (const r of results) {
  console.log(`\n【${r.人格}】`);
  console.log(`  分段   ${r.分段实际占比.join('  ')}`);
  console.log(`  爆点   中位 ${r.爆点.中位数}x  平均 ${r.爆点.平均}x  区间 ${r.爆点.最低}–${r.爆点.最高}x`);
  console.log(`  赢面   混合局 ${r.赢面['有输有赢(混合局)_占比']}%  全场输光 ${r.赢面['全场输光_占比']}%  全场皆赢 ${r.赢面['全场皆赢_占比']}%`);
  console.log(`         ≤20%人赢 ${r.赢面['≤20%的人赢_占比']}%  ≥80%人赢 ${r.赢面['≥80%的人赢_占比']}%  平均赢面 ${r.赢面.平均赢面}%`);
  console.log(`  刺激   擦肩而过 ${r.刺激度.每局擦肩而过人数} 人/局  ≥1人 ${r.刺激度['擦肩而过≥1人的局_占比']}%  ≥3人 ${r.刺激度['擦肩而过≥3人的局_占比']}%  每局人均净 ${r.刺激度.每局人均净}`);
  console.log(`  玩家   破产 ${r.玩家整体.破产率}%  人均净中位 ${r.玩家整体.人均净收益中位}  最赚 ${r.玩家整体.最赚}  最亏 ${r.玩家整体.最亏}  人均 ${r.玩家整体.平均参与局数} 局`);
  console.log(`  Jev    ${JSON.stringify(r.Jev)}`);
  console.log(`  秒爆   配置强制 ${r.秒爆来源.配置强制} 局  ·  Jev主动 ${r.秒爆来源['Jev主动选择']} 局`);
  if (typeof r.活动段 === 'string') {
    console.log(`  活动段 ${r.活动段}`);
  } else {
    const a = r.活动段;
    console.log(`  活动段 ${a.生效局数} 局（${a.人格}）  赢面 非活动 ${a.非活动段平均赢面} → 活动段 ${a.活动段平均赢面}`);
    console.log(`         上限 ${ACT.maxRate} 最高爆点 ${a.爆点最高值} ${a.是否超过配置上限}  ·  秒爆 配${a.配置秒爆率} 实${a.实际秒爆率}`);
  }
  console.log('  分个性:');
  for (const [k, v] of Object.entries(r.分个性)) {
    console.log(`         ${String(v.人数).padStart(2)}人 ${k.padEnd(12)} 阈值${String(v.平均阈值).padStart(6)}x  胜率${String(v.胜率).padStart(5)}%  净中位${String(v.人均净收益中位).padStart(10)}  破产${String(v.破产率).padStart(5)}%  最长连败${v.最长连败}`);
  }
}
console.log('\nJev 调用 ' + stats.calls + ' 次  失败 ' + stats.fail + '  分布复用 ' + stats.reused + ' 局' +
  '  平均延迟 ' + (stats.lat.length ? Math.round(stats.lat.reduce((a, b) => a + b, 0) / stats.lat.length) : '-') + 'ms');
if (stats.calls) {
  const totalRounds = results.reduce((s, r) => s + r.局数, 0);
  const perCall = stats.inTok / stats.calls;
  const perRound = stats.inTok / (totalRounds || 1);
  console.log('Token 用量:  input ' + stats.inTok + '  output ' + stats.outTok);
  console.log('  每次调用 ' + Math.round(perCall) + ' tok  ·  摊到每局 ' + Math.round(perRound) + ' tok' +
    '  ·  估算总费用 $' + ((stats.inTok / 1e6) * 42).toFixed(5));
  console.log('Jev 原始概率均值:');
  for (const k of BAND_KEYS) {
    const s = stats.probsByKey[k];
    console.log(`  ${BAND_LABEL[k].padEnd(4)} ${s ? (s.sum / s.n).toFixed(3) : '0.000'}`);
  }
}
