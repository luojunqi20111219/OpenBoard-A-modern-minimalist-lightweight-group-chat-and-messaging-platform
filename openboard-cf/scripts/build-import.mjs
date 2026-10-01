#!/usr/bin/env node
/**
 * 构建「数据库导入」功能所需的两样东西。
 *
 * 产出：
 *   dist/worker.js       —— 主 Worker（含 sql.js）
 *   dist/sql-wasm.wasm   —— 由 wrangler.toml 的 [wasm_modules] SQL_WASM 绑定上传
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这个脚本（而不是让 wrangler 自己打包 src/worker.ts）
 * ---------------------------------------------------------------------------
 * sql.js 是 CommonJS 包。Wrangler 自带的 bundler 会把
 * `import initSqlJs from 'sql.js'` 当成磁盘路径去找，报错：
 *     ENOENT: no such file or directory, open '.../sql.js'
 * 因此必须先用 esbuild 把它转成标准 ESM。
 *
 * ---------------------------------------------------------------------------
 * 为什么 wasm 用绑定而不是 `import wasm from './x.wasm'`
 * ---------------------------------------------------------------------------
 * 早期版本把导入功能做成独立 bundle + 动态 import，想让 wasm 按需加载。
 * 但 **wrangler 打包不跟随动态 import** —— 实测 `--dry-run` 产物里
 * 只有 worker.js，wasm 完全没被上传，线上会报「找不到模块」。
 *
 * 现在改为：
 *   · 导入功能**静态**打进主 Worker（本脚本负责）
 *   · wasm 通过 wrangler 的 [wasm_modules] 显式绑定上传（wrangler.toml 负责）
 * 绑定是显式声明的，wrangler 保证会上传，不会再出现「文件丢了」的问题。
 *
 * 用法：node scripts/build-import.mjs   （package.json 的 bundle 已包含）
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT_JS = join(DIST, 'worker.js');
const OUT_WASM = join(DIST, 'sql-wasm.wasm');
const SRC_WASM = join(ROOT, 'node_modules/sql.js/dist/sql-wasm.wasm');

mkdirSync(DIST, { recursive: true });

// ---------------------------------------------------------------------------
// 1) 打包主 Worker（sql.js 内联）
// ---------------------------------------------------------------------------
await build({
  entryPoints: [join(ROOT, 'src/worker.ts')],
  outfile: OUT_JS,
  bundle: true,
  format: 'esm',
  // neutral：不注入 Node/browser 平台的 polyfill，
  // 避免把 process / Buffer 之类 workerd 没有的全局变量塞进来
  platform: 'neutral',
  target: 'es2022',
  external: [
    'cloudflare:workers',
    // ⚠️ 关键：保持 `import wasm from './sql-wasm.wasm'` 原样不动。
    //    若让 esbuild 处理它，会退化成一句文件路径字符串，wasm 就用不了了。
    //    保持外部引用后，由 Cloudflare 的 CompiledWasm 模块规则接管
    //    （见 wrangler.toml 的 [[rules]]）。
    './sql-wasm.wasm',
  ],
  // sql.js 里有 require('node:fs') / require('node:crypto') 等分支，
  // 仅在 Node 环境下才会走到（内部 `ca` 标志为 false 时不执行）。
  // 外部化掉即可，workerd 不会真的去解析它们。
  plugins: [
    {
      name: 'externalize-node-builtins',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^node:/ }, (args) => ({
          path: args.path,
          external: true,
        }));
      },
    },
  ],
  logLevel: 'info',
});

// ---------------------------------------------------------------------------
// 2) 打补丁：修掉 sql.js 里对 `self.location` 的假设
//
//    workerd 没有 `self.location`，而 sql.js 在确定「程序所在目录」时会执行：
//        za = ba && (za = self.location.href)
//    于是抛 `TypeError: Cannot read properties of undefined (reading 'href')`，
//    且发生在 wasm 实例化之前，表现为整个导入功能不可用。
//
//    改成可选链 + 空串兜底 —— 该值只用于拼 locateFile 的默认路径，
//    而我们早已通过 instantiateWasm 绕开了文件定位，空串完全安全。
// ---------------------------------------------------------------------------
let js = readFileSync(OUT_JS, 'utf8');

const PATCH_FROM =
  '"undefined" != typeof __filename ? za = __filename : ba && (za = self.location.href);';
const PATCH_TO =
  '"undefined" != typeof __filename ? za = __filename : ba && (za = globalThis.location?.href ?? "");';

if (js.includes(PATCH_FROM)) {
  js = js.replace(PATCH_FROM, PATCH_TO);
  console.log('✔ 已修补 self.location.href（workerd 兼容）');
} else if (js.includes('globalThis.location?.href ?? ""')) {
  console.log('✔ self.location.href 补丁已存在，跳过');
} else {
  console.warn('⚠ 未找到 self.location.href 补丁目标 —— sql.js 版本可能变了，请检查！');
}

// 兜底：改写其余直接引用（不同 sql.js 版本写法可能不同）
if (/self\.location\.href/.test(js)) {
  js = js.replace(/self\.location\.href/g, '(globalThis.location?.href ?? "")');
  console.log('✔ 已兜底改写其余 self.location.href 引用');
}

writeFileSync(OUT_JS, js);

// ---------------------------------------------------------------------------
// 3) 复制 wasm 到 dist/，由 wrangler 的 [wasm_modules] 绑定上传
// ---------------------------------------------------------------------------
copyFileSync(SRC_WASM, OUT_WASM);

const kb = (p) => (statSync(p).size / 1024).toFixed(1) + ' KB';
console.log(`\n构建完成：`);
console.log(`  dist/worker.js      ${kb(OUT_JS)}`);
console.log(`  dist/sql-wasm.wasm  ${kb(OUT_WASM)}`);
console.log(`\n提示：wasm 计入 Worker 体积（Free 计划上限 1MB），deploy 时请留意。`);
