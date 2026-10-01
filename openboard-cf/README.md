# 信语 OpenBoard — Cloudflare Workers 版

原项目（FastAPI + SQLite + 本地文件）的 Cloudflare 原生改造版。API 与前端**保持完全兼容**，已发布的 Android / HarmonyOS / iOS / 网页客户端无需改动即可对接。

线上地址：<https://liuyan.luojunqi.xyz>（备用：<https://openboard.luojunqi.xyz>）

---

## 架构对照

| 原项目 | 本版本 | 说明 |
|---|---|---|
| FastAPI（Python） | **Hono** on Workers | Python Workers 跑不了 FastAPI（pydantic-core 是 Rust 扩展），故改写为 TypeScript |
| SQLite 文件 `board.db` | **D1** | SQLite 方言，表结构几乎原样迁移 |
| 内存 `ConnectionManager` | **Durable Object**（WebSocket Hibernation） | 原实现把连接存进程内存，边缘多节点下必然失效 |
| 本地 `uploads/` 目录 | **R2** | 原用 Pillow 生成缩略图，Workers 做不了服务端图片处理；图片用随机文件名当 capability token |
| PyJWT | **Web Crypto HMAC-SHA256** | JWT payload 结构不变，旧 token 可直接平移 |
| werkzeug 密码哈希 | **PBKDF2-SHA256**（Web Crypto） | 保持 werkzeug 同格式，旧库 pbkdf2 哈希可直接用 |
| bleach | 内置 HTML 清洗 | 等价于 `bleach.clean(text, tags=[], strip=True)` |
| Jinja2 模板 | Workers 静态资源托管 | `index.html` 原本就不含模板变量，直接搬 |
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
单 Worker（openboard）
┌────────────────────────────────────────────────────┐
│  WebSocket ──▶ ChatHub Durable Object（全局广播）   │
│  /api/*    ──▶ Hono 路由（D1 + R2 + KV）            │
│  其它路径   ──▶ Assets（index.html / admin.html）    │
└────────────────────────────────────────────────────┘
         ▲                          ▲
    openboard.luojunqi.xyz    liuyan.luojunqi.xyz
         └──────── Workers Routes ────────┘
```

> ⚠️ **为什么是一个 Worker，而不是 Pages + 独立 DO Worker**
>
> 本项目最初按 **Pages Functions** 实现，但该方案在本项目的核心场景下
> **根本不可用**：Pages 无法返回带 WebSocket 的 101 响应。
>
> Cloudflare 官方兼容性矩阵写得很明确 ——
> `Durable Objects: Only available on Workers`。
> Pages Functions 通过 `script_name` 跨服务引用 DO 时，普通 HTTP 请求正常，
> 但 WebSocket 升级**一律 500（`error code 1101`）**：
> 带 `webSocket` 属性的 101 响应无法穿过 Pages → DO 的服务绑定边界，
> 且异常发生在运行时层，连 `try/catch` 都拦不住。
>
> 改为单个 Worker 承载全部职责后：
> - DO 是**同 Worker 内的原生绑定**，不再需要 `script_name` 跨引用
> - WebSocket 全程走同一隔离环境，101 直接返回
> - 少一个 Worker、少一次跨服务调用，延迟更低
> - 额外获得 Cron Triggers 与完整可观测性
>
> 静态资源请求在此形态下与 Pages 一样**不额外计费**。

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

脚本会创建三个资源、自动把返回的 id 写进 `wrangler.toml`，
已存在的资源会跳过。等价的手工命令是：

```bash
npx wrangler d1 create openboard-db            # ← 把返回的 database_id 填进 wrangler.toml
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
`npx wrangler deploy`。**单次部署即可完成全部内容** ——
静态资源、API 路由、Durable Object 全在同一个 Worker 里，没有分步顺序问题。

手工等价的命令只有一条：

```bash
npx wrangler deploy
```

### 4.5 绑定自定义域名（可选）

Worker 部署后会得到一个 `*.workers.dev` 地址。若要绑自己的域名：

```bash
# 方式一：Worker 自定义域（推荐，Cloudflare 自动签发证书）
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/domains" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"zone_id":"<ZONE_ID>","hostname":"chat.example.com","service":"openboard","environment":"production"}'

# 方式二：Zone 级 Worker Route（需先有一条 proxied 的 DNS 记录指向任意地址）
curl -X POST "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/workers/routes" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"pattern":"chat.example.com/*","script":"openboard"}'
```

> ⚠️ Token 需具备 `Zone:Workers Routes:Edit`。**`Zone.DNS:Edit` 不被这两种方式需要**，
> 但方式二要求域名已有一条 proxied DNS 记录（否则流量到不了 Cloudflare）。
>
> ⚠️ 若域名此前挂在 Pages 项目上，必须先解绑再删除 Pages 项目
> （Cloudflare 不允许删除仍有自定义域的 Pages 项目），之后才能绑到 Worker。

### 5. 设置 JWT 密钥（务必做）

```bash
npx wrangler secret put JWT_SECRET
# 输入足够长的随机字符串： openssl rand -base64 48
```

不设置的话会用内置的开发用密钥（`src/env.ts` 的 `DEV_FALLBACK_SECRET`），
**任何人都能伪造 token**。

> ⚠️ `JWT_SECRET` **不能**同时写在 `wrangler.toml` 的 `[vars]` 里。
> 同名变量会让 `secret put` 报 `Binding name 'JWT_SECRET' already in use [code: 10053]`。
> 本项目的 `wrangler.toml` 已刻意移除该行。
>
> 写入 secret 后**不需要重新部署**，Worker 会在下次请求时读取到新值。

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
# → {"status":"ok","runtime":"cloudflare-workers","version":"v9.0.0","online_count":0}
```

---

## 从原项目迁移数据

有两种方式，**都只能执行一次**，成功后入口自动永久关闭。

### 方式 A：网页导入（推荐，四种输入都支持）

打开 `https://你的域名/upload`，页面支持三条通路：

| 输入 | 迁移内容 | 体积上限 |
|---|---|---|
| `board.db` 单文件 | 仅数据（20 张白名单表） | 25 MB |
| `.zip` / `.tar.gz` / `.tgz` / `.tar` | **数据 + `uploads/` 附件** | 60 MB |
| 点「选择文件夹」（或直接把文件夹拖进页面） | 同上，前端自动打 zip 后上传 | 60 MB（打包后） |

压缩包直接选**旧项目的整个根目录**即可（`openboard/` 那一层含 `board.db`、
`uploads/`、`APP/`、`app.js`…），服务端会自动剥掉外层包裹目录，
在任意深度定位 `board.db`，并把 `uploads/` 下的附件写进 R2。

> **附件为什么必须落到 R2**：旧消息正文里存的是路径
> （`[img:/uploads/{uuid}.jpg|/uploads/{uuid}.thumb.jpg]`），
> 而前端只渲染同源 URL。因此 R2 的 key 必须与旧文件名**逐字节相同**，
> 迁移后历史图片才能原样显示，前端**无需任何改动**。
> 为此服务端额外提供了两条兼容路由：
> `GET /uploads/:filename`（复刻旧的 StaticFiles 挂载点）
> 与 `GET /api/download/:filename?name=`（复刻旧的下载接口，含中文文件名）。

单次导入的返回体会带上附件统计（`archive.attachments`：
`written` / `existed` / `failed` / `totalBytes`），页面会直接展示。

**超大目录**：若压缩后超过 60 MB，页面会明确拒绝并建议分批
（例如先只打包 `uploads/`，再单独传 `board.db`）—— 不做静默截断。

### 方式 B：命令行（数据量大或需要脚本化时）

```bash
python3 migrations/export_from_sqlite.py /path/to/board.db
npx wrangler d1 execute openboard-db --remote --file=./migrations/d1_import.sql
```

分片导入：

```bash
python3 migrations/export_from_sqlite.py board.db --chunk 500
```

> ⚠️ 命令行方式**不含附件**。附件在旧版的 `uploads/` 目录里，
> 要一并迁移请走方式 A。

### 密码迁移注意

werkzeug 3.x 默认用 scrypt，而 Workers 的 Web Crypto 不提供 scrypt。
导入结果会列出受影响的账号（`needsPasswordReset.unsupported`），
这些账号迁移后需要重置密码（管理后台 → 改密码）。
`pbkdf2:sha256:` 且迭代次数不高于当前套餐限额的哈希可直接登录；
迭代次数过高的会被列进 `needsPasswordReset.highIteration`。

迁移后校验行数：

```bash
npx wrangler d1 execute openboard-db --remote \
  --command "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM messages) AS messages"
```

### 合并语义与保护

导入一律 `INSERT OR IGNORE`，**合并而非覆盖**：

- `users` / `groups` 等表以自身 UNIQUE 约束判冲突，已存在的记录跳过
- `groups.id=0`（公共大厅）与 `filehelper`（role=2）是 schema.sql 的种子数据，**永不被覆盖**
- 旧库中不在 20 表白名单里的表只提示、不导入
- 重名附件**不覆盖**（旧库文件名是 uuid4，碰撞概率可忽略）

---

## 本地开发

```bash
npm install
npx wrangler d1 execute openboard-db --local --file=./schema.sql   # 只做一次
npm run dev            # 完整本地环境（静态前端 + API + DO），wrangler dev 自带
npm run preflight      # 隔离环境跑完整链路自检，不碰开发数据
npm run test:import    # 数据导入专项（含 zip/附件/R2/旧 URL 兼容），85 项
```

`npm run dev` 起的是完整的 Worker（含 assets / API / DO 三合一），
静态前端与接口同域，无需像 Pages 时代那样先部署 DO 再 `wrangler pages dev`。

> ⚠️ **本地 Miniflare 与线上行为并不完全等价**，有两个已知差异：
> 1. Miniflare 3 **不支持** `assets.run_worker_first`，其 assets 路由会拦截
>    所有请求，导致 Worker 的 `fetch` 根本不执行。因此 `scripts/*.mjs`
>    的自检脚本**刻意不挂载 assets**，只依赖 `src/worker.ts` 里的路径兜底逻辑。
>    线上必须依赖 `wrangler.toml` 的 `run_worker_first` 配置。
> 2. Miniflare 4 在用 FormData 作 body 时**不会自动推导** multipart 的
>    Content-Type 与 boundary（v3 会）。`scripts/preflight.mjs` 已做兼容处理。
>
> 正因如此，**本地全绿不代表线上可用**。本项目早期正是「本地 38/38、线上 WS 全 500」。
> 部署后务必跑一次生产环境测试：
> ```bash
> node scripts/live-ws-test.mjs 你的域名
> ```

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
├── public/                 # 静态资源（前端，与原项目一致）
│   ├── index.html          # 聊天主页（仅增强 WebSocket 重连，业务逻辑未动）
│   ├── admin.html          # 管理后台（改为 fetch 渲染）
│   ├── game/               # 内置离线小游戏
│   ├── static/vendor/      # 本地化的 fontawesome、emoji-picker
│   └── favicon.ico
├── src/
│   ├── worker.ts           # Worker 入口（assets / API / DO 三合一 + 路径路由兜底）
│   ├── app.ts              # Hono 应用装配（含 4 条 WebSocket 路由、线上自检端点）
│   ├── env.ts              # 绑定与环境变量声明
│   ├── crypto.ts           # PBKDF2 / JWT / TOTP（Web Crypto）
│   ├── db.ts               # D1 封装
│   ├── auth.ts             # 认证与会话
│   ├── permissions.ts      # 群权限、好友关系判定
│   ├── realtime.ts         # DO 广播调用（含 WS 升级请求构造）
│   ├── kv.ts               # KV 用途封装（限流 + 在线快照，含降级）
│   ├── sanitize.ts         # XSS 清洗
│   ├── security.ts         # 限流、安全响应头（⚠️ 必须跳过 101）
│   ├── durable/chat.ts     # ChatHub Durable Object
│   └── routes/             # auth / messages / groups / friends / admin
├── scripts/
│   ├── setup.sh            # 一键创建 D1 / R2 / KV 并回写配置
│   ├── deploy.sh           # 一键部署（npx wrangler deploy）
│   ├── preflight.mjs       # 部署前 38 项链路自检（隔离环境）
│   ├── android-ws-check.mjs # 存量 Android 客户端收消息验证（22 项）
│   ├── live-ws-test.mjs    # ⭐ 生产环境端到端测试（在真实域名上跑）
│   └── local_d1_dump.sh    # 导出本地 D1 为 SQL
├── schema.sql              # D1 表结构
├── migrations/             # 旧 SQLite 数据导出脚本
└── wrangler.toml           # Worker 配置（单文件，无其他 toml）
```

---

## 与原版的差异及注意事项

1. **CPU 限制**：密码哈希用 PBKDF2-SHA256，默认 10000 次迭代。
   Workers **免费套餐**单请求 CPU 上限 10ms，`210000` 次迭代必然超限，
   表现为注册/登录一律 500。因此默认降到 10000（实测线上 `hash=0ms`）。
   升级到付费套餐（CPU 上限 30s）后可通过 `PASSWORD_ITERATIONS` 环境变量调回 `210000`。
   哈希自身记录了迭代次数，**调整此值不会让已有密码失效**；
   登录时若发现旧哈希迭代次数低于目标值，会**自动后台重算并升级**。
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
9. **静态资源缓存**：Workers Assets 的缓存响应头**无法被 Worker 代码覆盖**
   （Cloudflare 在 Worker 之后由静态资源层统一写入，实测包括 `new Response()` 重建也无效）。
   所有静态资源一律 `public, max-age=0, must-revalidate`。
   该策略功能正确（靠 ETag + 304 校验，不重复传文件体），若需强缓存请用 zone 级 Cache Rules。
   另：Pages 的 `public/_headers` 文件在 Workers 下**完全无效**，本版已移除。
10. **时区**：`created_at` 由 SQLite 的 `CURRENT_TIMESTAMP` 写入 UTC，
   计算消息年龄时必须用 `strftime('%s', created_at)`（直接按文本解析即 UTC），
   不能写 `strftime('%s', created_at, 'utc')` —— 后者会再减一次时区偏移，
   让「2 分钟编辑/撤回窗口」直接失效（实测偏出 28800 秒）。
10. **WS 转发的 `Upgrade` 头**：`realtime.ts` 的 `upgradeWebSocket()` **手工重建**了升级请求
    （显式带 `Upgrade: websocket` / `Connection: Upgrade`），而不是复制原请求的头部。
    原因：`Upgrade` 是 Fetch 的 forbidden header，任何 `new Request(url, request)` 或
    `new Request(url, { headers })` 都会把它丢掉。
    如果这里改成「搬运原请求头部」，DO 侧只会看到普通 GET，握手全部失败。
11. **存量 Android 客户端**：`/ws/{token}` 与 `/api/ws/{token}` 两条路径都保留，
    前者正是 `WebSocketManager.kt` 拼出来的（`wss://host/ws/{token}`）。
    改这两个入口后务必跑 `npm run check:android` 回归 —— 该脚本会逐字段核对
    `WsMessage.kt` 的 `WsData` 结构，防止改动字段名导致 App 侧解析失败。
12. **`/ws/` 路由参数类型**：`src/app.ts` 里必须写 `/ws/:token`（**不带尾随 `*`**）。
    原 Pages 版 `functions/ws/[[token]].ts` 会编译成 `/ws/:token*`，
    尾随 `*` 会让 `params.token` 变成**数组**，导致 `resolveUser()` 内部
    `token.split()` 抛错（500），存量安卓客户端全部连不上。
13. **安全响应头必须跳过 101**：`security.ts` 的 `securityHeaders()` 对
    `status === 101 || res.webSocket` 直接放行。101 响应的 headers 是
    **不可变（immutable）**的，对其 `set()` 会抛 `TypeError: Can't modify immutable headers`。
    该异常发生在中间件里，会把整个 WebSocket 握手变成 500，且响应体**看不到任何原因**
    （Pages 上是无信息的 `error code 1101`，Workers 上是「服务器内部错误」）。
    极易误判为 DO 绑定问题，实际纯粹是这一行 header 写入。所有 header 写入均已包 `try/catch`。
