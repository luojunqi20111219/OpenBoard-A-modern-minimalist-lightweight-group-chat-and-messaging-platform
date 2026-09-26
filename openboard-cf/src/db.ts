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
