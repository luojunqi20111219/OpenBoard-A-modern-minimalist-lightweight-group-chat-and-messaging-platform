# Release Notes (版本发布日志)

> 下方 `v5.0.0` 为历史发布记录。当前主干已到 `v8.0.0`，
> 最新变更见 [`升级内容.md`](./升级内容.md) 与 [`code_updates_summary.md`](./code_updates_summary.md)。

---

## 🏷️ 版本号：`v5.0.0`
## 📢 版本主题：极轻量级 C++ 桌面客户端与跨端扫码登录生态集成

---

## 🚀 版本概述
这是 **信语 (OpenBoard)** 即时通信平台的又一次重大突破！
在此版本中，我们正式推出了**超轻量级、原生 C++ 编写的 Windows 桌面客户端**，体积仅为 **833 KB**，实现了完美的系统托盘后台挂机、新消息双重闪烁提醒以及点击通知一键唤醒还原。
与此同时，我们打通了**移动端与网页端的跨端扫码登录生态**：网页端支持本地安全绘制二维码并进行状态轮询，安卓原生端集成了扫码模块与扫码登录确认，让用户无需输入密码即可安全、秒级登录网页端！

---

## 💻 核心更新：原生 C++ 桌面客户端 (OpenBoardClient)
为了提供极致的启动速度和最小的内存占用，我们未使用体积庞大的 Electron 框架，而是使用原生 C++ + Edge WebView2 打造了极简的桌面客户端：
1. **⚡ 极致轻量与性能**：程序仅为 **833 KB**，启动即开，后台内存占用极低。通过免 DLL 显式动态加载技术，无需附带额外的动态链接库即可在现代 Windows 系统上直接运行。
2. **📥 后台系统托盘挂机**：拦截了窗口最小化与关闭按钮，点击后自动缩入系统右下角小托盘后台挂机，避免误关。双击/单击托盘图标即可瞬间恢复主界面。
3. **🔔 新消息系统级通知 (Toasts)**：代理网页端的实时消息监听，当接收到新消息时，调用 Windows 原生 API 弹出右下角系统消息通知横幅，并对富文本内容进行了人性化文本化转换。
4. **🖱️ 点击通知直接查看**：用户直接点击系统右下角的通知气泡，客户端会自动将后台挂起的窗口还原、激活并置顶呈现在用户眼前。
5. **✨ 新消息任务栏与托盘双重闪烁**：当有新消息且客户端处于非激活状态时，任务栏图标与系统托盘图标会同步闪烁提醒，当用户点击并激活窗口后自动停止闪烁。
6. **🔒 安全数字签名 (Authenticode)**：完成了对可执行程序 `OpenBoard.exe` 的安全数字签名，并导入受信任根证书，避免 Windows SmartScreen 报毒拦截。
7. **🎨 专属品牌图标集成**：可执行文件、窗口标题栏、系统任务栏与系统托盘均完美嵌入展示信语官方专属图标。

---

## 🔑 跨端新体验：多端扫码登录生态 (QR Login)
打通了从移动端到网页端的安全快捷登录闭环：
1. **🌐 网页端二维码展示与轮询**：
   - 登录页面新增“扫码登录”标签页。
   - 使用 `qrcode.min.js` 在本地安全、高效地生成包含唯一 `qr_id` 的专属登录二维码。
   - 每 1.5 秒安全轮询状态，支持二维码过期（2分钟）点击刷新。
2. **📱 安卓客户端扫码确认**：
   - 集成了 **ZXing Android Embedded** 扫码模块。
   - 消息列表头部导航栏新增“扫一扫”快捷操作。
   - 支持扫码后的**安全授权确认机制**（弹窗确认：“确定要在网页端登录您的账号吗？”），点击确认后即可安全传输 Token 授权网页端登录。
3. **🛢️ 服务端临时会话安全保障**：
   - 数据库新增 `qr_sessions` 临时表，安全记录扫码状态（`pending` -> `scanned` -> `authorized`）。
   - 在确认授权后，服务器会将网页端标记为已授信，自动下发登录 Token，确保会话传输的安全性。

---

## ⚙️ 服务器热更新与代码库同步
- **GitHub 仓库同步**：后端及 Android 端的最新代码已全部同步推送至 GitHub 仓库。
- **部署方式**：自托管版本可通过 `run.sh` / `run.bat` 启动，或按下方「Cloudflare 部署」一节
  部署到边缘节点（无需自备服务器）。

---

## ☁️ 新增部署形态：Cloudflare Workers & Pages

本版本同时收录了 `openboard-cf/` —— 将后端从 FastAPI 迁移到 Cloudflare 边缘运行，
**对外 API 完全兼容**，Android / HarmonyOS / Flutter / 网页客户端无需改动。

| 原实现 | Cloudflare 版 |
| :--- | :--- |
| FastAPI（Python） | Hono（TypeScript） |
| SQLite 文件 `board.db` | D1 |
| 内存 `ConnectionManager` | Durable Object（WebSocket Hibernation） |
| 本地 `uploads/` 目录 | R2 |
| 进程内登录限流 | KV（+ D1 `login_history` 降级） |

### 部署三行命令

```bash
npm run setup      # 创建 D1 / R2 / KV，并把 id 写回 wrangler.toml
npm run preflight  # 本地隔离环境跑 38 项链路自检
npm run deploy     # 部署 DO Worker → 部署 Pages
```

> ⚠️ **KV 命名空间必须先生成**（`npm run setup` 会做）。
> 缺了它登录限流会失效，账号可被无限次暴力破解。
> 另外 KV 只能放「容忍短暂不一致」的数据（限流计数、在线快照），
> 用户账号 / 会话 / 封禁状态一律走 D1 —— 否则会出现「改完密码旧密码还能登录」这类漏洞。

详细步骤见 [`openboard-cf/README.md`](./openboard-cf/README.md)。

---

## 🛠️ 编译与使用指南

### 安卓客户端 (Android)
- 导入 Android Studio，在本地连接测试设备后使用 Gradle 编译或直接打包：
  `./gradlew.bat assembleDebug`

### C++ 桌面端编译 (Windows)
- 使用 MinGW g++ 编译器，进入项目根目录执行：
  ```bash
  windres resource.rc -O coff -o resource.o
  g++ main.cpp resource.o -o OpenBoard.exe -Iwebview2_sdk/build/native/include -DWEBVIEW_MSWEBVIEW2_EXPLICIT_LINK=1 -lole32 -lcomctl32 -loleaut32 -luuid -lversion -lshlwapi -mwindows -std=c++17
  ```
