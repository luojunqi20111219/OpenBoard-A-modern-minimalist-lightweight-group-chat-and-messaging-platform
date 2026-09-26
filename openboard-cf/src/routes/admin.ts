/**
 * 管理员路由 —— 迁移自 app/routes/admin.py
 */
import { Hono } from 'hono';
import type { HonoEnv, Env } from '../auth';
import { requireAuth, requireAdmin } from '../auth';
import { qAll, qOne, exec } from '../db';
import { broadcast, kickUser, onlineUsers } from '../realtime';
import { randomId } from '../crypto';
import { cleanText } from '../sanitize';

export const adminRoutes = new Hono<HonoEnv>();

function env(c: { env: unknown }): Env {
  return c.env as Env;
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
  const data = (await c.req.json()) as { username?: string; user_id?: number | string };
  const username = await resolveTargetUsername(e, data);
  if (!username) return c.json({ detail: '用户不存在' }, 404);
  const user = await qOne<{ id: number }>(e.DB, 'SELECT id FROM users WHERE username=?', username);
  if (!user) return c.json({ detail: '用户不存在' }, 404);

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
  const data = (await c.req.json()) as { content?: string };
  const content = cleanText(data.content || '', 2000);
  if (!content) return c.json({ detail: '广播内容不能为空' }, 400);

  await broadcast(e, {
    message: { type: 'system_broadcast', data: { content, time: '刚刚' } },
  });
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
