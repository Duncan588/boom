'use strict';
/** 重置数据库（会删除所有数据，谨慎使用） */
const fs = require('fs');
const path = require('path');
require('./env').load();

const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'baodian.db');
const abs = path.isAbsolute(file) ? file : path.join(__dirname, '..', file);

if (process.argv.includes('--yes') || process.argv.includes('-y')) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = abs + suffix;
    if (fs.existsSync(f)) { fs.unlinkSync(f); console.log('已删除', f); }
  }
  console.log('\n数据库已重置。重新运行 npm start 即可。');
} else {
  console.log('\n⚠  这将删除所有用户、下注、开奖记录。');
  console.log('   数据库: ' + abs);
  console.log('\n确认请运行:  node server/reset.js --yes\n');
}
