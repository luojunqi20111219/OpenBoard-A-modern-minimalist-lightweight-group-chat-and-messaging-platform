/**
 * 导入功能的解析入口。
 *
 * 关于打包方式的两次演进，别改回去：
 *
 *   初版把这里做成「独立 bundle + 动态 import」，希望 sql.js 与 643KB wasm
 *   只在访问导入接口时才加载。但实测发现 **wrangler 打包时不跟随动态 import**：
 *   `npx wrangler deploy --dry-run` 的产物里只有 worker.js，
 *   import.js 与 sql-wasm.wasm 根本没被上传，线上会直接报「找不到模块」。
 *
 *   现改为**静态导入**，整个功能打进同一个 Worker；
 *   wasm 通过 wrangler 的 `[wasm_modules] SQL_WASM` 显式绑定传入
 *   （见 wrangler.toml 与该绑定的注释）。
 *
 *   代价：wasm 在 Worker 启动时就会加载（多占约 644KB 体积/内存）。
 *   收益：功能真的能用。这是权衡后的取舍。
 */
import { loadSqlJs } from './sqljs';

/** 需要迁移的表，顺序：先主表后从表（与 migrations/export_from_sqlite.py 保持一致） */
export const TABLES = [
  'users', 'groups', 'messages', 'notifications', 'reactions',
  'message_reads', 'user_devices', 'revoked_sessions', 'favorite_emojis',
  'qr_sessions', 'friend_requests', 'friends', 'message_edits',
  'message_favorites', 'conversation_settings', 'group_members',
  'group_join_requests', 'group_invites', 'group_audit_logs', 'login_history',
] as const;

/** 单表最多读取的行数 —— 防止畸形库把内存撑爆（Free 计划 128MB/请求） */
const MAX_ROWS_PER_TABLE = 200_000;

const SQLITE_MAGIC = 'SQLite format 3\0';

export interface ParseResult {
  /** 实际存在于旧库中、且被读取的表 */
  tables: string[];
  /** 表名 → 行对象数组（列名 → 值） */
  rows: Record<string, Record<string, unknown>[]>;
  /** 表名 → 行数，用于页面展示摘要 */
  stats: Record<string, number>;
  /** 旧库里存在但不在白名单内的表（仅提示，不导入） */
  ignoredTables: string[];
}

export class ParseError extends Error {}

/**
 * 解析 SQLite 二进制，导出为纯 JS 对象。
 * 不碰 D1 —— 只负责「字节 → 行」。
 *
 * @param bytes 旧库 board.db 的完整字节
 */
export async function parseSqlite(bytes: Uint8Array): Promise<ParseResult> {
  // 1) 先验魔数，避免把随便什么文件喂给 wasm 解析器
  if (bytes.length < 100) {
    throw new ParseError('文件太小，不是有效的 SQLite 数据库');
  }
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, SQLITE_MAGIC.length));
  if (head !== SQLITE_MAGIC) {
    throw new ParseError('文件头校验失败：这不是一个 SQLite 数据库（期望 board.db）');
  }

  const SQL = await loadSqlJs();
  const db = new SQL.Database(bytes);

  try {
    // 2) 列出旧库里真实存在的表
    const existing = new Set<string>();
    const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'");
    while (stmt.step()) {
      const row = stmt.getAsObject() as { name?: unknown };
      if (typeof row.name === 'string') existing.add(row.name);
    }
    stmt.free();

    // 3) 逐表读取 —— 用 prepare/step 逐行取，
    //    避免 db.exec() 一次性把整表拼成 JSON（大表会瞬间撑爆内存）
    const rows: Record<string, Record<string, unknown>[]> = {};
    const stats: Record<string, number> = {};
    const tables: string[] = [];

    for (const table of TABLES) {
      if (!existing.has(table)) continue;

      const list: Record<string, unknown>[] = [];
      const reader = db.prepare(`SELECT * FROM "${table}"`);
      try {
        while (reader.step() && list.length < MAX_ROWS_PER_TABLE) {
          list.push(reader.getAsObject());
        }
      } finally {
        reader.free();
      }

      rows[table] = list;
      stats[table] = list.length;
      tables.push(table);
    }

    // 4) 旧库里不在白名单的表 —— 只提示，不导入
    const ignoredTables = [...existing].filter(
      (t) => !(TABLES as readonly string[]).includes(t) && !t.startsWith('sqlite_'),
    );

    return { tables, rows, stats, ignoredTables };
  } finally {
    // 无论成功失败都释放 wasm 侧内存
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}
