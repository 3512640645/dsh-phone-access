@echo off
chcp 65001 >nul
rem 注册守护任务：每 5 分钟检查网关与隧道，掉了自动拉起
rem 需要以普通用户身份运行即可（不需要管理员）
set "SCRIPT=%~dp0watchdog.ps1"
set "TASK=DSH Phone Access Watchdog"
schtasks /Create /SC MINUTE /MO 5 /TN "%TASK%" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"%SCRIPT%\"" /F
if errorlevel 1 (
  echo 注册失败：请确认已安装 PowerShell 且当前用户有创建计划任务的权限。
) else (
  echo 已注册计划任务 "%TASK%"，每 5 分钟运行一次。
  echo 立刻试跑一次： powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
)
pause
