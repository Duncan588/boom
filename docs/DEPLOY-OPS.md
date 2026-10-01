# 部署 / 运维 / 事故手册

面向后续维护者。**这里记录的是「怎么做」和「踩过什么坑」**，算法原理见
[`ALGO-ENGINE.md`](./ALGO-ENGINE.md)。

阅读顺序建议：第一次上线前通读 ① 和 ③，出事故时直接跳 ④。

---

## ① 部署怎么做（可照抄的顺序）

### 0.1 主机连接（不在代码库里，每次都要重新找）

```
ssh -i ~/.ssh/dash_key -o StrictHostKeyChecking=no -o BatchMode=yes root@130.12.171.157
```

**五个必须知道的点，踩过就是 wasted 一小时：**

| 事项 | 说明 |
|---|---|
| **必须带 `-i`** | 主机上**没有 agent、也没有 ssh-agent**。裸 `ssh root@host` 会报 `Permission denied (publickey,password)`，看起来像「没权限」，其实只是缺 `-i` |
| **解释器不是 `node`** | 服务用的是 **`/usr/local/node22/bin/node`**（v22.14.0），而 shell 里的 `node` 是 **v18**。用错解释器跑测试，失败是噪声不是信号 |
| **数据库不在应用目录** | 在 `/root/data/baodian.db`。`db.js` 按 `__dirname` 上溯两级解析，而 `boom.service` 的 CWD 是 `/root` |
| **`.env` 在 `/root/.env`** | 从 `server/` 上溯两级，**不是** `/root/boom/.env`。且 `env.js` 只导出 `load()`，**不会自执行** —— 任何读 `.env` 的脚本必须显式 `require('./server/env').load()` |
| **主机掐断连续连接** | 连着 3 次左右 ssh/scp 会出现 `Connection closed`。批量操作要 `sleep`，或合成一条命令 |

其他主机事实：settings 表列名是 `key` / `value`（**不是** `k`/`v`）；主机没有
`sqlite3` CLI，读库用 `node:sqlite`（输出会带 `ExperimentalWarning`，记得过滤）。

### 0.2 部署八步

```bash
# ── 1. 本地先验：语法 + 离线套件 ────────────────────────────
cd E:/爆点/baodian
node --check server/*.js public/js/*.js
node test/odds-powerlaw.js
node test/odds-invariants.js
node test/frontend-assets.js
node test/check-frontend-js.js

# ⚠️ 涉及多个套件时【逐条单跑】，不要 `a && b && c` 串在一条命令里。
#    串起来容易触发 `stdin is not a tty`，那三个结果是假的。

# ── 2. 备份（先备份，再做任何写操作）───────────────────────
TS=$(date +%Y%m%d-%H%M%S)
ssh -i ~/.ssh/dash_key root@130.12.171.157 "\
  cp -r /root/boom/{public,server,scripts,test} /root/boom/.rollback-pre-deploy-$TS/ && \
  cp /root/data/baodian.db /root/data/baodian.db.bak-$TS && \
  cp /root/.env /root/.env.bak-$TS"

# ── 3. scp 只推改动的文件（不要 tar 整树）────────────────────
#    ⚠️ 推完必须做第 4 步的字节数核对，这一步不能省。
scp -i ~/.ssh/dash_key public/js/app.js root@130.12.171.157:/root/boom/public/js/
scp -i ~/.ssh/dash_key public/index.html   root@130.12.171.157:/root/boom/public/

# ── 4. 【关键】逐文件核对字节数：本地 vs 远程 ────────────────
wc -c public/js/app.js                                    # 本地
ssh -i ~/.ssh/dash_key root@130.12.171.157 "wc -c /root/boom/public/js/app.js"
# 两个数必须【完全相等】。不相等 = 推送被掐断了，重推。
# 「scp 命令没报错」不能作为推送成功的证据 —— 见 ②-1。

# ── 5. 在主机上用服务的解释器跑测试 ──────────────────────────
ssh -i ~/.ssh/dash_key root@130.12.171.157 \
  "cd /root/boom && /usr/local/node22/bin/node test/frontend-assets.js"

# ── 6. 数据库迁移（幂律必须 --apply --force 才切 odds_mode）──
#    ⚠️ 只有 --apply 才写入；不加 --force 只改 RTP/cap，不动 odds_mode。
#    ⚠️ 这一步是【生产库写操作】，必须客户点头才能执行。
ssh -i ~/.ssh/dash_key root@130.12.171.157 \
  "cd /root/boom && /usr/local/node22/bin/node scripts/migrate-powerlaw.js"
#    先只读确认现值与目标值 → 再 --apply --force

# ── 7. 重启（顺序：改库 → 重启 → 验证。反了不报错也不生效）──
ssh -i ~/.ssh/dash_key root@130.12.171.157 "systemctl restart boom.service"
sleep 3

# ── 8. 对照闸 + 公网验证 ────────────────────────────────────
#    对照闸：比较【代码常量】与【settings 表】，两者必须一致
ssh -i ~/.ssh/dash_key root@130.12.171.157 \
  "cd /root/boom && /usr/local/node22/bin/node scripts/test-green-is-not-live.js"
curl -s https://boom.monster6324.me/ | head -20
```

### 0.3 前端改动的额外一步

改了 `public/` 下的文件，**`public/index.html` 里四个静态资源必须全量 bump**：

```html
<link rel="stylesheet" href="/css/base.css?v=N">
<link rel="stylesheet" href="/css/game.css?v=N">
<script src="/js/chart.js?v=N"></script>
<script src="/js/app.js?v=N"></script>
```

**只 bump 一个会被 `test/frontend-assets.js` 的「版本号唯一」闸打回** —— 那个闸
要求四个资源版本号一致，否则部分资源会拿到旧缓存。Cloudflare 的
`max-age=14400` 会缓存数小时，所以版本号不 bump 客户看到的还是旧文件。

---

## ② 错误经历（本项目真实发生过的）

### 2.1 ⚠️ 线上全黑 —— scp 被掐断，线上成了「新版 HTML + 旧版 JS」的混合文件

**现象**：客户打开页面全黑，只有背景色。`#app` 容器停在 `hidden`。

**根因**：批量 scp 时连接被主机掐断（见 ①-1），**部分文件推成功、部分没推**。
线上于是变成 `index.html` 是新版、`app.js` 是旧版。而旧版 `app.js` 里有
`$('#betAmt').addEventListener(...)`，那个输入框在「弹幕移位」改版里已经被删除：

```js
// 元素不存在 → $ 返回 null → null.addEventListener() → TypeError
$('#betAmt').addEventListener('input', ...);
```

这个调用在**启动路径**上，抛错后整个 `app.js` 挂掉，后面的代码全部不执行，
`#app` 永远停在 `hidden` ⇒ **全黑**。

**正确做法**：
1. scp 之后**逐文件核对字节数**（本地 `wc -c` vs 远程 `wc -c`），必须完全相等
2. 「scp 命令没报错」**不能**作为推送成功的证据
3. 删除 DOM 元素时，必须同一次提交里清掉所有引用点 —— 包括 `onclick`、
   `addEventListener`、以及**别处的调用点**（那次还有两处函数在别处被调用）

> 这个事故的教训和它的成因不对称：**成因很普通**（scp 掐断），
> **后果很严重**（全黑 + 客户可见）。所以代价必须落在「核对」这一步，
> 而不能落在「判断推送是否成功」上。

### 2.2 「改了默认值」不等于「线上生效」，而且越绿越危险

**现象**：代码里的默认值改了、离线套件全绿，但线上跑的还是旧值。**且没有任何报错。**

**根因**：`seedSettings()` **只在键不存在时写入**。线上库的键早就存在了，
所以新的 `DEFAULT_SETTINGS` 永远补不进去。

**更糟的地方**：那些「出厂默认值」断言读的是**代码常量**，不是 settings 表。
它们全绿，恰恰给出了「已经搞定」的错觉 —— 绿灯在掩盖一个完全没生效的部署。

**正确做法**：唯一的验证是 `scripts/test-green-is-not-live.js`，它把两个来源
**并排读出来对照**：

```
代码常量 RTP_DEFAULT = 0.90
settings 表 powerlaw_rtp = 0.87      ← 不一致，这个才会真正决定玩家体验
```

**规则**：改动任何 `DEFAULT_SETTINGS` 之后，部署清单里必须有 `--apply`，
否则代码常量只是装饰。

### 2.3 配置先改还是先重启：顺序反了不报错

**现象**：配置改了、服务也重启了，但行为没变，**且没有任何错误日志**。

**根因**：进程启动时读一次配置就缓存住了。先重启再改库 ⇒ 进程永远读旧值。

**正确做法**：固定顺序 **改库 → 重启 → 验证**。

### 2.4 Coin 溢出事故

**现象**：线上 `bets.amount` 溢出到 `1e+41`，连带 `coin_logs.delta/balance`
788 条溢出、`pool_balance` 涨到 `2.67e+21`、用户总余额 `5.59e+32`。

**根因**：下注金额**没有上限校验**，幂乘放大了溢出。

**正确做法**：
1. **任何会进账本的数值都要有上限断言** —— 账本一旦被污染，修复成本远高于
   加一条校验
2. 写探针脚本时，**先写只读版本跑一遍、确认输出形状，再写写入版本**。
   这两条规则在下面的 ③ 里也重复出现，因为它们救过不止一次

### 2.5 回滚保护救了一次

**现象**：`apply-prod-rules.js` 第一次跑失败（`coin_logs.created_at` 是
NOT NULL 而脚本没给值）。

**结果**：脚本里的 `BEGIN/COMMIT/ROLLBACK` 让**线上库没有半途改坏**。

**正确做法**：批量改库**必须包事务**，且**先在只读副本上演练**。
没有事务的话，一次失败就留下一个「改了一半」的库。

### 2.6 本地库路径拼错一层

**现象**：误报「本地库不存在」，进而得出「本地库不能测试」的错误结论。

**根因**：真实路径是 `E:\爆点\data\baodian.db`（在**仓库外面**、上一级），
按 `E:/爆点/baodian/data/` 去找当然找不到。

**正确做法**：跑任何依赖数据库的脚本前，先确认路径：

```bash
ls -la E:/爆点/data/
node -e "const {DatabaseSync}=require('node:sqlite');
         const db=new DatabaseSync('E:/爆点/data/baodian.db');
         console.log(db.prepare('SELECT COUNT(*) c FROM rounds').get());"
```

### 2.7 静态断言扫到了注释里的「反面教材」

**现象**：一条「某属性不该存在」的断言永远红，因为**注释里解释为什么删掉它**
的那句话包含了这个属性的名字。

**正确做法**：静态测试**必须先剥掉注释再断言**：

```js
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
t('不再有 width transition', !/transition[^;]*width/.test(code));
```

**推论**：解释「为什么不能这样写」的注释，和代码一样重要 —— 但**不能被测试
当成代码扫**。这两件事必须分开处理。

### 2.8 测量方法本身出错，导致结论也错（同一个陷阱踩了两次）

**现象**：为验证「前端插值的增长率假设对不对」，我用「目标倍率 × 1.06 反解出
时刻，再读该时刻的倍率」来测增长率。测出来恰好是 6.00%。

**根因**：**循环论证** —— 把 6% 当输入喂进去，再读出来，必然得到 6%。
不管真实值是多少，这个方法都会「证实」那个假设。

**正确做法**：让**自变量真实推进**，再读结果：

```js
// ❌ 循环论证：假设 6%，用它反解 t，再读 rateAt(t)
const t2 = invert(target * 1.06);
const rate2 = rateAt(t2);

// ✅ 正确：让 elapsed 真的推进 100ms，读两次
const rate1 = rateAt(elapsedMs);
const rate2 = rateAt(elapsedMs + 100);
const growth = rate2 / rate1 - 1;   // 实测随倍率递减，1.62% → 0.36%
```

**判据**：如果一个「验证假设」的测量，**无论假设真假都会得到同样的结果**，
那它就不是测量。发现方法是：**问自己「如果我假设错了，这个测法会报错吗」**。

**同一个陷阱**在评审中被另一方独立踩到，两人给出的是同一个错误数字 ——
这说明它足够隐蔽，值得在评审时主动追问「你的测量方法怎么排除自证」。

### 2.9 阈值必须跟着分布参数重新推导

**现象**：把默认 RTP 从 1.00 改到 0.87 之后，一条断言稳定变红：
「20 个 50 局段正负交替」，实测 `1 正 / 19 负`。

**根因**：那条断言的阈值 `pos >= 3 && pos <= 17` 是**按 RTP=1.00 算出来的**
（那时期望 7.6 段为正）。0.87 下期望只剩 1.25 段为正，所以「1 正」是
**完全正常的结果**，旧阈值必然红。

**正确做法**：阈值从分布参数**现场推导**，不要写死：

```js
const mean = blk * (p * win + (1 - p) * loss);
const sd   = Math.sqrt(blk * p * (1 - p) * Math.pow(win - loss, 2));  // 两点分布方差
const q    = 1 - normCdf((0 - mean) / sd);        // P(段 > 0)
const exp  = nBlocks * q;
const sdN  = Math.sqrt(nBlocks * q * (1 - q));
ok(pos >= exp - 3 * sdN && pos <= exp + 3 * sdN, ...);
```

**推论**：改任何一个影响分布的参数，都要回头看**所有**以该参数推导出来的阈值。
闸的失效往往不是「代码错了」，而是「参数变了、阈值没跟着变」。

> 顺带记一个同源错误：上面的 `normCdf` 第一版写成「0.5 + 从 −8 到 z 的积分」，
> 重复计了那半个 0.5，导致 `cdf(0)` 返回 1.000000、概率算成负数、σ 变 NaN，
> 而断言表现为「阈值带塌成 [0,0]」。**数学库里的一步算错，在外面看是「阈值不合理」。**

---

## ③ 后续如何避免（可执行规则）

### 3.1 部署前检查清单（八条，逐条打勾）

- [ ] `node --check` 全部改动文件
- [ ] 五个闸全绿（见 3.3），**逐条单跑**而不是串成一条命令
- [ ] 备份完成：`/root/boom/{public,server,scripts,test}` + `baodian.db` + `.env`
- [ ] scp 只推改动文件
- [ ] **逐文件核对字节数**：本地 `wc -c` == 远程 `wc -c`
- [ ] **在主机上**用 `/usr/local/node22/bin/node` 跑一次测试（不是 `node`）
- [ ] 数据库迁移已获得客户批准，且 `--apply --force`（幂律切 mode 需要）
- [ ] 重启后跑 `test-green-is-not-live.js`，代码常量 == settings 表

### 3.2 数据库改动的铁律

1. **先只读演练** —— 用同一个脚本的 dry-run 分支跑一遍，看清「现值 / 目标值 /
   待更新项数」再动手
2. **再包事务写入** —— `BEGIN/COMMIT/ROLLBACK` 三件套，失败即回滚
3. **写完立即只读复核** —— 用 dry-run 分支再跑一次，确认「全部已一致」
4. **账本表（`coin_logs`）不删不改，只改余额** —— 账本是审计凭据
5. **生产库写入与发版都必须客户点头**，没有例外

**幂等的迁移脚本是前提**：重复执行结果一致，已存在的值可显式覆盖，
所以「多跑一次」不会造成二次损害 —— 这是敢在生产上跑它的前提。

### 3.3 上线前必须跑的五道闸

```
node test/odds-powerlaw.js        算法不变量（毛赔付恒定、净期望与 m 无关、瞬爆口径）
node test/odds-invariants.js      全网格扫描 + 阈值可达性
node test/frontend-assets.js      ?v= 唯一性 + 静态 id 存在性 + 倒计时断言
node test/check-frontend-js.js    前端语法
node scripts/test-green-is-not-live.js   代码常量 vs settings 表
```

**最后一道是唯一能发现「代码对了但线上没生效」的闸**，不能省。

### 3.4 前端规则

- 改了 `public/` 就 **全量 bump 四个资源的 `?v=N`**
- **删除 DOM 元素时，同一次提交里清掉所有引用点**（`onclick` / `addEventListener` /
  其它函数里的调用点），grep 确认零残留
- 移动 DOM 节点**不改 id** —— 改了就是静默失效，不报错
- 移动端优先：触摸目标 ≥44px、`touchmove` 要 `preventDefault()`
- 窄屏可见性用**真实坐标断言**取证，不接受「应该没问题」

### 3.5 静态测试的两条纪律

1. **断言前先剥注释** —— 否则解释「为什么不能这样写」的注释会被当成代码扫（见 2.7）
2. **测试要加载真实实现，不要把实现抄进测试文件** —— 抄的副本会与源码悄悄漂移，
   测的是一个不存在的东西。正确做法是读磁盘上真实的源文件 + 注入桩

### 3.6 概率性参数的闸

- 随机算法**断言性质，不断言具体值**（具体值会让套件随机变红，然后训练你
  放宽容差直到容差失去意义）
- **容差要从样本量推导**，不能拍脑袋。N=50 万时 0.02 的容差相当于 41σ ——
  那不是容差，是「什么都抓不到」
- 改分布参数后，回头检查所有**由该参数推导的阈值**（见 2.9）

---

## ④ 事故排查手册

### 4.1 页面全黑 / 白屏

**先做两件事，不要瞎猜：**

1. 查 `#app` 是否带 `hidden` —— 页面全黑最常见的原因是「脚本在启动路径抛错，
   根本没跑到移除 `hidden` 那一步」
2. **抓真实报错**，别看代码猜：

```js
// 注入收集器，必须在导航【之前】注入，否则导航会把它清掉
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__caught = [];
  window.addEventListener('error', e => window.__caught.push(String(e.message)));
`});
await send('Page.navigate', { url: 'http://127.0.0.1:8080/' });
// 导航后读 window.__caught
```

**黑屏最常见的根因**：删了 DOM 元素但没删引用 → 启动路径上
`$(...)` 返回 null → 对 null 调方法 → TypeError → 整个脚本挂掉。
`test/frontend-assets.js` 的「boot 路径 id 存在性」断言就是防这个的，
**但它只覆盖静态 HTML 里就有的节点**（弹窗那些是 JS 动态生成的，不在范围内）。

### 4.2 「没看到任何区别」

**先查浏览器缓存，别先改代码。** 静态文件每次请求都重读，所以一条 curl
就能把「服务端是旧的」和「标签页是旧的」分开：

```bash
# 服务端现在发的是哪个版本
curl -s 'https://boom.monster6324.me/' | grep -oE '\?v=[0-9]+'
grep -oE '\?v=[0-9]+' public/index.html        # 磁盘上是哪个版本

# 服务端发的新版本，内容是不是新的（两个端要分开看）
curl -s 'https://boom.monster6324.me/js/app.js?v=<磁盘上的版本>' | grep -c '<新符号名>'
```

**`200` 只证明 CDN 上「有东西」，不证明「有你的字节」。**
两端独立失效，要分别读。

排查顺序：**浏览器缓存 → 遗留进程 → 配置残留 → 代码**。
每一层都有独立的确认命令，跳过任何一层都可能白改一轮。

### 4.3 读日志

```bash
tail -40 /root/boom/boom.log          # 不是 journalctl
```

`journalctl -u boom.service` 只有 systemd 的启停行，没有应用日志。
`boom.log` 里有 `[auth]` / `[daily]` 标记和未捕获异常的堆栈。

**要按你要找的东西过滤，不要 `tail` 就完事**：

```bash
grep -vE '^\[daily\]' boom.log          # 去掉刷屏的定时任务行
grep -iE 'auth|token|cookie' boom.log  # 只看登录相关
```

一个定时器每 60 秒写同一行时，它会占满 `tail` 窗口、把真正的事件挤出去。

### 4.4 未提交改动的作者无法从 git 反查

**git 只记录提交者，不记录「谁改了工作区文件」。** 所以未提交的改动是
「无主」的 —— 看到可疑改动**先问人**，不要根据内容猜作者。

同理：核磁盘状态时**优先用内容而不是行号**（`grep -n 'id="xxx"'` 或
`git show <commit> --stat`）。多人协作时行号会随别人的提交漂移，
「某行是某个内容」这种记忆很容易过期。

### 4.6 多人同时改同一仓库时，「核磁盘」容易核到过期状态

**现象**：一项改动实际早已完成、客户端也已验收，但连续多轮协作里，
所有人都报告「它还没做」—— 因为每个人核的是**自己记忆里的行号**，
而那份行号早已被别人的提交顶走。

**根因**：多人同时改同一个仓库时，**行号是漂移的**。同一段 HTML，
在别人插入一段注释之后，后面所有元素的行号都会变。
「某行是某个内容」这种记忆，跨几轮提交就失效了。

**正确做法**：**用内容核，不用行号核。**

```bash
# ❌ 会漂：记的是行号
sed -n '121p' public/index.html

# ✅ 不漂：记的是内容和它的上下文
grep -n 'id="chatForm"' public/index.html
git show <commit> --stat        # 这次提交到底动了哪些文件
git status --short              # 工作区此刻的干净程度
```

**配套的三条习惯：**

1. **报告里附命令输出，不附行号**。让别人能一条命令复现你的结论，
   而不是让他去比对两个会漂的数字。
2. **开工前先 `git status`**。工作区不干净就问清是谁的改动，再决定要不要
   stash / checkout —— 不要带着别人的未提交改动往下做。
3. **patch 之前重新读一遍目标文件**。工具报「文件已被另一个 agent 修改过」
   就是一个明确的信号，此时应该重新读、合并，而不是照着旧内容覆盖。

**推论**：在一个多人共享的工作区里，「我看到的」和「实际的」之间可能有几轮
的时间差。所以**每一条「已经做完了」的结论，都要在报告的那一刻重新核一次**，
而不是引用几轮前的记忆 —— 引用记忆会让人按错误的状态做决策，而且看起来
非常可信。

### 4.7 生产动作必须单独报备

**现象**：一个人在没有任何人知情的情况下推了生产，其它协作方一直以为
「线上没被动过」，于是基于「线上还是旧版本」做判断。

**根因**：「上线三步（迁移 → 重启 → 验证）获得授权」被理解成了
**任何人都可以自己执行**。但授权的范围是「这件事要做」，不是
「任何人任何时刻都能自己动手」。

**正确做法**：
- 任何生产写操作（scp / 改库 / 重启服务）执行前**单独报一次**，让所有
  协作方知道线上被动了
- 「客户已授权上线」不等于「可以静默上线」—— 授权的是**决策**，不是
  **执行时机的自主权**
- 这和「改了默认值不等于线上生效」（见 2.2）是同一类问题的两面：
  **一个管「改没改」，一个管「谁改的、什么时候改的」**

