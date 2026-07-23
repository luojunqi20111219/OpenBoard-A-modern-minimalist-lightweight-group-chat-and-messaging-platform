# 💬 信语 (OpenBoard) - 现代化的极简轻量级多端即时通信平台

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python Version](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-00a67d.svg?logo=fastapi)](https://fastapi.tiangolo.com/)

**信语 (OpenBoard)** 是一个基于 **FastAPI**、**SQLite** 以及 **WebSocket** 构建的现代化极简即时通信平台。

当前 **v7.7.0** 聚焦长聊天性能、弱网可靠性、可检索消息、精细群管理和账号安全中心，并同步升级网页、Android、HarmonyOS 与 Flutter 客户端协议。

🌍 **线上体验地址**：[https://liuyan.luojunqi.xyz](https://liuyan.luojunqi.xyz)

---

## 🚀 v7.7.0 更新

- **历史消息分页**：默认只加载最近 50 条，上滑按游标加载更早消息，避免移动端长会话卡顿和 502。
- **弱网可靠发送**：消息带客户端幂等 ID，显示发送中、已发送或失败，并支持失败重试与断线补拉。
- **消息能力**：支持两分钟内编辑与撤回、转发、全文/类型/日期搜索、收藏和已读回执。
- **群聊身份标识**：群消息气泡显示“昵称（@用户名）”，自己和其他成员的消息都能明确辨认。
- **媒体性能**：上传图片生成缩略图，网页上传前自动压缩，列表懒加载缩略图并保留原图查看。
- **手机网页布局**：会话列表改为按需打开的侧边抽屉，聊天区不再被侧栏挤出屏幕。
- **跨设备会话设置**：置顶、免打扰与最近已读位置写入服务端，在登录设备间同步。
- **群管理**：新增群公告、成员可见、入群审核、邀请处理、管理员、禁言、移除成员和操作审计。
- **安全中心**：新增登录历史、新设备/地区提醒、已登录设备管理、退出全部设备、可选 TOTP 两步验证和已读回执隐私开关。
- **自动化验证**：增加高级功能集成测试，并更新 Android、HarmonyOS、iOS、macOS 与 Linux 构建发布配置。

## v7.6.0 更新

- **网页加载提速**：Tailwind CSS、Font Awesome、二维码和 Emoji 组件改为本地静态资源，避免第三方 CDN 阻塞登录页。
- **登录状态恢复**：网页端支持保持登录 30 天；启动时先校验服务端 Session，失效后自动清理本地状态。
- **登录设备管理**：可查看账号的网页端与移动端登录设备，并在验证账号密码后远程退出指定设备。
- **会话安全**：JWT 增加唯一会话标识与撤销列表，退出或远程下线后旧 Token 立即失效。
- **消息稳定性**：保留 WebSocket 心跳、自动重连、二维码长轮询和并行初始化，降低代理网络下的等待时间。
- **服务端优化**：SQLite WAL、忙等待和消息索引优化；限制单用户 WebSocket 数量，广播增加超时与失效连接清理。
- **媒体优化**：上传头像自动校验、缩放和压缩，减少数据库体积与历史消息接口压力。

---

## ✨ 核心特性更新 (v6.0)

### 📱 1. 全新原生安卓客户端 (OpenBoardAndroid)
使用 **Kotlin + MVVM** 架构与 **Material Design** 全新打造的原生 Android 应用：
- **⚡ WebSocket 实时通讯**：极低延迟的文字、图片及文件双向实时收发，实时展示对方“正在输入中...”状态。
- **🔔 华为推送服务 (HMS Push) 系统级集成**：即使 App 在后台或被系统深度休眠，后端也会自动调度华为推送通道，确保消息实时提醒触达。
- **📝 长按操作气泡菜单**：支持在聊天气泡上长按呼出菜单，轻松执行“引用回复”、“复制”、“删除”或“撤回”操作。
- **🔗 引用回复与平滑滚动定位**：点击消息中引用的历史消息内容，列表会自动平滑滚动并闪烁定位到被引用的原始消息位置。
- **🖼️ 高清图片预览与保存**：点击聊天中的图片即可打开高清大图预览层，支持一键保存到系统相册。
- **📇 好友名片推送**：完美兼容名片格式，支持在会话中一键分享好友名片，点击名片即可直接拉起好友资料交互。

### 💻 2. Windows 客户端升级 (C++ WebView2 Desktop Client)
基于 **C++ + Edge WebView2** 编译的极致轻量级 Windows 桌面端（体积仅约 **800KB**，后台内存占用极低）：
- **⚙️ 一键开机自启**：系统托盘右键菜单集成“开机自启”设置项，一键写入或清除 Windows 注册表，带勾选状态自动同步。
- **📥 精准隐藏与正常最小化**：
  * 点击 **最小化** 按钮：窗口正常最小化到 Windows 任务栏（不消失），方便随时切换。
  * 点击 **关闭 (X)** 按钮：窗口自动隐藏至系统右下角小托盘后台挂机，避免误关并维持后台消息监听。
- **🔔 系统级 Toast 消息通知**：当有新消息且客户端处于后台时，调用 Windows 原生 API 弹出系统消息通知横幅，点击通知可自动还原并置顶激活窗口。
- **✨ 任务栏与托盘双重闪烁**：当有未读消息时，任务栏图标与系统托盘图标同步闪烁，直至用户点击并激活窗口后自动恢复正常。

### 🌐 3. 网页端（Web）重磅交互升级
- **🪂 全局拖拽文件/图片上传**：实现全局拖拽感知机制，将文件拖入网页任意位置即可拉起磨砂遮罩覆盖层，松开鼠标即可一键完成上传并发送。
- **📇 名片分享与快速社交**：消息输入框工具栏新增名片图标，点击可快捷推送好友名片（基于 `[user_card:username:nickname]` 协议）。接收端点击“查看个人资料”可直接跳转并向目标用户发起聊天或申请。

### ⚙️ 4. 后端服务 (Backend) 安全与架构升级
- **🛡️ 多设备安全并发限制（“强制下线”机制）**：
  * 引入 `user_devices` 设备状态绑定表。
  * 支持在网页端查看并管理登录设备；Android 推送设备记录保留最近 10 台，超出后自动撤销最旧 Session。
- **🛡️ JWT 强加密通行证与 API 安全拦截**：免除频繁读库校验，大幅减轻数据库并发负载，对 `/admin` 等敏感管理接口实现后端直接校对 Cookie 拦截。
- **🗃️ SQLite 自动回收连接**：通过依赖注入级别的 `get_db()` 自动生成器，确保每个 HTTP/WebSocket 请求完毕后强制自动关闭链接，彻底治愈 SQLite 锁表 `database is locked` 报错。

---

## 📖 部署与使用教程

### 1. 后端服务端部署 (Server)
服务端基于 Python 3.8+ 运行：
* **Windows 部署**：直接双击运行根目录下的 **`run.bat`**。
* **Linux / macOS 部署**：打开终端，执行以下指令：
  ```bash
  python3 -m pip install -r requirements.txt
  chmod +x run.sh
  ./run.sh
  ```
> **注**：`run.sh` 默认直接启动服务，以避免每次重启都重复检查和安装依赖。首次部署或更新依赖后请先执行安装命令。

生产环境建议设置以下变量：

```bash
export JWT_SECRET="替换为足够长的随机字符串"
export HMS_APP_ID="您的华为应用 ID"
export HMS_CLIENT_SECRET="您的华为应用密钥"
```

未设置 `JWT_SECRET` 时，程序会在项目目录生成权限为 `0600` 的 `.openboard_jwt_secret`。该文件和 `board.db` 都不应提交到仓库。

### 2. 安卓客户端编译 (Android)
1. 在 Android Studio 中导入 `OpenBoardAndroid` 目录。
2. 在 `app/src/main/java/com/openboard/nativeapp/data/api/RetrofitClient.kt` 中修改 `BASE_URL` 为您的服务端 IP/域名。
3. 连接测试设备，编译运行即可。如需生成 release 签名安装包，可执行：
   ```bash
   ./gradlew assembleRelease
   ```

### 3. C++ 桌面端编译 (Windows)
如果您需要重新编译桌面客户端，请确保系统已安装 GCC/MinGW 编译器，并运行以下编译指令：
```bash
# 编译命令（需指定 webview2 依赖及 version 库）
windres resource.rc -O coff -o resource.o
g++ main.cpp resource.o -o OpenBoard.exe -Iwebview2_sdk/build/native/include -luser32 -lshell32 -lgdi32 -lole32 -lshlwapi -lversion -mwindows -std=c++17
```

---

## 📂 项目结构
```text
OpenBoard/
├── OpenBoardAndroid/    # 原生 Kotlin 安卓客户端项目目录
├── app/                 # 后端核心业务包
│   ├── config.py        # 全局配置中心 (JWT密钥、HMS 推送参数)
│   ├── database.py      # SQLite连接池用完自动回收器、数据种子化
│   ├── auth.py          # JWT加解密与当前登录态/管理员权限拦截
│   ├── hms_push.py      # 华为 HMS 推送服务调度模块
│   └── routes/          # 业务路由逻辑分区 (auth、messages、friends、groups、admin)
├── main.cpp             # 现代 C++ WebView2 桌面客户端源码
├── webview2_sdk/        # Windows C++ WebView2 所需依赖 SDK
├── board.db             # 本地轻量级 SQLite 数据库 (已加入 gitignore)
├── run.bat              # Windows 服务端一键自动部署脚本
├── run.sh               # macOS / Linux 服务端一键自动部署脚本
├── requirements.txt     # 依赖包清单
└── templates/           # 精美前台网页界面模板 (Jinja2)
    ├── index.html       # 信语网页交互主页 (支持拖拽上传、名片展示)
    └── admin.html       # 🛡️ 信语 ROOT 系统管理后台
```

---

## 📄 开源协议
本项目采用 [MIT License](LICENSE) 开源协议。欢迎提交 PR 或 Issue。
