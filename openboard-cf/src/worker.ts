/**
 * Worker 入口 —— 全栈部署（静态资源 + API + Durable Object）
 *
 *   npx wrangler deploy            # 部署（读 wrangler.toml）
 *   npx wrangler dev               # 本地调试
 *
 * ---------------------------------------------------------------------------
 * 为什么从 Pages 迁移到 Workers
 * ---------------------------------------------------------------------------
 * 原方案是 Pages Functions + 独立 DO Worker（通过 script_name 跨引用）。
 * 该组合在 Cloudflare 上**不受支持**，表现为：普通 HTTP 请求正常，
 * 但 WebSocket 升级请求一律 500（error code 1101）——
 * 因为带 `webSocket` 属性的 101 响应无法穿过 Pages → DO 的服务绑定边界，
 * 且该异常发生在运行时层，连 try/catch 都拦不住（实测确认）。
 *
 * 官方兼容性矩阵写得很明确：`Durable Objects: Only available on Workers`。
 * 迁移到 Workers 后：
 *   - DO 变成同 Worker 内的原生绑定（不再需要 script_name）
 *   - WebSocket 全程走同一个隔离环境，101 直接返回，无跨边界问题
 *   - 少一个 Worker、少一次跨服务调用，延迟更低
 *   - 额外获得 Cron Triggers 与完整可观测性
 *
 * 静态资源通过 `assets` 绑定提供，成本与 Pages 一致（静态请求不额外计费）。
 */
import { createApp } from './app';
import { ChatHub } from './durable/chat';
import type { Env } from './env';

// DO 类必须从入口模块导出，运行时才能实例化
export { ChatHub };

const app = createApp();

/**
 * 需要由 Worker 处理的路径前缀。
 *
 * 为什么要显式判断，而不是只靠 wrangler.toml 的 `run_worker_first`：
 *   Worker 带 assets 绑定时默认「静态资源优先，未匹配才走 Worker」。
 *   配合 not_found_handling = "single-page-application"，
 *   /api/* 会被当成「没找到这个静态文件」而回退成 index.html（404 表现），
 *   接口全部失效且没有任何报错，排查成本极高。
 *
 *   `run_worker_first` 是新版运行时的特性，本地 Miniflare 3 不支持，
 *   会导致「本地测试通过、线上却 404」或相反的假象。
 *   因此在代码里做一个明确的兜底：无论运行时怎么配，这些前缀都归 Worker。
 *
 * ⚠️ `/uploads` 是**向后兼容**用的，别删：
 *    旧版（FastAPI）把 uploads/ 目录挂在 /uploads 静态路径下，
 *    历史消息里存的图片地址就是 `/uploads/{uuid}.{ext}`。
 *    不把它划归 Worker，assets 会先接住这个请求 ——
 *    文件当然找不到，于是 SPA 回退返回 index.html，
 *    表现为「所有历史图片都裂成一张 HTML」，且没有任何 404 报错可查。
 */
const WORKER_OWNED_PREFIXES = ['/api/', '/ws', '/upload', '/uploads'] as const;

function isWorkerOwned(pathname: string): boolean {
  return WORKER_OWNED_PREFIXES.some(
    (p) => pathname === p || pathname === p.replace(/\/$/, '') || pathname.startsWith(p),
  );
}

/**
 * 静态资源缓存策略
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 重要发现：Workers 的 assets 响应头**无法被 Worker 代码覆盖**
 * ---------------------------------------------------------------------------
 * 从 Pages 迁到 Workers 时，原来放在 `public/_headers` 里的缓存策略会失效：
 *   1. Workers 的 assets 绑定不认 `_headers` 文件（实测：请求 /_headers
 *      会被 SPA 回退当成前端路由，返回 187KB 的 index.html）。
 *   2. 把策略改写到代码里同样无效。assets 响应的 headers guard 是
 *      "immutable"，`set()` 抛 TypeError；即便用 `new Response()` 重建
 *      （headers 可变）也不生效 —— 因为 Cloudflare 在 Worker 之后由静态
 *      资源层统一写入 `Cache-Control`，并且会接管边缘缓存
 *      （响应里可见 `cf-cache-status`），Worker 侧完全插不上手。
 *
 * 实测证据：对 /static/... 加随机 query 依然返回 `cf-cache-status: HIT`，
 * 证明边缘按路径缓存并忽略 Worker 设置的缓存头。
 *
 * 结论：静态资源一律由 Cloudflare 以
 *   `Cache-Control: public, max-age=0, must-revalidate` 提供。
 * 这个策略**功能上是正确的**：浏览器每次带 If-None-Match 校验，
 * 命中 ETag 时返回 304，开销仅一次往返，不会重复传输文件体。
 * 只是不像强缓存那样能完全省掉请求，属于可接受的性能折中。
 *
 * 若将来确实需要强缓存，可行路径是：
 *   · 改用 Cloudflare Cache Rules（zone 级别，在控制台或 Rules API 配置）
 *   · 或把静态资源放到 R2 + 自定义 Cache-Control 元数据
 * 两者都不需要改动本函数。
 *
 * 下面这段逻辑**保留但当前不产生实际效果**，作为 Worker 侧显式表达
 * 意图的记录，并防止未来运行时行为变化时策略缺失。
 */
function applyCachePolicy(res: Response, pathname: string): Response {
  // 只处理成功响应与 304
  if (res.status !== 200 && res.status !== 304) return res;

  let policy: string | null = null;
  if (pathname.startsWith('/static/')) {
    policy = 'public, max-age=31536000, immutable';
  } else if (pathname.startsWith('/game/')) {
    policy = 'public, max-age=3600';
  } else if (pathname.endsWith('.html') || pathname === '/' || !pathname.includes('.')) {
    // 无扩展名的路径走 SPA 回退，返回的就是 index.html，同样不能缓存
    policy = 'no-cache';
  }

  if (!policy) return res;

  // 用新 Response 重建：assets 原始响应的 headers guard 为 "immutable"
  // body 用流直传，不做缓冲，避免大文件（游戏资源）占满内存
  try {
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', policy);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  } catch (err) {
    console.warn('[cache] rebuild failed', err instanceof Error ? err.message : err);
    return res;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    // API 与 WebSocket：交给 Hono 应用
    if (isWorkerOwned(pathname)) {
      return app.fetch(request, env, ctx);
    }

    // 其余交给静态资源；未命中时由 assets 的 SPA 回退返回 index.html
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      return applyCachePolicy(res, pathname);
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
