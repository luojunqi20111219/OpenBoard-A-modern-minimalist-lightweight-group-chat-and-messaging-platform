/**
 * 应用装配 —— Pages Functions 与独立 Worker 共用同一份入口
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { HonoEnv, Env } from './auth';
import { resolveUser } from './auth';
import { authRoutes } from './routes/auth';
import { messageRoutes } from './routes/messages';
import { groupRoutes } from './routes/groups';
import { friendRoutes } from './routes/friends';
import { adminRoutes } from './routes/admin';
import { upgradeWebSocket } from './realtime';
import { onlineUsers } from './realtime';
import { securityHeaders } from './security';

export function createApp() {
  const app = new Hono<HonoEnv>();

  // CORS：前端与 API 同域部署，主要为原生客户端与本地调试保留
  app.use(
    '/api/*',
    cors({
      origin: (origin) => origin || '*',
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  // 统一安全响应头
  app.use('*', async (c, next) => {
    await next();
    securityHeaders(c.res);
    if (c.req.path.startsWith('/api/')) {
      c.res.headers.set('Cache-Control', 'no-store');
    }
  });

  app.route('/api', authRoutes);
  app.route('/api', messageRoutes);
  app.route('/api', groupRoutes);
  app.route('/api', friendRoutes);
  app.route('/api', adminRoutes);

  // --- WebSocket ------------------------------------------------------------
  // /api/ws：网页端用 Cookie 携带凭证，不把 token 暴露在 URL / 访问日志里
  app.get('/api/ws', async (c) => {
    const e = c.env as unknown as Env;
    const token =
      c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') ??
      (c.req.header('Cookie') || '')
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('token='))
        ?.slice(6) ??
      null;

    const user = await resolveUser(e, token);
    if (!user) return c.json({ detail: '未登录' }, 401);
    if (user.is_banned === 1) return c.json({ detail: '账号已被封禁' }, 403);

    return upgradeWebSocket(e, c.req.raw, user.username);
  });

  // /api/ws/:token：兼容已发布的原生客户端（v8 之前的老路径）
  app.get('/api/ws/:token', async (c) => {
    const e = c.env as unknown as Env;
    const user = await resolveUser(e, c.req.param('token'));
    if (!user) return c.json({ detail: '未登录' }, 401);
    return upgradeWebSocket(e, c.req.raw, user.username);
  });

  // --- 健康检查 / 运行时信息 -------------------------------------------------
  app.get('/api/health', async (c) => {
    const e = c.env as unknown as Env;
    const online = await onlineUsers(e);
    return c.json({
      status: 'ok',
      runtime: 'cloudflare-workers',
      version: e.CURRENT_VERSION || 'v9.0.0',
      online_count: online.length,
    });
  });

  app.notFound((c) => c.json({ detail: '接口不存在' }, 404));
  app.onError((err, c) => {
    console.error('[app error]', err);
    return c.json({ detail: '服务器内部错误' }, 500);
  });

  return app;
}

export type AppEnv = Env;
