# 💬 信语 (OpenBoard) - 现代化的极简轻量级群聊与私信平台

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python Version](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-00a67d.svg?logo=fastapi)](https://fastapi.tiangolo.com/)

**信语 (OpenBoard)** 是一个基于 **FastAPI** 和 **SQLite** 构建的现代化极简 Web 聊天室。

在最新的 **V5.0** 架构中，项目迎来了**全方位的安全防护提升与微服务化架构重构**，在保障极致轻量运行（零冗余、省内存）的同时，大幅提高了系统的抗风险能力、代码维护性与高并发承载力。

🌍 **线上体验地址**：[http://liuyan.luojunqi.xyz](http://liuyan.luojunqi.xyz)

---

## ✨ 核心特性更新 (v5.0)

- **🛡️ JWT 强加密通行证**：从旧版随机 Hex 令牌升级为标准的 JSON Web Token (JWT) 加密身份证。免除频繁读库校验，大幅减轻数据库并发负载，并完美向下兼容历史已有登录状态。
- **🧩 现代化模块化包架构**：彻底告别 800 行大杂烩 `app.py`，合理重构划分为 `config`、`database`、`auth`、`websocket` 与解耦的 `routes/` 路由分区，让后续功能扩展极其方便。
- **🗃️ 杜绝 SQLite 锁表假死**：引入 FastAPI 依赖注入级别的 `get_db()` 自动生成器，通过 `yield` 保证每个 HTTP/WebSocket 请求完毕后强制自动关闭链接，从根源治愈 SQLite `database is locked` 报错。
- **🔒 安全 Cookie 后端硬拦截**：首屏访问 `/admin` 管理页面时，后端直接校对 Cookie 中的 JWT。非管理员一律 303 安全重定向拦截退回，杜绝任何 Curl 爬虫越权或禁用 JavaScript 数据泄露。
- **🛡️ 铁律级官方账号防护**：对 `"官方账号"` 实施系统最高指令级防护（禁止被删除、注销或封禁）。解禁了普通 `"admin"` 账号的特权，防范系统管理员权限失联。
- **📁 多平台一键部署运行**：同时提供 `run.bat` (Windows) 与 `run.sh` (Linux/macOS，包含 ANSI 彩色日志高亮) 一键配置环境与拉起服务脚本，极大降低部署门槛。
- **🛡️ 多维文件上传与 XSS 安全红线**：
  - 限制最大上传大小为 `10MB`，自动过滤 `.py`、`.sh` 等一切可执行文件上传。
  - 文件名采用 `uuid.uuid4()` 随机随机化，防止目录越权遍历及重名碰撞。
  - 消息正文结合前端防溢出与后端 XSS 过滤净化，彻底封杀注入漏洞。
- **🧑‍💻 全平台自适应交互**：完美适配手机、平板及电脑端，全站交互无刷新顺滑体验。

---

## 📖 使用教程

### 1. 启动与部署 (一键双击)
* **Windows 部署**：直接双击运行根目录下的 **`run.bat`**。
* **Linux / macOS 部署**：打开终端，执行以下指令：
  ```bash
  chmod +x run.sh
  ./run.sh
  ```
> **注**：一键脚本会自动为您校验 Python 环境，并自动执行 `pip install -r requirements.txt` 补齐运行依赖！

### 2. 普通用户篇
- **入驻与登录**：点击左下角按钮即可快速注册或登录。
- **个性化设置**：登录后点击左上角 **⚙️ 齿轮**，可以自由上传头像、修改昵称、更改密码或注销账号。
- **社交互动**：
  - 侧边栏点击 **+** 创建新群聊。群主可在群设置中配置黑白名单权限。
  - 支持在聊天框发送文字、图片和文件；点击发送后的消息可执行撤回（2分钟内有效）。
  - 点击联系人列表可开启受保护的端到端私信。

### 3. 超级管理员篇
符合权限的账号在主页右上角可直访 `/admin` 页面（默认账号：`官方账号` / 密码：`12345678`）：
- **💬 留言巡查**：全站发言实时监控，支持批量勾选一键清理。
- **🗂️ 频道管理**：实时掌控所有群聊状态，对违规群聊进行冻结全员禁言或批量一键解散。
- **👥 用户管控**：一键执行账号状态切换（正常/封禁），或针对违规信息重置密码、修改头像。
- **📢 全局公告**：发布公告消息实时精准推送至每个在线用户的通知铃铛。

---

## 📂 项目结构
```text
OpenBoard/
├── app/                 # 重构后的微服务化核心包
│   ├── config.py        # 全局配置中心 (JWT密钥、上传白名单)
│   ├── database.py      # SQLite连接生成与用完自动回收器、数据种子化
│   ├── auth.py          # JWT加解密与当前登录态/管理员权限拦截
│   ├── models.py        # Pydantic 校验和传输数据格式模型
│   ├── websocket.py     # 长连接管理器，负责 typing 提示与广播
│   └── routes/          # 业务逻辑接口分区
│       ├── auth.py      # 登录、注册、修改密码及资料
│       ├── messages.py  # 发言、获取、撤回、文件上传下载
│       ├── groups.py    # 群组创建、解散、头像及权限设置
│       └── admin.py     # 后台删帖、冻结、禁言、公告
├── app.py               # 高向下兼容性的重定向入口
├── board.db             # 本地轻量级 SQLite 数据库 (已加入 gitignore)
├── favicon.ico          # 品牌专属气泡图标
├── requirements.txt     # 升级后的依赖清单
├── .gitignore           # 拦截缓存及机密上传的 Git 规则文件
├── run.bat              # Windows 一键自动装库与部署脚本
├── run.sh               # macOS / Linux 一键自动装库与部署脚本
└── templates/           # 精美前台界面模板
    ├── index.html       # 信语客户端交互主页
    └── admin.html       # 管理员后台面板 (Jinja2 安全加强版)
```

## 🖥️ C++ 桌面客户端 (Desktop Client)

本项目提供了一个基于 C++ 的超轻量级原生桌面客户端（启动即开，体积仅约 700KB）。它通过 Windows 原生 Edge WebView2 渲染器直接载入信语聊天界面。

### 编译运行

如果你需要重新编译桌面客户端，请确保系统已安装 GCC/MinGW 编译器，并运行以下编译指令：
```bash
# 编译命令
g++ main.cpp -o OpenBoard.exe -Iwebview2_sdk/build/native/include -DWEBVIEW_MSWEBVIEW2_EXPLICIT_LINK=1 -lole32 -lcomctl32 -loleaut32 -luuid -lversion -lshlwapi -mwindows -std=c++17
```

---

## 📄 开源协议
本项目采用 [MIT License](LICENSE) 开源协议。欢迎提交 PR 或 Issue。
