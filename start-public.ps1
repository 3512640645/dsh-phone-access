<#
  DSH 手机公网访问 —— 一条命令搞定

  做的事：
    1. 确保网关（proxy.mjs）在跑，并已有访问密钥（phone-key.txt）
    2. 用 cloudflared 快速隧道把 127.0.0.1:8080 暴露成一个 https 公网地址
    3. 打印带密钥的完整访问链接，并生成二维码 public-url-qr.png

  用法：
    powershell -ExecutionPolicy Bypass -File start-public.ps1
    powershell -ExecutionPolicy Bypass -File start-public.ps1 -Restart   # 强制换新隧道
#>
[CmdletBinding()]
param(
  [int]$Port = 8080,
  [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bin = Join-Path $root 'bin'
$cloudflared = Join-Path $bin 'cloudflared.exe'
$tunnelLog = Join-Path $bin 'cloudflared.log'
$keyFile = Join-Path $root 'phone-key.txt'
$urlFile = Join-Path $root 'public-url.txt'
$qrFile = Join-Path $root 'public-url-qr.png'

function New-Key {
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  -join (1..24 | ForEach-Object { $alphabet[(Get-Random -Maximum $alphabet.Length)] })
}

# 1) 访问密钥
if (-not (Test-Path $keyFile) -or -not (Get-Content $keyFile -Raw).Trim()) {
  New-Key | Set-Content -Path $keyFile -NoNewline -Encoding ascii
  Write-Host "[1/4] 已生成访问密钥" -ForegroundColor Green
} else {
  Write-Host "[1/4] 访问密钥已存在" -ForegroundColor DarkGray
}
$key = (Get-Content $keyFile -Raw).Trim()

# 2) 网关
$listening = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if (-not $listening) {
  Write-Host "[2/4] 启动网关 (127.0.0.1:$Port ...)" -ForegroundColor Yellow
  Start-Process wscript.exe -ArgumentList "`"$root\start-hidden.vbs`""
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { break }
  }
}
if (-not (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) { throw "网关未能在端口 $Port 启动，先手动跑一次 start.cmd 看报错" }
Write-Host "[2/4] 网关已监听 $Port" -ForegroundColor Green

# 3) cloudflared
if (-not (Test-Path $cloudflared)) {
  Write-Host "[3/4] 下载 cloudflared ..." -ForegroundColor Yellow
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cloudflared
}
Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $cloudflared } | Stop-Process -Force -ErrorAction SilentlyContinue
if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force }
Start-Sleep -Milliseconds 300
Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$Port", '--no-autoupdate', '--logfile', $tunnelLog, '--loglevel', 'info') -WindowStyle Hidden
Write-Host "[3/4] 隧道已启动，等待分配公网地址 ..." -ForegroundColor Yellow

$public = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Path $tunnelLog) {
    $m = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($m) { $public = $m.Matches[0].Value; break }
  }
}
if (-not $public) { throw "没能从隧道日志里拿到公网地址，看 $tunnelLog" }

$link = "$public/?k=$key"
Set-Content -Path $urlFile -Value $link -Encoding ascii
# 桌面留一份「当前地址」，重启后地址变了也能一眼看到
try {
  $lanIp = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -notlike '100.*' } |
    Select-Object -First 1 -ExpandProperty IPAddress
  $desktopNote = Join-Path ([Environment]::GetFolderPath('Desktop')) 'DSH-手机访问地址.txt'
  @(
    'DSH 手机访问地址（隧道每次重启都会变，以本文件为准）'
    ''
    "手机流量打开： $link"
    ''
    "同一 Wi-Fi 打开： $(if ($lanIp) { "http://${lanIp}:8080/" } else { '（未检测到局域网地址）' })"
    ''
    "更新时间： $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  ) | Set-Content -Path $desktopNote -Encoding UTF8
} catch { }
Write-Host "[4/4] 公网地址就绪" -ForegroundColor Green

# 二维码：优先用 DSH 自带 Python，其次系统 python（都没有就跳过）
$python = @(
  (Join-Path $env:APPDATA 'dsh-desktop\harness\..\..\..\python.exe'),
  'python.exe',
  'py.exe'
) | Where-Object { $_ -and ($_ -notmatch '\\$') } | Where-Object { ($_ -eq 'python.exe' -or $_ -eq 'py.exe') -or (Test-Path $_) } | Select-Object -First 1
$qrOk = $false
if ($python) {
  try {
    & $python -c "import segno,sys; segno.make(sys.argv[1], error='m').save(sys.argv[2], scale=8, border=3, dark='#1b1b1f', light='#ffffff')" $link $qrFile 2>$null
    $qrOk = Test-Path $qrFile
  } catch { $qrOk = $false }
}

Write-Host ''
Write-Host '  ██████████████████████████████████████' -ForegroundColor Cyan
Write-Host '  手机用流量(4G/5G)打开下面这个链接：' -ForegroundColor Cyan
Write-Host "  $link"
Write-Host "  二维码：$qrFile"
Write-Host '  ██████████████████████████████████████' -ForegroundColor Cyan
Write-Host ''
Write-Host "  隧道日志：$tunnelLog"
Write-Host "  换新地址：重新运行本脚本；关掉隧道：Get-Process cloudflared | Stop-Process" -ForegroundColor DarkGray
if (-not $qrOk) { Write-Host '  （未生成二维码：找不到可用的 python + segno）' -ForegroundColor DarkGray }
