# 信语 OpenBoard — Cloudflare Workers & Pages 版

原项目（FastAPI + SQLite + 本地文件）的 Cloudflare 原生改造版。API 与前端**保持完全兼容**，已发布的 Android / HarmonyOS / iOS / 网页客户端无需改动即可对接。

线上原版：<https://liuyan.luojunqi.xyz>

---

## 架构对照

| 原项目 | 本版本 | 说明 |
|---|---|---|
| FastAPI（Python） | **Hono** on Workers/Pages Functions | Python Workers 跑不了 FastAPI（pydantic-core 是 Rust 扩展），故改写为 TypeScript |
| SQLite 文件 `board.db` | **D1** | SQLite 方言，表结构几乎原样迁移 |
| 内存 `ConnectionManager` | **Durable Object**（WebSocket Hibernation） | 原实现把连接存进程内存，边缘多节点下必然失效 |
| 本地 `uploads/` 目录 | **R2** | 原用 Pillow 生成缩略图，Workers 做不了服务端图片处理；图片用随机文件名当 capability token |
| PyJWT | **Web Crypto HMAC-SHA256** | JWT payload 结构不变，旧 token 可直接平移 |
| werkzeug 密码哈希 | **PBKDF2-SHA256**（Web Crypto） | 保持 werkzeug 同格式，旧库 pbkdf2 哈希可直接用 |
| bleach | 内置 HTML 清洗 | 等价于 `bleach.clean(text, tags=[], strip=True)` |
| Jinja2 模板 | Pages 静态托管 | `index.html` 原本就不含模板变量，直接搬 |
| 进程内限流计数 | **KV**（登录限流 + 在线快照） | 原实现存进程内存，边缘多实例下形同虚设 |

### 存储职责划分

三套存储各管一摊，**不要混用**：

| 存储 | 存什么 | 为什么 |
|---|---|---|
| **D1** | 全部业务数据：用户、消息、群、好友、会话 Token、封禁状态、登录历史 | SQLite 强一致，能建索引、能事务 |
| **R2** | 聊天文件、头像、群头像 | 二进制对象，无一致性要求，便宜且不占 D1 配额 |
| **KV** | ① 登录失败计数/锁定时间 ② 在线用户快照（15s TTL） | 只有「偶尔漏一次也没关系」的数据才配放这里 |

> ⚠️ **KV 是最终一致存储，写入后全球生效需要数十秒。**
> 把用户账号、会话、封禁状态放进去，会直接造成「改完密码旧密码还能登录」
> 「封禁后仍可发消息」这类安全漏洞。这是本项目唯一一条存储红线。

### 部署形态

```
Pages（前端 + API）                    Worker（WebSocket 中枢）
┌─────────────────────────────┐        ┌──────────────────────┐
│ public/index.html  静态托管  │        │  ChatHub Durable Obj │
│ public/admin.html           │───────▶│  （全局广播 + 在线态）│
│ functions/api/[[path]].ts   │ script │                      │
│   → Hono 路由（D1 + R2）     │ _name  │                      │
└─────────────────────────────┘        └──────────────────────┘
```

> ⚠️ **为什么 DO 要单独部署**：Cloudflare 不允许 Pages Functions 直接导出 Durable Object 类，
> wrangler 会报 `Your Worker depends on the following Durable Objects, which are not exported
> in your entrypoint file`。DO 必须住在独立 Worker 中，Pages 再通过 `script_name` 引用。

---

## 部署步骤

> **部署前必须先做的一件事：创建 KV 命名空间。**
> KV 没有创建、或者 `wrangler.toml` 里还留着 `REPLACE_WITH_YOUR_KV_ID` 占位符，
> 部署后登录限流会直接失效（**账号可被无限次暴力破解**）。资源创建无法由代码代劳，
> 必须你在自己账号下执行一次。

### 0. 准备

```bash
npm install
export CLOUDFLARE_API_TOKEN=你的token   # 或交互式执行 npx wrangler login
```

Token 需要的权限：`Workers Scripts:Edit` + `D1:Edit` + `Workers R2 Storage:Edit` + `Workers KV Storage:Edit`。

### 1. 一键创建 D1 / R2 / KV 并回写配置

```bash
npm run setup
```

脚本会创建三个资源、自动把返回的 id 写进 `wrangler.toml` 与 `wrangler.worker.toml`，
已存在的资源会跳过。等价的手工命令是：

```bash
npx wrangler d1 create openboard-db          # ← 把返回的 database_id 填进两个 toml
npx wrangler r2 bucket create openboard-uploads
npx wrangler kv namespace create openboard-kv  # ← 把返回的 id 填进 [[kv_namespaces]]
```

<details>
<summary>KV 为什么不能省（点开看说明）</summary>

`src/security.ts` 的登录限流优先走 KV，KV 未绑定时降级为查 D1 的 `login_history` 表 ——
降级路径能跑通，但每次失败登录都要写一次 D1，且统计口径不如 KV 精确。
**更重要的是：如果 KV 未绑定且 D1 的 `login_history` 表也不存在，限流会整体失效。**

本项目的 KV 只承担两类「容忍短暂不一致」的数据：

| 用途 | 键 | 为什么放 KV 没问题 |
|---|---|---|
| 登录限流计数 | `login:fail:u:{用户名}` / `login:fail:ip:{IP}` | 偶尔漏计一次，最多让人多试一次密码 |
| 在线用户快照 | `presence:online`（15 秒 TTL） | DO 才是权威源，KV 只是给管理后台统计读的缓存 |

⚠️ **绝对不要把用户账号、会话、封禁状态放进 KV。** KV 是最终一致存储，
写入后全球生效需要数十秒，会造成「改完密码旧密码还能登录」「封禁后仍可发消息」
这类真实的安全漏洞。业务数据一律走 D1，文件走 R2。

验证 KV 确实生效：

```bash
npx wrangler kv key list --binding=RATE_LIMIT --namespace-id=<你的KV_ID>
# 故意用错密码登录 5 次后，应能看到 login:fail:* 与 login:lock:* 键
```

</details>

### 2. 部署前自检（推荐）

```bash
npm run preflight
```

在本地 Miniflare 里把 schema 灌进临时 D1，跑完 38 项链路检查（注册/登录/会话/消息幂等/
编辑撤回/R2 上传与免鉴权直链/路径穿越/群聊/WebSocket 跨连接广播/KV 限流），
不创建任何云端资源、不碰你 `.wrangler` 里的开发数据。全绿再往下走。

### 3. 初始化 D1 表结构

```bash
npx wrangler d1 execute openboard-db --remote --file=./schema.sql
```

### 4. 一键部署（或分步执行）

```bash
npm run deploy
```

`scripts/deploy.sh` 会依次做：生成绑定类型 → `tsc --noEmit` → 灌 schema →
部署 DO Worker → 部署 Pages。顺序不能颠倒，**Pages 引用的 `ChatHub` 必须先存在于线上**，
否则会报 `Your Worker depends on the following Durable Objects, which are not exported
in your entrypoint file`。

手工分步等价于：

```bash
npx wrangler deploy --config wrangler.do.toml   # 产出 openboard-chat-hub
npx wrangler pages deploy public                # 首次会提示创建 Pages 项目
```

### 5. 设置 JWT 密钥（务必做）

```bash
npx wrangler pages secret put JWT_SECRET
# 输入足够长的随机字符串： openssl rand -base64 48
npx wrangler pages deploy public   # 设置 secret 后需重新发布一次才生效
```

不设置的话会用内置的开发用密钥（`src/env.ts` 的 `DEV_FALLBACK_SECRET`），
任何人都能伪造 token。

### 6. 设置管理员

注册一个账号后，把它提为管理员：

```bash
npx wrangler d1 execute openboard-db --remote \
  --command "UPDATE users SET role=1 WHERE username='你的账号'"
```

也可以把用户名加进 `wrangler.toml` 的 `ALLOWED_ADMINS`（逗号分隔，改完需重新部署）。

### 7. 部署后验收

```bash
curl https://你的域名/api/health
# → {"status":"ok","runtime":"cloudflare-workers","version":"v8.0.0","online_count":0}
```

---

## 从原项目迁移数据

```bash
python3 migrations/export_from_sqlite.py /path/to/board.db
npx wrangler d1 execute openboard-db --remote --file=./migrations/d1_import.sql
```

数据量大时分片导入：

```bash
python3 migrations/export_from_sqlite.py board.db --chunk 500
```

**密码迁移注意**：werkzeug 3.x 默认用 scrypt，而 Workers 的 Web Crypto 不提供 scrypt。
脚本会自动列出受影响的账号，这些账号迁移后需要重置密码（管理后台 → 改密码）。
旧库若使用 `pbkdf2:sha256:` 格式则可直接使用。

迁移后校验一下行数是否对得上：

```bash
npx wrangler d1 execute openboard-db --remote \
  --command "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM messages) AS messages"
```

---

## 本地开发

```bash
npm install
npx wrangler d1 execute openboard-db --local --file=./schema.sql   # 只做一次
npm run dev:api        # 纯 API + DO，端口 8788
npm run preflight      # 隔离环境跑完整链路自检，不碰开发数据
```

`wrangler.worker.toml` 把 API 与 DO 打进同一个 Worker，方便本地一次性验证。
Pages 全链路（含静态前端）的本地联调需要先部署 DO Worker 再跑 `wrangler pages dev`。

已跑通并做过回归的链路（`npm run preflight`，38/38 通过）：健康检查与安全响应头 /
注册 / 登录 / 会话（Bearer + Cookie）/ 重复用户名与弱密码拦截 / 好友申请与通过 /
发消息（含 `client_id` 幂等去重）/ 游标拉取 / 2 分钟窗口内编辑与撤回 /
R2 上传 + **免鉴权图片直链** / 路径穿越拦截 / 上传扩展名白名单 / 建群 / 群消息 /
群成员可见性 / **WebSocket 跨连接广播（收方 + 发方多端同步）** / **KV 登录限流 5 次锁 15 分钟**。

> ⚠️ `npm run preflight` 必须在干净环境下跑，不要加 `--persist`。
> schema 里含种子数据，`users` 表有唯一约束，第二次灌会报唯一键冲突。

把本地开发用的 D1 导出成 SQL（含 schema，可整份丢给远端）：

```bash
npm run d1:dump-local        # 产出 ./.local_d1_dump.sql
```

---

## 目录结构

```
openboard-cf/
├── public/                 # Pages 静态资源（前端，与原项目一致）
│   ├── index.html          # 聊天主页（仅增强 WebSocket 重连，业务逻辑未动）
│   ├── admin.html          # 管理后台（改为 fetch 渲染）
│   ├── game/               # 内置离线小游戏
│   ├── static/vendor/      # 本地化的 fontawesome、emoji-picker
│   └── _headers            # 安全响应头
├── functions/              # Pages Functions
│   ├── api/[[path]].ts     # /api/* 主入口
│   ├── ws.ts               # /ws（旧客户端路径，Cookie 鉴权）
│   └── ws/[[token]].ts     # /ws/{token}
├── src/
│   ├── app.ts              # Hono 应用装配
│   ├── worker.ts           # 独立 Worker 入口（备选方案）
│   ├── env.ts              # 绑定与环境变量声明
│   ├── crypto.ts           # PBKDF2 / JWT / TOTP（Web Crypto）
│   ├── db.ts               # D1 封装
│   ├── auth.ts             # 认证与会话
│   ├── permissions.ts      # 群权限、好友关系判定
│   ├── realtime.ts         # DO 广播调用
│   ├── kv.ts               # KV 用途封装（限流 + 在线快照，含降级）
│   ├── sanitize.ts         # XSS 清洗
│   ├── security.ts         # 限流、安全头
│   ├── durable/chat.ts     # ChatHub Durable Object
│   └── routes/             # auth / messages / groups / friends / admin
├── scripts/
│   ├── setup.sh            # 一键创建 D1 / R2 / KV 并回写配置
│   ├── deploy.sh           # 一键部署（DO Worker → Pages）
│   ├── preflight.mjs       # 部署前 38 项链路自检（隔离环境）
│   ├── android-ws-check.mjs # 存量 Android 客户端收消息验证（22 项）
│   └── local_d1_dump.sh    # 导出本地 D1 为 SQL
├── do-worker/index.ts      # DO 宿主 Worker
├── schema.sql              # D1 表结构
├── migrations/             # 旧 SQLite 数据导出脚本
├── wrangler.toml           # Pages 配置
├── wrangler.do.toml        # DO Worker 配置
└── wrangler.worker.toml    # 单 Worker 备选配置
```

---

## 与原版的差异及注意事项

1. **CPU 限制**：密码哈希用 PBKDF2-SHA256 210000 次迭代。Workers 免费套餐单请求 CPU 上限 10ms，
   登录/注册大概率超限 —— 请使用付费套餐，或把 `src/crypto.ts` 的 `PASSWORD_ITERATIONS` 调到 100000。
2. **服务端图片压缩**：原版用 Pillow 生成缩略图，Workers 上做不到。上传原样存入 R2，
   缩略图与压缩由前端负责（`index.html` 已实现上传前压缩）。如需服务端处理可接入 Cloudflare Images。
3. **HMS 推送**：原项目 v8.0.0 已移除华为推送，本版同样不含。离线通知可改接 Web Push。
4. **单机 WebSocket 上限**：ChatHub 是单 DO 实例，适合中小规模（数百到数千并发连接）。
   超大规模需按 room 分片（改 `realtime.ts` 的 `idFromName` 即可）。
5. **`/api/check_update`**：原版读取 GitHub Release，本版直接返回服务端版本号。
6. **登录限流**：原版存进程内存（边缘多实例下形同虚设），本版优先走 KV，
   KV 未绑定时降级为查 D1 的 `login_history` 表。规则同为「15 分钟内失败 5 次锁 15 分钟」。
7. **前端 WebSocket 重连**：原版固定 3 秒重连一次。本版改为指数退避 + 随机抖动
   （1s→2s→4s…上限 30s），并在页面重新可见 / 网络恢复时立即重连。
   必须这么改的原因：DO 会因 WebSocket Hibernation 被逐出内存，唤醒期间的连接会集中断开，
   固定间隔重连容易形成尖峰。
8. **图片直链鉴权**：原版从本地目录读文件。本版默认 `PUBLIC_UPLOADS=true`，
   上传文件名是随机串（相当于 capability token），`<img src>` 可直接加载；
   设成 `false` 则强制登录后才能读（但网页里的图片会全部 403，需自己接签名 URL）。
9. **时区**：`created_at` 由 SQLite 的 `CURRENT_TIMESTAMP` 写入 UTC，
   计算消息年龄时必须用 `strftime('%s', created_at)`（直接按文本解析即 UTC），
   不能写 `strftime('%s', created_at, 'utc')` —— 后者会再减一次时区偏移，
   让「2 分钟编辑/撤回窗口」直接失效（实测偏出 28800 秒）。
10. **WS 转发的 `Upgrade` 头**：`realtime.ts` 的 `upgradeWebSocket()` **手工重建**了升级请求
    （显式带 `Upgrade: websocket` / `Connection: Upgrade`），而不是复制原请求的头部。
    原因：`Upgrade` 是 Fetch 的 forbidden header，任何 `new Request(url, request)` 或
    `new Request(url, { headers })` 都会把它丢掉；而 Pages 运行时模板内部
    还会做一次 `new Request(request.clone())`，再丢一次。
    如果这里改成「搬运原请求头部」，DO 侧只会看到普通 GET，握手全部失败。
11. **存量 Android 客户端**：`/ws/{token}` 与 `/api/ws/{token}` 两条路径都保留，
    前者正是 `WebSocketManager.kt` 拼出来的（`wss://host/ws/{token}`）。
    改这两个入口后务必跑 `npm run check:android` 回归 —— 该脚本会逐字段核对
    `WsMessage.kt` 的 `WsData` 结构，防止改动字段名导致 App 侧解析失败。
12. **`/ws/` 路由参数归一化**：`functions/ws/[[token]].ts` 编译出的路由是 `/ws/:token*`，
    尾随 `*` 会让 `params.token` 变成**数组**，必须归一化成字符串再用，
    否则 `resolveUser()` 内部 `token.split()` 会抛错（500）。
