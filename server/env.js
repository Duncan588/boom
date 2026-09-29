'use strict';
/**
 * 极简 .env 解析器 —— 零依赖。
 * 支持 KEY=VALUE、# 注释、空行、引号包裹、export 前缀。
 * 不覆盖已存在的 process.env（真实环境变量优先）。
 */
const fs = require('fs');
const path = require('path');

function parse(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (!key) continue;
    // 去掉行尾注释（仅当引号外）
    if ((val.startsWith('"') && val.endsWith('"') && val.length > 1) ||
        (val.startsWith("'") && val.endsWith("'") && val.length > 1)) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

function load(file) {
  const p = file || path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(p)) return {};
  const parsed = parse(fs.readFileSync(p, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return parsed;
}

module.exports = { load, parse };
