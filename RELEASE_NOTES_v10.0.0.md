# OpenBoard v10.0.0 发布说明

> **主题：管理员体系上线** — 从"硬编码管理员"到"可申请、可批准、可撤销、可审计"

发布日期：2026-10-02

---

## 一、这个版本解决了什么问题

v9.0.0 迁移到 Cloudflare Workers 之后，遗留了两个必须尽快处理的问题：

**问题 1：有一批账号用原密码登不进来。**

旧版 Python/FastAPI 用 werkzeug 的默认哈希策略 `scrypt:32768:8:1`。
scrypt 的参数（N=32768, r=8）写在哈希串里，**验证时必须用同样的参数**，
不能降级。实测这个参数在 Cloudflare Workers 上：

| 实现方式 | 单次验证耗时 |
|---|---|
| 纯 JS（`@noble/hashes`） | 130–150 ms |
| WASM（`hash-wasm`） | 75 ms |
| **Workers Free 计划单请求 CPU 上限** | **10 ms** |

差了将近 60 倍，**物理上跑不完**。（`limits.cpu_ms` 配置只有 Paid 计划能用，
而 N 参数无法降低。）所以这些账号只能由管理员重置密码。

**问题 2：管理权限硬编码在 `wrangler.toml` 里。**

改一次要重新部署，而且没法在手机上授权别人。用户的原话是：

> "你也可以设置一下，同意谁也成为管理员，它第一次使用的时候，需要授权登录。
> 授权登录的方式，可以设置为跳转到普通的聊天客户端，然后点击账号。"

v10.0.0 把这两件事一起做掉了。

---

## 二、新增能力

### 1. 管理员权限动态化

权限判定现在是三级，顺序不可颠倒：

```
1. role === 1                    ← 老数据里已提权的账号（兼容，避免历史管理员掉权）
2. ALLOWED_ADMINS 硬编码名单      ← 保底通道
3. D1 的 users.is_admin = 1      ← 动态管理员（本版新增）
```

**为什么顺序不能反**：第 2 条必须在第 3 条之前。`ALLOWED_ADMINS` 是
"就算数据库被清空也还能救回来"的最后一道门。全部依赖 D1 的话，
一旦有人误删 `is_admin` 字段，就再也没人能进管理端了。

### 2. 申请 → 批准 的信任链

```
某人想当管理员
      ↓  在聊天端「设置」点「申请成为管理员」，填写说明
   admin_requests 表（status=pending）
      ↓  现有管理员在聊天端点开，或去管理端 App「授权」标签页
   批准 ──→ users.is_admin = 1，立即可用管理端
   拒绝 ──→ 记录被拒，可重新申请
```

**为什么不直接授予**：管理端的用户列表里有几十个人，误点一下就把陌生人
提权了，风险太大。让申请人自己提交申请（带说明、设备信息、时间），
管理员在有完整上下文的情况下做决定，而且这是个显式动作。

重复申请不会堆积：`UNIQUE(username, status)` 配合
`INSERT ... ON CONFLICT DO UPDATE`，只刷新内容不新增行。

### 3. 管理端安卓客户端（全新）

`OpenBoardAdmin/`，包名 `com.openboard.admin`。五个标签页：

| 标签页 | 内容 |
|---|---|
| **概览** | 注册数 / 近期消息 / 在线数 / 已封禁数 / 待重置密码数 + 最近消息、群聊、在线名单 + 全站广播 |
| **用户** | 搜索、分页、**「只看需要重置密码的账号」筛选**、一键重置密码、封禁/解封 |
| **授权** | 待处理 / 已批准 / 已拒绝三个子页，批准或拒绝申请 |
| **操作记录** | 审计日志，提权类操作红色高亮 |
| **服务器** | 切服务器地址、迁移状态自查与一键初始化、管理员名单 |

用户列表里的关键设计：**服务端返回 `needs_password_reset` 标记**，
客户端把旧格式哈希的账号高亮出来，并提供筛选开关。否则管理员得自己
一个一个试谁登不上。

### 4. 密码重置

- 新密码用 `pbkdf2:sha256:<当前迭代>`，当前套餐下可直接验证
- 强度由**服务端**强制：≥6 位、≥2 类字符、≤128 位
- 不能重置系统账号（role=2）、不能重置自己（防自锁）
- 重置后 `kickUser` 强制下线所有在线连接

### 5. 审计日志

所有管理操作落 `admin_audit_logs`：

`admin.apply` / `admin.approve` / `admin.revoke` / `admin.reject` /
`admin.reset_password` / `admin.ban` / `admin.unban` /
`admin.delete_user` / `admin.broadcast`

写日志失败**不阻断主流程**（审计是附属能力，不该拖垮操作本身），
所以这是"尽力而为"的记录，不是严格的事务日志。

### 6. 登录提示改造

旧格式哈希的账号登录时返回结构化响应，不再是干巴巴的"登录失败"：

```json
{
  "detail": "该账号需要重置密码后才能登录",
  "code": "PASSWORD_RESET_REQUIRED",
  "reason": "...",
  "admin_contact": {
    "title": "…",
    "message": "…",
    "action_url": "/contact-admin",
    "action_label": "…"
  },
  "unavailable_since": "scrypt"
}
```

配套新增 `/contact-admin` 页面（只展示管理员用户名，不暴露更多信息）。

### 7. 聊天端联动

`OpenBoardAndroid` 的「设置」页新增：

- **已是管理员** → 显示「待处理的管理员申请（N）」「管理员名单」
- **申请待审批** → 隐藏申请按钮，避免重复提交
- **普通用户** → 显示「申请成为管理员」

名单页里，自己的账号和保底名单账号不给撤销按钮（服务端也会拦，
这里只是少让人白点一次）。

---

## 三、部署与使用

### 首次使用：先初始化数据库

管理端 App 打开后，如果数据库还没加管理功能所需的表/字段，首页会显示
一条橙色提示条，点一下即可完成初始化（幂等，不会删除任何数据）。

也可以手动触发：

```bash
curl -X POST https://<your-worker>/api/admin/apply_migrations \
  -H "Authorization: <token>"
```

补充的内容：

- `users.is_admin` 列
- `admin_requests` 表 + 索引
- `admin_audit_logs` 表 + 索引
- 把历史 `role=1` 的账号同步为 `is_admin=1`

### 让现有账号能重新登录

在管理端 App「用户」标签页打开「只看需要重置密码的账号」，
逐个点「重置密码」，把新密码告诉对应的用户。

如果只有一两个账号要处理，也可以用脚本在本地生成哈希后写回 D1：

```bash
CF_API_TOKEN=... CF_ACCOUNT_ID=... CF_D1_ID=... \
  node scripts/rehash-local.mjs <username> <新密码>
```

---

## 四、兼容性与安全性说明

**兼容**

- 旧客户端签发的 JWT 可直接继续使用（结构未变）
- 旧格式密码哈希**原样保留**，没有被覆盖 —— 万一将来升级到 Paid
  计划能跑得动 scrypt，密码仍然可用
- `role=1` 的历史管理员权限保持不变

**安全**

- 所有管理接口都是 `requireAuth` + `requireAdmin` 双重校验
- `approve` / `revoke` 在**写库前**再校验一次操作者权限 ——
  否则"权限已被撤销但旧会话还在"的人仍能提权别人
- 不能撤销自己（防自锁）；不能撤销保底名单里的人
- 不能封禁/删除自己；系统账号（role=2）不可操作
- 管理接口不回传密码哈希本体，只回传算法标识
- 管理端 App 只存 token，**不存密码**

**已知限制**

- **Free 计划跑不了 scrypt**，旧密码必须重置。这是硬约束，
  除非升级到 Paid 计划并开放更大的 CPU 预算。
- 审计日志的作用范围限于"用了审计接口的操作"。直接改数据库
  不会留下记录。

---

## 五、升级步骤

```bash
# 1. 部署 Worker（新增了 /api/admin/apply、/api/admin/requests 等接口）
cd openboard-cf && npm run deploy

# 2. 安装管理端 App
#    OpenBoardAdmin/app/build/outputs/apk/release/app-release.apk

# 3. 打开管理端 App 登录 → 首页橙色提示条 → 一键初始化

# 4. 在「用户」页筛选需重置密码的账号，逐个重置
```

> **本次线上环境已经完成迁移**（2026-10-02）：
>
> - `users.is_admin` 列、`admin_requests` 表、`admin_audit_logs` 表及索引均已创建
> - 已有管理员：`官方账号`、`Forest_siri`、`Brian_Birch`、`admin`
> - `test` 账号已从 `role=1` 降回 `role=0`
>
> 因此管理端 App 首次打开**不会**再看到初始化提示条。
>
> 迁移是通过 D1 的 HTTP query 接口逐条执行完成的，原因见下。
>
> **关于 `wrangler d1 execute --remote --file=...`** —— 这条命令走的是 D1 的
> *导入通道*（先上传 SQL 文件再执行），在部分网络环境下会以 `fetch failed`
> 失败，而 D1 的 HTTP query 接口却是通的。所以 `scripts/deploy.sh` 里第 3 步
> 如果失败，不代表数据库有问题，直接用 `POST /api/admin/apply_migrations`
> （需管理员 token）或 D1 REST API 即可。
>
> 注意 `ALTER TABLE ADD COLUMN` 在 SQLite 里不支持 `IF NOT EXISTS`，
> 重复执行会报 `duplicate column name`。幂等性靠"先探测列是否存在"来实现
> （见 `src/routes/migrations.ts` 的 `hasColumn`），而不是靠 SQL 自带的能力。

Android 端 `versionCode` 已从 `90000` 升到 `100000`，
可直接覆盖安装 v9.0.0。

---

## 六、文件清单

**Cloudflare Workers（`openboard-cf/`）**

| 文件 | 变更 |
|---|---|
| `src/routes/admin-grants.ts` | 新建 —— 申请/批准/拒绝/撤销/名单/审计 |
| `src/routes/migrations.ts` | 新建 —— 幂等迁移接口 |
| `src/auth.ts` | `isAdminAsync` 三级判定、`hasAdminFlag`、`setAdminFlag` |
| `src/routes/admin.ts` | 新增 `/admin/users`、`/admin/user`、`/admin/reset_password`、`/admin/ban_users` + 审计埋点 |
| `src/routes/auth.ts` | `PASSWORD_RESET_REQUIRED` 结构化响应 |
| `src/app.ts` | `/contact-admin` 页面、新路由挂载 |
| `src/worker.ts` | `/contact-admin` 加入 Worker 优先路由 |
| `schema.sql` | `admin_requests`、`admin_audit_logs` |
| `migrations/001_admin_grants.sql` | 新建 |
| `scripts/admin-grants-test.mjs` | 新建 —— 77 项管理员体系回归测试 |
| `wrangler.toml` | `CURRENT_VERSION = "v10.0.0"`；`ALLOWED_ADMINS` 中 `Forest_Brian_Birch` 修正为 `Brian_Birch`（原值与实际用户名不符，保底通道实际不生效） |

**管理端 App（`OpenBoardAdmin/`，全新）**

```
app/src/main/java/com/openboard/admin/
├── data/
│   ├── AdminSession.kt             只存 token，不存密码
│   ├── api/AdminApiService.kt      全部管理端点
│   ├── api/AdminRetrofitClient.kt  默认指向线上部署，登录页可改
│   └── model/AdminModels.kt        数据模型
└── ui/
    ├── login/AdminLoginActivity.kt 三分支：管理员 / 非管理员 / 需重置密码
    ├── main/AdminMainActivity.kt   五标签容器 + 迁移横幅
    ├── main/ServerFragment.kt      服务器设置与迁移
    ├── overview/OverviewFragment.kt
    ├── user/UserListFragment.kt    搜索 + 筛选 + 重置 + 封禁
    ├── user/UserDetailActivity.kt  详情 + 权限授予/撤销 + 删除
    ├── user/AdminUserAdapter.kt
    ├── auth/AdminRequestsFragment.kt
    ├── auth/AdminRequestAdapter.kt
    ├── common/AuditFragment.kt
    ├── common/AuditAdapter.kt
    ├── common/Ui.kt                头像、三态视图、时间格式化
    └── common/Views.kt
```

**聊天端 App（`OpenBoardAndroid/`）**

| 文件 | 变更 |
|---|---|
| `ui/main/ProfileFragment.kt` | 管理入口 + 申请/审批/名单三处对话框 |
| `data/api/ApiService.kt` | 7 个管理员相关端点 |
| `data/repository/ChatRepository.kt` | 对应 7 个仓库方法 |
| `data/model/AdminModels.kt` | 新建 —— 聊天端侧的精简模型 |
| `res/layout/fragment_profile.xml` | 管理区块 |
| `app/build.gradle` | `versionCode 100000` / `versionName "10.0.0"` |

---

## 七、测试

```bash
cd openboard-cf
npm run typecheck     # TypeScript 类型检查
npm run test:all      # 全量回归
```

`test:all` 现在包含五套：

| 套件 | 覆盖内容 | 项数 |
|---|---|---|
| `test:import` | 旧库导入、`/upload` 页面、附件迁移、未知列过滤 | 109 |
| `test:admin` | 迁移幂等、申请/批准/拒绝/撤销、权限边界、审计、密码算法标记、未迁移降级 | 77 |
| `preflight` | 登录限流与 429 锁定、核心接口冒烟 | 38 |
| `check:android` | WebSocket 协议兼容性 | 22 |
| `test:ui` | `/upload` 浏览器端全流程（前端打 zip → 上传 → 落库 → 附件直链） | 37 |

合计 **283 项全部通过**。

> `test:admin` 里有两条断言值得一提，它们都是**先发现了 bug 才写下的**：
>
> 1. *「高迭代 pbkdf2 标为需重置」* —— 管理端用户列表原来只看算法名
>    （`isUnsupportedHash`），把 `pbkdf2:sha256:260000` 这种"算法对但迭代
>    超预算"的哈希标成可正常登录，实际登录却会返回 `PASSWORD_RESET_REQUIRED`。
>    管理员照着列表清理会漏掉一批人。修复方式是在 `src/crypto.ts` 提取
>    `needsPasswordReset(stored, targetIterations)`，**登录路径与管理端列表
>    共用同一份判定**。
> 2. *「未迁移时申请列表为空并带 detail」* —— 测试必须先 `DROP TABLE`
>    才有意义。因为 `schema.sql` 里已经有这两张表了，默认建库后它们就存在，
>    不删表走的就是正常路径，测不到降级分支。

---

## 八、下一步

- **轮换凭据** —— 本项目开发过程中有 Cloudflare API Token 与
  GitHub Token 出现在对话记录里，建议在控制台重新签发。
  注意：Cloudflare Token 一旦轮换，需要同步更新本地环境变量。
- 考虑给管理端 App 加请求签名，避免 token 被中间人截获后直接重放。
- 如果后续升级到 Workers Paid 计划，可以把 `PASSWORD_ITERATIONS`
  调到 210000，并在有需要时恢复 scrypt 校验路径。
