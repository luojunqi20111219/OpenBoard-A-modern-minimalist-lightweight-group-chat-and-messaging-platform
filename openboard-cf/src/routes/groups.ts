/**
 * 群聊路由 —— 迁移自 app/routes/groups.py
 */
import { Hono } from 'hono';
import type { HonoEnv, Env } from '../auth';
import { requireAuth } from '../auth';
import { qAll, qOne, exec, nowIso, UserRow } from '../db';
import {
  canViewGroup,
  isGroupManager,
  auditGroup,
  splitList,
  checkSpeakAllowed,
  GroupRow,
} from '../permissions';
import { cleanText } from '../sanitize';
import { randomId } from '../crypto';
import { broadcast } from '../realtime';

export const groupRoutes = new Hono<HonoEnv>();

function env(c: { env: unknown }): Env {
  return c.env as Env;
}

/** 把 base64 头像写入 R2，返回可访问 URL；非 base64 则原样返回 */
async function storeAvatar(e: Env, value: string, prefix: string): Promise<string> {
  const v = (value || '').trim();
  if (!v.startsWith('data:')) return v.slice(0, 512);

  const match = /^data:([^;]+);base64,(.*)$/s.exec(v);
  if (!match) return v.slice(0, 512);

  const mime = match[1];
  const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
  const binary = Uint8Array.from(atob(match[2]), (ch) => ch.charCodeAt(0));
  const key = `avatars/${prefix}-${randomId(8)}.${ext}`;
  await e.UPLOADS.put(key, binary, { httpMetadata: { contentType: mime } });
  return `/api/download/${key}`;
}

// ---------------------------------------------------------------------------
// 我的群列表（含公共大厅）
// ---------------------------------------------------------------------------
groupRoutes.get('/groups', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');

  const rows = await qAll<GroupRow & { member_role: string | null }>(
    e.DB,
    `SELECT g.*, gm.member_role FROM groups g
       LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.username = ?
      WHERE g.id = 0
         OR gm.username IS NOT NULL
         OR g.owner_id = ?
         OR (g.is_public = 1 AND COALESCE(g.member_only, 0) = 0)
      ORDER BY g.id ASC`,
    user.username,
    user.id,
  );

  const result = [];
  for (const g of rows) {
    if (!(await canViewGroup(e, g, user.username, user.id, user.role))) continue;
    const count = await qOne<{ n: number }>(
      e.DB,
      'SELECT COUNT(*) AS n FROM group_members WHERE group_id=?',
      g.id,
    );
    result.push({ ...g, member_count: count?.n ?? 0 });
  }
  return c.json({ status: 'success', data: result });
});

// ---------------------------------------------------------------------------
// 创建群
// ---------------------------------------------------------------------------
groupRoutes.post('/groups', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as { name?: string; is_public?: boolean; avatar?: string };

  const name = cleanText(data.name || '', 64);
  if (!name) return c.json({ detail: '群名称不能为空' }, 400);

  // created_at 由 migrations 后加（历史群为 NULL）。这里显式写入 ——
  // 不写的话即使列存在，新群的 created_at 也一直是 NULL，
  // 数据看板的「每日新增群聊」就会恒为 0，看着像功能坏了。
  //
  // 列可能不存在（未迁移的库），所以包一层 catch：建群本身不能因此失败。
  let res;
  try {
    res = await exec(
      e.DB,
      'INSERT INTO groups (name, is_public, owner_id, avatar, created_at) VALUES (?, ?, ?, ?, ?)',
      name,
      data.is_public === false ? 0 : 1,
      user.id,
      data.avatar ? await storeAvatar(e, data.avatar, 'group') : null,
      nowIso(),
    );
  } catch {
    res = await exec(
      e.DB,
      'INSERT INTO groups (name, is_public, owner_id, avatar) VALUES (?, ?, ?, ?)',
      name,
      data.is_public === false ? 0 : 1,
      user.id,
      data.avatar ? await storeAvatar(e, data.avatar, 'group') : null,
    );
  }
  const groupId = Number(res.meta?.last_row_id ?? 0);
  await exec(
    e.DB,
    "INSERT OR IGNORE INTO group_members (group_id, username, member_role) VALUES (?, ?, 'owner')",
    groupId,
    user.username,
  );
  await auditGroup(e, groupId, user.username, 'create');
  return c.json({ status: 'success', id: groupId, name });
});

// ---------------------------------------------------------------------------
// 修改群资料
// ---------------------------------------------------------------------------
groupRoutes.put('/groups/:group_id', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const groupId = parseInt(c.req.param('group_id') as string, 10);
  const group = await isGroupManager(e, groupId, user.username, user.id, user.role);
  if (!group) return c.json({ detail: '仅群主或管理员可操作' }, 403);

  const data = (await c.req.json()) as { name?: string; is_public?: boolean };
  if (data.name !== undefined) {
    const name = cleanText(data.name, 64);
    if (!name) return c.json({ detail: '群名称不能为空' }, 400);
    await exec(e.DB, 'UPDATE groups SET name=? WHERE id=?', name, groupId);
  }
  if (data.is_public !== undefined) {
    await exec(e.DB, 'UPDATE groups SET is_public=? WHERE id=?', data.is_public ? 1 : 0, groupId);
  }
  await auditGroup(e, groupId, user.username, 'update');
  return c.json({ status: 'success' });
});

// ---------------------------------------------------------------------------
// 可见 / 发言权限（黑白天名单）
// ---------------------------------------------------------------------------
groupRoutes.put('/groups/:group_id/permissions', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const groupId = parseInt(c.req.param('group_id') as string, 10);
  const group = await isGroupManager(e, groupId, user.username, user.id, user.role);
  if (!group) return c.json({ detail: '仅群主或管理员可操作' }, 403);

  const data = (await c.req.json()) as {
    view_mode?: number;
    speak_mode?: number;
    black_view?: string;
    black_speak?: string;
    white_view?: string;
    white_speak?: string;
  };
  await exec(
    e.DB,
    `UPDATE groups SET
       view_mode=COALESCE(?, view_mode), speak_mode=COALESCE(?, speak_mode),
       black_view=COALESCE(?, black_view), black_speak=COALESCE(?, black_speak),
       white_view=COALESCE(?, white_view), white_speak=COALESCE(?, white_speak)
     WHERE id=?`,
    data.view_mode ?? null,
    data.speak_mode ?? null,
    data.black_view ?? null,
    data.black_speak ?? null,
    data.white_view ?? null,
    data.white_speak ?? null,
    groupId,
  );
  await auditGroup(e, groupId, user.username, 'permissions');
  return c.json({ status: 'success' });
});

groupRoutes.put('/groups/:group_id/advanced', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const groupId = parseInt(c.req.param('group_id') as string, 10);
  const group = await isGroupManager(e, groupId, user.username, user.id, user.role);
  if (!group) return c.json({ detail: '仅群主或管理员可操作' }, 403);

  const data = (await c.req.json()) as {
    announcement?: string;
    member_only?: boolean;
    join_approval?: boolean;
  };
  if (data.announcement !== undefined) {
    await exec(e.DB, 'UPDATE groups SET announcement=? WHERE id=?', cleanText(data.announcement, 2000), groupId);
  }
  if (data.member_only !== undefined) {
    await exec(e.DB, 'UPDATE groups SET member_only=? WHERE id=?', data.member_only ? 1 : 0, groupId);
  }
  if (data.join_approval !== undefined) {
    await exec(e.DB, 'UPDATE groups SET join_approval=? WHERE id=?', data.join_approval ? 1 : 0, groupId);
  }
  await auditGroup(e, groupId, user.username, 'advanced');
  return c.json({ status: 'success' });
});

groupRoutes.post('/groups/:group_id/avatar', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const groupId = parseInt(c.req.param('group_id') as string, 10);
  const group = await isGroupManager(e, groupId, user.username, user.id, user.role);
  if (!group) return c.json({ detail: '仅群主或管理员可操作' }, 403);

  const data = (await c.req.json()) as { avatar?: string };
  const url = await storeAvatar(e, data.avatar || '', 'group');
  await exec(e.DB, 'UPDATE groups SET avatar=? WHERE id=?', url, groupId);
  return c.json({ status: 'success', avatar: url });
});

groupRoutes.delete('/groups/:group_id', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const groupId = parseInt(c.req.param('group_id') as string, 10);
  const group = await qOne<GroupRow>(e.DB, 'SELECT * FROM groups WHERE id=?', groupId);
  if (!group) return c.json({ detail: '群聊不存在' }, 404);

  const isSiteAdmin = user.role === 1;
  if (!isSiteAdmin && group.owner_id !== user.id) {
    return c.json({ detail: '仅群主可解散群聊' }, 403);
  }

  await exec(e.DB, 'DELETE FROM messages WHERE room_id=?', groupId);
  await exec(e.DB, 'DELETE FROM group_members WHERE group_id=?', groupId);
  await exec(e.DB, 'DELETE FROM group_join_requests WHERE group_id=?', groupId);
  await exec(e.DB, 'DELETE FROM group_invites WHERE group_id=?', groupId);
  await exec(e.DB, 'DELETE FROM group_audit_logs WHERE group_id=?', groupId);
  await exec(e.DB, 'DELETE FROM groups WHERE id=?', groupId);
  await broadcast(e, { message: { type: 'group_removed', data: { id: groupId } } });
  return c.json({ status: 'success' });
});

// ---------------------------------------------------------------------------
// 发现群
// ---------------------------------------------------------------------------
groupRoutes.get('/groups/discover', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const rows = await qAll<GroupRow>(
    e.DB,
    'SELECT * FROM groups WHERE is_public = 1 AND id > 0 ORDER BY id DESC LIMIT 50',
  );
  const out = [];
  for (const g of rows) {
    if (!(await canViewGroup(e, g, user.username, user.id, user.role))) continue;
    const joined = await qOne(
      e.DB,
      'SELECT 1 AS hit FROM group_members WHERE group_id=? AND username=?',
      g.id,
      user.username,
    );
    const count = await qOne<{ n: number }>(
      e.DB,
      'SELECT COUNT(*) AS n FROM group_members WHERE group_id=?',
      g.id,
    );
    out.push({ ...g, joined: !!joined, member_count: count?.n ?? 0 });
  }
  return c.json({ status: 'success', data: out });
});

// ---------------------------------------------------------------------------
// 成员
// ---------------------------------------------------------------------------
groupRoutes.get('/groups/:group_id/members', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const groupId = parseInt(c.req.param('group_id') as string, 10);
  const group = await qOne<GroupRow>(e.DB, 'SELECT * FROM groups WHERE id=?', groupId);
  if (!group) return c.json({ detail: '群聊不存在' }, 404);
  if (!(await canViewGroup(e, group, user.username, user.id, user.role))) {
    return c.json({ detail: '无权查看该群聊' }, 403);
  }

  const rows = await qAll(
    e.DB,
    `SELECT gm.username, gm.member_role, gm.muted_until, gm.joined_at,
            u.nickname, u.avatar
       FROM group_members gm LEFT JOIN users u ON u.username = gm.username
      WHERE gm.group_id=? ORDER BY gm.joined_at ASC`,
    groupId,
  );
  return c.json({ status: 'success', data: rows });
});

groupRoutes.post('/groups/:group_id/join', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const groupId = parseInt(c.req.param('group_id') as string, 10);
  const group = await qOne<GroupRow>(e.DB, 'SELECT * FROM groups WHERE id=?', groupId);
  if (!group || groupId === 0) return c.json({ detail: '群聊不存在' }, 404);
  if (group.is_frozen) return c.json({ detail: '该群已被冻结' }, 403);

  const already = await qOne(
    e.DB,
    'SELECT 1 AS hit FROM group_members WHERE group_id=? AND username=?',
    groupId,
    user.username,
  );
  if (already) return c.json({ status: 'success', msg: '您已在群中' });

  if (group.join_approval) {
    await exec(
      e.DB,
      'INSERT OR IGNORE INTO group_join_requests (group_id, username) VALUES (?, ?)',
      groupId,
      user.username,
    );
    await exec(
      e.DB,
      "UPDATE group_join_requests SET status='pending', updated_at=CURRENT_TIMESTAMP WHERE group_id=? AND username=?",
      groupId,
      user.username,
    );
    return c.json({ status: 'success', pending: true, msg: '已提交入群申请，等待管理员审核' });
  }

  await exec(
    e.DB,
    "INSERT OR IGNORE INTO group_members (group_id, username, member_role) VALUES (?, ?, 'member')",
    groupId,
    user.username,
  );
  await auditGroup(e, groupId, user.username, 'join');
  return c.json({ status: 'success', joined: true });
});

groupRoutes.get('/groups/:group_id/join-requests', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const groupId = parseInt(c.req.param('group_id') as string, 10);
  const group = await isGroupManager(e, groupId, user.username, user.id, user.role);
  if (!group) return c.json({ detail: '仅群主或管理员可操作' }, 403);

  const rows = await qAll(
    e.DB,
    `SELECT id, username, status, created_at, updated_at FROM group_join_requests
      WHERE group_id=? AND status='pending' ORDER BY created_at DESC`,
    groupId,
  );
  return c.json({ status: 'success', data: rows });
});

groupRoutes.post('/groups/:group_id/join-requests/respond', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const groupId = parseInt(c.req.param('group_id') as string, 10);
  const group = await isGroupManager(e, groupId, user.username, user.id, user.role);
  if (!group) return c.json({ detail: '仅群主或管理员可操作' }, 403);

  const data = (await c.req.json()) as { username?: string; accept?: boolean; action?: string };
  const target = (data.username || '').trim();
  // 前端会传 action（'accept' / 'reject'），也接受布尔 accept
  const accept = data.accept !== undefined
    ? data.accept !== false
    : (data.action || 'accept') !== 'reject' && (data.action || '') !== 'rejected';
  if (!target) return c.json({ detail: '缺少用户名' }, 400);

  await exec(
    e.DB,
    "UPDATE group_join_requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE group_id=? AND username=?",
    accept ? 'approved' : 'rejected',
    groupId,
    target,
  );
  if (accept) {
    await exec(
      e.DB,
      "INSERT OR IGNORE INTO group_members (group_id, username, member_role) VALUES (?, ?, 'member')",
      groupId,
      target,
    );
  }
  await auditGroup(e, groupId, user.username, accept ? 'approve_join' : 'reject_join', target);
  await broadcast(e, {
    message: { type: 'group_join_result', data: { group_id: groupId, accepted: accept } },
    receiver: target,
    sender: user.username,
  });
  return c.json({ status: 'success', accepted: accept });
});

groupRoutes.post('/groups/:group_id/invite', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const groupId = parseInt(c.req.param('group_id') as string, 10);
  const data = (await c.req.json()) as { username?: string };
  const invitee = (data.username || '').trim();
  if (!invitee) return c.json({ detail: '缺少用户名' }, 400);

  const group = await qOne<GroupRow>(e.DB, 'SELECT * FROM groups WHERE id=?', groupId);
  if (!group) return c.json({ detail: '群聊不存在' }, 404);

  const isManager = await isGroupManager(e, groupId, user.username, user.id, user.role);
  if (!isManager) return c.json({ detail: '仅群主或管理员可邀请' }, 403);

  await exec(
    e.DB,
    'INSERT OR IGNORE INTO group_invites (group_id, inviter, invitee) VALUES (?, ?, ?)',
    groupId,
    user.username,
    invitee,
  );
  await exec(
    e.DB,
    "UPDATE group_invites SET status='pending', updated_at=CURRENT_TIMESTAMP WHERE group_id=? AND invitee=?",
    groupId,
    invitee,
  );
  await exec(
    e.DB,
    'INSERT INTO notifications (content, sender, target_user) VALUES (?, ?, ?)',
    `${user.nickname || user.username} 邀请你加入群「${group.name}」`,
    '群邀请',
    invitee,
  );
  await broadcast(e, {
    message: { type: 'group_invite', data: { group_id: groupId, from: user.username } },
    receiver: invitee,
    sender: user.username,
  });
  return c.json({ status: 'success' });
});

groupRoutes.get('/group-invites', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const rows = await qAll(
    e.DB,
    `SELECT gi.id, gi.group_id, gi.inviter, gi.created_at, g.name AS group_name, g.avatar AS group_avatar
       FROM group_invites gi LEFT JOIN groups g ON g.id = gi.group_id
      WHERE gi.invitee=? AND gi.status='pending' ORDER BY gi.created_at DESC`,
    user.username,
  );
  return c.json({ status: 'success', data: rows });
});

groupRoutes.post('/group-invites/respond', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const data = (await c.req.json()) as { invite_id?: number; accept?: boolean; action?: string };
  const accept = data.accept !== undefined
    ? data.accept !== false
    : (data.action || 'accept') !== 'reject' && (data.action || '') !== 'rejected';

  const invite = await qOne<{ id: number; group_id: number }>(
    e.DB,
    'SELECT id, group_id FROM group_invites WHERE id=? AND invitee=?',
    data.invite_id,
    user.username,
  );
  if (!invite) return c.json({ detail: '邀请不存在' }, 404);

  await exec(
    e.DB,
    'UPDATE group_invites SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
    accept ? 'accepted' : 'rejected',
    invite.id,
  );
  if (accept) {
    await exec(
      e.DB,
      "INSERT OR IGNORE INTO group_members (group_id, username, member_role) VALUES (?, ?, 'member')",
      invite.group_id,
      user.username,
    );
  }
  return c.json({ status: 'success', accepted: accept });
});

groupRoutes.put('/groups/:group_id/members/:username', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const groupId = parseInt(c.req.param('group_id') as string, 10);
  const target = c.req.param('username') as string;
  const group = await isGroupManager(e, groupId, user.username, user.id, user.role);
  if (!group) return c.json({ detail: '仅群主或管理员可操作' }, 403);

  // 前端有的界面传 role，有的传 member_role，两者都接受
  const data = (await c.req.json()) as {
    member_role?: string;
    role?: string;
    muted_until?: string | null;
  };
  const roleValue = data.member_role ?? data.role;
  if (roleValue) {
    await exec(
      e.DB,
      'UPDATE group_members SET member_role=? WHERE group_id=? AND username=?',
      roleValue === 'admin' ? 'admin' : 'member',
      groupId,
      target,
    );
  }
  if (data.muted_until !== undefined) {
    await exec(
      e.DB,
      'UPDATE group_members SET muted_until=? WHERE group_id=? AND username=?',
      data.muted_until,
      groupId,
      target,
    );
  }
  await auditGroup(e, groupId, user.username, 'update_member', target);
  return c.json({ status: 'success' });
});

groupRoutes.delete('/groups/:group_id/members/:username', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const groupId = parseInt(c.req.param('group_id') as string, 10);
  const target = c.req.param('username') as string;

  const group = await qOne<GroupRow>(e.DB, 'SELECT * FROM groups WHERE id=?', groupId);
  if (!group) return c.json({ detail: '群聊不存在' }, 404);

  const isManager = await isGroupManager(e, groupId, user.username, user.id, user.role);
  if (!isManager && target !== user.username) {
    return c.json({ detail: '仅群主或管理员可移除成员' }, 403);
  }
  if (group.owner_id === user.id && target === user.username) {
    return c.json({ detail: '群主不能退出自己的群' }, 400);
  }

  await exec(e.DB, 'DELETE FROM group_members WHERE group_id=? AND username=?', groupId, target);
  await auditGroup(e, groupId, user.username, 'remove_member', target);
  await broadcast(e, {
    message: { type: 'group_member_removed', data: { group_id: groupId } },
    receiver: target,
    sender: user.username,
  });
  return c.json({ status: 'success' });
});

groupRoutes.get('/groups/:group_id/audit', requireAuth, async (c) => {
  const e = env(c);
  const user = c.get('user');
  const groupId = parseInt(c.req.param('group_id') as string, 10);
  const group = await isGroupManager(e, groupId, user.username, user.id, user.role);
  if (!group) return c.json({ detail: '仅群主或管理员可操作' }, 403);

  const rows = await qAll(
    e.DB,
    'SELECT id, actor, action, target, detail, created_at FROM group_audit_logs WHERE group_id=? ORDER BY id DESC LIMIT 100',
    groupId,
  );
  return c.json({ status: 'success', data: rows });
});

export { splitList, checkSpeakAllowed };
export type { UserRow };
