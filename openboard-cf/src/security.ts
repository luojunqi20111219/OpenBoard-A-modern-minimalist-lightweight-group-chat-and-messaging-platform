/**
 * 登录限流 / 客户端信息 —— 替代原 app/security.py
 *
 * 原实现把计数器放在进程内存，Workers 上每个请求可能落在不同实例，
 * 内存计数没有意义。本版优先走 KV（容忍短暂不一致，成本低），
 * KV 未绑定时降级为查 D1 的 login_history 表。
 */
import type { Env } from './env';
import { qOne } from './db';
import {
  kvLockedSeconds,
  kvRecordFailure,
  kvResetFailures,
  LOGIN_FAIL_LIMIT,
  LOGIN_LOCK_SECONDS,
} from './kv';

export { LOGIN_FAIL_LIMIT, LOGIN_LOCK_SECONDS };

export function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ||
    request.headers.get('X-Real-IP') ||
    '0.0.0.0'
  );
}

export function countryOf(request: Request): string {
  return (
    request.headers.get('CF-IPCountry') ||
    request.headers.get('X-Country-Code') ||
    ''
  )
    .toUpperCase()
    .slice(0, 16);
}

/** 返回还需要等待的秒数；0 表示未锁定 */
export async function loginLockedSeconds(env: Env, accountKey: string, ip: string): Promise<number> {
  // 优先 KV
  const fromKv = await kvLockedSeconds(env, accountKey, ip);
  if (fromKv > 0) return fromKv;

  // 降级：查 D1 登录历史
  const row = await qOne<{ fails: number; last_fail: string | null }>(
    env.DB,
    `SELECT COUNT(*) AS fails, MAX(created_at) AS last_fail
       FROM login_history
      WHERE success = 0
        AND created_at >= datetime('now', ?)
        AND (LOWER(username) = LOWER(?) OR ip_address = ?)`,
    `-${Math.floor(LOGIN_LOCK_SECONDS / 60)} minutes`,
    accountKey,
    ip,
  );
  const fails = row?.fails ?? 0;
  if (fails < LOGIN_FAIL_LIMIT) return 0;

  const last = row?.last_fail ? Date.parse(row.last_fail.replace(' ', 'T') + 'Z') : Date.now();
  const elapsed = (Date.now() - (Number.isNaN(last) ? Date.now() : last)) / 1000;
  return Math.max(0, Math.ceil(LOGIN_LOCK_SECONDS - elapsed));
}

/** 记录一次登录失败，返回锁定秒数 */
export async function recordLoginFailure(env: Env, accountKey: string, ip: string): Promise<number> {
  return kvRecordFailure(env, accountKey, ip);
}

/** 登录成功后清空失败计数 */
export async function resetLoginFailures(env: Env, accountKey: string): Promise<void> {
  await kvResetFailures(env, accountKey);
}

/**
 * 安全响应头 —— 对应原 main.py 的 add_security_headers 中间件
 *
 * ⚠️ 必须跳过 WebSocket 101 —— 升级响应的 headers 是**不可变**的（immutable），
 *    对它们调用 set() 会抛 `TypeError: Can't modify immutable headers`。
 *
 *    这个坑的代价很大：异常发生在中间件里，会把整个 WebSocket 握手变成 500，
 *    而且响应体里看不到任何原因 ——
 *       · 在 Pages 上表现为无信息的 `error code: 1101`
 *       · 在 Workers 上表现为「服务器内部错误」500
 *    现象会让人误以为是 DO 绑定或运行时边界的问题，极难定位。
 *    实际上与 WebSocket 基础设施毫无关系，纯粹是这行 header 写入。
 *
 *    另外 101 握手响应本来也不需要这些头（后续通信走帧，不经过 HTTP 中间件）。
 */
export function securityHeaders(res: Response): Response {
  // 101 Switching Protocols：headers 只读，且安全头对其无意义，直接放行
  if (res.status === 101 || res.webSocket) return res;

  const h = res.headers;
  // 防御：即使不是 101，运行时也可能给出 guard 为 "immutable" 的 headers
  // （例如来自内部 fetch 的响应），此时任何写入都会抛错。
  try {
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('X-Frame-Options', 'DENY');
    h.set('Referrer-Policy', 'no-referrer');
    h.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    h.set(
      'Content-Security-Policy',
      "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; font-src 'self' data:; " +
        "connect-src 'self' ws: wss:; object-src 'none'; " +
        "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
  } catch {
    // headers 不可变时静默跳过安全头，绝不因为加头而让请求失败
  }
  return res;
}
