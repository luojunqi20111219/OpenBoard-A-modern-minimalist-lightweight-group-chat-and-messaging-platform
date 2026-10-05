/**
 * D1 薄封装 —— 让迁移后的代码读起来接近原来的 sqlite3 用法
 */
import type { Env } from './env';

export type Row = Record<string, unknown>;

export async function qOne<T = Row>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  // 注意：D1 的 bind() 返回新的 statement，不能用 stmt.bind() 原地调用
  return (await bind(db, sql, params).first()) as T | null;
}

export async function qAll<T = Row>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const res = await bind(db, sql, params).all();
  return (res.results || []) as T[];
}

export async function exec(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<D1Result> {
  return bind(db, sql, params).run();
}

/** 批量执行（D1 的 batch 会自动包事务，比循环 exec 快很多） */
export async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  return db.batch(statements);
}

/** 构造并绑定参数的语句（D1 的 bind 是返回新对象的链式调用） */
export function bind(db: D1Database, sql: string, params: unknown[]): D1PreparedStatement {
  const stmt = db.prepare(sql);
  return params.length ? stmt.bind(...(params as never[])) : stmt;
}

export function prep(db: D1Database, sql: string, ...params: unknown[]): D1PreparedStatement {
  return bind(db, sql, params);
}

/** 取 INSERT 后生成的自增 ID */
export function lastRowId(res: D1Result): number {
  return typeof res.meta?.last_row_id === 'number' ? res.meta.last_row_id : 0;
}

/** SQLite/D1 都用 CURRENT_TIMESTAMP，这里统一成 ISO 字符串便于前端排序 */
export function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * 给「从数据库读出来、要发给客户端显示」的时间字符串补上 UTC 标记。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有这个函数（一个反复复发的老 bug）
 * ---------------------------------------------------------------------------
 * D1/SQLite 存的时间一律是 **UTC**，格式 `'2026-10-05 06:14:55'`。
 * 但这个格式**不带任何时区标记**，客户端 `new Date('2026-10-05 06:14:55')`
 * 会按**本地时区**解析 —— 中国用户看到的时间就比实际早 8 小时。
 *
 * 以前部署在自有服务器上（FastAPI 版），修法是
 * `timedatectl set-timezone Asia/Shanghai` 改系统时区，让服务器直接吐北京时间。
 * **Cloudflare Workers 没有系统时区概念**，永远跑在 UTC，改不了。
 * 所以那种修法在这里根本不存在，必须改成：
 *   服务端标明"这是 UTC"（加 Z）→ 客户端自己转成本地时区。
 *
 * ---------------------------------------------------------------------------
 * 为什么只在「出参」时加，不写进数据库
 * ---------------------------------------------------------------------------
 *   · 写库带 Z 会改变 SQLite `date()` / `datetime()` 的比较与聚合行为
 *     —— admin-stats 的日聚合用的是 `date(created_at)` 与 `date('now')`，
 *        两边口径必须都是"裸 UTC"，否则曲线会整体错位一天
 *   · 服务端内部所有时间比较（禁言是否过期、撤回窗口、age_seconds）
 *     要么走 SQL 内计算，要么走秒数，**都不解析这个字符串**
 *   · 所以「出参加 Z」是纯增益：只影响客户端显示，不影响服务端任何逻辑
 *
 * ---------------------------------------------------------------------------
 * 边界处理
 * ---------------------------------------------------------------------------
 *   · null / undefined → 原样返回（调用方通常要区分"无值"）
 *   · 已经带 Z 或带 `+08:00` 偏移 → 原样返回，**绝不叠加**成 ZZ
 *   · 认不出的格式 → 原样返回，不猜（猜错比不猜更糟）
 */
export function utcOut(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return value ?? null;
  const s = String(value).trim();
  if (!s) return s;

  // 已有明确时区标记，不要再加
  if (/[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) return s;

  // 'YYYY-MM-DD HH:MM:SS' —— 最常见的形态
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return `${s}Z`;
  // 'YYYY-MM-DDTHH:MM:SS'
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return `${s}Z`;

  // 纯日期 'YYYY-MM-DD' 不加 Z —— 它代表"某一天"，换算时区反而会跨天
  return s;
}

/** utcOut 的数组版本，用于列表出参 */
export function utcOutAll<T extends string | null | undefined>(values: T[]): (string | null)[] {
  return values.map((v) => utcOut(v));
}

/** 事务性会话辅助：把多条语句一次性提交 */
export function tx(db: D1Database) {
  const stmts: D1PreparedStatement[] = [];
  return {
    push(sql: string, ...params: unknown[]) {
      stmts.push(prep(db, sql, ...params));
      return this;
    },
    async commit() {
      if (!stmts.length) return [];
      return batch(db, stmts);
    },
  };
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string | null;
  nickname: string | null;
  token: string | null;
  role: number;
  is_banned: number;
  avatar: string | null;
  blocked_users: string | null;
  last_read_notice_id: number;
  push_token: string | null;
  two_factor_secret: string | null;
  two_factor_enabled: number;
  read_receipts_enabled: number;
  /**
   * 自助重置为默认密码后置 1，改完密码清 0。
   *
   * ⚠️ 该列由 migrations.ts 后加（老库没有），所以读到的值可能是 undefined。
   *    所有消费方都必须用 `!!user.must_change_password` / `Number(... ?? 0)`，
   *    不能直接当 0 用 —— 否则未迁移的部署上会出现 `undefined === 0` 为 false
   *    这类诡异分支。
   */
  must_change_password?: number;
  /**
   * 站点级禁言的解禁时间（UTC 'YYYY-MM-DD HH:MM:SS'），NULL 表示未被禁言。
   *
   * ⚠️ 同 must_change_password：该列由 migrations.ts 后加，老库读到的是
   *    undefined。判定时用 `?? null` 归一，**不要**写 `!== null`——
   *    `undefined !== null` 为 true，会把所有人都判成被禁言。
   */
  muted_until?: string | null;
}

export async function getUserByName(db: D1Database, username: string): Promise<UserRow | null> {
  return qOne<UserRow>(db, 'SELECT * FROM users WHERE username = ?', username);
}

export async function getUserById(db: D1Database, id: number): Promise<UserRow | null> {
  return qOne<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id);
}

/** 对外暴露的用户信息，永不泄露 password_hash / token / 2FA 密钥 */
export function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname || u.username,
    avatar: u.avatar,
    role: u.role,
    is_banned: u.is_banned,
    read_receipts_enabled: u.read_receipts_enabled,
    two_factor_enabled: u.two_factor_enabled,
  };
}

export type AppEnv = Env;
