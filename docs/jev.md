# Jev 做庄（赔率模式 7）

TypeSafe System One（模型 `jev-latest` / `jev-1.13`）在起飞时刻替管理员选一个
倍率段。**爆点仍然只有一个、全场共享同一条 `rateAt()` 曲线** —— 与前六个模式
完全一致，不做任何按人差异化的赔付。Jev 只决定「这一局落在哪一段」，段内具体
倍率由代码 `Math.random()` 取。

代码：[`server/jev.js`](server/jev.js)、[`server/jev-bands.js`](server/jev-bands.js)、
[`server/jev-personas.js`](server/jev-personas.js)、[`test/jev.js`](test/jev.js)、
模拟器 [`scripts/sim-jev.mjs`](scripts/sim-jev.mjs)。

---

## 1. 为什么 Jev 只选段，不算数

Jev **不做算术**（官方文档 § Math and Numbers）。「这一段大概让几成人赢」是算术，
所以：

| 谁做 | 什么 |
| --- | --- |
| **代码**（`buildBands`） | 按在场玩家阈值的分位数切出五段，保证「低段 = 大约赢一半人」对任何房间都成立 |
| **Jev** | 在这五段里按房间状态给一个**概率分布** |
| **代码** | 按分布采样 → 得到段 → 段内随机取值 → 得到最终 `rate` |

因此后台那张百分比表（`odds_table_json`）在 mode 7 下**不参与选段**，只作为
降级基线和后台预览对照。

```
instant  1.00 – p05     全灭
low      p05   – p50    赢约一半
mid      p50   – p80    赢约两成
high     p80   – 高段顶 专喂赌高倍型
top      高段顶 – natural 名场面
```

---

## 2. 人格（只有两种）

`iron`（铁公鸡）已删除：与「不干扰用户体验」的产品原则冲突。

| key | 目标 | criteria 关键句 |
| --- | --- | --- |
| `standard` | 有输有赢 | `low: 阈值最低的一半人能逃跑` / `mid: 阈值较高的那两三成人能逃跑` |
| `bodhisattva` | 多数人带钱走 | `mid: 阈值中段以上的人都能赢，大多数人能带着钱走，倍率也够看` |

活动段**无论当前人格为何，强制切到 `bodhisattva`**。

### ⚠️ criteria 必须一句一义

`jev-1.13` 是**字面阅读**的（官方文档 § Literal reading）。早先 `high` 写成：

> 「高段。只够喂饱赌高倍型，其余人都亏。偶尔制造名场面，不要连续用」

模型照字面执行 —— 标准人格平均赢面被压到 **33%**，赌高倍型胜率 **0%**。
删掉语气词、每项只陈述「谁在这个段能逃跑」之后，赢面回到 **49%**。

> **结论：state 压缩省的是钱，criteria 改写改的是行为。**
> 改 criteria 前先想清楚模型会怎么字面执行。

---

## 3. 成本：实测数据与四层优化

`POST https://api.typesafe.ai/v1/systemone` 按 **input token 计费**
（官方 `models.md`：$42 / Btok，**output 免费**）。三次独立实测：

| 版本 | input/次 |
| --- | --- |
| 逐人明细 + 5 段静态映射 + 2 个问题 | **1,919** |
| 聚合 state + 精简 criteria + 1 个问题 | **714** |
| 再加分布复用（摊到每局） | **~180** |

### API 没有缓存，也没有会话

已用四路证据核实（文档索引全文关键词 0 命中、`api.md` 请求体、`models.md`
计价、Exa 搜到的第三方封装）：

- 请求体只有 `state` / `model` / `questions`。
  **没有** `session_id`、`conversation_id`、`previous_response_id`。
- 没有服务端 prompt caching；`usage` 里只有 `input_tokens` / `output_tokens`，
  不存在 OpenAI 那种 `input_tokens_details.cached_tokens`。
- 官方唯一提到的成本杠杆是 `parallel_questions`：同一 state 问 N 个问题
  合并成一次调用，比分开问便宜 **12.2x**。但本项目只问一个问题，吃不到这个红利。

> **「让 Jev 记住上一局」在 API 层做不到。** 等效效果靠项目内持久化。

### 官方杠杆：合并问题

| 做法 | state 付费次数 |
| --- | --- |
| N 次调用、同一 state | **N** |
| 1 次调用、N 个问题 | **1** |

`models.md` 的机制说明是「Jev ingests the `state` once and evaluates every
question against it in parallel」。

### 分布复用（等价于「会话」的核心）

Jev 一次返回的是**完整概率分布**，而段内本来就是 `Math.random()` 取值。
所以每局调用拿到的也只是「从同一个分布里采一个样」——
**把分布复用 N 局 = 同一个分布采样 N 次，不损失任何随机性**。

实现见 `pickBand()`：缓存未预热 → 降级出本局倍率，异步 `prefetch()` 拉下一次
的分布。复用后每局成本摊薄到约 **180 tok**，线上约 **$1.1/小时**（对比优化前
$14.5/小时）。

---

## 4. 三条硬约束

### ① 没人下注 → 不调用 API

空房间每局也会走 `decideRate`。`pickBand()` 和 `prefetch()` 都在入口判
`seated.length === 0` 直接短路 —— 否则一个没人玩的服会持续烧钱。
测试用例：`pickBand 空房间不调用`、`prefetch 空房间不调用`。

### ② 起飞绝不 await

起飞那一刻玩家正盯着火箭等结果，任何网络等待都是可见的卡顿。
`prefetch` 是 fire-and-forget，内部 `AbortController` + `try/catch` 且**永不
reject** —— 一个 unhandled rejection 能杀掉引擎进程。

### ③ 熔断降级

超时 / HTTP 错误 / 未配 key / 采样率未命中 → 走 `fallbackBand()`（纯代码
加权），**游戏照跑**。降级分布里人格必须参与，否则 `standard` 和
`bodhisattva` 在 Jev 不可用时表现几乎一样（实测赢面 61.8% / 59.6%，方向完全反了）。

---

## 5. 活动段

后台一键开启：生效局数 + 最高倍率 + 秒爆百分比，强制切菩萨人格。

| 参数 | setting | 由谁执行 |
| --- | --- | --- |
| 生效局数 | `jev_act_rounds` | 代码 |
| 最高倍率 | `jev_act_max` | **代码**（`buildBands` 压缩顶部区间） |
| 秒爆百分比 | `jev_act_instant` | **代码**（确定性配额） |
| 人格 | — | 代码强制 `bodhisattva` |

### 秒爆配额不能交给 Jev

Jev 只返回段权重，**它不数局**。早先版本只把 `instantPct` 写进 `state` 的
`note` 里让 Jev「注意」，实测配 30% 实际只有 **2-4%**。

现在改成**确定性配额调度器**（`planActivity` / `mustInstant`）：活动段一共
N 局，按 `instantPct` 算出恰好多少局必须瞬爆，用「每几局一次」均匀铺开。
配 20% / 100 局 = 20 局强制；Jev 自己额外选 instant 会让实际略高于配额
（实测 24），这是预期行为。

### 活动段局数一个局扣一次

`activity()` 是**纯查询**，不扣减。扣减只在 `engine` 起飞那一处
（`consumeActivity()`）。早先在 `activity()` 里扣，导致 `pickBand` 和
`prefetch` 各扣一次 → 一局扣两次 → 「设 2 局活动」只生效 1 局。

### 上限不能简单截断

```js
// ❌ 错：房间里赌高倍型阈值 20x 时 p80≈17x，actMax=25 只比 p80 高 1.25 倍，
//       top = min(natural, 25) 会把 high 和 top 压成同一段，
//       实测 mid/high/top 占比全 0%、全场只能赢 14%
top = Math.min(natural, actMax);

// ✅ 对：按比例缩进顶部区间，保住每段的相对宽度
top = p80 + (natural - p80) * Math.max(0.05, (actMax - p80) / (natural - p80));
```

---

## 6. 启用条件（三条缺一不可）

```js
const mode7 = String(cfg.odds_mode) === '7'
  && String(cfg.jev_enabled ?? '0') === '1'
  && !!(cfg.jev_api_key || process.env.TYPESAFE_API_KEY);
```

**默认 `jev_enabled = '0'`**，所以即使 `odds_mode` 误设成 7，engine 也不会
启用 Jev，整局退回表驱动 —— 与改动前行为一致。

API key 读取顺序：settings `jev_api_key` → 环境变量 `TYPESAFE_API_KEY`。
服务器上装在 **`/root/.env`**（不是 `/root/boom/.env`）—— `server/env.js` 的
路径是 `path.join(__dirname, '..', '..', '.env')`，从 `server/` 上两级就是
`/root/.env`。

---

## 7. 后台接口

全部走 `requireAdmin`；API key **只回传「是否已配置」，绝不回传明文**
（端点会进浏览器 devtools 历史）。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/admin/api/jev` | 配置 + 人格字典 + 运行时状态（含 token/费用） |
| `POST` | `/admin/api/jev` | 保存配置，**返回保存后的真实分布** |
| `POST` | `/admin/api/jev/activity` | 一键开启/结束活动段 |
| `GET` | `/admin/api/jev/preview` | 纯代码分布预览 |

### 预览绝不烧钱

`jev.preview()` 只跑 `fallbackBand()`，**不调用 Jev**。管理员点一次预览就烧
一次钱是不能接受的默认行为 —— 有测试用例守着这条。

### 保存后回显真实分布

项目铁律：静默生效的缺陷正是用户报「配了没生效」的根因。保存响应里带
`preview.bands[].pct` 和 `avgWinShare`，前端渲染成表格，不只弹「已保存」。

---

## 8. 前端面板

`admin/index.html` 的「爆点赔率控制」区，模式下拉新增 `value="7"`。
面板在 `w6Preview()` 里统一显隐 —— **必须同时显隐 `w7Panel` 和 `w7Body`**，
只改一个会出现「标题在但输入框没了」。

⚠️ 加了 inline JS 绑定后，`test/admin-w6-ui.js` 的 mock DOM 必须补齐所有
`j_*` 元素，否则 `Cannot set properties of null` 会让整个测试挂掉。

---

## 9. 日志

```js
if (dec.jev) {   // ⚠️ 不能写 if (mode7)
  console.log(`[jev] 第 ${roundId} 局 爆点 ${rate}x  段=${dec.jev.band}  来源=${dec.jev.source}  conf=${dec.jev.confidence ?? '-'}`);
}
```

早先用 `if (mode7)`，于是线上出现
`[jev] 第 5426 局 段=undefined 来源=undefined` —— mode7 为真但本局没有真人
下注，`decideRate` 走 `7-fallback` 早退分支，返回值里根本没有 `jev` 字段。
这种日志会让人误以为 Jev 在工作。

`来源` 字段读法：`jev` = 真实调用 / `cache` = 复用上次分布 /
`fallback` = Jev 不可用走本地算法。

---

## 10. 测试

```bash
node test/jev.js
```

30 条，纯离线（`fetch` 被 mock），零 API 成本。覆盖：空房间不调用、降级、
熔断、分布复用、缓存 key 隔离、活动段上限/秒爆/人格、分段单调性、
mode 7 回归、token 统计、预览不烧钱。

**断言秒爆用「≥ 配额」而不是「= 配额」** —— Jev 自己的 instant 权重会额外
贡献（实测配 20% 得 24 局）。断言等于配额等于把「Jev 不能自己选瞬爆」
当成了需求。

其余回归：`odds` / `odds-table` / `odds-weighted` / `odds-field-audit` /
`odds-validate` / `check-frontend-js` / `admin-w6-ui` / `daily-event-tz`。

生产用 **`/usr/local/node22/bin/node`**（`package.json` 要求 `>=22.5.0`；
服务器 `node -v` 默认的 v18 不是服务实际用的）。

---

## 11. 模拟器

```bash
node scripts/sim-jev.mjs --rounds=1000 --mode=jev --persona=standard \
  --detail=20 --out=out.json --out-md=detail.md
```

- `--mode=code` 纯代码零成本，`--mode=jev` 真实调用
- `--jev-every=N` 分布复用窗口（默认 4）
- `--act-rounds/--act-max/--act-instant` 活动段
- `--detail=N --out-md=path` 导出逐局逐玩家 Markdown 表格
- `--out=path` 导出 JSON

⚠️ **一定要传 `--out-md`**：逐局数据只存在进程内存，不落盘就随退出丢失。
