# OpenBoard 项目更新与 GitHub 同步报告

本报告汇总了服务器端与安卓客户端的代码更新内容，并记录了将代码推送到 GitHub 远程仓库的同步状态。

---

## 📊 Git 同步状态

> [!NOTE]
> 上次代码推送至 GitHub 远程仓库。
> *   **远程仓库**: [OpenBoard](https://github.com/luojunqi20111219/OpenBoard-A-modern-minimalist-lightweight-group-chat-and-messaging-platform.git)
> *   **推送分支**: `main`
> *   **最新提交 Hash**: `91c4bda...`
>
> ⚠️ 本次新增的 `openboard-cf/`（Cloudflare 版）与文档改动**尚未提交**，等你确认后再推。

---

## ☁️ 新增：Cloudflare Workers 版（`openboard-cf/`）

在原 FastAPI 版之外新增了一套可部署到 Cloudflare 边缘的实现，**对外 API 完全兼容**，
已发布的 Android / HarmonyOS / Flutter / 网页客户端无需改动即可直连。

### 技术栈替换

| 原实现 | Cloudflare 版 | 原因 |
| :--- | :--- | :--- |
| FastAPI（Python） | Hono（TypeScript） | Python Workers 跑不了 FastAPI，`pydantic-core` 是 Rust 扩展 |
| SQLite 文件 `board.db` | D1 | SQLite 方言，表结构几乎原样迁移 |
| 内存 `ConnectionManager` | Durable Object（WebSocket Hibernation） | 连接存进程内存，边缘多节点下必然失效 |
| 本地 `uploads/` 目录 | R2 | 二进制走对象存储 |
| PyJWT | Web Crypto HMAC-SHA256 | JWT payload 结构不变，旧 token 可直接平移 |
| werkzeug 密码哈希 | PBKDF2-SHA256 | 保持 werkzeug 同格式，旧库 pbkdf2 哈希可直接用 |

### 存储职责划分（重要）

| 存储 | 承担什么 |
| :--- | :--- |
| **D1** | 全部业务数据：用户、消息、群、好友、会话、封禁状态、登录历史 |
| **R2** | 聊天文件、头像、群头像 |
| **KV** | 仅两类：① 登录失败计数/锁定时间 ② 在线用户快照（15 秒 TTL） |

> ⚠️ **KV 是最终一致存储，绝不能放用户账号、会话、封禁状态。**
> 否则会出现「改完密码旧密码还能登录」「封禁后仍可发消息」这类安全漏洞。

### 部署前必须先做

```bash
npm run setup         # 创建 D1 / R2 / KV 并把 id 自动写回 wrangler.toml
npm run preflight     # 本地隔离环境跑 38 项链路自检
npm run check:android # 存量 Android 客户端收消息回归（22 项，改了 WS 入口必跑）
npm run deploy        # npx wrangler deploy，单次部署（含 DO）
```

`KV` 命名空间必须先在你自己账号下创建 —— 没有它，登录限流会整体失效，
账号可被无限次暴力破解。

`npm run check:android` 存在的意义：`/ws/{token}` 是已发布 App 拼出来的地址，
一旦路由参数类型（数组 vs 字符串）或 `WsData` 字段名改动，App 会静默收不到消息。
该脚本会复刻客户端的连接方式并逐字段核对载荷。

---

## 🛠️ 服务器端 (Server) 更新详情

对比远程 GitHub 仓库，服务器端代码进行了多项核心架构和安全性的升级：

### 1. 多设备在线管理与强制下线
*   **数据库修改**: 在 [app/database.py](./app/database.py#L90-L101) 中创建了 `user_devices` 关系表，用于追踪用户活跃设备、Session Token 以及推送令牌。
*   **上限踢出**: 在登录与注册 Token 接口 [app/routes/auth.py](./app/routes/auth.py#L152-L195) 中限制每个账号最多只能有 2 台设备同时保持活跃。当在第 3 台设备登录时，系统会自动删除最老设备的 Session。

### 2. 上传文件格式安全审查 (Whitelist)
*   **安全升级**: 抛弃了原先的黑名单（容易绕过），在 [app/routes/messages.py](./app/routes/messages.py#L17-L33) 中采用了 **白名单机制**：
    ```python
    ALLOWED_EXTENSIONS = {'jpg', 'jpeg', 'png', 'gif', 'pdf', 'docx', 'txt', 'zip'}
    ```
    目前仅允许以上安全格式的文件上传，极大降低了服务器被上传木马/可执行脚本的风险。

### 3. 登录限流落库
*   原先把失败计数放在进程内存，多 worker 下统计不准。现改为可跨进程一致的统计口径，
    15 分钟内失败 5 次即锁定 15 分钟（Cloudflare 版对应 KV + `login_history` 双路径）。

---

## 📱 安卓客户端 (Android Client) 更新详情

本地安卓客户端代码已全部同步回 monorepo 的 `OpenBoardAndroid` 目录中。以下是修复和重构的核心功能：

### 1. 核心 Bug 修复
*   **图片实时渲染**: 修复了此前在聊天界面中发送图片后，图片占位及内容无法实时更新、必须重启 App 才能加载显示的 Bug。

### 2. 交互体验增强
*   **大图查看与保存**:
    *   在聊天列表中点击图片消息即可打开独立的高清大图详情页面。
    *   页面内提供了**保存图片**按钮，允许用户将接收到的图片直接下载并保存至手机相册。
*   **长按文本选择与操作**:
    *   优化了聊天消息的长按手势。长按消息时，上方会弹出操作菜单（如复制、转发、回复等），下方则高亮显示消息文本，支持自由滑动选择部分文本。
*   **引用定位跳转**:
    *   如果在聊天中回复了某条历史消息，点击引用内容会自动定位、滑动并高亮闪烁指示该条被引用的源消息。

### 3. 实时消息接收
*   通过 WebSocket 接收 `type == "message"` 广播包（见 `WsMessage.kt` / `MessageService.kt`）。
*   发送方自己的消息也会被广播回来用于多端同步，客户端已按 `sender == me` 去重，不会重复显示。

---

## 📂 本次变动文件清单

### Cloudflare 版（新增目录 `openboard-cf/`）

| 模块 | 文件路径 | 状态 | 说明 |
| :--- | :--- | :--- | :--- |
| **入口** | `openboard-cf/src/app.ts` | ➕ 新增 | Hono 应用装配，挂载五组路由 + WS + 健康检查 |
| **入口** | `openboard-cf/src/worker.ts` | ➕ 新增 | 独立 Worker 入口（备选部署形态） |
| **入口** | `openboard-cf/src/worker.ts` | ➕ 新增 | Worker 主入口（assets / API / DO 三合一） |
| **认证** | `openboard-cf/src/auth.ts` | ➕ 新增 | JWT 校验、CSRF 同源检查、管理员判定 |
| **认证** | `openboard-cf/src/crypto.ts` | ➕ 新增 | PBKDF2 / JWT HS256 / TOTP（全走 Web Crypto） |
| **数据** | `openboard-cf/src/db.ts` | ➕ 新增 | D1 封装（含 `bind()` 语义修正） |
| **数据** | `openboard-cf/schema.sql` | ➕ 新增 | D1 表结构（20 张表 + 索引 + 种子） |
| **缓存** | `openboard-cf/src/kv.ts` | ➕ 新增 | KV 用途封装：限流计数 + 在线快照，未绑定自动降级 |
| **实时** | `openboard-cf/src/durable/chat.ts` | ➕ 新增 | ChatHub Durable Object（WebSocket Hibernation） |
| **实时** | `openboard-cf/src/realtime.ts` | ➕ 新增 | 广播 / 踢人 / 在线列表（DO 为权威源） |
| **实时** | `openboard-cf/src/durable/chat.ts` | ➕ 新增 | ChatHub Durable Object（同 Worker 内绑定） |
| **路由** | `openboard-cf/src/routes/{auth,messages,groups,friends,admin}.ts` | ➕ 新增 | 五组业务路由，共 80+ 接口 |
| **安全** | `openboard-cf/src/security.ts` | ➕ 新增 | 限流、安全响应头 |
| **安全** | `openboard-cf/src/sanitize.ts` | ➕ 新增 | XSS 清洗、用户名校验、文本裁剪 |
| **前端** | `openboard-cf/public/index.html` | ➕ 新增 | 主聊天页（仅增强 WS 重连） |
| **前端** | `openboard-cf/public/admin.html` | ➕ 新增 | 管理后台（改为 fetch 渲染） |
| **脚本** | `openboard-cf/scripts/setup.sh` | ➕ 新增 | 一键创建 D1 / R2 / KV 并回写配置 |
| **脚本** | `openboard-cf/scripts/deploy.sh` | ➕ 新增 | 一键部署（单 Worker） |
| **脚本** | `openboard-cf/scripts/preflight.mjs` | ➕ 新增 | 部署前 38 项链路自检（隔离环境） |
| **脚本** | `openboard-cf/scripts/android-ws-check.mjs` | ➕ 新增 | 存量 Android 客户端收消息验证（22 项） |
| **脚本** | `openboard-cf/scripts/local_d1_dump.sh` | ➕ 新增 | 本地 D1 导出为 SQL |
| **迁移** | `openboard-cf/migrations/export_from_sqlite.py` | ➕ 新增 | 旧 SQLite → D1 数据导出 |
| **配置** | `openboard-cf/wrangler.toml` | ➕ 新增 | 单文件 Worker 配置（assets / D1 / KV / R2 / DO） |

### 原版（Python / Android）

| 模块 | 文件路径 | 状态 | 说明 |
| :--- | :--- | :--- | :--- |
| **服务器** | `app/database.py` | 📝 修改 | 新增 `user_devices` 结构及 `push_token` 字段 |
| **服务器** | `app/routes/auth.py` | 📝 修改 | 增加设备上报注册及超限踢出接口 |
| **服务器** | `app/routes/messages.py` | 📝 修改 | 上传白名单验证 |
| **服务器** | `templates/index.html` | 📝 修改 | 网页前端轻量化调整 |
| **安卓端** | `OpenBoardAndroid/` | 📝 修改 | 重构打包脚本、界面逻辑 |
| **文档** | `README.md` | 📝 修改 | 新增 Cloudflare 版说明，移除已废弃的 HMS 配置 |
| **文档** | `DEVELOPER_GUIDE.md` | 📝 修改 | 升级到 v9.0.0，补全 API 清单与 Cloudflare 开发流程 |
| **文档** | `.gitignore` | 📝 修改 | 新增 Cloudflare 版构建产物与依赖目录 |
