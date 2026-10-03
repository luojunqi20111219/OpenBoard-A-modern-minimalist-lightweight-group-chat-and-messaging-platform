/**
 * 管理员授权路由 —— 管理端 App 的信任链。
 *
 * ---------------------------------------------------------------------------
 * 设计目标
 * ---------------------------------------------------------------------------
 * 管理权限不再硬编码在 wrangler.toml（改一次要重新部署），改为存 D1 的
 * `users.is_admin`，并引入「申请 → 批准」流程：
 *
 *   1. 某人想当管理员 → 登录管理端 App → 提交申请（带说明）
 *   2. 现有管理员在**聊天端 App**点他的账号 → 看到待处理申请 → 批准
 *   3. 批准后 is_admin=1 生效，该账号可用管理端全部功能
 *
 * 为什么要有"申请"这一步而不是管理员直接授予：
 *   避免管理员在聊天列表里误点某个陌生人就把他提权了。申请带说明、
 *   带设备信息、带申请时间，管理员有足够上下文判断，而且这是个显式动作。
 *
 * ---------------------------------------------------------------------------
 * 安全边界
 * ---------------------------------------------------------------------------
 *   · 所有"批准/撤销"操作都要求操作者**当前是管理员**，且在批准那一刻
 *     重新校验（不复用请求开头的判定），防止并发下权限已被撤销仍能操作
 *   · 不能撤销自己（防自锁）；不能撤销硬编码保底名单里的人
 *   · 所有管理操作写 admin_audit_logs，可追溯
 */

import { Hono } from 'hono';
import type { HonoEnv, Env } from '../auth';
import { requireAuth, requireAdmin, isAdminAsync, setAdminFlag } from '../auth';
import { qAll, qOne, exec } from '../db';
import { nowIso } from '../db';
import { adminList } from '../env';
import { cleanText } from '../sanitize';
import { audit } from '../audit';

export const adminGrantRoutes = new Hono<HonoEnv>();

function envOf(c: { env: unknown }): Env {
  return c.env as unknown as Env;
}

/** 该账号是否在硬编码保底名单里（这批人不可被撤销管理权限） */
function isHardcodedAdmin(e: Env, username: string): boolean {
  return adminList(e).includes(username);
}

// ---------------------------------------------------------------------------
// 申请
// ---------------------------------------------------------------------------

/**
 * 提交管理员申请（需登录，不要求已是管理员）。
 *
 * 用 INSERT OR REPLACE 配合 UNIQUE(username, status)：
 * 同一个人重复提交 pending 申请只会刷新内容，不会堆积多条待审。
 */
adminGrantRoutes.post('/admin/apply', requireAuth, async (c) => {
  const e = envOf(c);
  const me = c.get('user');
  if (!me) return c.json({ detail: '未登录' }, 401);

  // 已经是管理员就没必要申请了
  if (await isAdminAsync(e, me)) {
    return c.json({ status: 'already_admin', msg: '您已经是管理员' });
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    note?: string; device_info?: string;
  };
  const note = cleanText(body.note || '', 300);
  const deviceInfo = cleanText(body.device_info || '', 200);

  try {
    await exec(
      e.DB,
      `INSERT INTO admin_requests (username, note, status, device_info, created_at)
       VALUES (?, ?, 'pending', ?, ?)
       ON CONFLICT(username, status) DO UPDATE SET
         note = excluded.note,
         device_info = excluded.device_info,
         created_at = excluded.created_at`,
      me.username, note || null, deviceInfo || null, nowIso(),
    );
  } catch (err) {
    return c.json(
      { detail: `提交失败（管理员功能可能尚未初始化）：${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }

  await audit(e, me.username, 'admin.apply', me.username, note || undefined);
  return c.json({
    status: 'success',
    msg: '申请已提交，请等待现有管理员批准',
    username: me.username,
  });
});

/** 查询自己是否有待处理的申请 */
adminGrantRoutes.get('/admin/my_application', requireAuth, async (c) => {
  const e = envOf(c);
  const me = c.get('user');
  if (!me) return c.json({ detail: '未登录' }, 401);

  const isAdminNow = await isAdminAsync(e, me);
  let pending = null;
  try {
    pending = await qOne<{ id: number; note: string | null; created_at: string }>(
      e.DB,
      `SELECT id, note, created_at FROM admin_requests
        WHERE username = ? AND status = 'pending'`,
      me.username,
    );
  } catch {
    /* 表未迁移 */
  }

  return c.json({
    is_admin: isAdminNow,
    // 硬编码保底名单也算管理员，客户端据此显示
    pending: pending
      ? { id: pending.id, note: pending.note, created_at: pending.created_at }
      : null,
  });
});

// ---------------------------------------------------------------------------
// 审批（仅管理员）
// ---------------------------------------------------------------------------

/** 待审批列表 —— 管理端点「授权」标签页要用的数据 */
adminGrantRoutes.get('/admin/requests', requireAuth, requireAdmin, async (c) => {
  const e = envOf(c);
  const status = (c.req.query('status') || 'pending').trim();
  const allow = new Set(['pending', 'approved', 'rejected']);

  try {
    const rows = await qAll<{
      id: number; username: string; note: string | null; status: string;
      device_info: string | null; created_at: string;
      handled_at: string | null; handled_by: string | null;
    }>(
      e.DB,
      `SELECT id, username, note, status, device_info, created_at, handled_at, handled_by
         FROM admin_requests
        WHERE status = ? ORDER BY id DESC LIMIT 200`,
      allow.has(status) ? status : 'pending',
    );
    return c.json({ requests: rows });
  } catch (err) {
    // 表不存在时返回空列表而不是 500 —— 客户端可正常渲染空状态
    return c.json({
      requests: [],
      detail: `读取申请列表失败（可能尚未执行管理员迁移）：${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

/**
 * 批准申请 → 授予管理权限。
 *
 * 批准前重新校验操作者权限：请求进入时的 requireAdmin 已经校验过一次，
 * 但那之后到写库之间存在时间差。管理权限被撤销后仍能提权别人是个
 * 真实的越权路径，所以这里再确认一次。
 */
adminGrantRoutes.post('/admin/approve', requireAuth, requireAdmin, async (c) => {
  const e = envOf(c);
  const me = c.get('user');
  if (!me) return c.json({ detail: '未登录' }, 401);

  // 复检：防止"已被撤销权限的人"借旧会话提权
  if (!(await isAdminAsync(e, me))) {
    return c.json({ detail: '您的管理权限已失效，请重新登录' }, 403);
  }

  const body = (await c.req.json().catch(() => ({}))) as { username?: string; request_id?: number };
  let username = (body.username || '').trim();

  // 允许按 request_id 批准（客户端从列表点进来时用这个更准确）
  if (!username && Number.isFinite(Number(body.request_id))) {
    const row = await qOne<{ username: string }>(
      e.DB, 'SELECT username FROM admin_requests WHERE id = ?', Number(body.request_id),
    );
    username = row?.username || '';
  }
  if (!username) return c.json({ detail: '缺少 username 或 request_id' }, 400);

  const target = await qOne<{ id: number; role: number }>(
    e.DB, 'SELECT id, role FROM users WHERE username = ?', username,
  );
  if (!target) return c.json({ detail: '用户不存在' }, 404);
  if (target.role === 2) return c.json({ detail: '系统账号不能设为管理员' }, 400);

  await setAdminFlag(e, username, true);
  try {
    await exec(
      e.DB,
      `UPDATE admin_requests SET status='approved', handled_at=?, handled_by=?
        WHERE username=? AND status='pending'`,
      nowIso(), me.username, username,
    );
  } catch { /* 表未迁移 */ }

  await audit(e, me.username, 'admin.approve', username);
  return c.json({
    status: 'success',
    username,
    msg: `已授予 ${username} 管理权限`,
  });
});

/** 拒绝申请 */
adminGrantRoutes.post('/admin/reject', requireAuth, requireAdmin, async (c) => {
  const e = envOf(c);
  const me = c.get('user');
  if (!me) return c.json({ detail: '未登录' }, 401);

  const body = (await c.req.json().catch(() => ({}))) as { username?: string; request_id?: number };
  let username = (body.username || '').trim();
  if (!username && Number.isFinite(Number(body.request_id))) {
    const row = await qOne<{ username: string }>(
      e.DB, 'SELECT username FROM admin_requests WHERE id = ?', Number(body.request_id),
    );
    username = row?.username || '';
  }
  if (!username) return c.json({ detail: '缺少 username 或 request_id' }, 400);

  try {
    await exec(
      e.DB,
      `UPDATE admin_requests SET status='rejected', handled_at=?, handled_by=?
        WHERE username=? AND status='pending'`,
      nowIso(), me.username, username,
    );
  } catch { /* 表未迁移 */ }

  await audit(e, me.username, 'admin.reject', username);
  return c.json({ status: 'success', msg: `已拒绝 ${username} 的申请` });
});

/**
 * 撤销某人的管理权限。
 *
 * 三重保护：
 *   · 不能撤销自己 —— 否则最后一个管理员点一下就没人能管理了
 *   · 不能撤销硬编码名单里的人 —— 那是保底通道，撤销了 D1 出问题就进不去
 *   · 必须当前仍是管理员（同 approve）
 */
adminGrantRoutes.post('/admin/revoke', requireAuth, requireAdmin, async (c) => {
  const e = envOf(c);
  const me = c.get('user');
  if (!me) return c.json({ detail: '未登录' }, 401);
  if (!(await isAdminAsync(e, me))) {
    return c.json({ detail: '您的管理权限已失效，请重新登录' }, 403);
  }

  const body = (await c.req.json().catch(() => ({}))) as { username?: string };
  const username = (body.username || '').trim();
  if (!username) return c.json({ detail: '缺少 username' }, 400);

  if (username === me.username) {
    return c.json({ detail: '不能撤销自己的管理权限' }, 400);
  }
  if (isHardcodedAdmin(e, username)) {
    return c.json(
      { detail: '该账号在服务器保底管理员名单中，需修改配置才能撤销' },
      400,
    );
  }

  await setAdminFlag(e, username, false);
  await audit(e, me.username, 'admin.revoke', username);
  return c.json({ status: 'success', msg: `已撤销 ${username} 的管理权限` });
});

/** 当前管理员名单（管理端展示 + 聊天端标记用） */
adminGrantRoutes.get('/admin/list', requireAuth, async (c) => {
  const e = envOf(c);

  // 硬编码保底名单
  const hardcoded = adminList(e);

  let dynamic: { username: string; nickname: string | null; avatar: string | null }[] = [];
  try {
    dynamic = await qAll(
      e.DB,
      `SELECT username, nickname, avatar FROM users
        WHERE is_admin = 1 AND role <> 2 ORDER BY username ASC LIMIT 200`,
    );
  } catch { /* 列未加 */ }

  // 合并去重：硬编码优先（带 builtin 标记，客户端不给撤销按钮）
  const seen = new Set<string>();
  const merged: {
    username: string; nickname: string | null; avatar: string | null; builtin: boolean;
  }[] = [];

  for (const u of hardcoded) {
    if (seen.has(u)) continue;
    seen.add(u);
    const row = await qOne<{ nickname: string | null; avatar: string | null }>(
      e.DB, 'SELECT nickname, avatar FROM users WHERE username = ?', u,
    );
    merged.push({ username: u, nickname: row?.nickname ?? null, avatar: row?.avatar ?? null, builtin: true });
  }
  for (const u of dynamic) {
    if (seen.has(u.username)) continue;
    seen.add(u.username);
    merged.push({ username: u.username, nickname: u.nickname, avatar: u.avatar, builtin: false });
  }

  return c.json({ admins: merged });
});

/**
 * 审计日志（管理端「操作记录」页）
 *
 * ---------------------------------------------------------------------------
 * 为什么要合并两张表
 * ---------------------------------------------------------------------------
 * 项目里有两处审计：`admin_audit_logs`（全局管理操作，如提权/封禁/撤回）
 * 和 `group_audit_logs`（群内管理操作，如踢人/禁言）。排查一次纠纷时
 * 往往需要**按时间顺序看全**——某个管理员先在群里静音了某人、随后又
 * 把他封号，这两条分别在两张表里，分开查根本串不起来。
 *
 * 两表的 created_at 格式恰好一致：
 *   · admin_audit_logs  —— TEXT，由 nowIso() 写入 'YYYY-MM-DD HH:MM:SS'
 *   · group_audit_logs   —— DATETIME DEFAULT CURRENT_TIMESTAMP，SQLite
 *                           读出来也是 'YYYY-MM-DD HH:MM:SS'
 * 都是 UTC，所以可以直接字符串比较、UNION 排序，不需要时间转换。
 *
 * ---------------------------------------------------------------------------
 * uid 字段的由来（踩过的坑）
 * ---------------------------------------------------------------------------
 * 两张表 id 各自自增，UNION 之后 **id 必然重复**。Android 端
 * AuditAdapter 的 DiffUtil 用 id 判断「是否同一个条目」，id 重复会导致
 * 列表项错位闪烁（内容明明变了却复用旧 ViewHolder）。
 * 因此这里给每条拼一个 `uid = "来源:自增id"`，客户端 DIFF 改用它。
 *
 * @param actor  按操作者精确筛选（等值，非模糊）
 * @param action 按动作名精确筛选，如 admin.ban
 * @param from   起始时间，可只传 'YYYY-MM-DD'（服务端补 00:00:00）
 * @param to     结束时间，可只传 'YYYY-MM-DD'（服务端补 23:59:59）
 * @param source all | admin | group
 */
adminGrantRoutes.get('/admin/audit', requireAuth, requireAdmin, async (c) => {
  const e = envOf(c);

  const actor = (c.req.query('actor') || '').trim().slice(0, 64);
  const action = (c.req.query('action') || '').trim().slice(0, 64);
  const source = (c.req.query('source') || 'all').trim();
  const limit = Math.min(Math.max(Number(c.req.query('limit') || 50), 1), 200);
  const offset = Math.max(Number(c.req.query('offset') || 0), 0);

  /**
   * 只传日期时补全时分秒。
   * 不补的话 `created_at <= '2026-10-03'` 会把当天 00:00:00 之后的全部漏掉
   * —— 用户选「截止到今天」却发现今天的记录一条都没有，非常反直觉。
   */
  const normalizeFrom = (v: string) => (v.length === 10 ? `${v} 00:00:00` : v);
  const normalizeTo = (v: string) => (v.length === 10 ? `${v} 23:59:59` : v);

  const from = normalizeFrom((c.req.query('from') || '').trim().slice(0, 19));
  const to = normalizeTo((c.req.query('to') || '').trim().slice(0, 19));

  // 动态拼 WHERE，值一律走绑定参数，不拼接用户输入
  const where: string[] = [];
  const params: unknown[] = [];
  if (actor) { where.push('t.actor = ?'); params.push(actor); }
  if (action) { where.push('t.action = ?'); params.push(action); }
  if (from) { where.push('t.created_at >= ?'); params.push(from); }
  if (to) { where.push('t.created_at <= ?'); params.push(to); }
  if (source === 'admin' || source === 'group') { where.push('t.source = ?'); params.push(source); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const unionSql = `
    SELECT id, actor, action, target, detail, created_at, 'admin' AS source, NULL AS group_id
      FROM admin_audit_logs
    UNION ALL
    SELECT id, actor, action, target, detail, created_at, 'group' AS source, group_id
      FROM group_audit_logs`;

  try {
    const rows = await qAll<{
      id: number; actor: string; action: string; target: string | null;
      detail: string | null; created_at: string; source: string; group_id: number | null;
    }>(
      e.DB,
      `SELECT * FROM (${unionSql}) t ${whereSql}
        ORDER BY t.created_at DESC, t.source ASC, t.id DESC
        LIMIT ? OFFSET ?`,
      ...params, limit, offset,
    );

    const totalRow = await qOne<{ n: number }>(
      e.DB, `SELECT COUNT(*) AS n FROM (${unionSql}) t ${whereSql}`, ...params,
    );

    // uid：来源 + 自增 id，客户端 DiffUtil 的唯一键
    const logs = rows.map((r) => ({ ...r, uid: `${r.source}:${r.id}` }));
    return c.json({ logs, total: Number(totalRow?.n ?? logs.length) });
  } catch {
    // 表未迁移：保持向后兼容的返回形状（旧客户端只读 logs）
    return c.json({ logs: [], total: 0 });
  }
});
