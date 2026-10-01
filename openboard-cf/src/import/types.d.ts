/**
 * 补充类型声明 —— 这些模块在运行时由 Cloudflare/esbuild 特殊处理，
 * TypeScript 默认不认识。
 */

/** Workers 的 .wasm 导入：产物是已编译好的 WebAssembly.Module（CompiledWasm） */
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}

/**
 * sql.js 的 UMD 发行版没有自带类型（官方 @types 只覆盖主入口 'sql.js'）。
 * 这里按我们实际用到的形状声明 —— 具体接口见 ./sqljs.ts 的 SqlJsStatic。
 */
declare module 'sql.js/dist/sql-wasm.js' {
  const initSqlJs: (config?: {
    instantiateWasm?: (
      imports: WebAssembly.Imports,
      cb: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) => WebAssembly.Exports;
    locateFile?: (file: string, prefix: string) => string;
  }) => Promise<unknown>;
  export default initSqlJs;
}
