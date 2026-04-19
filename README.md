# 💬 OpenBoard - 现代化的极简轻量级群聊与私信平台

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python Version](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-00a67d.svg?logo=fastapi)](https://fastapi.tiangolo.com/)

OpenBoard 是一个基于 **FastAPI** 和 **SQLite** 构建的现代化极简 Web 聊天室。它摒弃了繁重的依赖，只需几个 Python 基础库即可极速启动。项目支持多群组聊天、端到端私信、个人头像定制，并拥有一个功能强大的 ROOT 管理后台。

🌍 **线上体验地址**：[http://liuyan.luojunqi.xyz](http://liuyan.luojunqi.xyz)

---

## ✨ 核心特性

- **🚀 极速部署**：无需配置复杂的 MySQL 或 Redis，基于单文件 SQLite 数据库，开箱即用。
- **🛡️ 纯净安全**：密码采用 Werkzeug 哈希强加密；具备严格的后端 API 鉴权，支持管理员账号白名单。
- **📱 响应式 UI**：采用 Tailwind CSS 构建，完美适配 PC 和移动端，带有平滑的气泡过渡动画。
- **💬 社交互动**：
  - 支持创建、重命名、解散自定义**群聊频道**。
  - 内置受保护的“公共大厅”。
  - 支持一对一**端到端私信**。
- **🧑‍💻 个人定制**：支持上传本地图片作为头像，前端自动裁剪并压缩为 Base64，不占带宽。

---

## 📖 详细使用教程

### 1. 普通用户篇
- **注册与登录**：点击左下角按钮，在弹窗中选择“注册”或“登录”。
- **个人资料**：登录后点击左上角 **⚙️ 齿轮**，可以上传头像、修改昵称、更改密码或注销账号。
- **私信交流**：在左侧联系人列表点击任意在线用户，即可发起私聊。
- **管理自己的群**：点击群聊标题旁的 **+** 创建新群。如果你是群主（群名旁有 👑），点击右上角齿轮可解散群聊。

### 2. ROOT 管理员篇 (管理员白名单账号)
拥有管理员权限的账号（由 `app.py` 中 `ALLOWED_ADMINS` 指定）可进入 `/admin`：
- **💬 留言管理**：全站留言预览，支持批量勾选删除。
- **🗂️ 群聊管理**：可强制解散任何违规群聊（公共大厅除外）。
- **👥 用户管理**：支持一键禁言、强制重置用户密码、或彻底抹除违规用户。

---

## 🚀 部署与运行 (开发者指南)

### 1. 环境准备
确保你的服务器安装了 **Python 3.8+**。

### 2. 安装依赖
```bash
pip install fastapi uvicorn jinja2 werkzeug
```

### 3. 配置管理员白名单
在运行前，请打开 `app.py`，在 `ALLOWED_ADMINS` 列表中填入你的管理员账号名：
```python
ALLOWED_ADMINS = ["官方账号", "你的管理员账号"]
```

### 4. 启动服务
```bash
python app.py
```
默认运行在 `http://127.0.0.1:8000`。

### 5. 默认管理员账号 (针对纯净版数据库)
本项目自带了一个初始化好的 `board.db`。你可以使用以下预设账号登录：
- **账号**：`官方账号`
- **密码**：`12345678`
> **安全建议**：部署后请立即登录并在个人设置中修改此密码！

---

## 📂 目录结构
```text
OpenBoard/
├── app.py               # 后端核心逻辑与 API
├── board.db             # SQLite 数据库文件
├── requirements.txt     # 项目依赖
├── README.md            # 项目说明
└── templates/           # 前端模板
    ├── index.html       # 聊天室主页
    └── admin.html       # 管理员后台
```

---

## 🛠️ 技术栈
- **后端**：FastAPI (异步框架), SQLite3 (数据库)
- **前端**：Tailwind CSS, Vanilla JavaScript (原生 JS), FontAwesome (图标)
- **安全**：Werkzeug (密码加密), Token-based Auth (登录状态)

## 📄 开源协议
本项目采用 [MIT License](LICENSE) 开源协议。欢迎提交 PR 或 Issue。