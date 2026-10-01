/**
 * sql.js 加载器。
 *
 * ---------------------------------------------------------------------------
 * 为什么不能用 sql.js 的 wasmBinary 选项
 * ---------------------------------------------------------------------------
 * sql.js 内部把 wasmBinary 当成 URL/ArrayBuffer 交给它自己的加载器，
 * 而那个加载器在浏览器分支下用的是 XMLHttpRequest —— workerd 里没有。
 * 结果是**静默失败**：不抛错、不拒绝，请求就这么永久挂着（已实测踩过）。
 *
 * 改为走 instantiateWasm 钩子，直接把编译好的 WebAssembly.Module 注入，
 * 完全绕开 sql.js 自己的 wasm 加载逻辑。
 *
 * ---------------------------------------------------------------------------
 * 关于 wasm 的引入方式
 * ---------------------------------------------------------------------------
 * 用 Workers 原生的 `import wasm from './sql-wasm.wasm'`（产物是已编译的
 * WebAssembly.Module）。注意不能用 wrangler 的 [wasm_modules] 绑定 ——
 * ES module worker 下会直接报错，必须走模块导入。
 *
 * 打包时需保持这条导入为 external（见 scripts/build-import.mjs），
 * 否则 esbuild 会把它降级成一句文件路径字符串，wasm 就用不了了。
 */
// ⚠️ 必须显式指定路径！直接写 'sql.js' 会被打包器解析到
//    sql.js/dist/sql-wasm-browser.js（浏览器版），在 workerd 里行为不对。
import initSqlJs from 'sql.js/dist/sql-wasm.js';

/** 与 sql.js 的 Database 实例对应的最小接口（只用到只读能力） */
export interface SqlDatabase {
  exec(sql: string): { columns: string[]; values: unknown[][] }[];
  prepare(sql: string): SqlStatement;
  close(): void;
}

export interface SqlStatement {
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): void;
}

export interface SqlJsStatic {
  Database: new (data?: Uint8Array) => SqlDatabase;
}

let cached: SqlJsStatic | null = null;

/** 初始化 sql.js（进程内只做一次） */
export async function loadSqlJs(): Promise<SqlJsStatic> {
  if (cached) return cached;

  const mod = (await import('./sql-wasm.wasm')) as { default: unknown };
  const maybeModule = mod.default;

  const wasmModule =
    maybeModule instanceof WebAssembly.Module
      ? maybeModule
      : // @cloudflare/workers-types 的 WebAssembly 声明没有 compile()，
        // 但 workerd 运行时是有的；这里只为非 CompiledWasm 的场景兜底。
        await (
          WebAssembly as unknown as { compile(b: BufferSource): Promise<WebAssembly.Module> }
        ).compile(maybeModule as BufferSource);

  cached = (await initSqlJs({
    instantiateWasm(imports, cb) {
      const instance = new WebAssembly.Instance(wasmModule, imports);
      cb(instance, wasmModule);
      return instance.exports;
    },
  })) as unknown as SqlJsStatic;

  return cached;
}
