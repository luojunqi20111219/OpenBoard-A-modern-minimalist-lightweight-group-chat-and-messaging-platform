-- ===========================================================================
-- 迁移：管理端新功能（禁言 / 看板 / 内容审核 / 操作日志）
-- ===========================================================================
--
-- 执行方式（二选一）：
--
--   A. 命令行
--      npx wrangler d1 execute openboard-db --remote --file=migrations/002_admin_features.sql
--
--   B. 接口（若命令行网络不通 —— 这也是本项目更常用的一条路）
--      调 POST /api/admin/apply_migrations（需管理员登录）
--      语句在 src/routes/migrations.ts 的 runAdminMigrations() 里内联
--
-- ⚠️ 本文件与 runAdminMigrations() 必须保持一致。
--    代码路径是**权威**（Android 管理端的一键初始化按钮走它），
--    这里只是为了给命令行留一条等价通道。
--
-- ⚠️ SQLite 的 ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，
--    重复执行会报 "duplicate column name"。首次报错可忽略。
-- ===========================================================================

-- 1) users.muted_until —— 站点级禁言
--
-- 与 is_banned 的区别：封号 = 登不进来；禁言 = 能进能看但不能发言。
-- 存 UTC 的 'YYYY-MM-DD HH:MM:SS'，与 group_members.muted_until 同格式。
-- NULL 表示从未被禁言。
ALTER TABLE users ADD COLUMN muted_until DATETIME;

-- 2) groups.created_at —— 看板的「每日新增群聊」曲线
--
-- ⚠️ 不能带 DEFAULT CURRENT_TIMESTAMP：SQLite 的 ADD COLUMN 只接受
--    常量默认值，带非常量默认值会报
--      Cannot add a column with non-constant default
--    历史群该列保持 NULL，曲线从迁移生效后开始计。
ALTER TABLE groups ADD COLUMN created_at DATETIME;

-- 3) 给已有的历史群补一个近似时间
--    否则看板上「新增群聊」会全是 0，看着像坏了。
--    这只是近似值（都用当前时间），仅用于让曲线不为空，
--    不要拿它做精确的历史统计。
UPDATE groups SET created_at = datetime('now') WHERE created_at IS NULL OR created_at = '';

-- 4) messages.created_at 索引
--    看板按天聚合消息量，messages 是唯一会长到几十万行的表，
--    没索引的话每次聚合都是全表扫描。
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
