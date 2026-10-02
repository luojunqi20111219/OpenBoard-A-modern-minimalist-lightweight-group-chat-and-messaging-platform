-- ===========================================================================
-- 迁移：管理员动态授权
-- ===========================================================================
--
-- 执行方式（二选一）：
--
--   A. 命令行
--      npx wrangler d1 execute openboard-db --remote --file=migrations/001_admin_grants.sql
--
--   B. 接口（若命令行网络不通）
--      调 POST /api/admin/apply_migrations（需管理员登录）
--
-- 幂等：所有语句都带 IF NOT EXISTS / 用 UPDATE 做数据补齐，
-- 重复执行不会报错。
-- ===========================================================================

-- 1) users 增加 is_admin 列
--    SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS，重复执行会报
--    "duplicate column name"，把首次错误忽略即可（见下方执行说明）。
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- 2) 把已有的 role=1 账号同步为 is_admin=1
--    这样从"硬编码时代"过渡过来时，老管理员不会掉权限。
UPDATE users SET is_admin = 1 WHERE role = 1;

-- 3) 管理员申请表
CREATE TABLE IF NOT EXISTS admin_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL,
    note        TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    device_info TEXT,
    created_at  TEXT NOT NULL,
    handled_at  TEXT,
    handled_by  TEXT,
    UNIQUE(username, status)
);

CREATE INDEX IF NOT EXISTS idx_admin_requests_status
    ON admin_requests(status, id DESC);

-- 4) 管理员操作审计
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
