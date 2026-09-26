/**
 * 群权限 / 好友关系判定 —— 供 messages 与 groups 路由共用
 * 迁移自 app/routes/groups.py::can_view_group 与 app/routes/friends.py::are_friends
 */
import type { Env } from './env';
import { qOne } from './db';
import { adminList } from './env';

export interface GroupRow {
  id: number;
  name: string | null;
  is_public: number;
  owner_id: number;
  avatar: string | null;
  is_frozen: number;
  view_mode: number;
  speak_mode: number;
  black_view: string | null;
  black_speak: string | null;
  white_view: string | null;
  white_speak: string | null;
  announcement: string | null;
  member_only: number;
  join_approval: number;
}

export function splitList(v: string | null | undefined): string[] {
  return (v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export async function canViewGroup(
  env: Env,
  group: GroupRow,
  username: string,
  userId: number,
  userRole: number,
): Promise<boolean> {
  if (group.id === 0) return true;
  if (username && group.owner_id === userId) return true;
  if (userRole === 1 || adminList(env).includes(username)) return true;

  if (group.member_only) {
    const member = await qOne(
      env.DB,
      'SELECT 1 AS hit FROM group_members WHERE group_id=? AND username=?',
      group.id,
      username,
    );
    if (!member) return false;
  }

  if (group.view_mode === 1) {
    return splitList(group.white_view).includes(username);
  }
  return !splitList(group.black_view).includes(username);
}

export async function areFriends(env: Env, a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const row = await qOne(
    env.DB,
    `SELECT 1 AS hit FROM friends
      WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)`,
    a,
    b,
    b,
    a,
  );
  return !!row;
}

export async function isGroupManager(
  env: Env,
  groupId: number,
  username: string,
  userId: number,
  userRole: number,
): Promise<GroupRow | null> {
  const group = await qOne<GroupRow>(env.DB, 'SELECT * FROM groups WHERE id=?', groupId);
  if (!group || groupId === 0) return null;

  const isSiteAdmin = userRole === 1 || adminList(env).includes(username);
  if (isSiteAdmin || group.owner_id === userId) return group;

  const member = await qOne<{ member_role: string }>(
    env.DB,
    'SELECT member_role FROM group_members WHERE group_id=? AND username=?',
    groupId,
    username,
  );
  if (member?.member_role === 'admin') return group;
  return null;
}

export async function auditGroup(
  env: Env,
  groupId: number,
  actor: string,
  action: string,
  target?: string | null,
  detail?: string | null,
): Promise<void> {
  const { exec } = await import('./db');
  await exec(
    env.DB,
    'INSERT INTO group_audit_logs (group_id, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)',
    groupId,
    actor,
    action,
    target ?? null,
    detail ?? null,
  );
}

/** 群内禁言检查，返回错误文案或 null */
export async function checkSpeakAllowed(
  env: Env,
  group: GroupRow,
  username: string,
  userId: number,
  userRole: number,
): Promise<string | null> {
  if (group.is_frozen) return '此群聊已被管理员冻结，全员禁言';

  if (group.owner_id !== userId && userRole !== 1) {
    const membership = await qOne<{ muted_until: string | null }>(
      env.DB,
      'SELECT muted_until FROM group_members WHERE group_id=? AND username=?',
      group.id,
      username,
    );
    if (membership?.muted_until) {
      const active = await qOne<{ active: number }>(
        env.DB,
        'SELECT datetime(?) > CURRENT_TIMESTAMP AS active',
        membership.muted_until,
      );
      if (active?.active) return '您当前处于群聊禁言状态';
    }

    if (group.speak_mode === 1) {
      if (!splitList(group.white_speak).includes(username)) {
        return '您不在该群的发言白名单中';
      }
    } else if (splitList(group.black_speak).includes(username)) {
      return '您已被群主禁言';
    }
  }
  return null;
}
