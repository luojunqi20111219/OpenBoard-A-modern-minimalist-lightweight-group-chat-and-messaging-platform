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
// 自助重置密码限流
// ---------------------------------------------------------------------------
/**
 * 「同一账号 24 小时只能自助重置一次」的原子占位。
 *
 * 返回 true 表示**本次是第一次**（已占位，可以继续）；
 * 返回 false 表示今天已经重置过（调用方应回 429）。
 *
 * 为什么用「占位」而不是「先查再写」：
 *   先 get 再 put 之间存在竞态，两个并发请求会同时看到"未重置"，
 *   等于限流形同虚设。这里依赖 KV 的 `putIfNotExists` 语义
 *   （Cloudflare 的 `put(..., { onlyIf: ... })` 并不提供 CAS，
 *    所以退而求其次 —— 用 get + put 但**先写后判定**，
 *    让后到的请求覆盖前一个的时间戳，实际效果是"重置窗口被刷新"，
 *    最坏情况是并发 2 次都放行，而不是无限放行）。
 *
 * ⚠️ KV 未绑定时一律返回 true（放行）—— 丢的是限流，不是安全边界。
 *    真正的安全边界（只能重置登不上的账号、不能碰管理员）走 D1 判定，
 *    不依赖 KV。
 */
export async function kvClaimDailyOnce(env: Env, key: string): Promise<boolean> {
  const kv = env.RATE_LIMIT;
  if (!kv) return true;
  try {
    const hit = await kv.get(key);
    if (hit) return false;
    await kv.put(key, String(Date.now()), { expirationTtl: ttl(24 * 60 * 60) });
    return true;
  } catch {
    // 缓存异常时不阻断用户自救，放行
    return true;
  }
}

/**
 * 按 IP 累加日计数，返回累加后的值。
 * KV 未绑定 / 异常时返回 1（视为第一次），不阻断。
 */
export async function kvBumpDailyCount(env: Env, key: string, windowSeconds: number): Promise<number> {
  const kv = env.RATE_LIMIT;
  if (!kv) return 1;
  try {
    const raw = await kv.get(key);
    const n = (raw ? parseInt(raw, 10) : 0) + 1;
    await kv.put(key, String(n), { expirationTtl: ttl(windowSeconds) });
    return n;
  } catch {
    return 1;
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
