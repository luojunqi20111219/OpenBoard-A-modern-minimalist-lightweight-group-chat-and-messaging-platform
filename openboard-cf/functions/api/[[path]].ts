/**
 * Pages Functions 入口：捕获 /api/* 全部请求
 */
import { createApp } from '../../src/app';
import type { Env } from '../../src/env';

const app = createApp();

export const onRequest: PagesFunction<Env> = async (context) => {
  return app.fetch(
    context.request,
    context.env as unknown as Env,
    context as unknown as ExecutionContext,
  );
};
