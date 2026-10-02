-- 信语 OpenBoard — Cloudflare D1 数据库结构
-- 原项目 app/database.py 的 patch_db() 会在运行时反复 ALTER TABLE 补列，
-- D1 上没有意义（且 D1 迁移是一次性的），因此这里直接给出最终态 schema。
--
-- 应用：
--   npx wrangler d1 execute openboard-db --file=./schema.sql
-- 本地：
--   npx wrangler d1 execute openboard-db --local --file=./schema.sql

PRAGMA foreign_keys = OFF;

-- 用户 ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    nickname TEXT,
    token TEXT,
    role INTEGER DEFAULT 0,              -- 0 普通 / 1 管理员 / 2 系统账号
    is_banned INTEGER DEFAULT 0,
    avatar TEXT,
    blocked_users TEXT DEFAULT '',
    last_read_notice_id INTEGER DEFAULT 0,
    push_token TEXT,
    two_factor_secret TEXT,
    two_factor_enabled INTEGER DEFAULT 0,
    read_receipts_enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ⚠️ is_admin 与 must_change_password **刻意不写在上面**。
--
-- 这两列由 runAdminMigrations() 通过 ALTER TABLE 补齐（见 src/routes/migrations.ts），
-- 那才是它们的唯一权威来源。写进 CREATE TABLE 会带来一个隐蔽的问题：
-- schema.sql 同时被"全新安装"和"迁移后校验"两条路径使用，
-- 一旦这里预先建好列，migration_status 就会在任何环境下都报 ready=true，
-- 迁移是否真的跑过、要不要跑，就再也测不出来、也提示不出来了。
--
-- 新库的最终状态由 `npm run d1:init`（灌 schema）+ 一次 apply_migrations 共同决定，
-- 两步都是幂等的。

-- 消息 ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,                            -- 发送者用户名
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    room_id INTEGER DEFAULT 0,            -- 0 = 公共大厅，>0 = 群
    reply TEXT,
    receiver TEXT,                        -- 私聊接收者；群聊/大厅为 NULL
    edited_at DATETIME,
    edit_count INTEGER DEFAULT 0,
    client_id TEXT                        -- 客户端幂等 ID，弱网重发去重
);

-- 群组 ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    is_public INTEGER DEFAULT 1,
    owner_id INTEGER DEFAULT 0,
    avatar TEXT,
    is_frozen INTEGER DEFAULT 0,
    view_mode INTEGER DEFAULT 0,
    speak_mode INTEGER DEFAULT 0,
    black_view TEXT DEFAULT '',
    black_speak TEXT DEFAULT '',
    white_view TEXT DEFAULT '',
    white_speak TEXT DEFAULT '',
    announcement TEXT DEFAULT '',
    member_only INTEGER DEFAULT 0,
    join_approval INTEGER DEFAULT 0
);

-- 通知 ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    sender TEXT,
    target_user TEXT
);

-- 表情回应 ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id INTEGER,
    user TEXT,
    emoji TEXT,
    time TEXT
);

-- 已读回执 ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_reads (
    msg_id INTEGER,
    user TEXT,
    read_at TEXT,
    PRIMARY KEY (msg_id, user)
);

-- 登录设备 ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    device_id TEXT,
    push_token TEXT,
    token TEXT,
    last_login DATETIME DEFAULT CURRENT_TIMESTAMP,
    device_name TEXT,
    user_agent TEXT,
    ip_address TEXT,
    country TEXT,
    last_seen DATETIME,
    UNIQUE(user_id, device_id)
);

-- 已撤销会话 ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS revoked_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER,
    device_id TEXT,
    revoked_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 收藏表情 ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS favorite_emojis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    emoji TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(username, emoji)
);

-- 扫码登录会话 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qr_sessions (
    qr_id TEXT PRIMARY KEY,
    token TEXT DEFAULT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 好友请求 ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(from_user, to_user)
);

-- 好友 ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a TEXT NOT NULL,
    user_b TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_a, user_b)
);

-- 消息编辑历史 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id INTEGER NOT NULL,
    editor TEXT NOT NULL,
    old_content TEXT NOT NULL,
    edited_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 消息收藏 ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    msg_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(username, msg_id)
);

-- 会话设置（置顶 / 免打扰 / 最近已读）------------------------------------------
CREATE TABLE IF NOT EXISTS conversation_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    is_pinned INTEGER DEFAULT 0,
    is_muted INTEGER DEFAULT 0,
    last_read_id INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(username, conversation_key)
);

-- 群成员（v7.7 起改为用户名制）------------------------------------------------
CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    member_role TEXT DEFAULT 'member',
    muted_until DATETIME,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(group_id, username)
);

-- 入群申请 ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_join_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, username)
);

-- 邀请 ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    inviter TEXT NOT NULL,
    invitee TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, invitee)
);

-- 群操作审计 ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 登录历史 ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT NOT NULL,
    device_id TEXT,
    device_name TEXT,
    ip_address TEXT,
    country TEXT,
    user_agent TEXT,
    success INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 公共大厅（id = 0）+ 系统账号种子数据 ------------------------------------------
INSERT OR IGNORE INTO groups (id, name, is_public, owner_id) VALUES (0, '公共大厅', 1, 0);
-- 文件传输助手：无法登录的系统账号
INSERT OR IGNORE INTO users (username, password_hash, nickname, role, avatar)
    VALUES ('filehelper', 'system_account', '文件传输助手', 2, 'system_filehelper');

-- 管理员：role 提升为 1（密码需通过 /api/register 或管理员重置后设置）
-- 注意：D1 里没有默认管理员账号，首次部署后请用普通账号注册，
-- 再执行：UPDATE users SET role=1 WHERE username='你的账号';

-- 旧库导入状态 ---------------------------------------------------------------
-- 通过 /upload 上传旧 Python 版 board.db 的「仅一次」闸门。
-- CHECK (id = 1) 让这表最多只存一行 —— 并发导入时靠主键冲突做互斥，
-- 只有第一个 INSERT 成功（changes = 1），其余全部被忽略。
-- 存在行 = 导入入口已永久关闭。
-- 该表也会由代码在首次访问 /api/import/status 时懒创建，此处保留仅为
-- 让全新部署一次性建好、便于本地测试与人工核对。
CREATE TABLE IF NOT EXISTS _import_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    imported_at TEXT NOT NULL,
    source_summary TEXT
);

-- 索引 ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver);
CREATE INDEX IF NOT EXISTS idx_messages_name ON messages(name);
CREATE INDEX IF NOT EXISTS idx_messages_room_receiver_id ON messages(room_id, receiver, id);
CREATE INDEX IF NOT EXISTS idx_messages_name_receiver_id ON messages(name, receiver, id);
CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(content);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sender_client
    ON messages(name, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_reads_msg ON message_reads(msg_id);
CREATE INDEX IF NOT EXISTS idx_message_favorites_user ON message_favorites(username, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_settings_user ON conversation_settings(username, is_pinned DESC);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(username, group_id);
CREATE INDEX IF NOT EXISTS idx_group_requests_group_status ON group_join_requests(group_id, status);
CREATE INDEX IF NOT EXISTS idx_group_invites_user_status ON group_invites(invitee, status);
CREATE INDEX IF NOT EXISTS idx_group_audit_group_id ON group_audit_logs(group_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_login_history_user_id ON login_history(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_friend_requests_users ON friend_requests(from_user, to_user);
CREATE INDEX IF NOT EXISTS idx_friends_users ON friends(user_a, user_b);
CREATE INDEX IF NOT EXISTS idx_user_devices_user_login ON user_devices(user_id, last_login DESC);
CREATE INDEX IF NOT EXISTS idx_revoked_sessions_user ON revoked_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_notifications_target ON notifications(target_user, id DESC);

-- ===========================================================================
-- 管理员授权（管理端 App 用）
-- ===========================================================================
--
-- 背景：早期管理员名单硬编码在 wrangler.toml 的 ALLOWED_ADMINS 里，
-- 增删一个管理员要改配置并重新部署。管理端 App 需要动态授权，因此改存 D1。
--
-- 设计：
--   · is_admin = 1 表示该账号拥有管理权限（与原 role=1 等价，但独立成列，
--     避免和"版主/普通用户"这类业务角色语义混淆）
--   · granted_by 记录是谁授予的，形成审计链
--   · 首次授权走"申请 → 批准"：被授权人先登录管理端提交申请，
--     现有管理员在聊天端或管理端点「批准」才真正生效，
--     防止误点把陌生人提权
-- ---------------------------------------------------------------------------

-- 管理员申请表
CREATE TABLE IF NOT EXISTS admin_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL,
    -- 申请人填写的说明（如"我是 XX，负责内容审核"），供管理员判断
    note        TEXT,
    -- pending / approved / rejected
    status      TEXT NOT NULL DEFAULT 'pending',
    -- 申请人设备信息，便于管理员识别
    device_info TEXT,
    created_at  TEXT NOT NULL,
    handled_at  TEXT,
    handled_by  TEXT,
    UNIQUE(username, status)
);

CREATE INDEX IF NOT EXISTS idx_admin_requests_status
    ON admin_requests(status, id DESC);

-- 管理员操作审计日志（谁在什么时候对谁做了什么）
CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    target     TEXT,
    detail     TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created
    ON admin_audit_logs(id DESC);
