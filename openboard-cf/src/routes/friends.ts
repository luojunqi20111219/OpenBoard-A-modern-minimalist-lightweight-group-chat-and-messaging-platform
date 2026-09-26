/**
 * 好友路由 —— 迁移自 app/routes/friends.py
 */
import { Hono } from 'hono';
import type { HonoEnv, Env } from '../auth';
import { requireAuth } from '../auth';
import { qAll, qOne, exec } from '../db';
import { areFriends } from '../permissions';
import { cleanText } from '../sanitize';
import { broadcast } from '../realtime';

export const friendRoutes = new Hono<HonoEnv>();

function env(c: { env: unknown }): Env {
  return c.env as Env;
}

async function addFriends(e: Env, a: string, b: string) {
  if (await areFriends(e, a, b)) return;
  const [userA, userB] = a < b ? [a, b] : [b, a];
  await exec(
    e.DB,
    'INSERT OR IGNORE INTO friends (user_a, user_b) VALUES (?, ?)',
    userA,
    userB,
  );
}

// ---------------------------------------------------------------------------
// 搜索用户
// ---------------------------------------------------------------------------
friendRoutes.get('/users/search', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const q = (c.req.query('q') || '').trim().slice(0, 64);
  if (!q) return c.json({ status: 'success', data: [] });

  const rows = await qAll<{ username: string; nickname: string | null; avatar: string | null }>(
    e.DB,
    `SELECT username, nickname, avatar FROM users
      WHERE (username LIKE ? OR nickname LIKE ?) AND username != ? AND role != 2
      LIMIT 20`,
    `%${q}%`,
    `%${q}%`,
    user.username,
  );

  const results = [];
  for (const u of rows) {
    const pending = await qOne<{ status: string; from_user: string }>(
      e.DB,
      `SELECT status, from_user FROM friend_requests
        WHERE (from_user=? AND to_user=?) OR (from_user=? AND to_user=?)`,
      user.username,
      u.username,
      u.username,
      user.username,
    );
    results.push({
      username: u.username,
      nickname: u.nickname,
      avatar: u.avatar,
      is_friend: await areFriends(e, user.username, u.username),
      request_status: pending?.status ?? null,
      request_direction: pending
        ? pending.from_user === user.username
          ? 'sent'
          : 'received'
        : null,
    });
  }
  return c.json({ status: 'success', data: results });
});

// ---------------------------------------------------------------------------
// 好友列表
// ---------------------------------------------------------------------------
friendRoutes.get('/friends', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const rows = await qAll<{ username: string; nickname: string | null; avatar: string | null }>(
    e.DB,
    `SELECT u.username, u.nickname, u.avatar FROM users u
      WHERE u.username IN (
        SELECT user_b FROM friends WHERE user_a=?
        UNION
        SELECT user_a FROM friends WHERE user_b=?
      )
      ORDER BY u.nickname ASC`,
    user.username,
    user.username,
  );
  return c.json({
    status: 'success',
    data: [
      { username: 'filehelper', nickname: '文件传输助手', avatar: 'system_filehelper' },
      ...rows,
    ],
  });
});

// ---------------------------------------------------------------------------
// 收到的好友申请
// ---------------------------------------------------------------------------
friendRoutes.get('/friends/requests', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const rows = await qAll(
    e.DB,
    `SELECT fr.id, fr.from_user, fr.created_at, u.nickname, u.avatar
       FROM friend_requests fr JOIN users u ON fr.from_user = u.username
      WHERE fr.to_user=? AND fr.status='pending'
      ORDER BY fr.created_at DESC`,
    user.username,
  );
  return c.json({ status: 'success', data: rows });
});

// ---------------------------------------------------------------------------
// 发送好友申请（对方已申请则自动互加）
// ---------------------------------------------------------------------------
friendRoutes.post('/friends/request', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as { to_user?: string };
  const toUser = (data.to_user || '').trim();

  if (!toUser) return c.json({ detail: '缺少目标用户' }, 400);
  if (toUser === user.username) return c.json({ detail: '不能添加自己为好友' }, 400);

  const target = await qOne(e.DB, 'SELECT username FROM users WHERE username=?', toUser);
  if (!target) return c.json({ detail: '用户不存在' }, 404);
  if (await areFriends(e, user.username, toUser)) {
    return c.json({ detail: '你们已经是好友了' }, 400);
  }

  const reverse = await qOne(
    e.DB,
    "SELECT id FROM friend_requests WHERE from_user=? AND to_user=? AND status='pending'",
    toUser,
    user.username,
  );
  if (reverse) {
    await exec(
      e.DB,
      "UPDATE friend_requests SET status='accepted' WHERE from_user=? AND to_user=?",
      toUser,
      user.username,
    );
    await addFriends(e, user.username, toUser);
    await exec(
      e.DB,
      'INSERT INTO notifications (content, sender, target_user) VALUES (?, ?, ?)',
      `${user.nickname || user.username} 已与你成为好友`,
      '好友',
      toUser,
    );
    await broadcast(e, {
      message: { type: 'friend_update', data: { with: user.username } },
      receiver: toUser,
      sender: user.username,
    });
    return c.json({
      status: 'success',
      msg: '对方也想加您为好友，已自动互相成为好友！',
      auto_accepted: true,
    });
  }

  const existing = await qOne(
    e.DB,
    'SELECT id FROM friend_requests WHERE from_user=? AND to_user=?',
    user.username,
    toUser,
  );
  if (existing) {
    await exec(
      e.DB,
      "UPDATE friend_requests SET status='pending', created_at=CURRENT_TIMESTAMP WHERE id=?",
      existing.id,
    );
  } else {
    await exec(
      e.DB,
      'INSERT INTO friend_requests (from_user, to_user) VALUES (?, ?)',
      user.username,
      toUser,
    );
  }

  await exec(
    e.DB,
    'INSERT INTO notifications (content, sender, target_user) VALUES (?, ?, ?)',
    `${user.nickname || user.username} 请求添加你为好友`,
    '好友',
    toUser,
  );
  await broadcast(e, {
    message: { type: 'friend_request', data: { from: user.username } },
    receiver: toUser,
    sender: user.username,
  });

  return c.json({ status: 'success', msg: '好友申请已发送' });
});

// ---------------------------------------------------------------------------
// 处理好友申请
// ---------------------------------------------------------------------------
friendRoutes.post('/friends/respond', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as {
    request_id?: number;
    accept?: boolean;
    from_user?: string;
    username?: string;
    action?: string;
  };
  // 前端传 { username, action }，管理端可能传 { request_id, accept }
  const accept = data.accept !== undefined
    ? data.accept !== false
    : (data.action || 'accept') !== 'reject' && (data.action || '') !== 'rejected';

  let fromUser = data.from_user || data.username;
  if (!fromUser && data.request_id) {
    const row = await qOne<{ from_user: string }>(
      e.DB,
      'SELECT from_user FROM friend_requests WHERE id=? AND to_user=?',
      data.request_id,
      user.username,
    );
    fromUser = row?.from_user;
  }
  if (!fromUser) return c.json({ detail: '申请不存在' }, 404);

  await exec(
    e.DB,
    'UPDATE friend_requests SET status=? WHERE from_user=? AND to_user=?',
    accept ? 'accepted' : 'rejected',
    fromUser,
    user.username,
  );

  if (accept) {
    await addFriends(e, user.username, fromUser);
    await exec(
      e.DB,
      'INSERT INTO notifications (content, sender, target_user) VALUES (?, ?, ?)',
      `${user.nickname || user.username} 接受了你的好友申请`,
      '好友',
      fromUser,
    );
  }

  await broadcast(e, {
    message: { type: 'friend_update', data: { with: user.username, accepted: accept } },
    receiver: fromUser,
    sender: user.username,
  });
  return c.json({ status: 'success', accepted: accept });
});

// ---------------------------------------------------------------------------
// 直接加好友（管理员或内部调用）
// ---------------------------------------------------------------------------
friendRoutes.post('/friends/add', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as { username?: string };
  const target = (data.username || '').trim();
  if (!target) return c.json({ detail: '缺少用户名' }, 400);

  const exists = await qOne(e.DB, 'SELECT username FROM users WHERE username=?', target);
  if (!exists) return c.json({ detail: '用户不存在' }, 404);

  await addFriends(e, user.username, target);
  return c.json({ status: 'success' });
});

// ---------------------------------------------------------------------------
// 删除好友
// ---------------------------------------------------------------------------
friendRoutes.delete('/friends/:username', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const target = c.req.param('username') as string;
  await exec(
    e.DB,
    'DELETE FROM friends WHERE (user_a=? AND user_b=?) OR (user_a=? AND user_b=?)',
    user.username,
    target,
    target,
    user.username,
  );
  await exec(
    e.DB,
    'DELETE FROM friend_requests WHERE (from_user=? AND to_user=?) OR (from_user=? AND to_user=?)',
    user.username,
    target,
    target,
    user.username,
  );
  return c.json({ status: 'success' });
});

export { cleanText };
