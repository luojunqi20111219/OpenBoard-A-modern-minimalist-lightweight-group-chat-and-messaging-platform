/**
 * 可选部署方式：把后端单独部署成一个 Worker（纯 API，不含前端静态资源）
 *
 *   npx wrangler deploy --config wrangler.worker.toml
 *
 * 适用场景：想把 API 挂在 api.example.com、前端挂在 example.com 时。
 * 默认情况下（Pages Functions）不需要这个文件。
 */
import { createApp } from './app';
import { ChatHub } from './durable/chat';

export { ChatHub };

const app = createApp();

export default {
  fetch: (request: Request, env: unknown, ctx: ExecutionContext) =>
    app.fetch(request, env as never, ctx),
};
