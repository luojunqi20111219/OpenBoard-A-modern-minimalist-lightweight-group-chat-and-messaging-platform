/**
 * 管理员路由 —— 迁移自 app/routes/admin.py
 */
import { Hono } from 'hono';
import type { HonoEnv, Env } from '../auth';
import { requireAuth, requireAdmin } from '../auth';
import { qAll, qOne, exec, utcOut } from '../db';
import { nowIso } from '../db';
import { broadcast, kickUser, onlineUsers } from '../realtime';
import { randomId, hashPassword, needsPasswordReset } from '../crypto';
import { passwordIterations } from '../env';
import { cleanText } from '../sanitize';
import { audit, summarizeIds } from '../audit';

export const adminRoutes = new Hono<HonoEnv>();

function env(c: { env: unknown }): Env {
  return c.env as Env;
}

adminRoutes.post('/admin/toggle_freeze_group', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const me = c.get('user');
  const data = (await c.req.json()) as { group_id?: number };
  const groupId = Number(data.group_id);
  const group = await qOne<{ is_frozen: number }>(e.DB, 'SELECT is_frozen FROM groups WHERE id=?', groupId);
  if (!group) return c.json({ detail: '群聊不存在' }, 404);

  const next = group.is_frozen ? 0 : 1;
  await exec(e.DB, 'UPDATE groups SET is_frozen=? WHERE id=?', next, groupId);
  await audit(e, me?.username, 'admin.freeze_group', String(groupId), next ? '冻结' : '解冻');
  return c.json({ status: 'success', is_frozen: next, msg: next ? '群聊已冻结' : '群聊已解冻' });
});

/**
 * 管理端参数兼容：原前端传 user_id，新版传 username，两者都接受
 */
async function resolveTargetUsername(
  e: Env,
  data: { username?: string; user_id?: number | string },
): Promise<string | null> {
  if (data.username) return data.username.trim();
  const id = Number(data.user_id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const row = await qOne<{ username: string }>(e.DB, 'SELECT username FROM users WHERE id=?', id);
  return row?.username ?? null;
}

/**
 * 探测 users 表是否有某列。
 *
 * 为什么需要：`is_admin` / `muted_until` 都是迁移才加的列，在**未迁移
 * 的库**上直接 `SELECT is_admin FROM users` 会让整个接口 500 —— 而
 * 用户列表恰恰是管理端首页就要调的东西，一挂全挂。
 * 与其 try/catch 整条查询（分不清是列缺失还是别的错），不如先探测。
 */
async function usersColumnExists(e: Env, column: string): Promise<boolean> {
  try {
    const info = await e.DB.prepare('PRAGMA table_info("users")').all<{ name: string }>();
    return (info.results ?? []).some((r) => r.name === column);
  } catch {
    return false;
  }
}

/**
 * 把「禁言分钟数」换算成 UTC 时间戳字符串。
 *
 * ⚠️ 时间一律由**服务端**算，不接受客户端传绝对时间 —— 手机时区
 * 千奇百怪，客户端算出来的时间可能差几小时，结果就是刚点上禁言
 * 就已经过期，或者多禁了一整天。
 *
 * 输出格式必须与 group_members.muted_until 一致
 * （'YYYY-MM-DD HH:MM:SS'），因为判定逻辑都是
 * `datetime(?) > CURRENT_TIMESTAMP`。
 *
 * @param minutes 时长；<=0 或非数字时返回 null（表示"永久"由调用方另处理）
 * @param until   客户端显式指定的时间（仅当没给 minutes 时使用，服务端不校验时区）
 */
function computeMutedUntil(minutes: unknown, until: unknown): string | null {
  const m = Number(minutes);
  if (Number.isFinite(m) && m > 0) {
    // 上限一年，防止误传一个巨大的数字把时间算到几百年后
    const capped = Math.min(m, 365 * 24 * 60);
    const d = new Date(Date.now() + capped * 60_000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }
  if (typeof until === 'string' && until.trim()) {
    // 只接受 'YYYY-MM-DD HH:MM:SS' 或 'YYYY-MM-DD'，其余丢弃
    const t = until.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return `${t} 23:59:59`;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)) return t;
  }
  return null;
}

adminRoutes.post('/admin/update_user_avatar', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const me = c.get('user');
  const data = (await c.req.json()) as {
    username?: string;
    user_id?: number | string;
    avatar?: string;
    avatar_base64?: string;
  };
  const username = await resolveTargetUsername(e, data);
  if (!username) return c.json({ detail: '用户不存在' }, 404);

  let avatar = ((data.avatar_base64 || data.avatar) || '').slice(0, 4_000_000);

  if (avatar.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(avatar);
    if (match) {
      const mime = match[1];
      const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
      const binary = Uint8Array.from(atob(match[2]), (ch) => ch.charCodeAt(0));
      const key = `avatars/user-${randomId(8)}.${ext}`;
      await e.UPLOADS.put(key, binary, { httpMetadata: { contentType: mime } });
      avatar = `/api/download/${key}`;
    }
  }

  await exec(e.DB, 'UPDATE users SET avatar=? WHERE username=?', avatar, username);
  await audit(e, me?.username, 'admin.update_user_avatar', username);
  return c.json({ status: 'success', avatar, msg: '头像已更新' });
});

adminRoutes.post('/admin/update_group_avatar', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const me = c.get('user');
  const data = (await c.req.json()) as { group_id?: number; avatar?: string; avatar_base64?: string };
  let avatar = ((data.avatar_base64 || data.avatar) || '').slice(0, 4_000_000);

  if (avatar.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(avatar);
    if (match) {
      const mime = match[1];
      const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
      const binary = Uint8Array.from(atob(match[2]), (ch) => ch.charCodeAt(0));
      const key = `avatars/group-${randomId(8)}.${ext}`;
      await e.UPLOADS.put(key, binary, { httpMetadata: { contentType: mime } });
      avatar = `/api/download/${key}`;
    }
  }

  await exec(e.DB, 'UPDATE groups SET avatar=? WHERE id=?', avatar, Number(data.group_id));
  await audit(e, me?.username, 'admin.update_group_avatar', String(Number(data.group_id)));
  return c.json({ status: 'success', avatar, msg: '群头像已更新' });
});

adminRoutes.post('/admin/delete_user', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const me = c.get('user');
  const data = (await c.req.json()) as { username?: string; user_id?: number | string };
  const username = await resolveTargetUsername(e, data);
  if (!username) return c.json({ detail: '用户不存在' }, 404);
  const user = await qOne<{ id: number }>(e.DB, 'SELECT id FROM users WHERE username=?', username);
  if (!user) return c.json({ detail: '用户不存在' }, 404);

  // 删除前先记日志 —— 用户行删掉之后就查不到是谁删的了
  await audit(e, me?.username, 'admin.delete_user', username);

  const stmts: Array<[string, unknown[]]> = [
    ['DELETE FROM messages WHERE name=?', [username]],
    ['DELETE FROM user_devices WHERE user_id=?', [user.id]],
    ['DELETE FROM friends WHERE user_a=? OR user_b=?', [username, username]],
    ['DELETE FROM friend_requests WHERE from_user=? OR to_user=?', [username, username]],
    ['DELETE FROM group_members WHERE username=?', [username]],
    ['DELETE FROM login_history WHERE user_id=?', [user.id]],
    ['DELETE FROM notifications WHERE target_user=?', [username]],
    ['DELETE FROM users WHERE id=?', [user.id]],
  ];
  for (const [sql, params] of stmts) await exec(e.DB, sql, ...params);
  await kickUser(e, username);
  return c.json({ status: 'success', msg: `已删除用户 ${username}` });
});

adminRoutes.post('/admin/delete_group', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const me = c.get('user');
  const data = (await c.req.json()) as { group_id?: number };
  const groupId = Number(data.group_id);
  const group = await qOne<{ name: string | null }>(e.DB, 'SELECT name FROM groups WHERE id=?', groupId);
  await audit(e, me?.username, 'admin.delete_group', String(groupId), group?.name ?? undefined);
  await exec(e.DB, 'DELETE FROM messages WHERE room_id=?', groupId);
  await exec(e.DB, 'DELETE FROM group_members WHERE group_id=?', groupId);
  await exec(e.DB, 'DELETE FROM groups WHERE id=?', groupId);
  await broadcast(e, { message: { type: 'group_removed', data: { id: groupId } } });
  return c.json({ status: 'success' });
});

adminRoutes.post('/admin/delete_groups', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const me = c.get('user');
  const data = (await c.req.json()) as { group_ids?: number[] };
  const ids = Array.isArray(data.group_ids) ? data.group_ids.slice(0, 200) : [];
  for (const id of ids) {
    await exec(e.DB, 'DELETE FROM messages WHERE room_id=?', id);
    await exec(e.DB, 'DELETE FROM group_members WHERE group_id=?', id);
    await exec(e.DB, 'DELETE FROM groups WHERE id=?', id);
  }
  // 汇总一条而不是逐条 —— 一次删 200 个群写 200 条日志会淹没审计表
  if (ids.length) await audit(e, me?.username, 'admin.delete_groups', null, summarizeIds(ids, '删除群'));
  return c.json({ status: 'success', deleted: ids.length });
});

adminRoutes.post('/delete_messages', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const me = c.get('user');
  const data = (await c.req.json()) as { msg_ids?: number[] };
  const ids = Array.isArray(data.msg_ids) ? data.msg_ids.slice(0, 500) : [];
  for (const id of ids) {
    await exec(e.DB, "UPDATE messages SET content='[system_recalled]' WHERE id=?", id);
  }
  // 同上：汇总一条，detail 里留前若干 id 供追查
  if (ids.length) await audit(e, me?.username, 'admin.delete_messages', null, summarizeIds(ids, '撤回消息'));
  await broadcast(e, { message: { type: 'recall', data: { ids } } });
  return c.json({ status: 'success', deleted: ids.length });
});

adminRoutes.post('/toggle_ban_user', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const me = c.get('user');
  const data = (await c.req.json()) as { username?: string; user_id?: number | string };
  const username = await resolveTargetUsername(e, data);
  if (!username) return c.json({ detail: '用户不存在' }, 404);
  const user = await qOne<{ is_banned: number }>(e.DB, 'SELECT is_banned FROM users WHERE username=?', username);
  if (!user) return c.json({ detail: '用户不存在' }, 404);

  const next = user.is_banned ? 0 : 1;
  await exec(e.DB, 'UPDATE users SET is_banned=? WHERE username=?', next, username);
  await audit(e, me?.username, next === 1 ? 'admin.ban' : 'admin.unban', username);
  if (next === 1) await kickUser(e, username);
  return c.json({ status: 'success', is_banned: next, msg: next ? '已封禁该用户' : '已解除封禁' });
});

// ---------------------------------------------------------------------------
// 禁言（站点级）
//
// 与封号的区别是惩罚强度：封号 = 登不进来，禁言 = 能进能看但不能发言。
// 对刷屏、骂战这类行为，封号过重（会直接让人流失），禁言才合适。
// ---------------------------------------------------------------------------

adminRoutes.post('/admin/mute_user', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const me = c.get('user');
  const data = (await c.req.json()) as {
    username?: string; user_id?: number | string; minutes?: number; until?: string;
  };

  const username = await resolveTargetUsername(e, data);
  if (!username) return c.json({ detail: '用户不存在' }, 404);

  if (!(await usersColumnExists(e, 'muted_until'))) {
    return c.json({ detail: '服务端尚未初始化（缺少 users.muted_until），请先执行迁移' }, 400);
  }

  const target = await qOne<{ role: number }>(
    e.DB, 'SELECT role FROM users WHERE username=?', username,
  );
  if (!target) return c.json({ detail: '用户不存在' }, 404);

  // 两道保护：不能禁自己（会把自己也封口，需要另一个人来解），
  // 不能禁系统账号（role=2 是播报/机器人，封了会静默失效）
  if (me && me.username === username) {
    return c.json({ detail: '不能禁言自己' }, 400);
  }
  if (target.role === 2) {
    return c.json({ detail: '不能禁言系统账号' }, 400);
  }

  const until = computeMutedUntil(data.minutes, data.until);
  if (!until) return c.json({ detail: '请提供禁言时长（minutes）或解禁时间（until）' }, 400);

  await exec(e.DB, 'UPDATE users SET muted_until=? WHERE username=?', until, username);
  await audit(e, me?.username, 'admin.mute', username, `至 ${until}`);
  return c.json({ status: 'success', muted_until: utcOut(until), msg: `已禁言至 ${until}` });
});

adminRoutes.post('/admin/unmute_user', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const me = c.get('user');
  const data = (await c.req.json()) as { username?: string; user_id?: number | string };

  const username = await resolveTargetUsername(e, data);
  if (!username) return c.json({ detail: '用户不存在' }, 404);

  if (!(await usersColumnExists(e, 'muted_until'))) {
    return c.json({ detail: '服务端尚未初始化（缺少 users.muted_until），请先执行迁移' }, 400);
  }

  await exec(e.DB, 'UPDATE users SET muted_until=NULL WHERE username=?', username);
  await audit(e, me?.username, 'admin.unmute', username);
  return c.json({ status: 'success', muted_until: null, msg: '已解除禁言' });
});

// ---------------------------------------------------------------------------
// 禁言（群内）
//
// 为什么不复用 PUT /groups/:id/members/:username —— 它内部走
// isGroupManager()，而那个函数用的是**同步** isAdmin（只看 role=1 和
// 硬编码名单，不查 D1）。结果是：通过「申请→批准」拿到权限的动态管理员
// 在群里不算管理员，会 403。管理端不该受这个历史缺陷拖累，所以单开接口。
// ---------------------------------------------------------------------------

adminRoutes.post('/admin/mute_group_member', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const me = c.get('user');
  const data = (await c.req.json()) as {
    group_id?: number; username?: string; minutes?: number; until?: string;
  };

  const groupId = Number(data.group_id);
  const username = (data.username || '').trim();
  if (!Number.isFinite(groupId) || groupId <= 0) return c.json({ detail: '缺少 group_id' }, 400);
  if (!username) return c.json({ detail: '缺少 username' }, 400);

  const group = await qOne<{ id: number }>(e.DB, 'SELECT id FROM groups WHERE id=?', groupId);
  if (!group) return c.json({ detail: '群聊不存在' }, 404);

  // 不自动拉人进群 —— 管理端「禁言」的语义是惩罚已有成员，
  // 把不在群里的人拉进来再禁言是两件不同的事，容易误操作
  const member = await qOne<{ username: string }>(
    e.DB, 'SELECT username FROM group_members WHERE group_id=? AND username=?', groupId, username,
  );
  if (!member) return c.json({ detail: '该用户不在这个群里' }, 404);

  const until = computeMutedUntil(data.minutes, data.until);
  if (!until) return c.json({ detail: '请提供禁言时长（minutes）或解禁时间（until）' }, 400);

  await exec(
    e.DB,
    'UPDATE group_members SET muted_until=? WHERE group_id=? AND username=?',
    until, groupId, username,
  );
  await audit(e, me?.username, 'admin.mute_group_member', username, `群 ${groupId} 至 ${until}`);
  return c.json({ status: 'success', muted_until: utcOut(until), msg: `已在群内禁言至 ${until}` });
});

adminRoutes.post('/admin/unmute_group_member', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const me = c.get('user');
  const data = (await c.req.json()) as { group_id?: number; username?: string };

  const groupId = Number(data.group_id);
  const username = (data.username || '').trim();
  if (!Number.isFinite(groupId) || groupId <= 0) return c.json({ detail: '缺少 group_id' }, 400);
  if (!username) return c.json({ detail: '缺少 username' }, 400);

  await exec(
    e.DB,
    'UPDATE group_members SET muted_until=NULL WHERE group_id=? AND username=?',
    groupId, username,
  );
  await audit(e, me?.username, 'admin.unmute_group_member', username, `群 ${groupId}`);
  return c.json({ status: 'success', muted_until: null, msg: '已解除群内禁言' });
});

adminRoutes.post('/admin/broadcast', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const me = c.get('user');
  const data = (await c.req.json()) as { content?: string };
  const content = cleanText(data.content || '', 2000);
  if (!content) return c.json({ detail: '广播内容不能为空' }, 400);

  await broadcast(e, {
    message: { type: 'system_broadcast', data: { content, time: '刚刚' } },
  });
  await audit(e, me?.username, 'admin.broadcast', null, content.slice(0, 100));
  return c.json({ status: 'success' });
});

/** 管理后台概览数据（管理端 App 的概览页从这里取数） */
adminRoutes.get('/admin/overview', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const [users, messages, groups] = await Promise.all([
    qAll(e.DB, 'SELECT id, username, nickname, avatar, role, is_banned FROM users ORDER BY id DESC LIMIT 200'),
    qAll(e.DB, 'SELECT id, name, content, room_id, created_at FROM messages ORDER BY id DESC LIMIT 100'),
    qAll(e.DB, 'SELECT id, name, is_public, owner_id, is_frozen FROM groups ORDER BY id DESC LIMIT 200'),
  ]);
  // 管理后台只是展示统计，允许读 15 秒内的 KV 快照以省下 DO 调用
  const online = await onlineUsers(e, { allowStale: true });
  return c.json({ users, messages, groups, online });
});

// ===========================================================================
// 以下为管理端安卓客户端新增的接口
// ===========================================================================

/**
 * 用户列表（带搜索/分页）—— 管理端客户端的主力接口。
 *
 * 比 /admin/overview 更适合客户端：支持关键字过滤、分页，
 * 并且**额外返回 password_algorithm** —— 客户端据此标出哪些账号
 * 是旧格式哈希（scrypt / 高迭代 pbkdf2），这些账号在当前套餐下
 * 无法验证密码，需要走「重置密码」。
 */
adminRoutes.get('/admin/users', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const q = (c.req.query('q') || '').trim().slice(0, 64);
  const limit = Math.min(Math.max(Number(c.req.query('limit') || 100), 1), 500);
  const offset = Math.max(Number(c.req.query('offset') || 0), 0);

  // 关键字同时匹配用户名与昵称；用参数化绑定，不做字符串拼接
  const where = q ? 'WHERE username LIKE ? OR nickname LIKE ?' : '';
  const like = `%${q}%`;
  const params: unknown[] = q ? [like, like, limit, offset] : [limit, offset];

  // 可选列：未迁移的库里没有这些列，硬 SELECT 会让整个接口 500。
  // 一次探测后决定 SQL 里带不带，比 try/catch 整个查询干净。
  const hasFlagCol = await usersColumnExists(e, 'is_admin');
  const hasMutedCol = await usersColumnExists(e, 'muted_until');
  const optCols = `${hasFlagCol ? ', is_admin' : ''}${hasMutedCol ? ', muted_until' : ''}`;

  const users = await qAll<{
    id: number; username: string; nickname: string | null; avatar: string | null;
    role: number; is_banned: number; password_hash: string | null; created_at: string;
    is_admin?: number; muted_until?: string | null;
  }>(
    e.DB,
    `SELECT id, username, nickname, avatar, role, is_banned, password_hash, created_at${optCols}
       FROM users ${where} ORDER BY id ASC LIMIT ? OFFSET ?`,
    ...params,
  );

  const total = await qOne<{ n: number }>(
    e.DB,
    `SELECT COUNT(*) AS n FROM users ${q ? 'WHERE username LIKE ? OR nickname LIKE ?' : ''}`,
    ...(q ? [like, like] : []),
  );

  // 只回传算法标识，绝不回传哈希本体
  const iter = passwordIterations(e);
  const items = users.map((u) => {
    const ph = u.password_hash || '';
    const algo = ph.split('$')[0] || '';
    return {
      id: u.id,
      username: u.username,
      nickname: u.nickname,
      avatar: u.avatar,
      role: u.role,
      is_banned: u.is_banned,
      // 动态授权标记 —— 客户端靠它显示「管理员」而不是「普通用户」
      is_admin: hasFlagCol ? Number(u.is_admin ?? 0) === 1 : u.role === 1,
      muted_until: hasMutedCol ? utcOut(u.muted_until) : null,
      created_at: utcOut(u.created_at),
      password_algorithm: algo,
      // 与登录路径用**同一个**判定函数，保证列表与实际行为一致
      needs_password_reset: needsPasswordReset(ph, iter),
    };
  });

  return c.json({ users: items, total: total?.n ?? items.length });
});

/** 单个用户详情（客户端点进去看的页面） */
adminRoutes.get('/admin/user', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const username = (c.req.query('username') || '').trim();
  if (!username) return c.json({ detail: '缺少 username' }, 400);

  const hasFlagCol = await usersColumnExists(e, 'is_admin');
  const hasMutedCol = await usersColumnExists(e, 'muted_until');
  const optCols = `${hasFlagCol ? ', is_admin' : ''}${hasMutedCol ? ', muted_until' : ''}`;

  const user = await qOne<{
    id: number; username: string; nickname: string | null; avatar: string | null;
    role: number; is_banned: number; password_hash: string | null;
    created_at: string; two_factor_enabled: number; read_receipts_enabled: number;
    is_admin?: number; muted_until?: string | null;
  }>(e.DB, `SELECT id, username, nickname, avatar, role, is_banned, password_hash,
                   created_at, two_factor_enabled, read_receipts_enabled${optCols}
              FROM users WHERE username=?`, username);
  if (!user) return c.json({ detail: '用户不存在' }, 404);

  const [msgCount, deviceCount, loginCount, groups] = await Promise.all([
    qOne<{ n: number }>(e.DB, 'SELECT COUNT(*) AS n FROM messages WHERE name=?', username),
    qOne<{ n: number }>(e.DB, 'SELECT COUNT(*) AS n FROM user_devices WHERE user_id=?', user.id),
    qOne<{ n: number }>(e.DB, 'SELECT COUNT(*) AS n FROM login_history WHERE user_id=?', user.id),
    qAll<{ id: number; name: string }>(
      e.DB,
      `SELECT g.id, g.name FROM groups g
         JOIN group_members m ON m.group_id = g.id
        WHERE m.username=? ORDER BY g.id ASC LIMIT 100`,
      username,
    ),
  ]);

  const ph = user.password_hash || '';
  return c.json({
    user: {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      avatar: user.avatar,
      role: user.role,
      is_banned: user.is_banned,
      created_at: utcOut(user.created_at),
      two_factor_enabled: user.two_factor_enabled,
      read_receipts_enabled: user.read_receipts_enabled,
      is_admin: hasFlagCol ? Number(user.is_admin ?? 0) === 1 : user.role === 1,
      muted_until: hasMutedCol ? utcOut(user.muted_until) : null,
      password_algorithm: ph.split('$')[0] || '',
      needs_password_reset: needsPasswordReset(ph, passwordIterations(e)),
    },
    stats: {
      messages: msgCount?.n ?? 0,
      devices: deviceCount?.n ?? 0,
      logins: loginCount?.n ?? 0,
      groups: groups.length,
    },
    groups,
  });
});

/**
 * 重置用户密码 —— 管理端客户端核心能力。
 *
 * 为什么必须由管理员重置：旧库里的 scrypt 哈希（werkzeug 默认
 * scrypt:32768:8:1）验证一次需约 75ms CPU，而 Cloudflare 免费版
 * 每请求上限 10ms，物理上跑不完。所以这些账号无法用原密码登录，
 * 只能由管理员设一个新密码 —— 新密码用 pbkdf2:sha256:<当前配置>，
 * 在当前套餐下可直接验证。
 *
 * 安全性：
 *  - 必须已登录 + 管理员
 *  - 不能重置系统账号（role=2）与自己的密码（防止自锁）
 *  - 新密码强度下限由服务端强制，不信任客户端
 *  - 重置后踢掉该用户所有在线连接
 */
adminRoutes.post('/admin/reset_password', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const me = c.get('user');
  const data = (await c.req.json()) as {
    username?: string; user_id?: number | string; new_password?: string;
  };

  const username = await resolveTargetUsername(e, data);
  if (!username) return c.json({ detail: '用户不存在' }, 404);

  const user = await qOne<{ id: number; role: number; password_hash: string | null }>(
    e.DB, 'SELECT id, role, password_hash FROM users WHERE username=?', username,
  );
  if (!user) return c.json({ detail: '用户不存在' }, 404);

  if (user.role === 2) {
    return c.json({ detail: '系统账号不允许重置密码' }, 400);
  }
  if (me && me.username === username) {
    return c.json({ detail: '请通过「修改密码」修改自己的密码，而不是管理员重置' }, 400);
  }

  const newPassword = String(data.new_password || '');
  if (newPassword.length < 6) {
    return c.json({ detail: '新密码至少 6 位' }, 400);
  }
  if (newPassword.length > 128) {
    return c.json({ detail: '新密码过长（上限 128 位）' }, 400);
  }
  // 要求至少两类字符，避免设成 123456
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(newPassword)).length;
  if (kinds < 2) {
    return c.json({ detail: '新密码需包含字母、数字、符号中的至少两类' }, 400);
  }

  // 用当前套餐能承受的迭代次数生成新哈希
  const iter = passwordIterations(e);
  const hash = await hashPassword(newPassword, iter);

  // 记下旧算法，便于事后追溯"这个人是从什么状态迁过来的"
  const oldAlgo = (user.password_hash || '').split('$')[0] || '';

  await exec(e.DB, 'UPDATE users SET password_hash=? WHERE id=?', hash, user.id);
  // 重置后强制下线，避免旧会话继续可用
  await kickUser(e, username);

  await audit(e, me?.username, 'admin.reset_password', username, `旧算法：${oldAlgo || '未知'}`);

  return c.json({
    status: 'success',
    username,
    algorithm: `pbkdf2:sha256:${iter}`,
    msg: `已重置 ${username} 的密码，该用户需用新密码重新登录`,
  });
});

/**
 * 批量封禁 / 解封 —— 客户端勾选多人后一次提交。
 *
 * 批量操作里包含自己的话要跳过（防止管理员把自己封了）。
 * 系统账号（role=2）同样不可操作。
 */
adminRoutes.post('/admin/ban_users', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const me = c.get('user');
  const data = (await c.req.json()) as { usernames?: string[]; banned?: boolean };

  const names = Array.isArray(data.usernames)
    ? data.usernames.map((s) => String(s).trim()).filter(Boolean).slice(0, 200)
    : [];
  if (names.length === 0) return c.json({ detail: '未选择任何用户' }, 400);

  const banned = data.banned !== false ? 1 : 0;
  const done: string[] = [];
  const skipped: { username: string; reason: string }[] = [];

  for (const name of names) {
    if (me && me.username === name) {
      skipped.push({ username: name, reason: '不能封禁自己' });
      continue;
    }
    const row = await qOne<{ id: number; role: number }>(
      e.DB, 'SELECT id, role FROM users WHERE username=?', name,
    );
    if (!row) {
      skipped.push({ username: name, reason: '用户不存在' });
      continue;
    }
    if (row.role === 2) {
      skipped.push({ username: name, reason: '系统账号' });
      continue;
    }
    await exec(e.DB, 'UPDATE users SET is_banned=? WHERE id=?', banned, row.id);
    if (banned === 1) await kickUser(e, name);
    done.push(name);
  }

  // 只记实际生效的那些，跳过的没造成状态变更
  for (const name of done) {
    await audit(e, me?.username, banned === 1 ? 'admin.ban' : 'admin.unban', name);
  }

  return c.json({
    status: 'success',
    affected: done.length,
    banned: banned === 1,
    done,
    skipped,
    msg: `已${banned ? '封禁' : '解封'} ${done.length} 个账号`,
  });
});
