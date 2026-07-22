## 信语 (OpenBoard) v7.6.0

本版本集中解决网页版登录等待时间长、移动端历史消息偶发 502，以及登录状态和多设备会话不易管理的问题。

### 主要更新

- 网页端第三方前端依赖改为本地静态资源，减少 CDN 阻塞。
- 支持保持登录 30 天，并在打开网页时自动校验和恢复会话。
- 新增登录设备列表，可在输入账号密码后退出指定设备。
- JWT 增加唯一会话标识和撤销机制，退出后旧 Token 立即失效。
- 保留并优化 WebSocket 心跳、自动重连、二维码长轮询和首页并行加载。
- SQLite 启用 WAL、忙等待及常用消息索引，降低并发读取锁等待。
- WebSocket 广播增加超时、失效连接清理和单用户连接上限。
- 用户与群组头像在服务端自动校验、缩放和压缩，减少数据库和接口负载。
- 移除仓库中的固定 JWT/HMS 密钥默认值，支持环境变量与本地密钥文件。

### 部署提示

首次部署或依赖更新后执行：

```bash
python3 -m pip install -r requirements.txt
chmod +x run.sh
./run.sh
```

生产环境请设置 `JWT_SECRET`。使用华为推送时还需设置 `HMS_APP_ID` 和 `HMS_CLIENT_SECRET`。

### 客户端附件

- `OpenBoard-Windows-v7.6.0.exe`：Windows WebView2 桌面客户端。
- `OpenBoard-Android-v7.6.0.apk`：Android 客户端。
- `OpenBoard-HarmonyOS-v7.6.0.hap`：HarmonyOS 客户端。
- `OpenBoard-Linux.tar.gz`：Linux 桌面客户端。
- `OpenBoard-macOS.zip`：macOS 桌面客户端（未进行 Apple 公证）。
- `OpenBoard-iOS-v7.6.0-Unsigned.ipa`：iOS 真机未签名包，需使用自己的 Apple 证书重签名。
- `OpenBoard-iOS-v7.6.0-Simulator.app.zip`：iOS 模拟器包。
