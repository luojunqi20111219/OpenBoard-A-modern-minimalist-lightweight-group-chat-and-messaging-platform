# OpenBoard 项目更新与 GitHub 同步报告

本报告汇总了服务器端与安卓客户端的代码更新内容，并记录了将代码推送到 GitHub 远程仓库的同步状态。

---

## 📊 Git 同步状态

> [!NOTE]
> 本次代码已成功推送至 GitHub 远程仓库。
> *   **远程仓库**: [OpenBoard](https://github.com/luojunqi20111219/OpenBoard-A-modern-minimalist-lightweight-group-chat-and-messaging-platform.git)
> *   **推送分支**: `main`
> *   **最新提交 Hash**: `91c4bda...`

---

## 🛠️ 服务器端 (Server) 更新详情

对比远程 GitHub 仓库，本地服务器代码进行了多项核心架构和安全性的升级：

### 1. 华为推送服务 (HMS Push) 集成
*   **配置参数**: 在 [app/config.py](./app/config.py) 中引入了 `HMS_APP_ID` 和 `HMS_CLIENT_SECRET`。
*   **推送逻辑**: 新增 [app/hms_push.py](./app/hms_push.py) 模块，支持与华为 OAuth 2.0 服务进行交互获取 `access_token` 并向下发 Token 发送通知。
*   **异步触发**: 在消息发送路由 [app/routes/messages.py](./app/routes/messages.py#L129-L203) 中引入了 `BackgroundTasks`，在接收方不在线时自动异步触发 HMS 消息推送（包括单聊和群聊推送过滤）。

### 2. 多设备在线管理与强制下线
*   **数据库修改**: 在 [app/database.py](./app/database.py#L90-L101) 中创建了 `user_devices` 关系表，用于追踪用户活跃设备、Session Token 以及推送令牌。
*   **上限踢出**: 在登录与注册 Token 接口 [app/routes/auth.py](./app/routes/auth.py#L152-L195) 中限制每个账号最多只能有 2 台设备同时保持活跃。当在第 3 台设备登录时，系统会自动删除最老设备的 Session，并通过 HMS 推送向其发送下线指令 `"action": "logout"`。

### 3. 上传文件格式安全审查 (Whitelist)
*   **安全升级**: 抛弃了原先 the 黑名单（容易绕过），在 [app/routes/messages.py](./app/routes/messages.py#L17-L33) 中采用了 **白名单机制**：
    ```python
    ALLOWED_EXTENSIONS = {'jpg', 'jpeg', 'png', 'gif', 'pdf', 'docx', 'txt', 'zip'}
    ```
    目前仅允许以上安全格式的文件上传，极大增强了服务器抗木马/可执行脚本运行的风险。

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

### 3. 后台消息与通知 (HMS Integration)
*   增加了华为 `HmsMessageService`，当 App 处于后台时，依然能够及时弹窗提醒新消息。

---

## 📂 提交文件清单

以下是本次提交至 GitHub 的主要变动文件列表：

| 模块 | 文件路径 | 状态 | 说明 |
| :--- | :--- | :--- | :--- |
| **服务器** | `app/config.py` | 📝 修改 | 新增 HMS 配置常量 |
| **服务器** | `app/database.py` | 📝 修改 | 新增 `user_devices` 结构及 `push_token` 字段 |
| **服务器** | `app/hms_push.py` | ➕ 新增 | 华为推送封装类 |
| **服务器** | `app/models.py` | 📝 修改 | 增加 `PushTokenData` 数据校验模型 |
| **服务器** | `app/routes/auth.py` | 📝 修改 | 增加设备上报注册及超限踢出接口 |
| **服务器** | `app/routes/messages.py` | 📝 修改 | 上传白名单验证，发消息触发后台推送 |
| **服务器** | `templates/index.html` | 📝 修改 | 网页前端轻量化调整 |
| **安卓端** | `OpenBoardAndroid/` | 📝 修改 | 重构打包脚本、界面逻辑及推送服务 |
