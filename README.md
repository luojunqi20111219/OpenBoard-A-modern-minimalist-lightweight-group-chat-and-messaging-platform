# 💬 信语 (OpenBoard) - 现代化的极简轻量级群聊与私信平台

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python Version](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-00a67d.svg?logo=fastapi)](https://fastapi.tiangolo.com/)

**信语 (OpenBoard)** 是一个基于 **FastAPI** 和 **SQLite** 构建的现代化极简 Web 聊天室。在最新的版本迭代中，不仅保留了专属的视觉标识与管理员风控能力，还大幅升级了**群组高级权限管控**、**文件图片上传**与**消息撤回**等实用社交功能。项目支持多群组聊天、端到端私信、自定义头像，开箱即用，极速部署。

🌍 **线上体验地址**：[http://liuyan.luojunqi.xyz](http://liuyan.luojunqi.xyz)

---

## ✨ 核心特性更新

- **🛡️ 群组高级权限管控 (New)**：群主可以精准设置群聊的“查看权限”与“发言权限”，支持开启黑名单或白名单模式，让社群运营更具灵活性。
- **📁 文件与图片共享 (New)**：聊天全面支持图片和文件的上传、展示及下载交互。
- **⏱️ 消息安全撤回 (New)**：发送消息后支持 **2分钟内** 随时撤回，避免手滑尴尬（管理员可无视时间限制撤回任意违规消息）。
- **🚀 品牌深度定制**：全局适配专属蓝色气泡图标，并支持浏览器 Tab 标签页显示，公共大厅默认展示官方 Logo 作为头像。
- **🛡️ ROOT 级风控权限**：
  - **群聊冻结**：管理员可在后台一键“冻结”违规群聊，实现即时全员禁言。
  - **信息管控**：管理员拥有最高权限，可强行修改用户或群聊头像、重置用户密码、封禁用户以及批量删除违规留言。
- **🧑‍💻 极致轻量交互**：采用极简的 Token 认证，全站交互无刷新体验。
- **📱 全平台适配**：基于 Tailwind CSS 构建，完美适配手机、平板及电脑端，交互反馈顺滑。

---

## 📖 使用教程

### 1. 普通用户篇
- **入驻与登录**：点击左下角按钮即可快速注册或登录。
- **个性化设置**：登录后点击左上角 **⚙️ 齿轮**，可以自由上传头像、修改昵称、更改密码或注销账号。
- **社交互动**：
  - 侧边栏点击 **+** 创建新群聊。群主可在群设置中配置黑白名单权限。
  - 支持在聊天框发送文字、图片和文件；点击发送后的消息可执行撤回（2分钟内有效）。
  - 点击联系人列表可开启受保护的端到端私信。

### 2. ROOT 管理员篇
符合 `app.py` 中 `ALLOWED_ADMINS` 配置的账号可进入 `/admin` 访问管理后台：
- **💬 留言巡查**：全站发言实时监控，支持批量勾选一键清理。
- **🗂️ 频道管理**：实时掌控所有群聊状态，对违规频道执行冻结全员禁言或永久解散处理。
- **👥 用户管控**：一键执行账号状态切换（正常/封禁），或针对违规信息重置密码、修改头像。

---

## 🚀 快速部署 (开发者指南)

### 1. 环境准备
确保服务器已安装 **Python 3.8+**。将你的图标重命名为 `favicon.ico` 放入项目根目录。

### 2. 安装依赖
由于新版本引入了文件上传功能，请务必安装 `python-multipart`。
```bash
pip install fastapi uvicorn jinja2 werkzeug pydantic python-multipart
```

### 3. 配置管理员
打开 `app.py`，在 `ALLOWED_ADMINS` 列表中填入你的管理员账号名称。

### 4. 启动服务
你可以直接使用 Python 启动：
```bash
python app.py
```
默认监听地址：[http://0.0.0.0:5000](http://0.0.0.0:5000)（可在代码最后一行自定义修改）。

---

## 🔑 默认管理员信息
本项目预置了一个初始化账号用于首次登录：
- **账号**：`官方账号`
- **密码**：`12345678`

> **安全建议**：部署后请立即登录并在个人设置中修改此密码！

---

## 📂 项目结构
```text
OpenBoard/
├── app.py               # 后端核心引擎与 API 接口
├── board.db             # SQLite 数据库
├── favicon.ico          # 品牌专属蓝色气泡图标
├── requirements.txt     # 依赖清单
├── README.md            # 项目说明文档
├── uploads/             # 上传的图片与文件存储目录
└── templates/           # 前端模板
    ├── index.html       # “信语”客户端主界面
    └── admin.html       # ROOT 管理员后台界面
```

---

## 🛠️ 技术栈
- **后端**：FastAPI (异步框架), SQLite3 (数据库)
- **前端**：Tailwind CSS, Vanilla JavaScript (原生 JS), FontAwesome (图标)
- **安全**：Werkzeug (密码加密), Token-based Auth (登录状态)

## 📄 开源协议
本项目采用 [MIT License](LICENSE) 开源协议。欢迎提交 PR 或 Issue。
