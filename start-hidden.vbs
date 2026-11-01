' 隐藏窗口启动 DSH 手机访问网关
' 日志写在同目录 proxy.log（网关自己 tee 出来的，不依赖控制台重定向）
' 用法：双击本文件；或把它的快捷方式放进 shell:startup 实现开机自启
Option Explicit
Dim fso, sh, base, node, script
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
node = sh.ExpandEnvironmentStrings("%APPDATA%") & "\dsh-desktop\harness\.desktop-bin\node.cmd"
script = fso.BuildPath(base, "proxy.mjs")
sh.Run """" & node & """ """ & script & """", 0, False
