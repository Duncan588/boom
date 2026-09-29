'use strict';
/** 补齐 .env 中缺失的配置项。路径可由参数传入，否则自动定位项目上级目录的 .env */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT = path.join(__dirname, '..');

let file = process.argv[2];
if (file) {
  // bash 传入的 /e/xxx 形式 → 转成 Windows 绝对路径
  const m = file.match(/^\/([a-zA-Z])[\/\\](.*)$/);
  if (m) file = `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
} else {
  file = path.join(PROJECT, '..', '.env');
}
file = path.resolve(file);

if (!fs.existsSync(file)) {
  console.log('  [跳过] 未找到 .env');
  process.exit(0);
}

let text = fs.readFileSync(file, 'utf8');
const changed = [];

const gen = {
  BOT_API_SECRET: () => crypto.randomBytes(24).toString('base64url'),
  ADMIN_PASS: () => crypto.randomBytes(9).toString('base64url'),
  APP_URL: () => 'http://127.0.0.1:8080',
  DISCORD_REDIRECT_URI: () => 'http://127.0.0.1:8080/auth/callback',
  PORT: () => '8080',
  WS_PORT: () => '9501',
  DB_FILE: () => 'data/baodian.db',
  ADMIN_USER: () => 'admin',
  CHECKIN_COINS: () => '100',
  INVITE_REWARD_COINS: () => '200',
  INVITE_MIN_ROUNDS: () => '3',
};

for (const [k, f] of Object.entries(gen)) {
  const re = new RegExp('^' + k + '=(.*)$', 'm');
  const m = text.match(re);
  if (!m) {
    text += `\n${k}=${f()}`;
    changed.push(`${k} (新增)`);
  } else if (!m[1].trim()) {
    text = text.replace(re, `${k}=${f()}`);
    changed.push(`${k} (已生成)`);
  }
}

if (changed.length) {
  fs.writeFileSync(file, text);
  console.log('  [OK] 已补齐: ' + changed.join(', '));
} else {
  console.log('  [OK] 配置完整');
}
