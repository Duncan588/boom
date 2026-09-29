#!/usr/bin/env bash
# 爆点逃跑 · 启动脚本
cd "$(dirname "$0")"
exec node server/index.js
