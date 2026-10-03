/**
 * 迁移执行接口。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它
 * ---------------------------------------------------------------------------
 * 正常做法是 `npx wrangler d1 execute openboard-db --remote --file=xxx.sql`。
 * 但这条命令走的是 D1 的**导入通道**（上传 SQL 文件再执行），在部分网络
 * 环境下会以 "fetch failed" 失败，而直接用 D1 的 HTTP query 接口却正常。
 *
 * 所以这里提供一个等价的 HTTP 入口：把迁移语句内联在 Worker 里，
 * 用 env.DB.prepare().run() 逐条执行。这样只要能打开网站就能完成迁移。
 *
 * ---------------------------------------------------------------------------
 * 安全
 * ---------------------------------------------------------------------------
 *   · 仅管理员可调用（executeAdminMigrations 内部再校验一次）
 *   · 语句全部内联在代码里，**不接受外部传入 SQL** —— 这点很重要，
 *     否则就是一个远程 SQL 执行漏洞
 *   · 幂等：重复调用不报错（先探测列是否已存在）
 */

import { Hono } from 'hono';
import type { HonoEnv, Env } from '../auth';
import { requireAuth, requireAdmin, isAdminAsync } from '../auth';

export const migrationRoutes = new Hono<HonoEnv>();

/** 判断 users 表是否已有某列 */
async function hasColumn(e: Env, table: string, column: string): Promise<boolean> {
  try {
    const info = await e.DB.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
    return (info.results ?? []).some((r) => r.name === column);
  } catch {
    return false;
  }
}

/** 判断表是否存在 */
async function hasTable(e: Env, table: string): Promise<boolean> {
  try {
    const row = await e.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
      .bind(table)
      .first<{ name: string }>();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * 执行管理员相关迁移（幂等）。
 *
 * 与 migrations/001_admin_grants.sql 等价，但用代码判断代替
 * "ALTER TABLE ADD COLUMN 失败就忽略"，语义更清晰。
 */
export async function runAdminMigrations(e: Env): Promise<{
  applied: string[];
  skipped: string[];
  errors: string[];
}> {
  const applied: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  // 1) users.is_admin
  if (await hasColumn(e, 'users', 'is_admin')) {
    skipped.push('users.is_admin 已存在');
  } else {
    try {
      await e.DB.prepare(
        'ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0',
      ).run();
      applied.push('users.is_admin 已添加');
    } catch (err) {
      errors.push(`添加 users.is_admin 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2) 把历史 role=1 的账号同步为 is_admin=1
  try {
    const r = await e.DB.prepare(
      'UPDATE users SET is_admin = 1 WHERE role = 1 AND (is_admin IS NULL OR is_admin = 0)',
    ).run();
    const n = Number(r.meta?.changes ?? 0);
    if (n > 0) applied.push(`已把 ${n} 个 role=1 的历史账号同步为管理员`);
    else skipped.push('无需同步历史管理员');
  } catch (err) {
    errors.push(`同步历史管理员失败：${err instanceof Error ? err.message : String(err)}`);
  }

  // 3) admin_requests
  if (await hasTable(e, 'admin_requests')) {
    skipped.push('admin_requests 已存在');
  } else {
    try {
      await e.DB.prepare(
        `CREATE TABLE IF NOT EXISTS admin_requests (
           id          INTEGER PRIMARY KEY AUTOINCREMENT,
           username    TEXT NOT NULL,
           note        TEXT,
           status      TEXT NOT NULL DEFAULT 'pending',
           device_info TEXT,
           created_at  TEXT NOT NULL,
           handled_at  TEXT,
           handled_by  TEXT,
           UNIQUE(username, status)
         )`,
      ).run();
      await e.DB.prepare(
        'CREATE INDEX IF NOT EXISTS idx_admin_requests_status ON admin_requests(status, id DESC)',
      ).run();
      applied.push('admin_requests 表已创建');
    } catch (err) {
      errors.push(`创建 admin_requests 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4) admin_audit_logs
  if (await hasTable(e, 'admin_audit_logs')) {
    skipped.push('admin_audit_logs 已存在');
  } else {
    try {
      await e.DB.prepare(
        `CREATE TABLE IF NOT EXISTS admin_audit_logs (
           id         INTEGER PRIMARY KEY AUTOINCREMENT,
           actor      TEXT NOT NULL,
           action     TEXT NOT NULL,
           target     TEXT,
           detail     TEXT,
           created_at TEXT NOT NULL
         )`,
      ).run();
      await e.DB.prepare(
        'CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(id DESC)',
      ).run();
      applied.push('admin_audit_logs 表已创建');
    } catch (err) {
      errors.push(`创建 admin_audit_logs 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 5) users.must_change_password
  //
  // 「自助重置为默认密码 12345678」之后打上这个标记，
  // 客户端登录成功看到它就必须先改密码才能进主界面。
  if (await hasColumn(e, 'users', 'must_change_password')) {
    skipped.push('users.must_change_password 已存在');
  } else {
    try {
      await e.DB.prepare(
        'ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0',
      ).run();
      applied.push('users.must_change_password 已添加');
    } catch (err) {
      errors.push(
        `添加 users.must_change_password 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 6) users.muted_until —— 站点级禁言
  //
  // 与 is_banned 的区别是惩罚强度：封号是「登不进来」，禁言是
  // 「能进能看但不能发言」。对刷屏、骂战这类行为，封号过重（会让人
  // 直接流失），禁言才是合适的工具。
  //
  // 存 UTC 的 'YYYY-MM-DD HH:MM:SS'，与 group_members.muted_until
  // 保持同一格式 —— 判定逻辑都是 `datetime(?) > CURRENT_TIMESTAMP`。
  // 不带 DEFAULT：默认 NULL 表示从未被禁言。
  if (await hasColumn(e, 'users', 'muted_until')) {
    skipped.push('users.muted_until 已存在');
  } else {
    try {
      await e.DB.prepare('ALTER TABLE users ADD COLUMN muted_until DATETIME').run();
      applied.push('users.muted_until 已添加');
    } catch (err) {
      errors.push(
        `添加 users.muted_until 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 7) groups.created_at —— 数据看板的「每日新增群聊」曲线
  //
  // ⚠️ 这里**不能**写 DEFAULT CURRENT_TIMESTAMP。SQLite 的
  // ALTER TABLE ADD COLUMN 只接受常量默认值，带非常量默认值会直接报
  //   Cannot add a column with non-constant default
  // 于是历史群的 created_at 保持 NULL —— 曲线只能从本次迁移生效后
  // 开始计，这是已知且可接受的代价（历史数据没法凭空造出来）。
  if (await hasColumn(e, 'groups', 'created_at')) {
    skipped.push('groups.created_at 已存在');
  } else {
    try {
      await e.DB.prepare('ALTER TABLE groups ADD COLUMN created_at DATETIME').run();
      applied.push('groups.created_at 已添加（历史群为 NULL）');
    } catch (err) {
      errors.push(
        `添加 groups.created_at 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // 补齐建群时未写入的时间戳（只能补一个近似值，至少让曲线不为空）
  try {
    const r = await e.DB.prepare(
      "UPDATE groups SET created_at = datetime('now') WHERE created_at IS NULL OR created_at = ''",
    ).run();
    const n = Number(r.meta?.changes ?? 0);
    if (n > 0) applied.push(`已为 ${n} 个历史群补上 created_at（取当前时间）`);
  } catch { /* 列未加成功就跳过 */ }

  // 8) messages.created_at 索引
  //
  // 看板要按天聚合消息量。messages 是这两张表里唯一会长到几十万行的，
  // 没索引的话 `date(created_at)` 每次都是全表扫描。
  // 幂等：IF NOT EXISTS。
  try {
    await e.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)',
    ).run();
  } catch (err) {
    errors.push(`创建 idx_messages_created 失败：${err instanceof Error ? err.message : String(err)}`);
  }

  return { applied, skipped, errors };
}

/** 管理员手动触发迁移 */
migrationRoutes.post('/admin/apply_migrations', requireAuth, requireAdmin, async (c) => {
  const e = c.env as unknown as Env;
  const me = c.get('user');
  if (!me) return c.json({ detail: '未登录' }, 401);
  // 双保险：requireAdmin 已校验，这里再确认一次
  if (!(await isAdminAsync(e, me))) return c.json({ detail: '无权操作' }, 403);

  const result = await runAdminMigrations(e);
  return c.json({
    status: result.errors.length === 0 ? 'success' : 'partial',
    ...result,
  });
});

/** 迁移状态查询 —— 客户端首页据此提示"需要初始化" */
migrationRoutes.get('/admin/migration_status', requireAuth, async (c) => {
  const e = c.env as unknown as Env;
  const [hasFlag, hasReq, hasAudit, hasMustChange, hasMuted, hasGroupCreated] = await Promise.all([
    hasColumn(e, 'users', 'is_admin'),
    hasTable(e, 'admin_requests'),
    hasTable(e, 'admin_audit_logs'),
    hasColumn(e, 'users', 'must_change_password'),
    hasColumn(e, 'users', 'muted_until'),
    hasColumn(e, 'groups', 'created_at'),
  ]);
  return c.json({
    users_is_admin: hasFlag,
    admin_requests: hasReq,
    admin_audit_logs: hasAudit,
    users_must_change_password: hasMustChange,
    users_muted_until: hasMuted,
    groups_created_at: hasGroupCreated,
    ready: hasFlag && hasReq && hasAudit && hasMustChange && hasMuted && hasGroupCreated,
  });
});
