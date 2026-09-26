/**
 * 兼容旧客户端的 /ws 与 /ws/{token} 路径
 * 新客户端请改用 /api/ws（Cookie 携带凭证，避免 token 出现在访问日志里）
 */
import { resolveUser } from '../src/auth';
import { upgradeWebSocket } from '../src/realtime';
import type { Env } from '../src/env';

function cookieToken(request: Request): string | null {
  const cookie = request.headers.get('Cookie') || '';
  const hit = cookie
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('token='));
  return hit ? decodeURIComponent(hit.slice(6)) : null;
}

/** /ws —— Cookie 鉴权 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const user = await resolveUser(context.env, cookieToken(context.request));
  if (!user || user.is_banned === 1) {
    return new Response(JSON.stringify({ detail: '未登录' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return upgradeWebSocket(context.env, context.request, user.username);
};
