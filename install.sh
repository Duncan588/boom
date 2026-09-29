#!/usr/bin/env bash
# ============================================================
#  爆点逃跑 · 一键安装
#  用法：bash install.sh
#  依赖：Node.js >= 22.5（唯一要求）
# ============================================================
set -e

cd "$(dirname "$0")"
ROOT="$(pwd)"
ENV_FILE="$(dirname "$ROOT")/.env"

echo ""
echo "  ┌─────────────────────────────────────────┐"
echo "  │  爆点逃跑 · 安装程序                      │"
echo "  └─────────────────────────────────────────┘"
echo ""

# ---------- 1. 检查 Node ----------
if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ 未检测到 Node.js"
  echo ""
  echo "  请先安装 Node.js 22.5 或更高版本："
  echo "    官网下载: https://nodejs.org/zh-cn"
  echo "    或使用 nvm:  nvm install 22 && nvm use 22"
  echo "    或 winget:   winget install OpenJS.NodeJS.LTS"
  echo ""
  exit 1
fi

NODE_VER=$(node -v)
NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v\([0-9]*\).*/\1/')
NODE_MINOR=$(echo "$NODE_VER" | sed 's/v[0-9]*\.\([0-9]*\).*/\1/')
echo "  ✓ Node.js $NODE_VER"

# node:sqlite 需要 >= 22.5
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  echo "  ✗ 需要 Node.js >= 22.5（当前 $NODE_VER，node:sqlite 模块不可用）"
  exit 1
fi

# ---------- 2. 检查 .env ----------
if [ ! -f "$ENV_FILE" ]; then
  echo "  ✗ 未找到配置文件: $ENV_FILE"
  exit 1
fi
echo "  ✓ 配置文件 $ENV_FILE"

# ---------- 3. 安装依赖 ----------
echo ""
echo "  [1/4] 安装依赖…"
npm install --no-audit --no-fund --loglevel=error
echo "  ✓ 依赖安装完成（仅 1 个包：ws）"

# ---------- 4. 检查 node:sqlite ----------
echo ""
echo "  [2/4] 校验内置 SQLite…"
node -e "require('node:sqlite');" 2>/dev/null \
  && echo "  ✓ node:sqlite 可用" \
  || { echo "  ✗ node:sqlite 不可用，请升级 Node.js"; exit 1; }

# ---------- 5. 生成密钥 ----------
echo ""
echo "  [3/4] 检查配置…"
# 用相对路径，避开 Git-Bash / MSYS 的路径转换问题
node scripts/fill-env.js "$(cd .. && pwd)/.env"

# ---------- 6. 初始化数据库 ----------
echo ""
echo "  [4/4] 初始化数据库…"
node -e "
require('./server/env').load();
const db=require('./server/db'); db.init();
const admin=require('./server/routes/admin');
admin.ensureAdmin();
console.log('  ✓ 数据库就绪: data/baodian.db');
"

echo ""
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   安装完成！"
echo ""
echo "   启动游戏：  bash start.sh      (macOS / Linux)"
echo "              start.bat          (Windows)"
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
