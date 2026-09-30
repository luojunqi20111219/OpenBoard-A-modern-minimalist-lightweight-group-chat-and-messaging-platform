# 🏷️ 版本号：`v9.0.0`
# 📢 版本主题：Cloudflare Workers 部署方案 + 全端版本号统一

---

## 🚀 版本概述

**信语 (OpenBoard)** v9.0.0 正式发布！

本次更新带来一个**全新的部署形态** —— 除原有的自托管 FastAPI 方案外，
新增一套可运行在 **Cloudflare 全球边缘网络** 的实现（目录 `openboard-cf/`）。
它**对外 API 完全兼容**，已发布的 Android / HarmonyOS / Flutter / 网页客户端
**无需任何改动**即可切换到新后端。

同时，全端版本号统一升级至 **v9.0.0**，并修复了若干真实缺陷
（其中两个是在本版兼容性验证过程中才被发现的历史隐患）。

---

## ☁️ 核心更新：Cloudflare Workers 部署形态

后端从 FastAPI 迁移到 Cloudflare 边缘运行，无需自备服务器：

| 维度 | 原实现 | Cloudflare 版 |
| :--- | :--- | :--- |
| Web 框架 | FastAPI (Python) | Hono v4 (TypeScript) |
| 业务数据 | SQLite 文件 `board.db` | **D1** |
| 文件存储 | 本地 `uploads/` 目录 | **R2** |
| 实时广播 | 进程内 `ConnectionManager` | **Durable Object**（ChatHub） |
| 登录限流 | 进程内存 | **KV**（+ D1 `login_history` 降级） |
| 静态资源 | 本地 `static/` / 模板渲染 | **Workers Assets** |

### 为什么是 Workers 而不是 Pages

本项目最初按 **Pages Functions** 实现，但该方案在本项目的核心场景下**不可用**：

> **Pages 无法返回带 WebSocket 的 101 响应。**

Cloudflare 官方兼容性矩阵写得很明确 —— `Durable Objects: Only available on Workers`。
Pages Functions 若要通过 `script_name` 跨服务引用 DO，普通 HTTP 请求正常，
但 WebSocket 升级**一律 500（`error code 1101`）**：
带 `webSocket` 属性的 101 响应无法穿过 Pages → DO 的服务绑定边界，
且异常发生在运行时层，连 `try/catch` 都拦不住。

因此改为单个 Worker 承载全部职责（静态资源 + API + DO），收益是：

- DO 成为**同 Worker 内的原生绑定**，不再需要 `script_name` 跨引用
- WebSocket 全程走同一隔离环境，101 直接返回，无跨边界问题
- 少一个 Worker、少一次跨服务调用，延迟更低
- 额外获得 Cron Triggers 与完整可观测性

> 静态资源请求在 Workers Assets 下与 Pages 一样**不额外计费**。

### 技术要点

1. **Durable Object + WebSocket Hibernation**：原版把连接存在进程内存里，
   一旦部署到边缘（请求可能落在不同节点）内存态广播直接失效。
   DO 提供全局单实例 + 持久化，是所有节点共享的广播中枢。
   启用 Hibernation 后，连接空闲时 DO 可被逐出内存而**不掉线**，
   空闲期间不计 CPU / 内存费用，对长连接低流量场景能显著降低成本。
2. **密码哈希兼容**：用 Web Crypto 实现 PBKDF2-SHA256，
   与原 werkzeug 格式兼容，**老用户密码无需重置**即可登录。
   > ⚠️ Workers **免费套餐**的 CPU 上限是 **10ms/请求**，而 `210000` 次
   > PBKDF2 迭代必然超限，表现为注册/登录一律 500。
   > 故默认迭代次数降为 `10000`（仍在免费额度内），并提供
   > `PASSWORD_ITERATIONS` 环境变量覆盖。升级到付费套餐后可调回 `210000`。
   > 哈希自身记录了迭代次数，调整此值**不会**让已有密码失效。
3. **存储职责严格划分**（务必遵守）：

   | 存储 | 承担的数据 |
   | :--- | :--- |
   | **D1** | 用户账号、密码哈希、会话、消息、群组、封禁状态等**全部业务数据** |
   | **R2** | 上传的图片与文件 |
   | **KV** | **仅**登录限流计数与可陈旧的在线快照 |

   > ⚠️ KV 是最终一致存储，**绝不可**用于账号 / 会话 / 封禁状态。
   > 否则会出现「改完密码旧密码还能登录」「封禁后仍可发消息」这类安全漏洞。

### 部署命令

```bash
npm run setup         # 创建 D1 / R2 / KV，并把 id 自动写回 wrangler.toml
npm run preflight     # 本地隔离环境跑 38 项链路自检（不碰云端资源）
npm run check:android # 存量 Android 客户端收消息回归（22 项）
npm run deploy        # npx wrangler deploy（单次部署，无需分步）
```

> ⚠️ **KV 命名空间必须先生成**（`npm run setup` 会做）。
> 缺了它登录限流整体失效，账号可被无限次暴力破解。
>
> ⚠️ **JWT_SECRET 必须用 secret 写入**，不能留在 `wrangler.toml`：
> ```bash
> npx wrangler secret put JWT_SECRET
> ```
> 留空时程序会退回内置默认值，**任何人都能伪造登录 token**。

详细步骤见 [`openboard-cf/README.md`](./openboard-cf/README.md)。

---

## 🐛 缺陷修复

### 1. WebSocket 升级请求丢失 `Upgrade` 头（严重）

转发给 Durable Object 时若用 `new Request(url, request)` 重建请求，
`Upgrade`（Fetch 规范的 **forbidden header**）会被静默丢弃；
Pages 运行时模板内部还会再做一次 `new Request(request.clone())`，等于丢两遍。

结果 DO 侧只看到普通 GET，**握手必然失败**。
已改为手工构造升级请求并显式写入 `Upgrade` / `Connection` 头。

### 2. `/ws/{token}` 路由参数类型错误（影响存量 App）

原 Pages 实现中 `functions/ws/[[token]].ts` 编译出的路由是 `/ws/:token*`，
尾随 `*` 使 `params.token` 变成**字符串数组**（如 `["abc"]`）而非字符串。
`resolveUser()` 内部 `token.split()` 抛类型错误，返回 500，
**存量 Android 客户端全部连不上**。路由迁移到 `src/app.ts` 后
已用 `/ws/:token`（无 `*`）修正，参数类型恢复为字符串。

### 2.5 安全响应头中间件改坏 WebSocket 握手（本次迁移中最隐蔽的坑）

`securityHeaders()` 会给所有响应写入 `X-Frame-Options`、CSP 等头，
但它对 **101 Switching Protocols** 响应也执行了 `headers.set()` ——
而 101 的 headers 是**不可变（immutable）**的，写入会抛

```
TypeError: Can't modify immutable headers
```

异常发生在中间件里，会把整个 WebSocket 握手变成 500，**且响应体看不到任何原因**：

- 在 Pages 上表现为无信息的 `error code: 1101`
- 在 Workers 上表现为「服务器内部错误」500

现象极易被误判为 DO 绑定或运行时边界问题，实际与 WebSocket 基础设施
**毫无关系**，纯粹是这一行 header 写入。
已改为对 `status === 101 || res.webSocket` 直接放行，
并将所有 header 写入包进 `try/catch`，确保**绝不因为加安全头而让请求失败**。

### 2.6 assets 的响应头无法被 Worker 覆盖（性能提示）

Workers Assets 的响应 headers guard 为 `immutable`，
且 Cloudflare 在 Worker 之后由静态资源层统一写入 `Cache-Control`，
Worker 侧（包括用 `new Response()` 重建）都无法覆盖。
表现为所有静态资源一律 `public, max-age=0, must-revalidate`。

该策略**功能上正确**（浏览器带 `If-None-Match` 校验，命中 ETag 返回 304，
不会重复传输文件体），仅比强缓存多一次往返。
若需强缓存，应改用 zone 级 Cache Rules 或 R2 + 自定义元数据。

> 另注：Pages 仓库里的 `public/_headers` 文件在 Workers 下**完全无效**，
> 且请求 `/_headers` 会被 SPA 回退当成前端路由，返回 187KB 的 index.html。
> 本版已移除该文件。

### 3. 更新检查的版本号比较用错方式（未来定时炸弹）

原实现直接做字符串比较（`"8.0.0" > current_version`）。
这在主版本号进位后会**永久失效**：

```
10.0.0 > 9.0.0     字符串法 = False（错）    元组法 = True（对）
```

届时用户将**收不到任何更新提示**，且不报错、不崩溃，难以排查。
已改为按数值元组逐段比较。

### 4. 消息年龄计算时区错误

`created_at` 由 SQLite `CURRENT_TIMESTAMP` 写入 UTC。
计算消息年龄时若写成 `strftime('%s', created_at, 'utc')` 会**二次扣减**时区偏移，
导致「2 分钟编辑 / 撤回窗口」直接失效（实测偏出 28800 秒 = 8 小时）。
已统一改为 `strftime('%s', created_at)`。

### 5. Cloudflare 版图片直链 403

`<img src>` 请求不携带 `Authorization` 头，原先要求鉴权导致所有图片加载失败。
改为默认免鉴权读取（随机文件名即 capability token），
并保留 `PUBLIC_UPLOADS=false` 强制鉴权开关。

### 6. WebSocket 重连退避

由固定 3 秒改为指数退避 + 随机抖动（1s→2s→4s…上限 30s），
并在页面重新可见 / 网络恢复时立即重连。

> 必须这么改的原因：DO 会因 WebSocket Hibernation 被逐出内存，
> 唤醒期间的连接会集中断开，固定间隔重连容易形成尖峰。

### 7. D1 参数绑定

D1 的 `stmt.bind()` 返回**新对象**而非原地修改，
原写法导致 `Wrong number of parameter bindings`，已改为链式返回。

---

## 📱 存量客户端兼容性

**已发布的客户端无需任何改动**，本版逐项验证通过：

| 客户端行为 | 服务端对应 | 状态 |
| :--- | :--- | :--- |
| `WebSocketManager.kt` 拼 `wss://host/ws/{token}` | `src/app.ts` 的 `/ws/:token` 路由 | ✅ 握手 101 |
| 读取 `type == "message"` 的事件 | 广播载荷 `type: "message"` | ✅ |
| 解析 `WsMessage.kt` 的 `WsData` | 11 个字段逐一核对 | ✅ 全部存在且类型正确 |
| 群消息按 `room_id` 分流 | 群广播带 `room_id` | ✅ |
| 撤回提示 | `type: "recall"` 事件 | ✅ |
| 旧路径 `/api/ws/{token}` | 保留兼容 | ✅ 握手 101 |

新增自动化回归脚本 `openboard-cf/scripts/android-ws-check.mjs`（22 项断言），
复刻客户端的连接方式并逐字段核对载荷结构：

```bash
cd openboard-cf && npm run check:android
```

> ⚠️ `/ws/{token}` 是**已发布 App** 拼出来的地址。一旦路由参数类型
> （数组 vs 字符串）或 `WsData` 字段名变动，App 会**静默收不到消息** ——
> 不报错、不崩溃，最难排查。改动 WS 入口后务必跑该脚本。

---

## 🔢 全端版本号升级至 v9.0.0

| 位置 | 变更 |
| :--- | :--- |
| `OpenBoardAndroid/app/build.gradle` | `versionCode 90000` / `versionName "9.0.0"` |
| `OpenBoardHarmony/AppScope/app.json5` | `versionCode 9000000` / `versionName "9.0.0"` |
| `OpenBoardFlutter/pubspec.yaml` | `9.0.0+900` |
| `app/config.py` | `CURRENT_VERSION = "v9.0.0"` |
| `openboard-cf/wrangler*.toml` | `CURRENT_VERSION = "v9.0.0"` |
| `openboard-cf/package.json` | `"version": "9.0.0"` |

---

## 🛠️ 编译与使用指南

### 自托管版（原始方案）

```bash
pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

或使用 `run.sh` / `run.bat` 一键启动。

### Cloudflare 版

见上方「部署三行命令」，完整步骤见 `openboard-cf/README.md`。

### 安卓客户端 (Android)

```bash
cd OpenBoardAndroid && ./gradlew.bat assembleDebug
```

---

## 📄 文档

- [`升级内容.md`](./升级内容.md) —— 版本迭代历史（本版新增 v9.0.0 章节）
- [`openboard-cf/README.md`](./openboard-cf/README.md) —— Cloudflare 版部署指南
- [`DEVELOPER_GUIDE.md`](./DEVELOPER_GUIDE.md) —— 全平台 API 集成指南
- [`code_updates_summary.md`](./code_updates_summary.md) —— 变更文件清单

---

**完整变更记录**：[`bbe3166...v9.0.0`](https://github.com/luojunqi20111219/OpenBoard-A-modern-minimalist-lightweight-group-chat-and-messaging-platform/compare/bbe3166...v9.0.0)
