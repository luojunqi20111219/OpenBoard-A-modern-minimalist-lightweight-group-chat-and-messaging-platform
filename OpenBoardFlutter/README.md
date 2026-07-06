# 💬 信语 (OpenBoard) Mobile - 跨平台移动客户端 (Flutter)

这是 **信语 (OpenBoard)** 的跨平台移动端客户端，基于 **Google Flutter** 框架开发，支持同时打包生成 **iOS 客户端 (.ipa / Xcode)** 与 **Android 客户端 (.apk)**。

---

## 🧭 功能特性
- **双栏极简布局**：根据极简社交规范重新精简合并底部导航为 **“聊天”** 与 **“设置”** 双栏。
- **全功能 API 对齐**：100% 对齐 Python 后端提供的 HTTP/WebSocket 协议，支持大厅、群聊、私信会话。
- **媒体与文件发送**：支持直接调用相机拍摄、从系统相册选取图片并支持任意格式的文件传输及下载卡片渲染。
- **消息撤回机制**：支持 2 分钟内长按消息气泡安全撤回。
- **实时状态同步**：支持好友在线状态绿点广播、输入状态 (Typing Indicator) 提示。
- **扫码设备绑定**：首创**自适应摄像头扫码**，支持直接通过摄像头扫描服务配置或解析好友名片/群组，并在无相机/模拟器中自动安全降级展示手动输入框与相册识别。

---

## 🛠️ 开始使用与运行指南

### 1. 环境准备
- 确保您已安装好 **Flutter SDK** (`>=3.0.0`)：
  - 在命令行中运行 `flutter doctor` 确保 Android/iOS 工具链配置正常。
  - 对于编译 iOS，您需要有一台安装了 **macOS** 的机器，且配有 **Xcode** 以及 CocoaPods。

### 2. 初始化依赖
在 `OpenBoardFlutter` 文件夹根目录下执行：
```bash
flutter pub get
```

### 3. 本地运行调试
将您的手机（或虚拟机）连接到电脑上，并运行：
```bash
# 启动本地开发热重载
flutter run
```

### 4. 打包构建

#### 📱 构建 iOS 客户端 (需要在 macOS/Xcode 环境下)
```bash
# 生成 iOS 构建包 (包含包签名配置)
flutter build ipa
```
生成的包可以在 Xcode 中进行归档 (Archive) 并分发至 TestFlight 或真机中。

#### 🤖 构建 Android 客户端 (Windows/macOS/Linux)
```bash
# 编译生成已签名的 APK 安装包
flutter build apk --split-per-abi
```
安装包将输出在 `build/app/outputs/flutter-apk/app-release.apk`。

---

## 📂 项目结构
```
OpenBoardFlutter/
├── pubspec.yaml            # 依赖与资源配置
├── lib/
│   ├── main.dart           # 入口类与主题路由配置
│   ├── models/
│   │   ├── message.dart    # 消息数据模型
│   │   └── relation.dart   # 关系/会话频道数据模型
│   ├── services/
│   │   └── api_service.dart # HTTP 请求与 WebSocket 长连接核心总线
│   ├── widgets/
│   │   ├── chat_bubble.dart # 气泡卡片与附件智能渲染组件
│   │   └── avatar_widget.dart # 具有在线状态与哈希渐变色的头像组件
│   └── screens/
│       ├── login_screen.dart # 登录/注册/服务器配置页面
│       ├── main_screen.dart # 底部双栏核心骨架页面
│       ├── chat_screen.dart  # 聊天会话主页面（含附件上传、输入态、长按撤回）
│       └── scan_screen.dart  # 自适应扫码对焦与相册解析页面
```
