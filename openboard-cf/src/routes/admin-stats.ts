/**
 * 管理端「数据看板」路由。
 *
 * ---------------------------------------------------------------------------
 * 数据来源的现实约束
 * ---------------------------------------------------------------------------
 *   · `users.created_at`    —— 一直存在，可画完整的「每日新增用户」曲线
 *   · `groups.created_at`   —— 迁移后才有。历史群由迁移统一补一个近似值
 *                              （都取迁移时刻），所以曲线在迁移当天会有
 *                              一个尖峰，之后才是真实数据。要跟使用者讲清楚。
 *   · `messages.created_at` —— 一直存在，曲线完整
 *
 * 所有时间都是 UTC：`CURRENT_TIMESTAMP` / `nowIso()` 写的都是 UTC，
 * `date('now')` 在 D1 里也是 UTC，两端一致，不会错位。
 * **客户端不要做本地时区换算** —— 换算之后就和服务端的 GROUP BY 对不上了，
 * 曲线上的点会整体偏移几个小时。
 *
 * ---------------------------------------------------------------------------
 * 安全
 * ---------------------------------------------------------------------------
 * `metric` 直接决定 SQL 里的表名，必须走白名单映射。
 * 任何"把 query 参数拼进 SQL"的写法都是注入漏洞，这里一律不犯。
 */

import { Hono } from 'hono';
import type { HonoEnv, Env } from '../auth';
import { requireAuth, requireAdmin } from '../auth';
import { qAll, qOne } from '../db';
import { onlineUsers } from '../realtime';

export const adminStatsRoutes = new Hono<HonoEnv>();

function env(c: { env: unknown }): Env {
  return c.env as Env;
}

/** 指标 → 表名的白名单映射。绝不接受白名单之外的输入 */
const METRIC_TABLE: Record<string, string> = {
  users: 'users',
  messages: 'messages',
  groups: 'groups',
};

/**
 * 总量概览。
 *
 * 每个计数都单独 try/catch —— 单张表或单列缺失（比如未迁移的库没有
 * groups.created_at）不该让整个看板打不开。拿不到就回 0，
 * 页面上显示 0 总比白屏好。
 */
adminStatsRoutes.get('/admin/stats/overview', requireAuth, requireAdmin, async (c) => {
  const e = env(c);

  const count = async (sql: string, ...params: unknown[]): Promise<number> => {
    try {
      const r = await qOne<{ n: number }>(e.DB, sql, ...params);
      return Number(r?.n ?? 0);
    } catch {
      return 0;
    }
  };

  const [
    users, groups, messages,
    newUsersToday, newMessagesToday, newGroupsToday,
    banned, muted, admins,
  ] = await Promise.all([
    count('SELECT COUNT(*) AS n FROM users'),
    count('SELECT COUNT(*) AS n FROM groups'),
    count('SELECT COUNT(*) AS n FROM messages'),
    // date('now') 是 UTC 当天 —— 与 created_at 的存储口径一致
    count("SELECT COUNT(*) AS n FROM users WHERE date(created_at) = date('now')"),
    count("SELECT COUNT(*) AS n FROM messages WHERE date(created_at) = date('now')"),
    // groups.created_at 可能不存在（未迁移），catch 兜底为 0
    count("SELECT COUNT(*) AS n FROM groups WHERE date(created_at) = date('now')"),
    count('SELECT COUNT(*) AS n FROM users WHERE is_banned = 1'),
    // 只统计"仍然生效"的禁言：已过期的不算，否则数字只增不减
    count("SELECT COUNT(*) AS n FROM users WHERE muted_until IS NOT NULL AND datetime(muted_until) > CURRENT_TIMESTAMP"),
    count('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1'),
  ]);

  // 在线数是内存/缓存里的快照，不走 D1
  let online = 0;
  try {
    online = (await onlineUsers(e, { allowStale: true })).length;
  } catch { /* 拿不到就算了 */ }

  return c.json({
    users,
    groups,
    messages,
    new_users_today: newUsersToday,
    new_messages_today: newMessagesToday,
    new_groups_today: newGroupsToday,
    banned,
    muted,
    admins,
    online,
  });
});

/**
 * 时间序列（按天聚合）。
 *
 * @param metric users | messages | groups
 * @param days   回看天数，1..90，默认 30
 *
 * 返回的点是**连续**的：没有数据的日期补 0。客户端画折线时如果点不连续，
 * 直接把点连起来会出现"跳跃"，视觉上像是那几天有数据。
 */
adminStatsRoutes.get('/admin/stats/timeseries', requireAuth, requireAdmin, async (c) => {
  const e = env(c);

  const metric = (c.req.query('metric') || 'messages').trim();
  const table = METRIC_TABLE[metric];
  if (!table) {
    return c.json({ detail: 'metric 只支持 users / messages / groups' }, 400);
  }

  const days = Math.min(Math.max(Number(c.req.query('days') || 30), 1), 90);

  let rows: Array<{ d: string; n: number }> = [];
  try {
    rows = await qAll<{ d: string; n: number }>(
      e.DB,
      // 表名来自白名单常量，不是用户输入；days 走绑定参数
      `SELECT date(created_at) AS d, COUNT(*) AS n
         FROM ${table}
        WHERE created_at IS NOT NULL
          AND date(created_at) >= date('now', ?)
        GROUP BY d ORDER BY d ASC`,
      `-${days - 1} days`,
    );
  } catch {
    // 表缺列（groups.created_at 未迁移）等情况：返回全 0 的连续点，
    // 让页面能正常画出空图，而不是报错
    rows = [];
  }

  const byDate = new Map(rows.map((r) => [String(r.d), Number(r.n)]));

  // 补零：从 (今天 - days + 1) 到今天，逐日生成
  const points: Array<{ d: string; n: number }> = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    points.push({ d: key, n: byDate.get(key) ?? 0 });
  }

  return c.json({ metric, days, points });
});
