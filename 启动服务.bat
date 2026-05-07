@echo off
chcp 65001 >nul
title 启动准备中...

echo ========================================
echo        正在清理残留的 3000 端口服务
echo ========================================
:: 查找占用 3000 端口的进程并强制结束，防止端口冲突报错
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1

echo ========================================
echo        正在启动 JZX-Chat 服务器
echo ========================================

:: 启动 Node.js 原本的服务器，并在新窗口中运行
start "JZX-Chat-Server" cmd /k "title JZX-Chat-Server && node server.js"
echo [OK] 本地服务器已启动！

echo.
echo ========================================
echo        正在等待服务器预热...
echo ========================================
timeout /t 2 /nobreak >nul

echo.
echo ========================================
echo        正在启动内网穿透服务
echo ========================================

:: 使用 Pinggy 的 SSH 隧道，并将地址精确指向 127.0.0.1 避免 IPv6 解析冲突
start "JZX-Chat-Tunnel" cmd /k "title JZX-Chat-Tunnel && ssh -p 443 -R0:127.0.0.1:3000 -o StrictHostKeyChecking=no a.pinggy.io"

echo [OK] 内网穿透已启动！
echo.
echo 请去弹出的 "JZX-Chat-Tunnel" 窗口中，找到含有 http:// 或者 https:// 的那行随机域名，发给朋友即可！
echo =========================================================================
echo * 如果在浏览器中打开网址提示网关错误或还是进不去，可以右键编辑本文件：
echo * 将上面的穿透命令替换成国内可访问的其他节点，例如：
echo * 备用1：ssh -R 80:127.0.0.1:3000 nokey@localhost.run
echo * 备用2：ssh -R 80:127.0.0.1:3000 serveo.net
echo * 或者考虑使用 cpolar、NATAPP 等国内免费穿透软件。
echo =========================================================================
pause
