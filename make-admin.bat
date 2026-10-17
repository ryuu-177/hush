@echo off
chcp 65001 >nul
cd /d "%~dp0"
set /p NAME=请输入要设为管理员的用户名，然后按回车：
node make-admin.js "%NAME%"
pause
