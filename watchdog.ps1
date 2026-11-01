# ============================================================================
#  DSH 手机访问守护脚本
#  每 5 分钟检查一次：网关在不在、隧道在不在，掉了就自动拉起来。
#  由 install-watchdog.cmd 注册成计划任务，也可以手动跑。
# ============================================================================
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $root 'watchdog.log'
$port = 8080

function Write-Log([string]$message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
  Add-Content -Path $log -Value $line -Encoding UTF8
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) { Set-Content -Path $log -Value '' -Encoding UTF8 }
}

# 日志轮转：超过 1MB 清空
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) { Set-Content -Path $log -Value '' -Encoding UTF8 }

# 1) 网关
$gatewayUp = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if (-not $gatewayUp) {
  Write-Log "gateway down on :$port -> restarting"
  Start-Process wscript.exe -ArgumentList "`"$root\start-hidden.vbs`""
  Start-Sleep -Seconds 6
  $gatewayUp = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  Write-Log ($(if ($gatewayUp) { 'gateway restarted' } else { 'gateway restart FAILED' }))
}

# 1b) 本机网卡地址变了（例如刚装上/登录 Tailscale，出现 100.x 地址）就重启网关，让它把新地址也监听上
$bound = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalAddress -Unique)
$local = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -ExpandProperty IPAddress -Unique)
$missing = @($local | Where-Object { $_ -notin $bound })
if ($missing.Count -gt 0) {
  Write-Log "new local address(es) $($missing -join ',') not bound -> restarting gateway"
  $pids = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($procId in $pids) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Start-Process wscript.exe -ArgumentList "`"$root\start-hidden.vbs`""
  Start-Sleep -Seconds 6
}

# 2) 隧道
$tunnelDown = -not (Get-Process cloudflared -ErrorAction SilentlyContinue)
if ($tunnelDown) {
  Write-Log 'tunnel down -> restarting (public url will change)'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'start-public.ps1') *>&1 |
    ForEach-Object { Add-Content -Path $log -Value "    $_" -Encoding UTF8 }
  $url = ''
  try { $url = (Get-Content (Join-Path $root 'public-url.txt') -Raw).Trim() } catch { }
  Write-Log "tunnel restarted: $url"
}

# 3) 每次运行都把最新地址同步到桌面（隧道重启后地址会变，手机照着桌面文件扫即可）
function Get-LanUrl {
  $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -notlike '100.*' } |
    Select-Object -First 1 -ExpandProperty IPAddress
  if ($ip) { "http://${ip}:8080/" } else { '' }
}

function Sync-DesktopNote {
  $url = ''
  try { $url = (Get-Content (Join-Path $root 'public-url.txt') -Raw).Trim() } catch { }
  if (-not $url) { return }
  try {
    $note = Join-Path ([Environment]::GetFolderPath('Desktop')) 'DSH-手机访问地址.txt'
    $current = ''
    if (Test-Path $note) { $current = Get-Content $note -Raw -Encoding UTF8 }
    if ($current -notmatch [regex]::Escape($url)) {
      @(
        'DSH 手机访问地址（隧道每次重启都会变，以本文件为准）'
        ''
        "手机流量打开： $url"
        ''
        "同一 Wi-Fi 打开： $(Get-LanUrl)"
        ''
        "更新时间： $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')（守护任务自动更新）"
      ) | Set-Content -Path $note -Encoding UTF8
      Write-Log 'desktop note updated'
    }
  } catch { }
}
Sync-DesktopNote

# 3) 心跳：一切正常时也留一行，便于确认守护在跑
$tunnelPid = (Get-Process cloudflared -ErrorAction SilentlyContinue | Select-Object -First 1).Id
Write-Log "ok gateway=up tunnel=$(if ($tunnelPid) { "pid:$tunnelPid" } else { 'missing' })"
