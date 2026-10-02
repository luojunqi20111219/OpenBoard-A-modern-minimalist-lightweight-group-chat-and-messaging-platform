/**
 * 认证 —— 对应原 app/auth.py
 * JWT 结构保持与 Python 版一致（username / jti / exp），
 * 旧客户端签发的 token 可以直接平移过来用。
 */
import type { Context, Next } from 'hono';
import { Env, adminList, jwtSecret } from './env';
import { getUserByName, UserRow, qOne, exec } from './db';

export type { Env };
import { sha256Hex, signJwt, unsafeDecodeJwt, verifyJwt, JwtPayload } from './crypto';

export type HonoEnv = {
  Bindings: Env;
  Variables: { user: UserRow; token: string };
};

export function extractToken(c: Context): string | null {
  const header = c.req.header('Authorization');
  if (header) {
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
    if (raw) return raw;
  }
  return getCookie(c, 'token');
}

export function getCookie(c: Context, name: string): string | null {
  const cookie = c.req.header('Cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

/**
 * 解析 token → 用户
 * 顺序与原实现一致：撤销列表 → JWT → 老式不透明 token 兜底
 */
export async function resolveUser(env: Env, token: string | null): Promise<UserRow | null> {
  if (!token || token.length > 8192) return null;

  const tokenHash = await sha256Hex(token);
  const revoked = await qOne(
    env.DB,
    'SELECT 1 AS hit FROM revoked_sessions WHERE token_hash = ?',
    tokenHash,
  );
  if (revoked) return null;

  const payload = await verifyJwt(token, jwtSecret(env));
  if (payload && payload.username) {
    const user = await getUserByName(env.DB, payload.username as string);
    if (user) return user;
    // JWT 有效但用户已注销 → 不再回退到不透明 token，避免已过期 JWT 复活
    return null;
  }

  // 只有不透明 token（不含两个点）才走数据库兜底
  if (token.split('.').length !== 3) {
    const legacy = await qOne<UserRow>(
      env.DB,
      'SELECT * FROM users WHERE token = ?',
      token,
    );
    if (legacy) return legacy;
  }

  return null;
}

export async function createAccessToken(
  env: Env,
  payload: JwtPayload,
  expiresMinutes?: number,
): Promise<string> {
  return signJwt(payload, jwtSecret(env), expiresMinutes);
}

export async function revokeToken(
  env: Env,
  token: string,
  userId: number,
  deviceId: string,
): Promise<void> {
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  await exec(
    env.DB,
    'INSERT OR IGNORE INTO revoked_sessions (token_hash, user_id, device_id) VALUES (?, ?, ?)',
    tokenHash,
    userId,
    deviceId,
  );
}

function sameOrigin(c: Context): boolean {
  const origin = c.req.header('Origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(c.req.url).host;
  } catch {
    return false;
  }
}

/** 必须登录 */
export async function requireAuth(c: Context<HonoEnv>, next: Next) {
  const token = extractToken(c);
  if (!token) return c.json({ detail: '未登录' }, 401);

  // Cookie 承载 token 时，对非幂等请求做同源校验（防 CSRF）
  if (!c.req.header('Authorization')) {
    const method = c.req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !sameOrigin(c)) {
      return c.json({ detail: '跨站请求已被拒绝' }, 403);
    }
  }

  const user = await resolveUser(c.env as unknown as Env, token);
  if (!user) return c.json({ detail: '登录已失效，请重新登录' }, 401);
  if (user.is_banned === 1) return c.json({ detail: '您的账号已被管理员封禁' }, 403);

  c.set('user', user);
  c.set('token', token);
  await next();
}

/** 必须管理员 */
export async function requireAdmin(c: Context<HonoEnv>, next: Next) {
  const user = c.get('user');
  if (!user) return c.json({ detail: '未登录' }, 401);
  const ok = await isAdminAsync(c.env as unknown as Env, user);
  if (!ok) return c.json({ detail: '您无权进行此项管理员操作' }, 403);
  await next();
}

/**
 * ⚠️ 同步版 isAdmin —— **只看硬编码名单与 role，不查 D1**。
 *
 * 保留它的理由：有些调用点已经在异步上下文里、且拿不到 env.DB 的
 * 便捷路径（或对性能敏感，不想为一次权限判断多打一次 D1）。
 *
 * 但它**不包含动态授权的管理员**。任何一个"决定这个人能不能做管理操作"
 * 的判断点，都必须用 isAdminAsync，否则会出现
 * 「管理端 App 里显示是管理员，但实际调接口 403」的割裂现象。
 */
export function isAdmin(env: Env, user: UserRow): boolean {
  return user.role === 1 || adminList(env).includes(user.username);
}

/**
 * 异步版 isAdmin —— **权限判断的唯一权威来源**。
 *
 * 判定顺序：
 *   1. role === 1        老数据里已经提权的账号（兼容，避免历史管理员掉权限）
 *   2. 硬编码 ALLOWED_ADMINS  保底名单，即使 D1 挂了也能进管理端
 *   3. D1 里 is_admin = 1     管理端点「授权」后写入的动态管理员 ← 新增
 *
 * 顺序不能反：2 必须在 3 之前，因为 ALLOWED_ADMINS 是"就算数据库被清空
 * 也还能救回来"的最后一道门。全部依赖 D1 的话，一旦误删 is_admin 字段
 * 就再也没人能进管理端了。
 */
export async function isAdminAsync(env: Env, user: UserRow): Promise<boolean> {
  if (user.role === 1) return true;
  if (adminList(env).includes(user.username)) return true;
  return await hasAdminFlag(env, user.username);
}

/**
 * 查询 D1 的 is_admin 标记。
 *
 * 表/列可能不存在（老部署没跑过迁移），所以整段包 try：
 * 查不到一律当 false，绝不因为权限表缺失就让请求 500。
 */
export async function hasAdminFlag(env: Env, username: string): Promise<boolean> {
  if (!username) return false;
  try {
    const row = await env.DB.prepare(
      'SELECT is_admin FROM users WHERE username = ?',
    )
      .bind(username)
      .first<{ is_admin: number | null }>();
    return Number(row?.is_admin ?? 0) === 1;
  } catch {
    // 列不存在（尚未迁移）→ 等同于"没有动态授权的管理员"
    return false;
  }
}

/** 授予 / 撤销管理权限（写 D1 的 is_admin 列） */
export async function setAdminFlag(
  env: Env,
  username: string,
  grant: boolean,
): Promise<void> {
  await exec(
    env.DB,
    'UPDATE users SET is_admin = ? WHERE username = ?',
    grant ? 1 : 0,
    username,
  );
}

/** 记录登录历史（安全中心用） */
export async function logLogin(
  env: Env,
  info: {
    userId: number;
    username: string;
    deviceId?: string | null;
    deviceName?: string | null;
    ip?: string | null;
    country?: string | null;
    userAgent?: string | null;
    success: boolean;
  },
): Promise<void> {
  await exec(
    env.DB,
    `INSERT INTO login_history (user_id, username, device_id, device_name, ip_address, country, user_agent, success)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    info.userId,
    info.username,
    info.deviceId ?? null,
    info.deviceName ?? null,
    info.ip ?? null,
    info.country ?? null,
    info.userAgent ?? null,
    info.success ? 1 : 0,
  );
}

export { unsafeDecodeJwt };
