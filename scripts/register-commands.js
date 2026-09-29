/**
 * 注册/更新 Discord application commands。
 *
 * 用法：
 *   node scripts/register-commands.js            # 干跑，只打印差异
 *   node scripts/register-commands.js --apply    # 实际 PUT
 *   node scripts/register-commands.js --global   # 注册到所有服务器（生效需 1 小时）
 *
 * 为什么要写这个脚本：/balance 之前失效的根因不是没注册，而是没有 gateway 接收；
 * 但注册本身也需要可重复执行的能力 —— 手点开发者后台改不动 6 条指令的选项。
 *
 * --global 用于删掉 /coin（全局指令删除后 1 小时内消失）。
 */

require('../server/env').load();
const { commandDefs } = require('../server/commands');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.BOT_GUILD_ID || process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ 缺少 DISCORD_BOT_TOKEN 或 DISCORD_CLIENT_ID');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const global = process.argv.includes('--global');

async function listCurrent(scopeId) {
  const path = scopeId
    ? `/applications/${CLIENT_ID}/guilds/${scopeId}/commands`
    : `/applications/${CLIENT_ID}/commands`;
  const r = await fetch('https://discord.com/api/v10' + path, {
    headers: { Authorization: 'Bot ' + TOKEN },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

(async () => {
  const scopeId = global ? null : GUILD_ID;
  console.log(`作用域：${global ? '全局（所有服务器，1 小时生效）' : `服务器 ${GUILD_ID}（即时生效）`}`);

  const defs = commandDefs({ activityUrl: process.env.APP_URL || '', clientId: CLIENT_ID });
  const current = await listCurrent(scopeId);

  console.log(`\n当前 ${current.length} 条：${current.map((c) => '/' + c.name).join(' ')}`);
  console.log(`目标 ${defs.length} 条：${defs.map((c) => '/' + c.name).join(' ')}\n`);

  const curNames = new Set(current.map((c) => c.name));
  const defNames = new Set(defs.map((c) => c.name));

  for (const n of curNames) {
    if (defNames.has(n)) continue;
    if (global && n === 'launch') { console.log('  保留  /launch（Discord 强制的 Entry Point，不可删）'); continue; }
    console.log(`  删除  /${n}`);
  }
  for (const d of defs) {
    if (!curNames.has(d.name)) { console.log(`  新增  /${d.name}`); continue; }
    const c = current.find((x) => x.name === d.name);
    if (JSON.stringify(c.options || []) !== JSON.stringify(d.options || [])) console.log(`  更新  /${d.name}（选项有变化）`);
    else if ((c.description || '') !== d.description) console.log(`  更新  /${d.name}（描述变化）`);
  }

  if (!apply) {
    console.log('\n（干跑，加 --apply 生效）');
    return;
  }

  const path = scopeId
    ? `/applications/${CLIENT_ID}/guilds/${scopeId}/commands`
    : `/applications/${CLIENT_ID}/commands`;
  // 全局作用域下 /launch 是 Discord 强制的「Entry Point」指令，
  // 批量 PUT 里不能删掉它 —— 必须原样带回，否则 HTTP 400 (code 50240)。
  // 保留原 body（保留它原有的 integration_types 等字段），只改我们自己的指令。
  const payload = global
    ? [...current.filter((c) => c.name === 'launch'), ...defs]
    : defs;
  const r = await fetch('https://discord.com/api/v10' + path, {
    method: 'PUT',
    headers: { Authorization: 'Bot ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    console.error(`\n❌ 注册失败 HTTP ${r.status}: ${await r.text()}`);
    process.exit(1);
  }
  const out = await r.json();
  console.log(`\n✅ 已注册 ${out.length} 条：${out.map((c) => '/' + c.name).join(' ')}`);
  console.log(global ? '（全局指令最长 1 小时后生效）' : '（服务器指令即时生效）');
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
