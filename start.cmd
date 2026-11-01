@echo off
chcp 65001 >nul
rem 启动 DSH 手机访问网关（局域网反代 + 自动换 Cookie）
rem 可用环境变量覆盖：set PHONE_PORT=8080 / PHONE_ALLOW=192.168.1.20 / PHONE_AUTO_TOKEN=0
set "DSH_NODE=%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd"
if not exist "%DSH_NODE%" set "DSH_NODE=node"
"%DSH_NODE%" "%~dp0proxy.mjs" %*
pause
