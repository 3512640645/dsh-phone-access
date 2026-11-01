@echo off
chcp 65001 >nul
rem 需要以管理员身份运行：放行局域网设备访问网关端口（默认 8080）
set "PORT=8080"
if not "%~1"=="" set "PORT=%~1"
netsh advfirewall firewall delete rule name="DSH Phone Access %PORT%" >nul 2>&1
netsh advfirewall firewall add rule name="DSH Phone Access %PORT%" dir=in action=allow protocol=TCP localport=%PORT% profile=any
echo.
echo 已放行入站 TCP %PORT%（profile=any）。当前网络为"公用"配置文件时也需要它。
pause
