/**
 * Durable Object 宿主 Worker
 *
 * Cloudflare 不允许 Pages Functions 直接导出 DO 类，DO 必须住在独立 Worker 里，
 * Pages 再通过 wrangler.toml 的 script_name 绑定引用它。
 *
 * 部署：
 *   npx wrangler deploy --config wrangler.do.toml
 *
 * 这个 Worker 本身不处理 HTTP 业务，所有请求都由 ChatHub DO 内部消化。
 */
import { ChatHub } from '../src/durable/chat';

export { ChatHub };

export default {
  fetch(): Response {
    return new Response(
      'OpenBoard ChatHub — WebSocket 广播中枢（Durable Object 宿主）',
      { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  },
} satisfies ExportedHandler;
