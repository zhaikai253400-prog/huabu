@echo off
cd /d "%~dp0"

set "TRAY_EXE=%~dp0server\tray\CanvasTray.exe"
if exist "%TRAY_EXE%" (
  start "" "%TRAY_EXE%"
  exit /b 0
)

set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" (
  echo 没有找到运行环境 runtime\node.exe
  echo 请确认 runtime 文件夹和本文件在同一个目录里。
  pause
  exit /b 1
)
start "" "%NODE_EXE%" "%~dp0server\index.js" --background
exit /b 0