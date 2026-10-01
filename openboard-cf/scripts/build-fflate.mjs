#!/usr/bin/env node
/**
 * 把 fflate 编译成浏览器可用的 IIFE bundle，产出 public/upload-fflate.js。
 *
 * 用途：/upload 页面支持「直接选文件夹」上传。浏览器无法把文件夹一次性
 * 作为表单提交，必须先在前端打成一个 zip 再上传。前端打 zip 需要解压库，
 * 而实现就在服务端的 src/import/archive.ts —— 于是复用同一份 fflate。
 *
 * ---------------------------------------------------------------------------
 * 为什么放进 public/ 而不是内联进 Worker
 * ---------------------------------------------------------------------------
 * Worker 有 1MB 体积硬上限（Free 计划），而当前 worker.js + sql-wasm.wasm
 * 已占 ~1000KB，只剩十几 KB 余量 —— 再塞 32KB 的 fflate 会直接超限。
 *
 * 放进 public/ 则由 Cloudflare 的 assets 单独托管，**不计入 Worker 体积**，
 * 且天然享受 CDN 缓存。代价只是多一个构建产物文件。
 *
 * 为什么不从 CDN 引：导入页面是运维用的一次性页面，不该依赖外部 CDN
 * 的可用性；项目其他页面也都是零外部依赖的。
 */
import { build } from 'esbuild';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const OUT = join(PUBLIC, 'upload-fflate.js');

mkdirSync(PUBLIC, { recursive: true });

await build({
  stdin: {
    contents: "export * from 'fflate';",
    resolveDir: ROOT,
    loader: 'js',
  },
  outfile: OUT,
  bundle: true,
  format: 'iife',
  // 暴露成 window.FFLATE，供 /upload 页面的内联脚本直接调用
  globalName: 'FFLATE',
  platform: 'browser',
  target: 'es2018',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});

const kb = (statSync(OUT).size / 1024).toFixed(1);
console.log(`构建完成：public/upload-fflate.js  ${kb} KB（作为静态资源，不占 Worker 体积）`);

