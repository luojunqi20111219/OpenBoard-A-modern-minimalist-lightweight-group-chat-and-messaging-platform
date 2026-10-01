/**
 * 消息路由 —— 迁移自 app/routes/messages.py
 *
 * 关键差异：
 *   1. 上传目录 → R2（原项目写本地 uploads/ 并用 Pillow 生成缩略图，
 *      Workers 无法做服务端图片处理，压缩改由前端在上传前完成）
 *   2. WebSocket 广播 → 经 Durable Object 推送（原为进程内存）
 *   3. 广播 payload 与原版逐字段一致，已发布的客户端可直接对接
 */
import { Hono } from 'hono';
import type { HonoEnv, Env } from '../auth';
import { requireAuth, resolveUser } from '../auth';
import { qAll, qOne, exec, UserRow, getUserByName } from '../db';
import { adminList, jwtSecret, publicUploads } from '../env';
import { broadcast } from '../realtime';
import { canViewGroup, checkSpeakAllowed, areFriends, GroupRow } from '../permissions';
import { cleanText, clampText } from '../sanitize';
import { randomId, sha256Hex } from '../crypto';

/** 私有模式下给资源名签一个短签名，便于前端拼 <img src> 时携带 */
export async function signAsset(key: string, secret: string): Promise<string> {
  return (await sha256Hex(`${key}:${secret}`)).slice(0, 32);
}

export const messageRoutes = new Hono<HonoEnv>();

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'pdf', 'docx', 'txt', 'zip', 'apk',
]);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);
const RECALL_WINDOW = 2 * 60;
const EDIT_WINDOW = 2 * 60;
const MENTION_RE = /@([\w]+)/g;

function env(c: { env: unknown }): Env {
  return c.env as Env;
}

interface MsgRow {
  id: number;
  content: string;
  time?: string;
  created_at?: string;
  room_id: number;
  receiver: string | null;
  reply_to?: string | null;
  edited_at?: string | null;
  edit_count?: number;
  client_id?: string | null;
  nickname?: string | null;
  name?: string | null;
  avatar?: string | null;
  age_seconds?: number;
  read_count?: number;
}

function serializeMessage(row: MsgRow, current: UserRow) {
  const age = row.age_seconds ?? 0;
  const isAdmin = current.role === 1;
  const isOwner = row.name === current.username;
  const isRecalled = row.content === '[system_recalled]';
  const withinWindow = age < RECALL_WINDOW;

  return {
    id: row.id,
    content: row.content,
    time: row.time || row.created_at,
    room_id: row.room_id,
    receiver: row.receiver,
    reply_to: row.reply_to ?? null,
    edited_at: row.edited_at ?? null,
    edit_count: row.edit_count ?? 0,
    client_id: row.client_id ?? null,
    nickname: row.nickname ?? row.name,
    name: row.name,
    avatar: row.avatar ?? null,
    edited: !!row.edited_at,
    read_count: Number(row.read_count ?? 0),
    can_recall: !isRecalled && (isAdmin || (isOwner && withinWindow)),
    recall_expires_in: isOwner && withinWindow && !isRecalled ? Math.max(0, RECALL_WINDOW - age) : 0,
    can_edit: !isRecalled && isOwner && withinWindow,
    edit_expires_in: isOwner && withinWindow && !isRecalled ? Math.max(0, EDIT_WINDOW - age) : 0,
  };
}

const MSG_SELECT = `
  SELECT m.id, m.content, m.created_at AS time, m.room_id, m.receiver,
         m.reply AS reply_to, m.edited_at, m.edit_count, m.client_id,
         u.nickname, COALESCE(u.username, m.name) AS name, u.avatar,
         (strftime('%s','now') - strftime('%s', m.created_at)) AS age_seconds,
         (SELECT COUNT(*) FROM message_reads mr WHERE mr.msg_id = m.id) AS read_count
    FROM messages m LEFT JOIN users u ON m.name = u.username
`;

// ---------------------------------------------------------------------------
// 消息列表（游标分页）
// ---------------------------------------------------------------------------
messageRoutes.get('/messages', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const q = c.req.query();

  const roomId = parseInt(q.room_id || '0', 10);
  const targetUser = q.target_user || null;
  const beforeId = q.before_id ? parseInt(q.before_id, 10) : null;
  const afterId = q.after_id !== undefined ? parseInt(q.after_id, 10) : null;
  const limit = Math.min(Math.max(parseInt(q.limit || '50', 10), 1), 50);

  const blocked = (user.blocked_users || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (targetUser && targetUser.length > 64) return c.json({ detail: '用户标识无效' }, 400);
  if (roomId < 0) return c.json({ detail: '群聊标识无效' }, 400);

  if (!targetUser && roomId > 0) {
    const group = await qOne<GroupRow>(e.DB, 'SELECT * FROM groups WHERE id=?', roomId);
    if (!group) return c.json({ detail: '群聊不存在' }, 404);
    if (!(await canViewGroup(e, group, user.username, user.id, user.role))) {
      return c.json({ detail: '无权查看该群聊' }, 403);
    }
  }

  if (beforeId && afterId !== null) {
    return c.json({ detail: 'before_id 与 after_id 不能同时使用' }, 400);
  }

  let cursorSql = '';
  const cursorParams: unknown[] = [];
  if (beforeId) {
    cursorSql = ' AND m.id < ?';
    cursorParams.push(beforeId);
  } else if (afterId !== null) {
    cursorSql = ' AND m.id > ?';
    cursorParams.push(afterId);
  }
  const order = afterId !== null ? 'ASC' : 'DESC';

  let rows: MsgRow[];
  if (targetUser) {
    rows = await qAll<MsgRow>(
      e.DB,
      MSG_SELECT +
        ' WHERE ((m.name = ? AND m.receiver = ?) OR (m.name = ? AND m.receiver = ?))' +
        cursorSql +
        ` ORDER BY m.id ${order} LIMIT ?`,
      user.username,
      targetUser,
      targetUser,
      user.username,
      ...cursorParams,
      limit + 1,
    );
  } else {
    rows = await qAll<MsgRow>(
      e.DB,
      MSG_SELECT + ' WHERE m.room_id = ? AND m.receiver IS NULL' + cursorSql + ` ORDER BY m.id ${order} LIMIT ?`,
      roomId,
      ...cursorParams,
      limit + 1,
    );
  }

  const hasMore = rows.length > limit;
  rows = rows.slice(0, limit);
  if (order === 'DESC') rows.reverse();
  const visible = rows.filter((r) => !blocked.includes(r.name || ''));

  return c.json({
    status: 'success',
    data: visible.map((r) => serializeMessage(r, user)),
    pagination: {
      limit,
      has_more: hasMore,
      next_before_id: hasMore && visible.length ? visible[0].id : null,
      last_id: visible.length ? visible[visible.length - 1].id : afterId || 0,
    },
  });
});

// ---------------------------------------------------------------------------
// 发送消息
// ---------------------------------------------------------------------------
messageRoutes.post('/messages', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as {
    content?: string;
    room_id?: number;
    receiver?: string | null;
    reply_to?: string | null;
    client_id?: string | null;
  };

  const roomId = Number(data.room_id ?? 0);
  const receiver = data.receiver ? data.receiver.trim() : null;

  // 幂等：弱网重发时按 client_id 去重
  if (data.client_id) {
    const dup = await qOne<{ id: number }>(
      e.DB,
      'SELECT id FROM messages WHERE name=? AND client_id=?',
      user.username,
      data.client_id,
    );
    if (dup) return c.json({ status: 'success', id: dup.id, duplicate: true });
  }

  const cleanContent = clampText(cleanText(data.content || ''));
  if (!cleanContent.trim()) return c.json({ detail: '消息内容不能为空' }, 400);

  // 私聊：拉黑 / 好友校验
  if (receiver) {
    const target = await qOne<{ blocked_users: string | null }>(
      e.DB,
      'SELECT blocked_users FROM users WHERE username=?',
      receiver,
    );
    if (!target) return c.json({ detail: '接收用户不存在' }, 404);

    const theirBlocked = (target.blocked_users || '').split(',').map((s) => s.trim());
    if (theirBlocked.includes(user.username)) {
      return c.json({ detail: '对方已将您拉黑，无法发送消息' }, 403);
    }
    if (user.role !== 1 && receiver !== 'filehelper') {
      if (!(await areFriends(e, user.username, receiver))) {
        return c.json({ detail: '你们还不是好友，无法发送私信' }, 403);
      }
    }
  }

  // 群聊：可见性 / 禁言校验
  let group: GroupRow | null = null;
  if (roomId > 0 && !receiver) {
    group = await qOne<GroupRow>(e.DB, 'SELECT * FROM groups WHERE id=?', roomId);
    if (!group) return c.json({ detail: '群聊不存在' }, 404);
    if (!(await canViewGroup(e, group, user.username, user.id, user.role))) {
      return c.json({ detail: '无权在该群聊发送消息' }, 403);
    }
    const denied = await checkSpeakAllowed(e, group, user.username, user.id, user.role);
    if (denied) return c.json({ detail: denied }, 403);
  }

  const res = data.reply_to
    ? await exec(
        e.DB,
        'INSERT INTO messages (name, content, room_id, receiver, reply, client_id) VALUES (?, ?, ?, ?, ?, ?)',
        user.username,
        cleanContent,
        roomId,
        receiver,
        data.reply_to,
        data.client_id ?? null,
      )
    : await exec(
        e.DB,
        'INSERT INTO messages (name, content, room_id, receiver, client_id) VALUES (?, ?, ?, ?, ?)',
        user.username,
        cleanContent,
        roomId,
        receiver,
        data.client_id ?? null,
      );

  const msgId = Number(res.meta?.last_row_id ?? 0);
  const senderInfo = await qOne<{ nickname: string | null; avatar: string | null }>(
    e.DB,
    'SELECT nickname, avatar FROM users WHERE username=?',
    user.username,
  );

  const payload = {
    type: 'message',
    data: {
      id: msgId,
      reply_to: data.reply_to ?? null,
      mentions: [...cleanContent.matchAll(MENTION_RE)].map((m) => m[1]),
      content: cleanContent,
      time: '刚刚',
      nickname: senderInfo?.nickname ?? user.nickname,
      name: user.username,
      avatar: senderInfo?.avatar ?? user.avatar,
      room_id: roomId,
      receiver,
      client_id: data.client_id ?? null,
      edited_at: null,
      edit_count: 0,
      read_count: 0,
      can_edit: true,
      edit_expires_in: EDIT_WINDOW,
      can_recall: true,
      recall_expires_in: RECALL_WINDOW,
    },
  };

  // 群消息定向推送给可见成员，私聊只推双方
  if (!receiver && group) {
    const members = await qAll<{ username: string }>(
      e.DB,
      'SELECT username FROM group_members WHERE group_id=?',
      roomId,
    );
    let only: string[] | null = members.map((m) => m.username);
    // 未开启成员可见限制时退化为全员广播（与原版行为一致）
    if (!group.member_only && group.view_mode === 0) only = null;
    await broadcast(e, { message: payload, room_id: roomId, only });
  } else {
    await broadcast(e, { message: payload, receiver, sender: user.username });
  }

  return c.json({
    status: 'success',
    id: msgId,
    data: {
      id: msgId,
      client_id: data.client_id ?? null,
      content: cleanContent,
      room_id: roomId,
      receiver,
    },
  });
});

// ---------------------------------------------------------------------------
// 转发
// ---------------------------------------------------------------------------
messageRoutes.post('/messages/:msg_id/forward', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const msgId = parseInt(c.req.param('msg_id') as string, 10);
  const data = (await c.req.json()) as { room_id?: number; receiver?: string | null };

  const src = await qOne<{ content: string }>(e.DB, 'SELECT content FROM messages WHERE id=?', msgId);
  if (!src) return c.json({ detail: '消息不存在' }, 404);

  const roomId = Number(data.room_id ?? 0);
  const receiver = data.receiver ? data.receiver.trim() : null;
  const res = await exec(
    e.DB,
    'INSERT INTO messages (name, content, room_id, receiver) VALUES (?, ?, ?, ?)',
    user.username,
    src.content,
    roomId,
    receiver,
  );
  const newId = Number(res.meta?.last_row_id ?? 0);

  await broadcast(e, {
    message: {
      type: 'message',
      data: {
        id: newId,
        content: src.content,
        name: user.username,
        nickname: user.nickname,
        avatar: user.avatar,
        room_id: roomId,
        receiver,
        time: '刚刚',
        read_count: 0,
      },
    },
    receiver,
    sender: user.username,
    room_id: roomId,
  });
  return c.json({ status: 'success', id: newId });
});

// ---------------------------------------------------------------------------
// 撤回
// ---------------------------------------------------------------------------
messageRoutes.delete('/messages/:msg_id', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const msgId = parseInt(c.req.param('msg_id') as string, 10);
  const row = await qOne<{ name: string; content: string; room_id: number; receiver: string | null; age: number }>(
    e.DB,
    `SELECT name, content, room_id, receiver,
            (strftime('%s','now') - strftime('%s', created_at)) AS age
       FROM messages WHERE id=?`,
    msgId,
  );
  if (!row) return c.json({ detail: '消息不存在' }, 404);

  const isAdmin = user.role === 1 || adminList(e).includes(user.username);
  const isOwner = row.name === user.username;
  // age 为负说明时钟/时区存在偏差，此情况下按「在窗口内」处理，避免误伤
  const withinWindow = row.age < RECALL_WINDOW;
  if (!isAdmin && !(isOwner && withinWindow)) {
    return c.json({ detail: '超出撤回时限' }, 403);
  }

  await exec(e.DB, "UPDATE messages SET content='[system_recalled]' WHERE id=?", msgId);
  await broadcast(e, {
    message: { type: 'recall', data: { id: msgId, room_id: row.room_id, receiver: row.receiver } },
    receiver: row.receiver,
    sender: user.username,
  });
  return c.json({ status: 'success' });
});

// ---------------------------------------------------------------------------
// 编辑（2 分钟内）
// ---------------------------------------------------------------------------
messageRoutes.put('/messages/:msg_id', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const msgId = parseInt(c.req.param('msg_id') as string, 10);
  const data = (await c.req.json()) as { content?: string };

  const row = await qOne<{ name: string; content: string; room_id: number; receiver: string | null; age: number }>(
    e.DB,
    `SELECT name, content, room_id, receiver,
            (strftime('%s','now') - strftime('%s', created_at)) AS age
       FROM messages WHERE id=?`,
    msgId,
  );
  if (!row) return c.json({ detail: '消息不存在' }, 404);
  if (row.name !== user.username) return c.json({ detail: '只能编辑自己的消息' }, 403);
  if (row.age >= EDIT_WINDOW) return c.json({ detail: '超出编辑时限' }, 403);

  const clean = clampText(cleanText(data.content || ''));
  if (!clean.trim()) return c.json({ detail: '消息内容不能为空' }, 400);

  await exec(
    e.DB,
    'INSERT INTO message_edits (msg_id, editor, old_content) VALUES (?, ?, ?)',
    msgId,
    user.username,
    row.content,
  );
  await exec(
    e.DB,
    'UPDATE messages SET content=?, edited_at=CURRENT_TIMESTAMP, edit_count=COALESCE(edit_count,0)+1 WHERE id=?',
    clean,
    msgId,
  );
  await broadcast(e, {
    message: {
      type: 'edit',
      data: { id: msgId, content: clean, room_id: row.room_id, receiver: row.receiver },
    },
    receiver: row.receiver,
    sender: user.username,
  });
  return c.json({ status: 'success', content: clean });
});

// ---------------------------------------------------------------------------
// 已读回执
// ---------------------------------------------------------------------------
messageRoutes.post('/messages/read', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as { msg_ids?: number[]; last_read_id?: number; conversation_key?: string };

  const ids = Array.isArray(data.msg_ids) ? data.msg_ids.slice(0, 500) : [];
  for (const id of ids) {
    await exec(
      e.DB,
      'INSERT OR IGNORE INTO message_reads (msg_id, user, read_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
      id,
      user.username,
    );
  }

  if (data.conversation_key && data.last_read_id !== undefined) {
    await exec(
      e.DB,
      `INSERT INTO conversation_settings (username, conversation_key, last_read_id, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(username, conversation_key)
       DO UPDATE SET last_read_id=excluded.last_read_id, updated_at=CURRENT_TIMESTAMP`,
      user.username,
      data.conversation_key,
      data.last_read_id,
    );
  }

  // 尊重隐私开关：关闭已读回执时不广播
  if (user.read_receipts_enabled === 1 && ids.length) {
    await broadcast(e, {
      message: { type: 'read', data: { user: user.username, msg_ids: ids } },
    });
  }
  return c.json({ status: 'success', read: ids.length });
});

messageRoutes.get('/messages/search', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const q = c.req.query();
  const keyword = (q.q || '').trim();
  const roomId = q.room_id ? parseInt(q.room_id, 10) : null;
  const type = q.type || 'all';
  const limit = Math.min(parseInt(q.limit || '50', 10), 100);

  if (!keyword) return c.json({ status: 'success', data: [] });

  let sql = MSG_SELECT + ' WHERE m.content LIKE ?';
  const params: unknown[] = [`%${keyword}%`];

  if (roomId !== null) {
    sql += ' AND m.room_id = ? AND m.receiver IS NULL';
    params.push(roomId);
  } else if (type === 'private') {
    sql += ' AND (m.receiver = ? OR m.name = ?)';
    params.push(user.username, user.username);
  } else {
    sql += ' AND (m.receiver IS NULL OR m.receiver = ? OR m.name = ?)';
    params.push(user.username, user.username);
  }
  sql += ' ORDER BY m.id DESC LIMIT ?';
  params.push(limit);

  const rows = await qAll<MsgRow>(e.DB, sql, ...params);
  return c.json({ status: 'success', data: rows.map((r) => serializeMessage(r, user)) });
});

messageRoutes.get('/messages/:msg_id/reads', requireAuth, async (c) => {
  const e = env(c);
  const msgId = parseInt(c.req.param('msg_id') as string, 10);
  const rows = await qAll(
    e.DB,
    'SELECT user, read_at FROM message_reads WHERE msg_id=? ORDER BY read_at',
    msgId,
  );
  return c.json(rows);
});

messageRoutes.get('/messages/export', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const roomId = c.req.query('room_id') ? parseInt(c.req.query('room_id') as string, 10) : null;
  const target = c.req.query('target_user');

  const rows = target
    ? await qAll(e.DB,
        'SELECT id, name, content, created_at, room_id, receiver FROM messages WHERE ((name=? AND receiver=?) OR (name=? AND receiver=?)) ORDER BY id',
        user.username, target, target, user.username)
    : await qAll(e.DB,
        'SELECT id, name, content, created_at, room_id, receiver FROM messages WHERE room_id=? AND receiver IS NULL ORDER BY id',
        roomId ?? 0);
  return c.json({ status: 'success', count: rows.length, data: rows });
});

messageRoutes.post('/messages/import', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const body = (await c.req.json()) as { room_id?: number; messages?: Array<{ content: string }> };
  const list = Array.isArray(body.messages) ? body.messages.slice(0, 2000) : [];
  let count = 0;
  for (const m of list) {
    const clean = clampText(cleanText(m.content || ''));
    if (!clean.trim()) continue;
    await exec(
      e.DB,
      'INSERT INTO messages (name, content, room_id) VALUES (?, ?, ?)',
      user.username,
      clean,
      Number(body.room_id ?? 0),
    );
    count++;
  }
  return c.json({ status: 'success', imported: count });
});

// ---------------------------------------------------------------------------
// 消息收藏
// ---------------------------------------------------------------------------
messageRoutes.get('/favorites/messages', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const rows = await qAll<MsgRow>(
    e.DB,
    MSG_SELECT +
      ` JOIN message_favorites f ON f.msg_id = m.id
        WHERE f.username = ? ORDER BY f.created_at DESC LIMIT 200`,
    user.username,
  );
  return c.json(rows.map((r) => serializeMessage(r, user)));
});

messageRoutes.post('/favorites/messages/:msg_id', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const msgId = parseInt(c.req.param('msg_id') as string, 10);
  await exec(
    e.DB,
    'INSERT OR IGNORE INTO message_favorites (username, msg_id) VALUES (?, ?)',
    user.username,
    msgId,
  );
  return c.json({ status: 'success' });
});

messageRoutes.delete('/favorites/messages/:msg_id', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const msgId = parseInt(c.req.param('msg_id') as string, 10);
  await exec(e.DB, 'DELETE FROM message_favorites WHERE username=? AND msg_id=?', user.username, msgId);
  return c.json({ status: 'success' });
});

// ---------------------------------------------------------------------------
// 会话设置（置顶 / 免打扰 / 最近已读）
// ---------------------------------------------------------------------------
messageRoutes.get('/conversation-settings', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const rows = await qAll(
    e.DB,
    'SELECT conversation_key, is_pinned, is_muted, last_read_id, updated_at FROM conversation_settings WHERE username=?',
    user.username,
  );
  return c.json(rows);
});

messageRoutes.put('/conversation-settings', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as {
    conversation_key?: string;
    is_pinned?: boolean;
    is_muted?: boolean;
    last_read_id?: number;
  };
  if (!data.conversation_key) return c.json({ detail: '缺少会话标识' }, 400);

  const cur = await qOne<{ is_pinned: number; is_muted: number; last_read_id: number }>(
    e.DB,
    'SELECT is_pinned, is_muted, last_read_id FROM conversation_settings WHERE username=? AND conversation_key=?',
    user.username,
    data.conversation_key,
  );
  await exec(
    e.DB,
    `INSERT INTO conversation_settings (username, conversation_key, is_pinned, is_muted, last_read_id, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(username, conversation_key) DO UPDATE SET
       is_pinned=excluded.is_pinned, is_muted=excluded.is_muted,
       last_read_id=excluded.last_read_id, updated_at=CURRENT_TIMESTAMP`,
    user.username,
    data.conversation_key,
    data.is_pinned !== undefined ? (data.is_pinned ? 1 : 0) : (cur?.is_pinned ?? 0),
    data.is_muted !== undefined ? (data.is_muted ? 1 : 0) : (cur?.is_muted ?? 0),
    data.last_read_id ?? cur?.last_read_id ?? 0,
  );
  return c.json({ status: 'success' });
});

// ---------------------------------------------------------------------------
// 文件上传（R2）
// ---------------------------------------------------------------------------
messageRoutes.post('/upload', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const form = await c.req.formData();
  const entry = form.get('file');
  if (!entry || typeof entry === 'string') return c.json({ detail: '缺少文件' }, 400);
  const file = entry as File;
  if (file.size > MAX_FILE_SIZE) return c.json({ detail: '文件超过 50MB 上限' }, 413);

  const original = file.name || 'file';
  const ext = original.includes('.') ? (original.split('.').pop() as string).toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return c.json({ detail: `不支持的文件类型：${ext || '未知'}` }, 400);
  }

  const key = `${Date.now()}-${randomId(8)}.${ext}`;
  await e.UPLOADS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
    customMetadata: { uploader: user.username, original },
  });

  const url = `/api/download/${key}`;
  const isImage = IMAGE_EXTENSIONS.has(ext);

  return c.json({
    status: 'success',
    filename: key,
    url,
    // 原版会用 Pillow 生成缩略图并返回该字段，本版没有服务端图片处理，
    // 传 null 让前端回退到原图（前端已有 `data.thumbnail_url ? ... : ''` 的兜底逻辑）
    thumbnail_url: null,
    is_image: isImage,
    size: file.size,
    type: file.type,
    original_name: original,
  });
});

/**
 * 文件下载
 *
 * ⚠️ 这里刻意不做强制 Authorization 校验。
 * 原因：前端是用 <img src="/api/download/xxx.jpg"> 直接加载图片的，
 * 浏览器不会在 <img> 请求里附带 Authorization 头，若强制鉴权会导致所有图片全裂。
 * 原版 FastAPI 同样如此 —— 上传目录是通过 StaticFiles 挂载的公开路径。
 *
 * 安全性由两点保证：
 *   1. 文件名形如 `时间戳-随机十六进制.ext`，不可枚举（等同 capability token）
 *   2. 若确需私有，可设 PUBLIC_UPLOADS=false，届时改走 ?sig= 签名或登录态校验
 */
messageRoutes.get('/download/:filename', async (c) => {
  const e = env(c);
  const key = c.req.param('filename') as string;
  if (key.includes('/') || key.includes('..') || key.startsWith('.')) {
    return c.json({ detail: '文件名非法' }, 400);
  }

  if (!publicUploads(e)) {
    const token =
      c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') ||
      (c.req.header('Cookie') || '')
        .split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith('token='))
        ?.slice(6) ||
      null;
    const user = await resolveUser(e, token);
    const sig = c.req.query('sig');
    const expected = await signAsset(key, jwtSecret(e));
    if (!user && sig !== expected) {
      return c.json({ detail: '未登录' }, 401);
    }
  }

  const obj = await e.UPLOADS.get(key);
  if (!obj) return c.json({ detail: '文件不存在' }, 404);

  // ---------------------------------------------------------------------------
  // 兼容旧版下载 URL：`/api/download/{uuid}.{ext}?name={显示名}`
  //
  // 旧版（FastAPI）的 download_file 会带 ?name= 把原始文件名写进
  // Content-Disposition，让浏览器另存为时有正确的名字。
  // 迁移过来的历史消息里存的就是这种 URL —— 不带 ?name= 处理的话，
  // 点击下载会得到一长串 uuid 文件名。
  //
  // 安全：name 只用于 Content-Disposition，且做了 basename + 长度限制；
  //       真正的文件名以路径参数 key 为准，不参与磁盘/对象寻址。
  // ---------------------------------------------------------------------------
  const nameParam = c.req.query('name');
  const headers: Record<string, string> = {
    'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
    'Content-Length': String(obj.size),
    // 文件名含随机串、内容不可变，可放心长缓存
    'Cache-Control': 'public, max-age=31536000, immutable',
    'ETag': obj.httpEtag,
  };

  if (nameParam) {
    const display = sanitizeDisplayName(nameParam);
    if (display) {
      headers['Content-Disposition'] =
        `attachment; filename="${display.ascii}"; filename*=UTF-8''${display.encoded}`;
    } else {
      headers['Content-Disposition'] = `attachment; filename="${key}"`;
    }
  } else {
    headers['Content-Disposition'] = `inline; filename="${key}"`;
  }

  return new Response(obj.body, { headers });
});

/**
 * 兼容旧版静态目录 URL：`/uploads/{uuid}.{ext}`。
 *
 * 旧版是把 `uploads/` 目录用 StaticFiles 挂在 `/uploads` 上的，
 * 所以历史消息里的图片地址是 `/uploads/xxx.jpg`。CF 版没有这个路径，
 * 若不补一条，导入进来的所有历史图片都会裂。
 *
 * ⚠️ 只认「单段、无子路径」的 key，与 R2 的平坦 key 空间一一对应，
 *    杜绝 `/uploads/../../xxx` 这类穿越。
 *
 * ⚠️ 这个 handler 挂在 **根部**（不是 /api 下），见 app.ts 的
 *    `app.get('/uploads/:filename', uploadsAssetHandler)`。
 *    因为 messageRoutes 整体挂在 /api 前缀下，在这里注册会变成
 *    `/api/uploads/...`，而旧消息里的地址是 `/uploads/...`。
 */
export const uploadsAssetHandler = async (c: {
  env: unknown;
  req: { param: (k: string) => string };
  json: (o: unknown, s?: number) => Response;
}) => {
  const e = env(c);
  const key = c.req.param('filename');
  if (!key || key.includes('/') || key.includes('..') || key.startsWith('.')) {
    return c.json({ detail: '文件名非法' }, 400);
  }
  const obj = await e.UPLOADS.get(key);
  if (!obj) return c.json({ detail: '文件不存在' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'ETag': obj.httpEtag,
    },
  });
};

/**
 * 把 `?name=` 洗成安全的下载文件名。
 *
 * 返回两套编码：
 *   · ascii   —— 去 ASCII 化后的降级名（给老浏览器）
 *   · encoded —— RFC 5987 的 UTF-8 百分号编码（给现代浏览器，中文名靠它）
 * 两者都经过引号/换行/路径分隔符清洗，防止响应头注入。
 */
function sanitizeDisplayName(raw: string): { ascii: string; encoded: string } | null {
  // 只取 basename，剥掉任何路径成分
  let name = raw.replace(/\\/g, '/').split('/').pop() || '';
  // 去掉控制字符（含 CR/LF，防 header 注入）与双引号
  name = name.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  if (!name) return null;
  if (name.length > 200) name = name.slice(0, 200);

  // ASCII 降级：非 ASCII 一律换成下划线
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\]/g, '_');
  const encoded = encodeURIComponent(name);
  return { ascii: ascii || 'download', encoded };
}

// ---------------------------------------------------------------------------
// 通知
// ---------------------------------------------------------------------------
messageRoutes.get('/notifications', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const rows = await qAll(
    e.DB,
    'SELECT id, content, sender, created_at FROM notifications WHERE target_user=? OR target_user IS NULL ORDER BY id DESC LIMIT 50',
    user.username,
  );
  return c.json(rows);
});

messageRoutes.post('/notifications/read', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const rows = await qAll<{ id: number }>(
    e.DB,
    'SELECT id FROM notifications WHERE target_user=? ORDER BY id DESC LIMIT 1',
    user.username,
  );
  const lastId = rows[0]?.id ?? 0;
  await exec(e.DB, 'UPDATE users SET last_read_notice_id=? WHERE id=?', lastId, user.id);
  return c.json({ status: 'success', last_read_notice_id: lastId });
});

// ---------------------------------------------------------------------------
// 收藏表情
// ---------------------------------------------------------------------------
messageRoutes.get('/favorites/emojis', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const rows = await qAll(
    e.DB,
    'SELECT emoji FROM favorite_emojis WHERE username=? ORDER BY created_at DESC',
    user.username,
  );
  return c.json(rows.map((r) => r.emoji));
});

messageRoutes.post('/favorites/emojis', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as { emoji?: string };
  if (!data.emoji) return c.json({ detail: '缺少表情' }, 400);
  await exec(
    e.DB,
    'INSERT OR IGNORE INTO favorite_emojis (username, emoji) VALUES (?, ?)',
    user.username,
    data.emoji.slice(0, 32),
  );
  return c.json({ status: 'success' });
});

messageRoutes.post('/favorites/emojis/delete', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as { emoji?: string };
  await exec(e.DB, 'DELETE FROM favorite_emojis WHERE username=? AND emoji=?', user.username, data.emoji || '');
  return c.json({ status: 'success' });
});

// ---------------------------------------------------------------------------
// 版本检查（原项目读取 GitHub Release，这里改为直接返回服务端版本）
// ---------------------------------------------------------------------------
messageRoutes.get('/check_update', async (c) => {
  const e = env(c);
  return c.json({
    version: e.CURRENT_VERSION || 'v9.0.0',
    repo: 'luojunqi20111219/OpenBoard-A-modern-minimalist-lightweight-group-chat-and-messaging-platform',
    runtime: 'cloudflare-workers',
    force_update: false,
  });
});

export { getUserByName };
