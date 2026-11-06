@echo off
chcp 65001 >nul
title 无限画布 - 允许局域网访问
net session >nul 2>&1
if not %errorlevel%==0 (
  echo 需要管理员权限，正在申请...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$n='无限画布 局域网访问 (TCP 17890)'; Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName $n -Direction Inbound -Action Allow -Protocol TCP -LocalPort 17890 -Profile Private,Domain | Out-Null; Write-Host ''; Write-Host '已完成：允许同一局域网访问 17890 端口（仅专用网络 / 域网络）。' -ForegroundColor Green"
echo.
echo 另一台电脑：托盘右键 -「同步程序代码…」，填上 http://本机IP:17890 拉取程序。
echo 本机 IP 见画布「显示与设置」-「另一台电脑同步程序」。
echo 只传程序文件；画布和素材库不对外开放，各自保留一份。
echo.
pause
