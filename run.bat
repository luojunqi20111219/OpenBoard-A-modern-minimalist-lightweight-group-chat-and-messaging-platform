@chcp 65001 >nul
@echo off
title 💬 信语 (OpenBoard) 一键启动服务
cls

echo ===================================================
echo   💬 信语 (OpenBoard) - 极简轻量级群聊平台一键启动
echo ===================================================
echo.

REM 1. 检测 Python 环境
echo [*] 正在检测 Python 环境...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] 未检测到 Python，请先安装 Python 3.8+ 并勾选 "Add Python to PATH" 选项！
    pause
    exit /b
)

REM 2. 自动安装依赖包
echo [*] 正在检查并自动安装所需依赖包 (pip install -r requirements.txt)...
echo [*] 这可能需要一分钟时间，请稍候...
python -m pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo [WARNING] 依赖安装过程中出现部分警告，尝试直接启动...
) else (
    echo [SUCCESS] 依赖包检查并安装成功！
)

echo.
echo ===================================================
echo   🚀 服务准备就绪！
echo   🌍 本地访问地址: http://127.0.0.1:5000
echo   🛡️ 管理后台地址: http://127.0.0.1:5000/admin
echo   🔑 默认管理员账号: 官方账号  密码: 12345678
echo.
echo   [*] 正在拉起 FastAPI 异步服务，请保持此窗口打开...
echo ===================================================
echo.

REM 3. 运行项目
python -m app.main

pause
