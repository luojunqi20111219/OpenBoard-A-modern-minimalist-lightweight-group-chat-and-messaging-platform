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
