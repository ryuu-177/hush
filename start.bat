@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 还没有安装 Node.js，请先到 https://nodejs.org 下载安装 LTS 版本，然后重新双击本文件。
  pause
  exit /b
)
if not exist node_modules (
  echo 第一次运行，正在安装依赖，需要联网，请稍等...
  call npm install
)
echo 正在启动，浏览器会自动打开 http://localhost:3000
echo 关闭这个黑色窗口，服务就会停止。
start http://localhost:3000
node server.js
pause
