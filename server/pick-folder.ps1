param(
  [string]$InitialDir = "",
  [Parameter(Mandatory = $true)][string]$ResultFile
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null

# 置顶相关的系统调用。个别精简系统编译不了时，退回到普通弹窗，至少能用。
$native = $true
try {
  Add-Type -Path (Join-Path $here "pick-win.cs") | Out-Null
} catch {
  $native = $false
}

$picked = ""

# 一个几乎看不见、但始终置顶的父窗口。
# 对话框挂在它上面才会浮在浏览器上方；把它放到鼠标位置，
# 这样多显示器时窗口也会出现在你正在看的那块屏幕上。
$owner = New-Object System.Windows.Forms.Form
$owner.Text = "选择导出目录"
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.ShowInTaskbar = $false
$owner.Opacity = 0.01
$owner.TopMost = $true
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$cursor = [System.Windows.Forms.Cursor]::Position
$owner.Location = New-Object System.Drawing.Point($cursor.X, $cursor.Y)
$owner.Size = New-Object System.Drawing.Size(2, 2)
$owner.Show()
$owner.Activate()
if ($native) { [void][CanvasPickWin]::SetForegroundWindow($owner.Handle) }

$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = "选择导出目录"
$dlg.ShowNewFolderButton = $true
if ($InitialDir -and (Test-Path -LiteralPath $InitialDir)) {
  $dlg.SelectedPath = $InitialDir
}

# 对话框冒出来的一瞬间，浏览器可能会把前台抢回去，把它压到下面。
# 这里一直盯着：只要发现它不在最上层，就立刻抬回去（只抬一次，
# 之后它自己带置顶属性，不会被盖住，也不会再抢你的焦点）。
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
  if (-not $native) { $timer.Stop(); return }
  $h = [CanvasPickWin]::FindOwnDialog($PID)
  if ($h -eq [IntPtr]::Zero) { return }
  if (-not [CanvasPickWin]::IsTopMost($h)) {
    [void][CanvasPickWin]::Raise($h)
  }
})
$timer.Start()

try {
  $res = $dlg.ShowDialog($owner)
  if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
    $picked = $dlg.SelectedPath
  }
} finally {
  $timer.Stop()
  $timer.Dispose()
  $dlg.Dispose()
  $owner.Close()
  [System.IO.File]::WriteAllText($ResultFile, $picked, (New-Object System.Text.UTF8Encoding($false)))
}
