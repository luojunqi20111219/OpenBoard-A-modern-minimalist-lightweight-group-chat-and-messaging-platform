/**
 * /ws/{token} —— 旧版原生客户端的 URL 携带 token 方式
 *
 * Android 客户端（WebSocketManager.kt）就是这么拼的：
 *   baseUrl.replace("https://", "wss://") + "ws/$token"
 * 所以这条路径必须保持可用，否则存量 App 收不到任何消息。
 *
 * ⚠️ 注意：本文件名是 `[[token]].ts`，Pages 生成的路由是 `/ws/:token*`，
 * 那个尾随 `*` 会让 params.token 变成**字符串数组**（如 ["abc"]），
 * 而不是字符串。早期版本直接当字符串用，会在 resolveUser 内部
 * 调用 token.split 时炸成 500。这里统一归一化。
 */
import { resolveUser } from '../../src/auth';
import { upgradeWebSocket } from '../../src/realtime';
import type { Env } from '../../src/env';

/** params.token 可能是 string，也可能是因为 `*` 通配导致的 string[] */
function pickToken(raw: unknown): string {
  if (Array.isArray(raw)) return String(raw[0] ?? '');
  return typeof raw === 'string' ? raw : '';
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const token = pickToken(context.params.token);
  const user = await resolveUser(context.env, token);
  if (!user || user.is_banned === 1) {
    return new Response(JSON.stringify({ detail: '未登录' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return upgradeWebSocket(context.env, context.request, user.username);
};
