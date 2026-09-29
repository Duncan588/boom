/**
 * 红包端到端测试：直接调用生产 redpacket.js + 模拟 Discord 交互。
 *
 * 覆盖用户要求的完整流程：
 *   /hongbao → 扣发送者余额 → 生成卡片 → 发布消息带领取按钮
 *            → 多人点击领取 → 每人收到「您已获得多少 QUN」
 *            → 余额 / 领取记录 / 流水三者一致
 *
 * 重点验证三件事：
 *   1. 发出的总额 == 全部领取额之和（不多不少，不造币也不吞币）
 *   2. 同一个人点两次只能领一次（UNIQUE 兜底）
 *   3. 余额守恒：QUN_total 不变
 */
/*
 * 红包金额与领取人全部是 mock 造的，不涉及真实 QUN。
 * ⚠️ 【本文件所有数据均为构造的测试数据，不是线上真实数据】
 *   赔率配置、倍率、mock 响应全部是写死的样例。
 *   测试不读系统当前时间、不连生产数据库、不发真实 Discord 请求。
 *   生产真实值请查 /root/data/baodian.db 的 settings 表（仅服务器可访问）。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const DB = path.join(os.tmpdir(), `rp-test-${Date.now()}.db`);
process.env.DB_FILE = DB;

const db = require('../server/db');
const rp = require('../server/redpacket');
const { buildRedpacketMessage, readCover } = require('../server/card-image');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

function totalCoins() {
  return db.get().prepare('SELECT COALESCE(SUM(coins),0) c FROM users').get().c;
}

(async () => {
  db.init(DB);
  db.seedSettings();

  // 造 6 个用户，每人 5000
  const ids = [];
  for (let i = 1; i <= 6; i++) {
    const r = db.upsertUser({ discordId: '100' + i, username: 'tester' + i, globalName: '测试员' + i });
    const id = r.user.id;               // upsertUser 返回 {user, created, granted}
    db.get().prepare('UPDATE users SET coins=5000 WHERE id=?').run(id);
    ids.push(id);
  }
  const [alice, bob, carol, dave, erin, frank] = ids;
  const setCoins = (id, n) => db.get().prepare('UPDATE users SET coins=? WHERE id=?').run(n, id);
  const getCoins = (id) => db.get().prepare('SELECT coins FROM users WHERE id=?').get(id).coins;

  console.log('\n=== 1. 余额守恒（发包时立即扣款）===');
  const before = totalCoins();
  const pkg = rp.create({ creatorId: alice, channelId: '999', amountTotal: 1000, slots: 5, mode: 'even' });
  ok(totalCoins() === before - 1000, `发包即扣款：总余额 ${before} → ${totalCoins()}（-1000）`);
  ok(getCoins(alice) === 4000, `发送者 5000 → ${getCoins(alice)}`);
  ok(db.get().prepare("SELECT 1 x FROM coin_logs WHERE user_id=? AND reason='redpacket_send'").get(alice),
    '写入 redpacket_send 流水');

  console.log('\n=== 2. 平均分：5 人领 1000，每人 200 ===');
  const claimed = [];
  for (const u of [bob, carol, dave, erin, frank]) claimed.push(rp.claim(pkg.id, u).amount);
  ok(claimed.every((a) => a === 200), `份额 = ${JSON.stringify(claimed)}`);
  const sum = claimed.reduce((a, b) => a + b, 0);
  ok(sum === 1000, `总额守恒：领走 ${sum} == 发出 1000`);

  console.log('\n=== 3. 重复领取被拒 ===');
  let dupErr = null;
  try { rp.claim(pkg.id, bob); } catch (e) { dupErr = e; }
  ok(dupErr && /已经领过/.test(dupErr.message), `第二次点按钮 → "${dupErr && dupErr.message}"`);
  ok(db.get().prepare('SELECT COUNT(*) c FROM redpacket_claims WHERE redpacket_id=?').get(pkg.id).c === 5,
    '领取记录仍为 5 条（重复未写入）');

  console.log('\n=== 4. 领完后不能再领 ===');
  const r2 = rp.create({ creatorId: alice, channelId: '999', amountTotal: 50, slots: 1, mode: 'even' });
  const got = rp.claim(r2.id, bob);
  ok(got.done === true, '单人红包领完 → status=done');
  let fullErr = null;
  try { rp.claim(r2.id, carol); } catch (e) { fullErr = e; }
  ok(fullErr && /领完/.test(fullErr.message), `其他人再领 → "${fullErr && fullErr.message}"`);

  console.log('\n=== 5. 余数处理（100 ÷ 3）===');
  const r3 = rp.create({ creatorId: alice, channelId: '999', amountTotal: 100, slots: 3, mode: 'even' });
  const a3 = [rp.claim(r3.id, bob).amount, rp.claim(r3.id, carol).amount, rp.claim(r3.id, dave).amount];
  ok(a3.reduce((x, y) => x + y, 0) === 100, `100/3 三人份额 ${JSON.stringify(a3)} 合计 ${a3.reduce((x, y) => x + y, 0)}`);

  console.log('\n=== 6. 随机分：2000 / 8 份，各不相同且守恒 ===');
  const r4 = rp.create({ creatorId: alice, channelId: '999', amountTotal: 2000, slots: 8, mode: 'random' });
  const a4 = [];
  // 用 8 个互不重复的用户：6 个已用 + 2 个新号，否则会撞「已领过」
  for (let i = 7; i <= 8; i++) {
    const r = db.upsertUser({ discordId: '100' + i, username: 'tester' + i, globalName: '测试员' + i });
    db.get().prepare('UPDATE users SET coins=1000 WHERE id=?').run(r.user.id);
    ids.push(r.user.id);
  }
  const claimers = [bob, carol, dave, erin, frank, alice, ids[6], ids[7]];
  for (const u of claimers) a4.push(rp.claim(r4.id, u).amount);
  {
    // JS 浮点求和会漂（2000 存成 1999.99999...），权威值是数据库里的 claimed_sum
    const dbSum = db.get().prepare('SELECT claimed_sum s FROM redpackets WHERE id=?').get(r4.id).s;
    const r4rec = rp.get(r4.id);
    ok(r4rec.status === 'done', `8 份全部领完 status=done`);
    ok(Math.abs(dbSum - 2000) < 0.005, `数据库 claimed_sum=${dbSum}（精确守恒 2000）`);
  }
  ok(a4.every((v) => v >= 0.01), '每人至少 0.01（没被饿死）');
  ok(new Set(a4).size > 1, '随机分确实有差异');

  console.log('\n=== 7. 余额全程守恒 ===');
  ok(totalCoins() === 32000, `红包内部转移不改变总量（30000 初始 + 2000 新号 = 32000，实际 ${totalCoins()}）`);

  console.log('\n=== 8. 卡片消息体（按用户要求：不渲染）===');
  // 用户要求：一张封面图 + 「来自 XX 的一个红包」+ 领取按钮。不生成图片。
  const msg = buildRedpacketMessage({ creatorName: '测试员', mode: 'even' });
  ok(/来自 \*\*测试员\*\* 的一个红包/.test(msg.embeds[0].description), `卡片文字: ${msg.embeds[0].description}`);
  ok(!/QUN|份|\d/.test(msg.embeds[0].description.replace('🧧','')), '卡片上不出现金额/份额等额外信息');
  ok(msg.embeds[0].image.url === 'attachment://hongbao_cover.jpg', '引用用户指定的封面图');
  ok(msg.components[0].components[0].label === '领取', '按钮文案是「领取」');
  ok(msg.components[0].components[0].custom_id === 'hongbao:claim', 'custom_id 固定，不带 id');
  const cover = readCover();
  ok(Buffer.isBuffer(cover) && cover.length > 100000, `封面原图 ${(cover.length / 1024 | 0)}KB 直接使用，不加工`);
  // readCover() 每次重新读盘，Buffer 不是同一对象，要比内容
  ok(Buffer.isBuffer(msg.files[0].attachment) && msg.files[0].attachment.equals(cover),
    '附件内容与封面原图逐字节一致');

  console.log('\n=== 9. 边界与异常 ===');
  let e1 = null; try { rp.create({ creatorId: alice, channelId: '1', amountTotal: 0.9, slots: 100, mode: 'even' }); } catch (e) { e1 = e; }
  ok(e1 && /不足 0.01/.test(e1.message), `0.9元/100人 → "${e1 && e1.message}"`);
  let e2 = null; try { rp.create({ creatorId: alice, channelId: '1', amountTotal: 999999, slots: 1, mode: 'even' }); } catch (e) { e2 = e; }
  ok(e2 && /不足/.test(e2.message), `余额不足 → "${e2 && e2.message}"`);

  console.log(`\n${'='.repeat(46)}`);
  console.log(fail === 0 ? `✅ 全部通过：${pass}/${pass}` : `❌ ${fail} 项失败（通过 ${pass}）`);
  try { fs.unlinkSync(DB); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('崩溃: ' + e.stack); process.exit(1); });
