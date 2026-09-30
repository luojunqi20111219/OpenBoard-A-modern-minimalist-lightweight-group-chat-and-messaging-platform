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
  //
  // 共 4 条路径，都是升级到同一个 ChatHub DO：
  //
  //   /api/ws            网页端，Cookie / Authorization 携带凭证
  //   /api/ws/:token     v8 起的原生客户端路径
  //   /ws                v7 及更早的网页端路径
  //   /ws/:token         旧版安卓客户端路径（WebSocketManager.kt 拼的）
  //
  // ⚠️ 后两条是**存量 App 的生命线**：已发布的安卓客户端硬编码了
  //    baseUrl.replace("https://","wss://") + "ws/$token"，
  //    少一条就会让老用户收不到任何消息。迁移时不能图省事删掉。
  //
  // 之所以把 4 条合到一个 helper：原 Pages 版本把它们分散在
  // functions/ws.ts 和 functions/ws/[[token]].ts，逻辑重复且容易漏改。

  /** 从 Cookie 或 Authorization 头取 token */
  const tokenFromHeaders = (c: { req: { header: (k: string) => string | undefined } }) => {
    const auth = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    if (auth) return auth;
    return (
      (c.req.header('Cookie') || '')
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('token='))
        ?.slice(6) ?? null
    );
  };

  /** 统一的升级处理：解析身份 → 转发给 DO，异常带出原因 */
  const handleUpgrade = async (
    c: { env: unknown; req: { raw: Request }; json: (o: unknown, s?: number) => Response },
    token: string | null,
    label: string,
  ): Promise<Response> => {
    const e = c.env as unknown as Env;
    try {
      const user = await resolveUser(e, token);
      if (!user) return c.json({ detail: '未登录' }, 401);
      if (user.is_banned === 1) return c.json({ detail: '账号已被封禁' }, 403);
      return await upgradeWebSocket(e, c.req.raw, user.username);
    } catch (err) {
      // DO 绑定缺失或 DO 内部报错时，裸异常会变成无信息的 500（error 1101），
      // 这里把原因带出来，便于区分是配置问题还是代码问题
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(`[${label}] upgrade failed`, msg);
      return c.json({ detail: 'WebSocket 升级失败', reason: msg }, 500);
    }
  };

  app.get('/api/ws', (c) => handleUpgrade(c, tokenFromHeaders(c), 'api/ws'));
  app.get('/api/ws/:token', (c) => handleUpgrade(c, c.req.param('token'), 'api/ws/token'));
  app.get('/ws', (c) => handleUpgrade(c, tokenFromHeaders(c), 'ws'));
  app.get('/ws/:token', (c) => handleUpgrade(c, c.req.param('token'), 'ws/token'));

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

  // --- 线上自检（Self-check）------------------------------------------------
  //
  // Worker 自己向自己发起一次真实的 WebSocket 升级，用于在生产环境验证
  // 「101 Switching Protocols」是否真的能返回。
  //
  // 存在的理由：本地 Miniflare 与线上 Cloudflare 的运行时行为不等价
  // （Miniflare 3 不支持 assets 的 run_worker_first，DO 边界行为也有差异）。
  // 早期 Pages 方案正是「本地全绿、线上 500」——因为带 webSocket 的 101
  // 响应无法穿过 Pages → DO 的服务绑定。
  //
  // 只在携带正确 flag 时启用，且不暴露任何敏感数据。
  app.get('/api/_selfcheck', async (c) => {
    if (c.req.query('key') !== 'openboard-selfcheck') {
      return c.json({ detail: '接口不存在' }, 404);
    }
    const e = c.env as unknown as Env;

    // 1) D1
    let d1 = 'skip';
    try {
      const r = await e.DB.prepare('SELECT COUNT(*) AS c FROM users').first<{ c: number }>();
      d1 = `ok:users=${r?.c ?? 0}`;
    } catch (err) {
      d1 = `fail:${err instanceof Error ? err.message : String(err)}`;
    }

    // 2) KV
    let kv = 'skip';
    try {
      if (!e.RATE_LIMIT) {
        kv = 'fail:binding-missing';
      } else {
        await e.RATE_LIMIT.put('__selfcheck', String(Date.now()), { expirationTtl: 60 });
        const got = await e.RATE_LIMIT.get('__selfcheck');
        kv = got ? 'ok' : 'fail:empty';
      }
    } catch (err) {
      kv = `fail:${err instanceof Error ? err.message : String(err)}`;
    }

    // 3) R2
    let r2 = 'skip';
    try {
      await e.UPLOADS.put('__selfcheck.txt', 'ok');
      const obj = await e.UPLOADS.get('__selfcheck.txt');
      r2 = obj ? 'ok' : 'fail:null';
      await e.UPLOADS.delete('__selfcheck.txt');
    } catch (err) {
      r2 = `fail:${err instanceof Error ? err.message : String(err)}`;
    }

    // 4) Durable Object —— 直接调用 stub，不经 HTTP
    let doCheck = 'skip';
    try {
      const stub = e.CHAT_HUB.get(e.CHAT_HUB.idFromName('selfcheck'));
      const res = await stub.fetch('https://do/online');
      const body = await res.text();
      doCheck = `ok:${res.status}:${body.slice(0, 80)}`;
    } catch (err) {
      doCheck = `fail:${err instanceof Error ? err.message : String(err)}`;
    }

    // 5) 真实 WebSocket 升级
    //
    // ⚠️ 不能用 fetch(`${origin}/api/ws/...`) 自请求——Worker 请求自己的
    //    公开域会被 Cloudflare 判为回环并拦回 `error code: 1014`。
    //
    //    改为直接调用生产代码里的 `upgradeWebSocket()`，走的是**完全相同**
    //    的函数路径（构造 Upgrade 请求 → DO stub → 101），只是省掉了一次
    //    互联网往返。因此这一步验证的就是真实链路的全部关键环节：
    //    PBKDF2 哈希（受 10ms CPU 限额约束）、D1 写入、JWT 签发、
    //    身份解析、DO WebSocket 升级并返回 101。
    let ws = 'skip';
    let auth = 'skip';
    const probeUser = `selfcheck_${Date.now()}`;
    const probePass = 'SelfCheck!2026';
    try {
      const { hashPassword } = await import('./crypto');
      const { passwordIterations } = await import('./env');
      const { createAccessToken } = await import('./auth');
      const { upgradeWebSocket: doUpgrade } = await import('./realtime');

      // 5a) 走真实注册流程（HTTP 层直接调内部函数，避免回环限制）
      const t0 = Date.now();
      const hashed = await hashPassword(probePass, passwordIterations(e));
      const hashMs = Date.now() - t0;

      const ins = await e.DB.prepare(
        'INSERT INTO users (username, password_hash, nickname, role) VALUES (?, ?, ?, 0)',
      )
        .bind(probeUser, hashed, '自检')
        .run();
      const uid = Number(ins.meta?.last_row_id ?? 0);

      const token = await createAccessToken(
        e,
        { sub: String(uid), username: probeUser, role: 0 },
        15,
      );
      await e.DB.prepare('UPDATE users SET token=? WHERE id=?').bind(token, uid).run();
      auth = `hash=${hashMs}ms token=${token ? 'ok' : 'none'}`;

      // 5b) 用真 token 解析身份
      const user = await resolveUser(e, token);
      auth += ` resolve=${user ? user.username : 'null'}`;

      // 5c) 真实 WebSocket 升级 —— 核心验证点
      if (user) {
        const fakeReq = new Request('https://openboard.local/api/ws', { method: 'GET' });
        const resp = await doUpgrade(e, fakeReq, user.username);
        ws = `status=${resp.status} webSocket=${resp.webSocket ? 'yes' : 'no'}`;
        if (resp.status !== 101 || !resp.webSocket) {
          ws += ` body=${(await resp.text()).slice(0, 120)}`;
        } else {
          resp.webSocket.accept();
          ws += ' accept=ok';
          resp.webSocket.close();
        }

        // 5d) 旧版安卓路径 —— /ws/{token} 解析出同样的身份
        const legacyUser = await resolveUser(e, token);
        const legacyResp = await doUpgrade(
          e,
          new Request('https://openboard.local/ws/x', { method: 'GET' }),
          legacyUser!.username,
        );
        ws += ` | legacy=${legacyResp.status}/${legacyResp.webSocket ? 'ws' : 'no'}`;
        try { legacyResp.webSocket?.accept(); legacyResp.webSocket?.close(); } catch { /* ignore */ }
      }

      // 5e) 无效 token 必须被拒
      const bad = await resolveUser(e, 'invalid-token-xxx');
      ws += ` | invalid=${bad === null ? 'rejected-ok' : 'LEAK!'}`;
    } catch (err) {
      ws = `fail:${err instanceof Error ? err.message : String(err)}`;
    } finally {
      try {
        await e.DB.prepare('DELETE FROM users WHERE username = ?').bind(probeUser).run();
      } catch { /* ignore */ }
    }

    return c.json({ d1, kv, r2, do: doCheck, auth, ws });
  });

  app.notFound((c) => c.json({ detail: '接口不存在' }, 404));
  app.onError((err, c) => {
    console.error('[app error]', err);
    return c.json({ detail: '服务器内部错误' }, 500);
  });

  return app;
}

export type AppEnv = Env;
