/**
 * KV 用途封装
 *
 * 设计原则：KV 只承载「容忍短暂不一致」的数据。
 *   ✅ 登录限流计数 —— 偶尔漏计一次最多让人多试一次密码，不影响安全底线
 *   ✅ 在线用户快照 —— Durable Object 才是权威源，KV 仅作缓存
 *   ❌ 用户账号 / 会话 / 封禁状态 —— 必须强一致，走 D1
 *
 * 所有方法在 KV 未绑定时自动降级（返回 null / no-op），
 * 保证不绑 KV 也能正常跑。
 */
import type { Env } from './env';

// ---------------------------------------------------------------------------
// 登录限流
// ---------------------------------------------------------------------------
export const LOGIN_FAIL_LIMIT = 5;
export const LOGIN_LOCK_SECONDS = 15 * 60;
const FAIL_WINDOW_SECONDS = 15 * 60;

function failKey(kind: 'u' | 'ip', value: string): string {
  return `login:fail:${kind}:${value.toLowerCase()}`;
}

function lockKey(kind: 'u' | 'ip', value: string): string {
  return `login:lock:${kind}:${value.toLowerCase()}`;
}

/** KV 的 expirationTtl 最小为 60 秒 */
function ttl(seconds: number): number {
  return Math.max(60, Math.ceil(seconds));
}

/**
 * 查询是否处于锁定状态，返回剩余秒数（0 = 未锁定）
 */
export async function kvLockedSeconds(
  env: Env,
  accountKey: string,
  ip: string,
): Promise<number> {
  const kv = env.RATE_LIMIT;
  if (!kv) return 0;

  try {
    const [u, i] = await Promise.all([
      kv.get(lockKey('u', accountKey)),
      kv.get(lockKey('ip', ip)),
    ]);
    const remaining = Math.max(
      u ? parseInt(u, 10) : 0,
      i ? parseInt(i, 10) : 0,
    );
    if (remaining <= 0) return 0;
    // 存储的是「解锁时间戳」
    const secs = Math.ceil((remaining - Date.now()) / 1000);
    return secs > 0 ? secs : 0;
  } catch {
    return 0;
  }
}

/**
 * 记录一次失败，返回锁定秒数（0 = 未锁定）
 */
export async function kvRecordFailure(
  env: Env,
  accountKey: string,
  ip: string,
): Promise<number> {
  const kv = env.RATE_LIMIT;
  if (!kv) return 0;

  try {
    const keys: Array<[string, string]> = [
      [failKey('u', accountKey), accountKey],
      [failKey('ip', ip), ip],
    ];

    let maxLock = 0;
    for (const [key, value] of keys) {
      const raw = await kv.get(key);
      const count = (raw ? parseInt(raw, 10) : 0) + 1;

      if (count >= LOGIN_FAIL_LIMIT) {
        const unlockAt = Date.now() + LOGIN_LOCK_SECONDS * 1000;
        await kv.put(lockKey(key.includes(':u:') ? 'u' : 'ip', value), String(unlockAt), {
          expirationTtl: ttl(LOGIN_LOCK_SECONDS),
        });
        await kv.delete(key);
        maxLock = Math.max(maxLock, LOGIN_LOCK_SECONDS);
      } else {
        await kv.put(key, String(count), { expirationTtl: ttl(FAIL_WINDOW_SECONDS) });
      }
    }
    return maxLock;
  } catch {
    return 0;
  }
}

/** 登录成功后清零计数 */
export async function kvResetFailures(env: Env, accountKey: string): Promise<void> {
  const kv = env.RATE_LIMIT;
  if (!kv) return;
  try {
    await Promise.all([
      kv.delete(failKey('u', accountKey)),
      kv.delete(lockKey('u', accountKey)),
    ]);
  } catch {
    /* 缓存清理失败不影响登录 */
  }
}

// ---------------------------------------------------------------------------
// 在线状态缓存
// ---------------------------------------------------------------------------
const ONLINE_KEY = 'presence:online';
const ONLINE_CACHE_SECONDS = 15;

/**
 * 把 DO 上报的在线列表写进 KV（供非关键路径快速读取）
 */
export async function cacheOnlineUsers(env: Env, users: string[]): Promise<void> {
  const kv = env.RATE_LIMIT;
  if (!kv) return;
  try {
    await kv.put(ONLINE_KEY, JSON.stringify(users), {
      expirationTtl: ttl(ONLINE_CACHE_SECONDS),
    });
  } catch {
    /* 缓存写入失败可忽略 */
  }
}

/** 读缓存的在线列表；未命中返回 null（调用方应回退到问 DO） */
export async function cachedOnlineUsers(env: Env): Promise<string[] | null> {
  const kv = env.RATE_LIMIT;
  if (!kv) return null;
  try {
    const raw = await kv.get(ONLINE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 通用小工具：给任意键做短时缓存
// ---------------------------------------------------------------------------
export async function kvCache<T>(
  env: Env,
  key: string,
  ttlSeconds: number,
  producer: () => Promise<T>,
): Promise<T> {
  const kv = env.RATE_LIMIT;
  if (kv) {
    try {
      const hit = await kv.get(key, 'json');
      if (hit !== null) return hit as T;
    } catch {
      /* 读缓存失败则回源 */
    }
  }

  const value = await producer();

  if (kv) {
    try {
      await kv.put(key, JSON.stringify(value), { expirationTtl: ttl(ttlSeconds) });
    } catch {
      /* 写缓存失败可忽略 */
    }
  }
  return value;
}
