/**
 * 实时广播入口 —— Worker 侧调用 DO 推送消息
 */
import type { Env } from './env';
import { cacheOnlineUsers, cachedOnlineUsers } from './kv';

function hub(env: Env): DurableObjectStub {
  return env.CHAT_HUB.get(env.CHAT_HUB.idFromName('global'));
}

export interface BroadcastPayload {
  message: unknown;
  receiver?: string | null;
  room_id?: number | null;
  sender?: string | null;
  only?: string[] | null;
}

export async function broadcast(env: Env, payload: BroadcastPayload): Promise<void> {
  try {
    await hub(env).fetch('https://chat-hub/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('[broadcast] failed', err);
  }
}

export async function kickUser(env: Env, username: string): Promise<void> {
  try {
    await hub(env).fetch('https://chat-hub/kick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
  } catch (err) {
    console.error('[kick] failed', err);
  }
}

/**
 * 在线用户列表
 *
 * Durable Object 是权威源。KV 里存的是 15 秒内的快照，
 * 只有明确允许陈旧的场景（如管理后台统计）才该读缓存。
 */
export async function onlineUsers(env: Env, opts?: { allowStale?: boolean }): Promise<string[]> {
  if (opts?.allowStale) {
    const cached = await cachedOnlineUsers(env);
    if (cached) return cached;
  }

  try {
    const res = await hub(env).fetch('https://chat-hub/online');
    const data = (await res.json()) as { users: string[] };
    const users = data.users || [];
    // 顺手刷新 KV 快照，供后续 allowStale 读取
    await cacheOnlineUsers(env, users);
    return users;
  } catch {
    // DO 不可达时退回缓存，至少不返回空
    return (await cachedOnlineUsers(env)) || [];
  }
}

/**
 * WebSocket 升级请求转发给 DO
 *
 * ⚠️ 两个必须绕开的坑，否则握手一律失败（表现为 500 或普通 GET）：
 *
 * 1. `Upgrade` 是 forbidden header。任何重建 Request 的写法
 *    —— `new Request(url, request)`、`new Request(url, {headers})`、
 *    甚至 Pages 运行时模板内部的 `new Request(request.clone())`
 *    —— 都会把它丢弃。
 *
 * 2. 所以**不能指望原请求头上的 Upgrade 还在**。这里直接手工构造
 *    一个升级请求，显式带上 `Upgrade: websocket` 与 `Connection: Upgrade`，
 *    DO 侧只看这两个头就够了（见 durable/chat.ts）。
 *
 * 用户身份通过 query 传，不依赖 Cookie / Authorization，
 * 这样旧客户端只要 URL 里有 token 就能连上。
 */
export function upgradeWebSocket(env: Env, request: Request, username: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = '/ws';
  url.searchParams.set('username', username);

  const forwarded = new Request(url.toString(), {
    method: 'GET',
    headers: {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      // Sec-WebSocket-* 由运行时补齐；显式声明版本提高兼容性
      'Sec-WebSocket-Version': '13',
    },
  });
  return hub(env).fetch(forwarded);
}
