# 💬 信语 (OpenBoard) 全平台多端开发者集成与开发指南 (v9.0.0)

本指南旨在协助全球开源开发者（包括移动端 App、小程序、桌面端 Electron、以及第三方接入开发者）快速接入并统一 **信语 (OpenBoard) v9.0.0** 的 API 接口，并提供跨平台统一的 UI 基础规范，以便实现各端一致的轻量极简用户体验。

> [!NOTE]
> **服务端有两套实现，接口完全一致：**
> - **方案 A｜Python / FastAPI**（`app/`）：自托管部署，见根目录 `README.md` 方案 B
> - **方案 B｜Cloudflare Workers**（`openboard-cf/`）：边缘部署，数据存 D1、文件存 R2、WebSocket 由 Durable Object 承载
>
> 两套实现共用同一份接口契约，客户端无需区分，只需把 `BASE_URL` 指向对应服务端即可。

---

## 🧭 全平台统一 UI 布局与设计规范

为保持各平台（iOS/Android/Web/小程序/桌面端）体验一致性，我们定义了以下极简自适应 UI 结构：

### 1. 核心骨架布局 (Core Layout)
推荐采用 **左侧主导航 + 右侧聊天视窗**（移动端可自适应折叠为侧边栏滑动或底部 Tab）：
* **侧边栏 (Sidebar)**：
  * 顶部：应用 Logo 与全局状态标识（在线/连接中）。
  * 频道列表区（`GET /api/groups`）：显示加入的群组，当前激活群组置灰/高亮，群主频道右侧带有 👑 皇冠图标。
  * 联系人列表区（`GET /api/users`）：展示全站活跃联系人，头像右下角配备在线绿点（结合 WebSocket 在线列表计算）。
  * 底部：当前登录用户头像、昵称、个人设置入口（⚙️ 齿轮）与通知中心（🔔 铃铛）。
* **聊天主面板 (Chat Panel)**：
  * 顶部栏 (Header)：当前聊天对象或群组名称，左侧显示头像，右侧配备操作按钮（群组显示 ⚙️ 群设置，单聊显示 🚫 拉黑）。
  * 消息滚动区 (Message Log)：展示消息流，滚动条默认锁定最底部，支持向上拉取加载历史。
  * 底部输入栏 (Input Panel)：集成表情选择（😀 弹窗）、文件/图片上传（📎 附件图标）与多行文本输入框，右侧为发送（🚀 纸飞机）按钮。

### 2. 消息气泡卡片 (Message Bubble Card)
为了统一各端视觉体验，消息气泡样式设计铁律如下：
* **我发送的消息 (Self Message)**：
  * 气泡居右，右侧贴边展示我的头像。
  * 气泡背景色采用品牌主色调（推荐亮丽天蓝色/深邃蓝 `bg-blue-600`），文字呈纯白色。
  * 悬停/长按气泡，在 2 分钟内可气泡下方呼出“撤回”小按钮。
* **他人发送的消息 (Other Message)**：
  * 气泡居左，左侧贴边展示他人头像。
  * 气泡上方用灰色小字标注发送者昵称。
  * 气泡背景色采用纯白色或极浅灰，文字为深灰黑色，气泡边缘带轻微边框或阴影。
* **特殊消息语法渲染**：
  * 图片语法 `[img:图片地址]`：UI 端检测正则匹配后，不展示纯文字，而是将其渲染为可点击放大的缩略图片组件。
  * 文件语法 `[file:下载地址|文件名]`：UI 端渲染为一个精致的文件下载卡片，包含文件图标、文件名和下载动作。
  * 撤回消息 `[system_recalled]`：消息正文隐去，渲染为居中的“`[昵称]` 撤回了一条消息”系统灰色气泡。

---

## 🔌 v9.0.0 接口大全 (全功能 API 规范)

> [!IMPORTANT]
> **接口通信规范**：
> - 接口前缀统一为 `/api`
> - 所有需要授权的接口，必须在 HTTP Header 中携带：`Authorization: Your-JWT-Token`

### 📋 全功能映射表 (18大核心功能与接口对照)

为了方便多端开发者快速实现与网页端完全一致的完整功能，以下是全站 **18 大核心功能** 与对应 API 接口及参数的 1:1 对照表：

| 序号 | 核心功能需求 | 接口端点 / 通信通道 | 请求方法 | 核心参数及开发说明 |
|:---:|:---|:---|:---:|:---|
| **1** | 注册用户 | `/api/register` | `POST` | `username`, `password`, `nickname` (选填) |
| **2** | 登录 | `/api/login` | `POST` | `username`, `password` |
| **3** | 在公共大厅发送信息 | `/api/messages` | `POST` | `room_id = 0`, `receiver = null` |
| **4** | 在群聊发送信息 | `/api/messages` | `POST` | `room_id = 目标群聊ID`, `receiver = null` |
| **5** | 在私信发送信息 | `/api/messages` | `POST` | `room_id = 0`, `receiver = "对方用户名"` |
| **6** | 群聊管理员修改发言黑/白名单 | `/api/groups/{group_id}/permissions` | `PUT` | `speak_mode` (0/1), `black_speak`, `white_speak` (以逗号分隔) |
| **7** | 群聊管理员修改入群(查看)黑/白名单 | `/api/groups/{group_id}/permissions` | `PUT` | `view_mode` (0/1), `black_view`, `white_view` (以逗号分隔) |
| **8** | 群聊管理员修改群聊头像 | `/api/groups/{group_id}/avatar` | `POST` | `avatar` (图片 Base64 字符串) |
| **9** | 设置昵称 | `/api/user/profile` | `POST` | `nickname` (新昵称字符串) |
| **10** | 设置头像 | `/api/user/profile` | `POST` | `avatar` (图片 Base64 字符串) |
| **11** | 修改密码 | `/api/user/password` | `PUT` | `old_password`, `new_password` |
| **12** | 查看对方是否在线 | `WS /ws/{token}` | `WebSocket` | 监听 `type == "online_status"` 在线列表广播，挂载 UI 绿点 |
| **13** | 拉黑/解黑用户 | `/api/user/block` | `POST` | `target_username` |
| **14** | 永久注销账号 | `/api/user/account` | `DELETE` | 注销当前登录用户（系统被保护账号除外） |
| **15** | 查看是否正在输入 | `WS /ws/{token}` | `WebSocket` | 客户端发送与监听 `type == "typing"` 广播帧，UI 配合 3s 定时器 |
| **16** | 获取全站用户列表 | `/api/users` | `GET` | 载入全站用户的昵称、头像，以及当前用户的拉黑名单 |
| **17** | 获取已加入及公开群聊列表 | `/api/groups` | `GET` | 自动根据用户权限黑白名单进行权限过滤后返回列表 |
| **18** | 创建新群组 | `/api/groups` | `POST` | `name` (群聊名称), `is_public` (默认1) |

---

### 📚 v7.7 / v8.0 新增接口（v4.0.0 指南之后补齐）

v4.0.0 之后项目新增了消息可靠性、群管理、安全中心等大量能力，以下为完整补充。
**接口前缀统一为 `/api`**，除标注「公开」外均需 `Authorization` 头。

#### 消息能力（弱网可靠 · 可检索 · 可管理）

| 接口端点 | 方法 | 说明 |
|:---|:---:|:---|
| `/messages` | `GET` | 游标分页拉取。参数：`room_id` / `target_user` / `before_id` / `after_id` / `limit`（上限 50） |
| `/messages/{id}/forward` | `POST` | 转发消息到指定 `room_id` 或 `receiver` |
| `/messages/{id}` | `PUT` | 编辑消息（**2 分钟内**，仅本人） |
| `/messages/{id}` | `DELETE` | 撤回消息（2 分钟内本人，或管理员随时） |
| `/messages/read` | `POST` | 已读回执上报：`msg_ids` / `conversation_key` + `last_read_id` |
| `/messages/{id}/reads` | `GET` | 查询某条消息的已读名单 |
| `/messages/search` | `GET` | 全文搜索：`q`、`room_id`、`type`（`all`/`private`） |
| `/messages/export` | `GET` | 导出聊天记录 |
| `/messages/import` | `POST` | 导入聊天记录（单次上限 2000 条） |
| `/favorites/messages` | `GET` | 收藏的消息列表 |
| `/favorites/messages/{id}` | `POST` / `DELETE` | 收藏 / 取消收藏 |
| `/favorites/emojis` | `GET` / `POST` | 收藏表情列表 / 添加 |
| `/favorites/emojis/delete` | `POST` | 删除收藏表情 |
| `/conversation-settings` | `GET` / `PUT` | 跨设备同步置顶、免打扰、最近已读位置 |

> **弱网可靠发送**：发送消息时携带 `client_id`（客户端生成的幂等 ID）。
> 服务端按 `(name, client_id)` 建唯一索引去重，重发会返回 `{"duplicate": true}` 与首次的 `id`，
> 客户端可据此安全重试而不产生重复消息。

#### 群管理（公告 · 审核 · 权限 · 审计）

| 接口端点 | 方法 | 说明 |
|:---|:---:|:---|
| `/groups` | `PUT` | 修改群名称与公开性 |
| `/groups/{id}/advanced` | `PUT` | 群公告、成员可见（`member_only`）、入群审核（`join_approval`） |
| `/groups/discover` | `GET` | 发现公开群（带 `joined`、`member_count`） |
| `/groups/{id}/join` | `POST` | 申请入群；开启审核时转为待审批 |
| `/groups/{id}/join-requests` | `GET` | 待审批入群申请列表 |
| `/groups/{id}/join-requests/respond` | `POST` | 审批：`username` + `action`(`accept`/`reject`) |
| `/groups/{id}/invite` | `POST` | 邀请用户入群 |
| `/group-invites` | `GET` | 我收到的群邀请 |
| `/group-invites/respond` | `POST` | 处理群邀请 |
| `/groups/{id}/members` | `GET` | 群成员列表 |
| `/groups/{id}/members/{username}` | `PUT` | 设置成员角色（`admin`/`member`）或禁言（`muted_until`） |
| `/groups/{id}/members/{username}` | `DELETE` | 移除成员 / 主动退群 |
| `/groups/{id}/audit` | `GET` | 群操作审计日志 |
| `/groups/{id}` | `DELETE` | 解散群聊（仅群主或站点管理员） |

#### 安全中心（登录历史 · 两步验证 · 设备管理）

| 接口端点 | 方法 | 说明 |
|:---|:---:|:---|
| `/user/security` | `GET` | 安全设置概览（2FA、已读回执、拉黑名单） |
| `/user/security/preferences` | `PUT` | 修改已读回执隐私开关 |
| `/user/login-history` | `GET` | 最近 50 条登录记录（含 IP、地区、设备） |
| `/user/devices` | `GET` | 已登录设备列表 |
| `/user/devices/register` | `POST` | 登记当前设备 |
| `/user/devices/{device_id}/logout` | `POST` | 远程退出指定设备 |
| `/user/logout-all` | `POST` | 退出全部设备（同时踢下线所有 WebSocket） |
| `/user/two-factor/setup` | `POST` | 生成 TOTP 密钥与 `otpauth://` 链接 |
| `/user/two-factor/confirm` | `POST` | 校验动态码并启用 2FA |
| `/user/two-factor/disable` | `POST` | 关闭 2FA（需动态码） |
| `/user/push_token` | `POST` | 上报推送 Token |

> 登录时若账号已启用 2FA，请求需额外携带 `otp` 字段；
> 服务端在未提供或校验失败时返回 `401` 并带响应头 `X-OpenBoard-2FA: required`，
> 客户端应据此弹出动态码输入框。

#### 扫码登录

| 接口端点 | 方法 | 说明 |
|:---|:---:|:---|
| `/qr/generate` | `GET` | 生成扫码会话，返回 `qr_id` 与 `expires_in` |
| `/qr/status` | `GET` | 轮询状态：`pending` / `scanned` / `authorized`；授权后直接下发 Token |
| `/qr/scan` | `POST` | 已登录端扫码确认（需登录） |
| `/qr/authorize` | `POST` | 已登录端确认授权（需登录） |

#### 好友系统

| 接口端点 | 方法 | 说明 |
|:---|:---:|:---|
| `/users/search` | `GET` | 搜索用户，返回 `is_friend`、`request_status`、`request_direction` |
| `/friends` | `GET` | 好友列表（首项固定为「文件传输助手」） |
| `/friends/requests` | `GET` | 收到的好友申请 |
| `/friends/request` | `POST` | 发起申请；若对方已申请则自动互加 |
| `/friends/respond` | `POST` | 处理申请：`username` + `action`(`accept`/`reject`) |
| `/friends/{username}` | `DELETE` | 删除好友 |

> ⚠️ **发送私聊的前置条件**：非管理员向非 `filehelper` 用户发私信时，
> 服务端会校验双方是否为好友，否则返回 `403 你们还不是好友，无法发送私信`。

#### 站点管理（需管理员）

| 接口端点 | 方法 | 说明 |
|:---|:---:|:---|
| `/admin/overview` | `GET` | 后台概览：用户、消息、群、在线列表 |
| `/admin/toggle_freeze_group` | `POST` | 冻结 / 解冻群聊（冻结后全员禁言） |
| `/admin/delete_user` · `/admin/delete_group` · `/admin/delete_groups` | `POST` | 删除用户 / 解散群聊（支持批量） |
| `/delete_messages` | `POST` | 批量撤回消息 |
| `/toggle_ban_user` | `POST` | 封禁 / 解封用户（封禁会立即踢下线） |
| `/admin/reset-password` | `POST` | 重置指定用户密码 |
| `/admin/update_user_avatar` · `/admin/update_group_avatar` | `POST` | 修改头像（接受 base64） |
| `/admin/broadcast` | `POST` | 发布全局公告 |

---

### 🧭 服务端实现差异对照（客户端无需关心，服务端开发者需知）

| 关注点 | FastAPI 版 | Cloudflare 版 |
|:---|:---|:---|
| 路由装配 | `app/main.py` 的 `include_router` | `src/app.ts` 的 `app.route('/api', ...)` |
| 取数据库 | `db = Depends(get_db)` | `qAll/qOne/exec(env.DB, ...)` |
| 取登录态 | `Depends(get_current_user)` | `requireAuth` 中间件 + `c.get('user')` |
| 取管理员 | `Depends(get_current_admin)` | `requireAuth, requireAdmin` 双中间件 |
| 广播消息 | `await manager.broadcast(...)` | `await broadcast(env, { message, receiver, sender })` |
| 文件存储 | 本地 `uploads/` 目录 | R2，经 `/api/download/{key}` 读取 |
| WebSocket 路径 | `/ws`（Cookie）与 `/ws/{token}` | 同上，另支持 `/api/ws` 与 `/api/ws/{token}` |
| 登录限流 | 进程内存计数 | KV 计数（未绑 KV 时降级查 `login_history`） |

---

### 一、 用户与认证模块 (Auth & User)

#### 1. 用户注册
* **接口**：`POST /api/register`
* **Payload** (JSON)：
  ```json
  {
    "username": "your_username",
    "password": "your_password",
    "nickname": "Optional_nickname"
  }
  ```
* **返回**：返回 JWT 签名 Token 及身份标识。写入并同步更新 Cookie `token`。

#### 2. 用户登录
* **接口**：`POST /api/login`
* **Payload** (JSON)：
  ```json
  {
    "username": "your_username",
    "password": "your_password"
  }
  ```
* **返回**：成功后返回 JWT `token`、`role` 等用户信息。写入并同步更新 Cookie `token`。

#### 3. 用户登出
* **接口**：`POST /api/logout`
* **返回**：清除安全 Cookie。客户端删除 localStorage 本地缓存并退回登录页。

#### 4. 修改密码
* **接口**：`PUT /api/user/password` (需 Authorization)
* **Payload**：`{"old_password": "...", "new_password": "..."}`

#### 5. 个人资料更新
* **接口**：`POST /api/user/profile` (需 Authorization)
* **Payload**：`{"nickname": "新昵称", "avatar": "data:image/jpeg;base64,..."}`

#### 6. 拉黑/解黑用户
* **接口**：`POST /api/user/block` (需 Authorization)
* **Payload**：`{"target_username": "target_name"}`
* **返回**：返回当前拉黑状态 `is_blocked: true/false`，UI 端过滤该用户的聊天气泡。

#### 7. 永久注销账号
* **接口**：`DELETE /api/user/account` (需 Authorization)
* **安全限制**：被保护的 `"官方账号"` 无法注销。

#### 8. 获取全站用户列表
* **接口**：`GET /api/users` (需 Authorization)
* **返回**：返回全站用户的昵称、头像以及当前登录用户的黑名单列表。

---

### 二、 群组与频道管理模块 (Groups & Channels)

#### 1. 获取已加入及公开群聊列表
* **接口**：`GET /api/groups`
* **鉴权说明**：Authorization 头可选。若携带，会自动校验黑白名单，仅放行可看/可加入的群组列表。

#### 2. 创建新群组
* **接口**：`POST /api/groups` (需 Authorization)
* **Payload**：`{"name": "群名字", "is_public": 1}`
* **返回**：群组 `group_id`。

#### 3. 修改群组名称
* **接口**：`PUT /api/groups/{group_id}` (需 Authorization)
* **限权**：仅群主或系统管理员可修改。

#### 4. 配置群组权限 (黑白名单)
* **接口**：`PUT /api/groups/{group_id}/permissions` (需 Authorization)
* **Payload**：
  ```json
  {
    "view_mode": 0, // 0-公开(拉黑禁看), 1-私密(白名单可看)
    "speak_mode": 0, // 0-公开(拉黑禁言), 1-全员禁言(仅白名单可言)
    "black_view": "userA,userB", // 逗号分隔的用户名
    "white_view": "",
    "black_speak": "",
    "white_speak": "userC"
  }
  ```

#### 5. 更改群组头像
* **接口**：`POST /api/groups/{group_id}/avatar` (需 Authorization)
* **Payload**：`{"avatar": "Base64图片字符串"}`

#### 6. 解散群组
* **接口**：`DELETE /api/groups/{group_id}` (需 Authorization)
* **注意**：公共大厅 (ID: 0) 受到保护，禁止解散。

---

### 三、 聊天与消息通信模块 (Messages & Chat)

#### 1. 获取消息历史记录
* **接口**：`GET /api/messages` (需 Authorization)
* **查询参数**：
  * 群聊：`?room_id=群ID`
  * 私信：`?target_user=对方用户名`
* **返回**：返回最近 100 条聊天历史。已自动根据黑名单列表过滤。

#### 2. 发送普通消息
* **接口**：`POST /api/messages` (需 Authorization)
* **Payload**：
  ```json
  {
    "content": "消息正文",
    "room_id": 0, // 0代表公共大厅，其余为对应群聊 ID
    "receiver": null, // 私信时填入对方用户名， room_id 设为 0
    "reply_to": null // 回复某条消息的 ID (选填)
  }
  ```
* **核心动作**：后端自动执行 XSS bleach 过滤 -> 写入 DB -> 触发 WebSocket 广播。

#### 3. 安全消息撤回
* **接口**：`DELETE /api/messages/{msg_id}` (需 Authorization)
* **限制规则**：非管理员仅可撤回 **2 分钟内** 的自发消息。

#### 4. 多媒体/图片/文档文件上传
* **接口**：`POST /api/upload` (需 Authorization)
* **Payload** (Multipart Form-Data)：`file: Binary`
* **安全校验**：最大大小 `10MB`，仅支持安全后缀，后端使用随机 UUID 进行高安全性重命名。
* **返回**：
  ```json
  {
    "status": "success",
    "url": "/uploads/random_uuid.jpg", // 图片展示链接
    "filename": "1790403653407-9037731a2110a12c.png",
    "url": "/api/download/1790403653407-9037731a2110a12c.png",  // 文件下载地址
    "thumbnail_url": null,   // 缩略图；Cloudflare 版无服务端图片处理，恒为 null，客户端回退原图
    "is_image": true,
    "size": 74,
    "type": "image/png",
    "original_name": "原始文件名.png"
  }
  ```

> **文件名规则**：`{毫秒时间戳}-{16位随机十六进制}.{ext}`，不可枚举。
> 上传限制：单文件 50MB，白名单扩展名 `jpg/jpeg/png/gif/webp/bmp/pdf/docx/txt/zip/apk`。

> **图片直链注意**：`/api/download/{key}` **默认不校验登录态**。
> 因为前端是以 `<img src="/api/download/xxx.png">` 直接加载图片的，浏览器不会在 `<img>`
> 请求中附带 `Authorization` 头，强制鉴权会导致所有图片无法显示。
> 安全性由随机文件名（等同 capability token）保证。
> 若确需私有化，可将服务端 `PUBLIC_UPLOADS` 设为 `false`，改用登录态或 `?sig=` 签名访问。

#### 5. 文件下载接口
* **接口**：`GET /api/download/{filename}?name=原始名称`
* **安全设计**：采用 `os.path.basename` 拦截目录遍历注入，直接返回安全的文件二进制流。

#### 6. WebSocket 实时双向管道
支持以下四种建连方式，**推荐用前两种**（凭证不出现在 URL 与访问日志中）：

| 路径 | 鉴权方式 | 适用场景 |
|:---|:---|:---|
| `WS /api/ws` | Cookie `token` | 网页端（推荐） |
| `WS /api/ws/{token}` | URL 携带 Token | 原生客户端（兼容） |
| `WS /ws` | Cookie `token` | 旧网页端路径（兼容保留） |
| `WS /ws/{token}` | URL 携带 Token | 已发布的旧客户端（兼容保留） |

* **说明**：建立实时长连接。单用户连接数上限由服务端 `MAX_CONNECTIONS_PER_USER` 控制（默认 4），
  超出时最旧连接会被以 `1013` 关闭；被强制下线时以 `4001` 关闭。

> **Cloudflare 版实现说明**：WebSocket 广播由 Durable Object（`ChatHub`）承载并启用了
> WebSocket Hibernation —— 连接空闲时 DO 可被逐出内存而不掉线，显著降低长连接成本。

---

### 🟢 WebSocket 实时状态流深度细化（在线状态与“对方正在输入”）

为了确保 Web 网页端、移动端 App、小程序等多端能完美互通并同步在线状态和正在输入状态，各平台开发者必须严格遵循以下 WebSocket 协议交互规范：

#### 1. 🟢 在线状态同步 (Online Status Sync)
- **触发机制**：任何一端（Web 网页、移动 App 客户端）与 `ws://<server_host>/ws/{token}` 成功建立 WebSocket 握手后，后端会在全局连接池中登记该用户，并**即时向全网所有在线的客户端广播**最新的在线用户列表。
- **服务器推送的广播帧 (Server to Client)**：
  ```json
  {
    "type": "online_status",
    "users": ["官方账号", "xiaoming", "app_user_99"]
  }
  ```
- **客户端 (Web/App) 渲染逻辑**：
  - 客户端在监听 WS 时，一旦收到 `type == "online_status"`，必须提取 `users` 数组。
  - 在用户列表 UI 组件中，遍历全站用户，若用户名存在于 `users` 数组中，则在头像右下角渲染**绿色在线小圆点**；若不在，则移除小圆点或置灰。
  - **跨端互通**：Web 网页端和 App 客户端共享同一套连接池，App 用户上线后，Web 网页端的联系人列表对应头像会瞬间亮起绿灯。

---

#### 2. ✍️ “对方正在输入...” 状态实时感知 (Cross-Platform Typing Indicator)
为了实现“网页端可以看到 App 用户正在输入，App 也能看到网页用户正在输入”的无缝跨平台体验，开发流程如下：

```text
  发送端 (Web/App)                   FastAPI WebSocket 服务                  接收端 (App/Web)
       │                                     │                                     │
       ├────────────── 发送输入帧 ───────────>│                                     │
       │  {"type":"typing", "room_id":1}     │                                     │
       │                                     │─── 过滤并分发推送 ─────────────────>│
       │                                     │  {"type":"typing", "user":"userA"}  │
       │                                     │                                     │呈现 "对方正在输入..."
       │                                     │                                     │开启 3秒自动消失定时器
```

##### 📤 步骤一：发送端 (Web / App) 状态上报
* **触发条件**：当用户在当前聊天窗口的输入框内按键输入（`oninput` / `keydown` 监听）时。
* **频率限制（重要）**：为防止频繁按键产生海量 WS 帧压垮服务器，客户端必须做**节流阀限频（防抖节流）**——每次上报事件后，**至少间隔 2.5 秒**才能允许发送下一次。
* **发送给 WS 的数据帧 (Client to Server)**：
  ```json
  {
    "type": "typing",
    "room_id": 0, // 如果是在群聊中输入，填入该群 ID；如果是私聊单聊，填入 0
    "receiver": "接收端用户名" // 如果是私聊，填入对方的 username；如果是群聊，填入 null
  }
  ```

##### 📥 步骤二：接收端 (App / Web) 消息捕获与渲染
* **服务器中转逻辑**：后端 WebSocket 收到该输入帧后，如果是私信，会仅中转发送给发送者和接收者；如果是群聊，会广播。发送出的 JSON 广播帧格式为：
  ```json
  {
    "type": "typing",
    "user": "发送端用户名", // 谁在输入
    "room_id": 0, // 对应的群聊 ID
    "receiver": "接收端用户名" // 对应的接收者
  }
  ```
* **接收端 (Web/App) 接收判定**：
  1. 接收端收到 `type == "typing"` 帧后，首先判断 `user` 是否是自己。如果是自己发出的，**必须直接忽略**。
  2. 接着，判断当前用户屏幕上**激活打开的聊天窗口**是否与推送来的频道一致：
     * **群聊**：当前激活群聊 ID 是否等于 `room_id`。
     * **单聊**：当前激活的私聊对象用户名是否等于 `user`。
  3. **UI 渲染呈现**：
     * 如果条件吻合，在聊天视窗的顶部标题栏下方（或底部输入框上方）展示一个轻盈的闪烁动画，如：`"对方正在输入..."`（或 `"${nickname} 正在输入..."`）。
  4. **自动清空机制 (Timeout Timer)**：
     * **非常关键**：在展示输入状态的同一时刻，客户端必须在后台启动一个 **3 秒的单次定时器 (Timeout Timer)**。
     * 如果 3 秒内没有收到来自同一个用户的下一个 `typing` 帧，定时器触发，**必须自动隐去该输入提示标签**。
     * 如果 3 秒内又收到了来自该用户的下一个 `typing` 帧，则**立即清除旧定时器，重新启动一个新的 3 秒定时器**，以此实现平滑的正在输入动效。

---

### 四、 公告与系统升级模块 (Notifications & Update)

#### 1. 拉取系统公告
* **接口**：`GET /api/notifications` (需 Authorization)
* **返回**：最近 20 条系统通知公告，并返回最后一次已读的公告 ID（`last_read_id`），以便 UI 端在铃铛上高亮显示未读红点。

#### 2. 标记所有公告已读
* **接口**：`POST /api/notifications/read` (需 Authorization)
* **返回**：`last_read_notice_id`，客户端据此清除铃铛红点。

#### 2.1 健康检查（Cloudflare 版提供，公开）
* **接口**：`GET /api/health`
* **返回**：`{ "status": "ok", "runtime": "cloudflare-workers", "version": "v9.0.0", "online_count": 2 }`
* **用途**：探活、监控、以及快速确认在线人数。

#### 3. 查询服务端版本
* **接口**：`GET /api/check_update`（公开，无需鉴权）
* **返回**：
  ```json
  {
    "version": "v9.0.0",
    "repo": "luojunqi20111219/OpenBoard-...",
    "runtime": "cloudflare-workers",   // 或 "fastapi"
    "force_update": false
  }
  ```
* **说明**：**Python 版**会读取 GitHub Release 判断是否有新版本（返回 `has_update` / `latest` / `body` / `url`）；
  **Cloudflare 版**直接返回服务端自身版本号，不访问 GitHub。客户端应同时兼容两种返回结构。



## 🛠️ 后端升级、接口推荐与功能开发规范

当您想在项目中添加新的业务功能或接口时，请**绝对遵循**以下规范。
项目有两套服务端实现，新增功能时请**两边同步实现**，以保证接口契约一致。

### 方案 A：Python / FastAPI（`app/`）

#### Step 1: 新增入参校验模型 (`app/models.py`)
在 `app/models.py` 中使用 Pydantic 规范一个新的传输实体类，规范其字长、格式等。

#### Step 2: 拆分开发具体路由 (`app/routes/`)
根据您的功能定位，在 `app/routes/` 的对应分区下开发接口。例如新聊天玩法写在 `routes/messages.py`，新安全核查写在 `routes/admin.py`：
* **如何安全取得数据库链接**：
  直接在函数参数中声明依赖注入 `db = Depends(get_db)`。生命周期全托管，**无需在函数内手动调用 db.close()，框架会自动在请求返回时优雅关门回收**。
* **如何取得登录身份/管理员身份**：
  * 需要登录才能使用：`current_user = Depends(get_current_user)`
  * 需要管理员权限才能使用：`current_admin = Depends(get_current_admin)`

#### Step 3: 在 `app/main.py` 中挂载并组装
在主路由总装口 `app/main.py` 中，使用 `app.include_router(your_module.router)` 将接口无缝接入。

#### Step 4: 测试
* 本地双击 `run.bat` (Win) 或在终端执行 `./run.sh` (Linux/Mac) 进行热重载开发调试。

---

### 方案 B：Cloudflare Workers（`openboard-cf/`）

#### Step 1: 在 `src/routes/` 对应分区新增路由
```ts
import { Hono } from 'hono';
import type { HonoEnv, Env } from '../auth';
import { requireAuth } from '../auth';
import { qAll, qOne, exec } from '../db';

export const messageRoutes = new Hono<HonoEnv>();

messageRoutes.get('/your-endpoint', requireAuth, async (c) => {
  const e = c.env as Env;
  const user = c.get('user');                    // requireAuth 已注入
  const rows = await qAll(e.DB, 'SELECT ... WHERE username=?', user.username);
  return c.json({ status: 'success', data: rows });
});
```

* **取数据库**：`qOne` / `qAll` / `exec(env.DB, sql, ...params)`
* **取登录态**：`requireAuth` 中间件，然后 `c.get('user')`；Token 在 `c.get('token')`
* **取管理员**：`requireAuth, requireAdmin` 双中间件
* **广播消息**：`await broadcast(env, { message, receiver, sender, room_id })`
* **文件读写**：`env.UPLOADS.put(key, stream)` / `env.UPLOADS.get(key)`（R2）

> ⚠️ **D1 参数绑定陷阱**：`stmt.bind()` 返回**新对象**，不能原地调用。始终使用封装好的
> `bind(db, sql, params)` 或 `qAll/qOne/exec`，不要写 `db.prepare(sql).bind(...)` 后忽略返回值。

> ⚠️ **KV 使用红线**：KV 是最终一致存储（写入后全球生效需数十秒）。
> **绝不可**用 KV 存用户账号、会话、封禁状态 —— 会导致「改完密码旧密码仍能登录」这类安全问题。
> KV 仅用于限流计数、可陈旧的在线快照；业务数据一律进 D1。

#### Step 2: 在 `src/app.ts` 挂载
```ts
app.route('/api', yourRoutes);
```

#### Step 3: 本地验证与部署
```bash
cd openboard-cf
npm run typecheck                        # 必须零错误
npx wrangler d1 execute openboard-db --local --file=./schema.sql
npx wrangler dev --config wrangler.worker.toml   # 本地调试 API + DO
npx wrangler deploy --config wrangler.do.toml    # 部署 Durable Object
npx wrangler pages deploy public                 # 部署前端 + API
```

> 新增数据表时，需同步更新 `schema.sql`，并对已有库执行迁移 SQL。

---

### Step 5: 提交与发布
编写完成后，依次运行以下三步将其干净地提交并发布至 GitHub 官方分支：
```bash
git add .
git commit -m "feat: 描述您的新功能"
git push origin main
```
*(注：`.gitignore` 已经为您做好了护航，绝不会泄露任何本地测试库、uploads 文件或 wrangler 构建产物！)*
