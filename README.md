# 💬 信语 (OpenBoard) - 现代化的极简轻量级群聊与私信平台

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python Version](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-00a67d.svg?logo=fastapi)](https://fastapi.tiangolo.com/)

**信语 (OpenBoard)** 是一个基于 **FastAPI** 和 **SQLite** 构建的现代化极简 Web 聊天室。V1.5 版本完成了全方位的品牌重塑，引入了专属蓝色气泡视觉标识，并大幅增强了管理员的 ROOT 级风控能力。项目支持多群组聊天、端到端私信、自定义头像，开箱即用，极速部署。

🌍 **线上体验地址**：[http://liuyan.luojunqi.xyz](http://liuyan.luojunqi.xyz)

---

## ✨ V1.5 核心特性

- **🚀 品牌深度定制**：系统正式更名为“信语”，全局适配专属蓝色气泡图标，并支持浏览器 Tab 标签页显示。
- **🖼️ 官方门面升级**：公共大厅默认展示官方 Logo 作为头像，极大提升了品牌正式感与辨识度。
- **🛡️ ROOT 级风控权限**：
  - **群聊冻结**：管理员可在后台一键“冻结”违规群聊，实现即时全员禁言。
  - **头像管控**：管理员拥有最高权限，可强行修改或彻底清除任何违规的用户或群聊头像。
- **🧑‍💻 极致轻量交互**：
  - **Base64 头像存储**：支持上传本地图片，前端自动裁剪压缩，不占服务器静态资源空间，不占带宽。
  - **消息批量管理**：后台支持批量勾选删除留言，维护社区环境更高效。
- **📱 全平台适配**：基于 Tailwind CSS 构建，完美适配手机、平板及电脑端，交互反馈顺滑。

---

## 📖 使用教程

### 1. 普通用户篇
- **入驻与登录**：点击左下角按钮即可快速注册或登录。
- **个性化设置**：登录后点击左上角 **⚙️ 齿轮**，可以自由上传头像、修改昵称、更改密码或注销账号。
- **社交互动**：侧边栏点击 **+** 创建新群聊。点击联系人列表可开启受保护的端到端私信。

### 2. ROOT 管理员篇
符合 `app.py` 中 `ALLOWED_ADMINS` 配置的账号可进入 `/admin` 访问管理后台：
- **💬 留言巡查**：全站发言实时监控，支持批量勾选一键清理。
- **🗂️ 频道管理**：实时掌控所有群聊状态，对违规频道执行冻结或永久解散处理。
- **👥 用户管控**：一键执行账号状态切换（正常/封禁），或针对违规信息重置密码、修改头像。

---

## 🚀 快速部署 (开发者指南)

### 1. 环境准备
确保服务器已安装 **Python 3.8+**。将你的图标重命名为 `favicon.ico` 放入项目根目录。

### 2. 安装依赖
```bash
pip install fastapi uvicorn jinja2 werkzeug pydantic
```
### 3. 配置管理员
打开 app.py，在 ALLOWED_ADMINS 列表中填入你的管理员账号名称。

### 4. 启动服务
```Bash
python app.py
```
默认监听地址：http://0.0.0.0:8000。

##🔑 默认管理员信息
本项目预置了一个初始化账号用于首次登录：

账号：官方账号

密码：12345678


### 5. 默认管理员账号 (针对纯净版数据库)
本项目自带了一个初始化好的 `board.db`。你可以使用以下预设账号登录：
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
