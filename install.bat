@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"
set "ROOT=%CD%"
set "ENV_FILE=%ROOT%..\.env"

echo.
echo   ==========================================
echo     爆点逃跑 · 安装程序
echo   ==========================================
echo.

REM ---------- 1. 检查 Node ----------
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] 未检测到 Node.js
  echo.
  echo   请先安装 Node.js 22.5 或更高版本:
  echo     下载: https://nodejs.org/zh-cn
  echo     或:   winget install OpenJS.NodeJS.LTS
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set "NODE_VER=%%v"
echo   [OK] Node.js %NODE_VER%

node -e "const[maj,min]=process.versions.node.split('.').map(Number);if(maj<22||(maj===22&&min<5))process.exit(1)"
if errorlevel 1 (
  echo   [X] 需要 Node.js ^>= 22.5 ^(当前 %NODE_VER%^)
  pause
  exit /b 1
)

REM ---------- 2. 检查 .env ----------
if not exist "%ENV_FILE%" (
  echo   [X] 未找到配置文件: %ENV_FILE%
  pause
  exit /b 1
)
echo   [OK] 配置文件 %ENV_FILE%

REM ---------- 3. 安装依赖 ----------
echo.
echo   [1/4] 安装依赖...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo   [X] 依赖安装失败
  pause
  exit /b 1
)
echo   [OK] 依赖安装完成

REM ---------- 4. 校验 sqlite ----------
echo.
echo   [2/4] 校验内置 SQLite...
node -e "require('node:sqlite')" 2>nul
if errorlevel 1 (
  echo   [X] node:sqlite 不可用，请升级 Node.js
  pause
  exit /b 1
)
echo   [OK] node:sqlite 可用

REM ---------- 5. 配置 ----------
echo.
echo   [3/4] 检查配置...
node -e "require('./server/env').load();const db=require('./server/db');db.init();require('./server/routes/admin').ensureAdmin();console.log('  [OK] 数据库就绪')" || (
  echo   [X] 数据库初始化失败
  pause
  exit /b 1
)
node "%ROOT%scripts\fill-env.js" "%ENV_FILE%"

REM ---------- 6. 完成 ----------
echo.
echo   ==========================================
echo    安装完成！
echo.
echo    启动游戏:  start.bat
echo   ==========================================
echo.
pause
