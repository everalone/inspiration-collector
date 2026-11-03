@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\launch-isolated.mjs
if errorlevel 1 echo 旧版本隔离入口未正常结束，请查看上面的说明。
pause
