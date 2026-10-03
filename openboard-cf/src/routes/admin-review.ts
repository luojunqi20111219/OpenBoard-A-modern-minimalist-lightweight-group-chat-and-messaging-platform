/**
 * 管理端「内容审核」路由 —— 跨用户消息检索 + 历史原文追溯。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要"跨用户"检索
 * ---------------------------------------------------------------------------
 * 普通聊天端的 `/messages/search` 只能搜**自己参与的**会话，这是对的：
 * 不该让任何人翻别人的聊天记录。但管理员要处理举报、排查违规内容时，
 * 必须能全局检索 —— 否则只能靠举报人截图，什么也查不到。
 *
 * 所以这个接口挂在 requireAdmin 之后，是刻意的提权设计，
 * 调用权限边界必须在审计日志里留痕（搜索虽未强制记日志，但撤回会记）。
 *
 * ---------------------------------------------------------------------------
 * 为什么还要能搜 message_edits.old_content
 * ---------------------------------------------------------------------------
 * 消息"删除"在本项目里是**内容替换**（content 改成 [system_recalled]），
 * 原文不复存在。但**修改**会落 `message_edits.old_content` —— 违规内容
 * 的典型操作路径就是"先发出去、被人看到、再偷偷改掉"。
 * 只搜 messages 表就会漏掉这类"改过就查不到"的情况，
 * 所以这里把 message_edits 一起 UNION 进来。
 */

import { Hono } from 'hono';
import type { HonoEnv, Env } from '../auth';
import { requireAuth, requireAdmin } from '../auth';
import { qAll, qOne } from '../db';

export const adminReviewRoutes = new Hono<HonoEnv>();

function env(c: { env: unknown }): Env {
  return c.env as Env;
}

/**
 * 转义 LIKE 的通配符。
 *
 * 不转义的话，用户搜一个 `%` 就会命中全表，搜 `_` 会命中任意单字符 ——
 * 看起来像"搜索没生效"，实际上是把整个库拉回来了（还慢）。
 * 转义字符用反斜杠，SQL 里要配 `ESCAPE '\'`。
 */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * 跨用户消息检索。
 *
 * @param q                关键字（匹配消息正文，也匹配历史修改前的原文）
 * @param username         限定发送者
 * @param room_id          限定群聊
 * @param receiver         限定私聊接收者
 * @param from             起始日期 'YYYY-MM-DD'
 * @param to               结束日期 'YYYY-MM-DD'
 * @param include_recalled 是否包含已被撤回（内容被替换）的消息
 * @param limit/offset     分页
 */
adminReviewRoutes.get('/admin/search_messages', requireAuth, requireAdmin, async (c) => {
  const e = env(c);

  const q = (c.req.query('q') || '').trim().slice(0, 100);
  const username = (c.req.query('username') || '').trim().slice(0, 64);
  const roomIdRaw = (c.req.query('room_id') || '').trim();
  const receiver = (c.req.query('receiver') || '').trim().slice(0, 64);
  const includeRecalled = c.req.query('include_recalled') === '1' ||
    c.req.query('include_recalled') === 'true';
  const limit = Math.min(Math.max(Number(c.req.query('limit') || 50), 1), 200);
  const offset = Math.max(Number(c.req.query('offset') || 0), 0);

  const normalizeFrom = (v: string) => (v.length === 10 ? `${v} 00:00:00` : v);
  const normalizeTo = (v: string) => (v.length === 10 ? `${v} 23:59:59` : v);
  const from = normalizeFrom((c.req.query('from') || '').trim().slice(0, 19));
  const to = normalizeTo((c.req.query('to') || '').trim().slice(0, 19));

  const roomId = roomIdRaw ? Number(roomIdRaw) : NaN;
  const hasRoomFilter = Number.isFinite(roomId);

  // 动态拼 WHERE，值一律绑定
  const where: string[] = [];
  const params: unknown[] = [];
  if (q) { where.push("m.content LIKE ? ESCAPE '\\'"); params.push(`%${likeEscape(q)}%`); }
  if (username) { where.push('m.name = ?'); params.push(username); }
  if (hasRoomFilter) { where.push('m.room_id = ?'); params.push(roomId); }
  if (receiver) { where.push('m.receiver = ?'); params.push(receiver); }
  if (from) { where.push('m.created_at >= ?'); params.push(from); }
  if (to) { where.push('m.created_at <= ?'); params.push(to); }
  if (!includeRecalled) { where.push("m.content <> '[system_recalled]'"); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const baseSql = `
    SELECT m.id, m.name, m.content, m.room_id, m.receiver, m.created_at,
           g.name AS group_name
      FROM messages m
      LEFT JOIN groups g ON g.id = m.room_id
      ${whereSql}`;

  const rows = await qAll<{
    id: number; name: string; content: string | null; room_id: number | null;
    receiver: string | null; created_at: string; group_name: string | null;
  }>(e.DB, `${baseSql} ORDER BY m.id DESC LIMIT ? OFFSET ?`, ...params, limit, offset);

  const totalRow = await qOne<{ n: number }>(
    e.DB, `SELECT COUNT(*) AS n FROM messages m ${whereSql}`, ...params,
  );

  const messages = rows.map((r) => ({
    id: r.id,
    name: r.name,
    content: r.content,
    room_id: r.room_id,
    receiver: r.receiver,
    group_name: r.group_name,
    created_at: r.created_at,
    source: 'message' as const,
    // 该消息是否已被撤回（内容已被替换为占位符）
    recalled: r.content === '[system_recalled]',
    // 该消息被改过几次 —— 客户端据此显示「查看历史」入口
    edit_count: 0,
  }));

  // 批量补 edit_count，避免 N+1
  if (messages.length) {
    try {
      const ids = messages.map((m) => m.id);
      const ph = ids.map(() => '?').join(',');
      const edits = await qAll<{ msg_id: number; n: number }>(
        e.DB,
        `SELECT msg_id, COUNT(*) AS n FROM message_edits
          WHERE msg_id IN (${ph}) GROUP BY msg_id`,
        ...ids,
      );
      const editMap = new Map(edits.map((x) => [Number(x.msg_id), Number(x.n)]));
      for (const m of messages) m.edit_count = editMap.get(m.id) ?? 0;
    } catch { /* 表未迁移，忽略 */ }
  }

  /**
   * 历史原文命中：只在有关键字时才查（否则把整张 message_edits 拉出来没意义）。
   *
   * 注意这部分**不计入 total** —— total 是 messages 表的分页基准。
   * 历史命中作为附加信息一次性返回（最多 50 条），客户端单独展示一段
   * 「历史版本命中」。这样分页逻辑不会被 UNION 搞复杂。
   */
  let historyMatches: Array<{
    msg_id: number; editor: string | null; old_content: string | null;
    edited_at: string | null; source: 'edit';
  }> = [];
  if (q) {
    try {
      const hWhere: string[] = ["me.old_content LIKE ? ESCAPE '\\'"];
      const hParams: unknown[] = [`%${likeEscape(q)}%`];
      if (username) { hWhere.push('me.editor = ?'); hParams.push(username); }
      if (from) { hWhere.push('me.edited_at >= ?'); hParams.push(from); }
      if (to) { hWhere.push('me.edited_at <= ?'); hParams.push(to); }
      historyMatches = await qAll(
        e.DB,
        `SELECT me.msg_id, me.editor, me.old_content, me.edited_at, 'edit' AS source
           FROM message_edits me
          WHERE ${hWhere.join(' AND ')}
          ORDER BY me.id DESC LIMIT 50`,
        ...hParams,
      );
    } catch { /* 表未迁移，忽略 */ }
  }

  return c.json({
    messages,
    total: Number(totalRow?.n ?? messages.length),
    history_matches: historyMatches,
  });
});

/**
 * 单条消息的完整版本链 —— 从当前内容一路回溯到最初版本。
 *
 * `message_edits` 表保存的是**每次修改前的旧内容**，所以按 id 升序拼起来
 * 就得到"原文 → 改一次 → 改两次 → 当前"这条时间线。
 */
adminReviewRoutes.get('/admin/message_history', requireAuth, requireAdmin, async (c) => {
  const e = env(c);
  const msgId = Number(c.req.query('msg_id'));
  if (!Number.isFinite(msgId) || msgId <= 0) {
    return c.json({ detail: '缺少 msg_id' }, 400);
  }

  const msg = await qOne<{
    id: number; name: string; content: string | null; room_id: number | null;
    receiver: string | null; created_at: string;
  }>(
    e.DB,
    'SELECT id, name, content, room_id, receiver, created_at FROM messages WHERE id=?',
    msgId,
  );
  if (!msg) return c.json({ detail: '消息不存在' }, 404);

  let edits: Array<{
    id: number; msg_id: number; editor: string | null;
    old_content: string | null; edited_at: string | null;
  }> = [];
  try {
    edits = await qAll(
      e.DB,
      `SELECT id, msg_id, editor, old_content, edited_at
         FROM message_edits WHERE msg_id=? ORDER BY id ASC`,
      msgId,
    );
  } catch { /* 表未迁移 */ }

  return c.json({
    message: {
      id: msg.id, name: msg.name, content: msg.content,
      room_id: msg.room_id, receiver: msg.receiver, created_at: msg.created_at,
    },
    // 按时间正序：第 0 项是最初的原文，最后一项是当前内容
    versions: [
      ...edits.map((ed) => ({
        editor: ed.editor,
        content: ed.old_content,
        edited_at: ed.edited_at,
        is_current: false,
      })),
      {
        editor: msg.name,
        content: msg.content,
        edited_at: msg.created_at,
        is_current: true,
      },
    ],
  });
});
