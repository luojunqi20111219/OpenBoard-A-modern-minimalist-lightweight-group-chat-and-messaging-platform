# 💬 信语 (OpenBoard) 全平台多端开发者集成与开发指南 (v3.0)

本指南旨在协助全球开源开发者（包括移动端 App、小程序、桌面端 Electron、以及第三方接入开发者）快速接入并统一 **信语 (OpenBoard) v3.0** 的 API 接口，并提供跨平台统一的 UI 基础规范，以便实现各端一致的轻量极简用户体验。

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

## 🔌 v3.0 接口大全 (全功能 API 规范)

> [!IMPORTANT]
> **接口通信规范**：
> - 接口前缀统一为 `/api`
> - 所有需要授权的接口，必须在 HTTP Header 中携带：`Authorization: Your-JWT-Token`

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
    "filename": "原始文件名.jpg",
    "download_url": "/api/download/random_uuid.jpg?name=原始文件名.jpg" // 文件下载接口
  }
  ```

#### 5. 文件下载接口
* **接口**：`GET /api/download/{filename}?name=原始名称`
* **安全设计**：采用 `os.path.basename` 拦截目录遍历注入，直接返回安全的文件二进制流。

#### 6. WebSocket 实时双向管道
* **接口**：`WS /ws/{token}`
* **说明**：建立长连接。在连接存活期间，接收端可在以下事件发生时，通过 WS 管道实时获取 JSON 消息：
  - 新消息广播事件：`{"type": "message", "data": {...}}`
  - 在线状态同步事件：`{"type": "online_status", "users": ["userA", "userB"]}`
  - 正在输入提示事件（客户端按键时向 WS 写入 `"type": "typing"` 触发）：`{"type": "typing", "user": "谁在写", "room_id": 0}`
  - 消息撤回广播事件：`{"type": "recall", "msg_id": 123}`

---

### 四、 公告与系统升级模块 (Notifications & Update)

#### 1. 拉取系统公告
* **接口**：`GET /api/notifications` (需 Authorization)
* **返回**：最近 20 条系统通知公告，并返回最后一次已读的公告 ID（`last_read_id`），以便 UI 端在铃铛上高亮显示未读红点。

#### 2. 标记所有公告已读
* **接口**：`POST /api/notifications/read` (需 Authorization)

#### 3. 查询 GitHub 仓库新版本
* **接口**：`GET /api/check_update`

---

### 五、 管理后台专属 API 模块 (Admin Panel)
> ⚠️ **鉴权要求**：以下所有接口不仅需要有效的 JWT Token，且操作用户的 `role` 必须为 `1`（或者属于超级免疫的 `"官方账号"`）。

#### 1. 一键冻结/解冻群聊
* **接口**：`POST /api/admin/toggle_freeze_group`
* **Payload**：`{"group_id": 123}`
* **动作**：全员禁言，冻结后群内普通用户无法发送任何消息。

#### 2. 管理员强行修改用户头像
* **接口**：`POST /api/admin/update_user_avatar`
* **Payload**：`{"user_id": 12, "avatar_base64": "..."}`

#### 3. 管理员强行修改群组头像
* **接口**：`POST /api/admin/update_group_avatar`
* **Payload**：`{"group_id": 5, "avatar_base64": "..."}`

#### 4. 彻底删除违规用户
* **接口**：`POST /api/admin/delete_user`
* **Payload**：`{"user_id": 12}`
* **注意**：自动清理该用户所发的一切言论、解散该用户拥有的所有群。超级免疫账户 `"官方账号"` 受到拦截保护，无法被删除。

#### 5. 重置用户密码
* **接口**：`POST /api/admin/reset_password`
* **Payload**：`{"user_id": 12, "new_password": "新密码"}`

#### 6. 强行解散单群
* **接口**：`POST /api/admin/delete_group`
* **Payload**：`{"group_id": 5}`

#### 7. 批量解散多个群组
* **接口**：`POST /api/admin/delete_groups`
* **Payload**：`{"group_ids": [5, 6, 7]}`
* **安全兜底**：空参数自动拦截，自动剔除公共大厅 (ID: 0)。

#### 8. 批量删除留言/消息
* **接口**：`POST /api/delete_messages`
* **Payload**：`{"msg_ids": [101, 102, 103]}`
* **安全兜底**：空参数自动拦截，防范 SQL IN 报错。

#### 9. 封禁/解封违规账户
* **接口**：`POST /api/toggle_ban_user`
* **Payload**：`{"user_id": 12}`
* **联动动作**：封禁时将自动强行失效该用户当前的 JWT 登录凭证（清除数据库 token 缓存）。系统保护账号 `"官方账号"` 无法被封禁。

#### 10. 发布全局系统公告
* **接口**：`POST /api/admin/broadcast`
* **Payload**：`{"content": "公告内容"}`

---

## 🛠️ 后端升级、接口推荐与功能开发规范

当您想在项目中添加新的业务功能或接口时，请**绝对遵循**以下微服务化包规范：

### Step 1: 新增入参校验模型 (`app/models.py`)
在 `app/models.py` 中使用 Pydantic 规范一个新的传输实体类，规范其字长、格式等。

### Step 2: 拆分开发具体路由路由 (`app/routes/`)
根据您的功能定位，在 `app/routes/` 的对应分区下开发接口。例如新聊天玩法写在 `routes/messages.py`，新安全核查写在 `routes/admin.py`：
* **如何安全取得数据库链接**：
  直接在函数参数中声明依赖注入 `db = Depends(get_db)`。生命周期全托管，**无需在函数内手动调用 db.close()，框架会自动在请求返回时优雅关门回收**。
* **如何取得登录身份/管理员身份**：
  * 需要登录才能使用：`current_user = Depends(get_current_user)`
  * 需要管理员权限才能使用：`current_admin = Depends(get_current_admin)`

### Step 3: 在 `app/main.py` 中挂载并组装
在主路由总装口 `app/main.py` 中，使用 `app.include_router(your_module.router)` 将接口无缝接入。

### Step 4: 测试与一键跨平台发布
* 本地双击 `run.bat` (Win) 或在终端执行 `./run.sh` (Linux/Mac) 进行热重载开发调试。
* 编写完成后，依次运行以下三步将其干净地提交并发布至 GitHub 官方分支：
  ```bash
  git add .
  git commit -m "feat: 描述您的新功能"
  git push origin main
  ```
  *(注：`.gitignore` 已经为您做好了护航，绝不会泄露任何本地测试库或 uploads 文件！)*
