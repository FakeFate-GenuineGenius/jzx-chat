@echo off
chcp 65001 >nul
title 正在停止服务...

echo ========================================
echo        正在精准停止 JZX-Chat 服务
echo ========================================

:: 1. 强制清理 3000 端口
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1

:: 2. 深入底层：通过命令行特征精准杀掉进程（无视窗口外壳问题）
wmic process where "name='node.exe' and commandline like '%%server.js%%'" call terminate >nul 2>&1
wmic process where "name='ssh.exe' and commandline like '%%3000%%'" call terminate >nul 2>&1

:: 3. 杀掉为这个服务开启的 cmd 黑框
wmic process where "name='cmd.exe' and commandline like '%%JZX-Chat%%'" call terminate >nul 2>&1

echo [OK] 端口释放成功，已成功关闭本地服务器和内网穿透窗口！
echo.
pause
