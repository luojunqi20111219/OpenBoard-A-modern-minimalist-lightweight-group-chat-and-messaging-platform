/**
 * 管理员路由 —— 迁移自 app/routes/admin.py
 */
import { Hono } from 'hono';
import type { HonoEnv, Env } from '../auth';
import { requireAuth, requireAdmin } from '../auth';
import { qAll, qOne, exec } from '../db';
import { nowIso } from '../db';
import { broadcast, kickUser, onlineUsers } from '../realtime';
import { randomId, hashPassword, needsPasswordReset } from '../crypto';
import { passwordIterations } from '../env';
import { cleanText } from '../sanitize';

export const adminRoutes = new Hono<HonoEnv>();

function env(c: { env: unknown }): Env {
  return c.env as Env;
}

/**
 * 写审计日志。
 *
 * 管理端新增的写操作（重置密码、批量封禁）也要留痕 —— 动态授权
 * 之后任何管理员都能提权别人，没有日志就无从追溯。
 * 失败不阻断主流程，审计表可能还没迁移。
 */
async function audit(
  e: Env,
  actor: string | undefined,
  action: string,
  target: string | null,
  detail?: string,
): Promise<void> {
  if (!actor) return;
  try {
    await exec(
      e.DB,
      'INSERT INTO admin_audit_logs (actor, action, target, detail, created_at) VALUES (?,?,?,?,?)',
      actor, action, target, detail ?? null, nowIso(),
    );
  } catch {
    /* 表未迁移，忽略 */
  }
}

adminRoutes.post('/admin/toggle_freeze_group', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const data = (await c.req.json()) as { group_id?: number };
  const groupId = Number(data.group_id);
  const group = await qOne<{ is_frozen: number }>(e.DB, 'SELECT is_frozen FROM groups WHERE id=?', groupId);
  if (!group) return c.json({ detail: '群聊不存在' }, 404);

  const next = group.is_frozen ? 0 : 1;
  await exec(e.DB, 'UPDATE groups SET is_frozen=? WHERE id=?', next, groupId);
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

adminRoutes.post('/admin/update_user_avatar', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
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
  return c.json({ status: 'success', avatar, msg: '头像已更新' });
});

adminRoutes.post('/admin/update_group_avatar', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
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
  const data = (await c.req.json()) as { group_id?: number };
  const groupId = Number(data.group_id);
  await exec(e.DB, 'DELETE FROM messages WHERE room_id=?', groupId);
  await exec(e.DB, 'DELETE FROM group_members WHERE group_id=?', groupId);
  await exec(e.DB, 'DELETE FROM groups WHERE id=?', groupId);
  await broadcast(e, { message: { type: 'group_removed', data: { id: groupId } } });
  return c.json({ status: 'success' });
});

adminRoutes.post('/admin/delete_groups', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const data = (await c.req.json()) as { group_ids?: number[] };
  const ids = Array.isArray(data.group_ids) ? data.group_ids.slice(0, 200) : [];
  for (const id of ids) {
    await exec(e.DB, 'DELETE FROM messages WHERE room_id=?', id);
    await exec(e.DB, 'DELETE FROM group_members WHERE group_id=?', id);
    await exec(e.DB, 'DELETE FROM groups WHERE id=?', id);
  }
  return c.json({ status: 'success', deleted: ids.length });
});

adminRoutes.post('/delete_messages', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const data = (await c.req.json()) as { msg_ids?: number[] };
  const ids = Array.isArray(data.msg_ids) ? data.msg_ids.slice(0, 500) : [];
  for (const id of ids) {
    await exec(e.DB, "UPDATE messages SET content='[system_recalled]' WHERE id=?", id);
  }
  await broadcast(e, { message: { type: 'recall', data: { ids } } });
  return c.json({ status: 'success', deleted: ids.length });
});

adminRoutes.post('/toggle_ban_user', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const data = (await c.req.json()) as { username?: string; user_id?: number | string };
  const username = await resolveTargetUsername(e, data);
  if (!username) return c.json({ detail: '用户不存在' }, 404);
  const user = await qOne<{ is_banned: number }>(e.DB, 'SELECT is_banned FROM users WHERE username=?', username);
  if (!user) return c.json({ detail: '用户不存在' }, 404);

  const next = user.is_banned ? 0 : 1;
  await exec(e.DB, 'UPDATE users SET is_banned=? WHERE username=?', next, username);
  if (next === 1) await kickUser(e, username);
  return c.json({ status: 'success', is_banned: next, msg: next ? '已封禁该用户' : '已解除封禁' });
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

/** 管理后台概览数据（admin.html 改造为纯前端 fetch 后从这里取数） */
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

  const users = await qAll<{
    id: number; username: string; nickname: string | null; avatar: string | null;
    role: number; is_banned: number; password_hash: string | null; created_at: string;
  }>(
    e.DB,
    `SELECT id, username, nickname, avatar, role, is_banned, password_hash, created_at
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
      created_at: u.created_at,
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

  const user = await qOne<{
    id: number; username: string; nickname: string | null; avatar: string | null;
    role: number; is_banned: number; password_hash: string | null;
    created_at: string; two_factor_enabled: number; read_receipts_enabled: number;
  }>(e.DB, `SELECT id, username, nickname, avatar, role, is_banned, password_hash,
                   created_at, two_factor_enabled, read_receipts_enabled
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
      created_at: user.created_at,
      two_factor_enabled: user.two_factor_enabled,
      read_receipts_enabled: user.read_receipts_enabled,
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
