/**
 * 数据库导入 —— 把旧 Python/FastAPI 版的 board.db 迁移进 D1。
 *
 * 设计要点（都是有意为之，改动前请先读完）：
 *
 * 1. **只允许导入一次**，导入后入口永久关闭。
 *    状态存在 D1 的 `_import_state` 表，而不是 KV —— KV 是最终一致，
 *    两个并发请求可能都读到"未导入"，从而导两遍。
 *    D1 主键冲突能提供真正的原子性保证。
 *
 * 2. **上传的文件不落 R2**。
 *    `PUBLIC_UPLOADS=true` 时 R2 里任何 key 都能被直接下载，
 *    把用户的整库丢进去等于公开泄露。这里直接在内存里解析完即弃，
 *    天然满足"上传后自动删除"。
 *
 * 3. **合并而非覆盖**。全部用 `INSERT OR IGNORE`，
 *    以各表自身的 UNIQUE 约束为准判冲突（users.username 等）。
 *
 * 4. **保护种子数据**：filehelper（role=2）和 groups.id=0（公共大厅）
 *    是 schema.sql 注入的系统数据，绝不能被旧库覆盖。
 */
import { Hono } from 'hono';
import type { Env } from '../env';
import { passwordIterations } from '../env';
import { iterationsOf, isUnsupportedHash } from '../crypto';
import { nowIso } from '../db';

/** 上传体积上限。Free 计划请求体硬上限 100MB，这里留足余量。 */
const MAX_DB_BYTES = 25 * 1024 * 1024;

/** 需要跳过的种子数据（见 schema.sql 末尾） */
const SEED_USERNAMES = new Set(['filehelper']);
const SEED_GROUP_IDS = new Set([0]);

/** 每批 batch 的语句数。D1 单次 batch 语句过多会报错，保守取 150。 */
const BATCH_SIZE = 150;

/**
 * 导入模块 —— **静态导入**。
 *
 * 早期版本用动态 import 做惰性加载，希望 sql.js（80KB JS + 644KB wasm）
 * 只在访问导入接口时才付出代价。但实测发现 **wrangler 打包不跟随动态
 * import**：`--dry-run` 产物里只有 worker.js，import.js 与 wasm 都没被上传，
 * 线上直接报「找不到模块」。因此改回静态导入，保证功能可用。
 *
 * wasm 通过 wrangler `[wasm_modules] SQL_WASM` 绑定传入（见 wrangler.toml）。
 */
import { parseSqlite, type ParseResult } from '../import/entry';

// ---------------------------------------------------------------------------
// _import_state 表 —— 懒创建，省去要求用户重跑 schema.sql
// ---------------------------------------------------------------------------
let stateTableReady = false;

async function ensureStateTable(env: Env): Promise<void> {
  if (stateTableReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS _import_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       imported_at TEXT NOT NULL,
       source_summary TEXT
     )`,
  ).run();
  stateTableReady = true;
}

interface ImportState {
  imported_at: string;
  source_summary: string | null;
}

async function readState(env: Env): Promise<ImportState | null> {
  await ensureStateTable(env);
  return env.DB.prepare('SELECT imported_at, source_summary FROM _import_state WHERE id = 1')
    .first<ImportState>();
}

/**
 * 抢占"导入权"。
 *
 * 用 `CHECK (id = 1)` + 主键冲突做互斥：只有第一个成功插入的请求拿到
 * `changes === 1`，其余全部为 0。这是**唯一**可靠的"仅一次"保证 ——
 * 先 SELECT 再 INSERT 的写法在并发下一定会漏。
 */
async function claimImportSlot(env: Env, summary: string): Promise<boolean> {
  await ensureStateTable(env);
  const res = await env.DB.prepare(
    'INSERT OR IGNORE INTO _import_state (id, imported_at, source_summary) VALUES (1, ?, ?)',
  )
    .bind(nowIso(), summary)
    .run();
  return Number(res.meta?.changes ?? 0) === 1;
}

/** 抢占失败时回滚占用（解析/写入中途出错的话，入口要恢复可用） */
async function releaseImportSlot(env: Env): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM _import_state WHERE id = 1').run();
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 值规范化
// ---------------------------------------------------------------------------
/**
 * 旧 SQLite 的值 → D1 可绑定的值。
 * sql.js 返回的可能是 number / string / null / Uint8Array（BLOB），
 * D1 只接受 null / number / string / ArrayBuffer。BLOB 转成 Uint8Array 即可。
 */
function normalizeValue(v: unknown): string | number | null | ArrayBuffer {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Uint8Array) {
    // 复制一份独立的 ArrayBuffer —— D1 不接受带 offset 的视图，
    // 也不接受 SharedArrayBuffer（TS 类型上 Uint8Array.buffer 可能是它）
    const copy = new ArrayBuffer(v.byteLength);
    new Uint8Array(copy).set(v);
    return copy;
  }
  return String(v);
}

/** D1 绑定参数数量上限约 100，超过则需拆句；此处按列数判断是否安全 */
const D1_MAX_PARAMS = 90;

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
export const importRoutes = new Hono<{ Bindings: Env }>();

/** 查询导入入口是否还可用 */
importRoutes.get('/import/status', async (c) => {
  const env = c.env;
  try {
    const state = await readState(env);
    return c.json({
      available: state === null,
      importedAt: state?.imported_at ?? null,
      summary: state?.source_summary ?? null,
    });
  } catch (err) {
    return c.json(
      { available: false, detail: `读取导入状态失败：${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }
});

/** 执行导入 */
importRoutes.post('/import/board', async (c) => {
  const env = c.env;

  // 0) 前置判定：已导入过就直接拒绝，连文件都不读
  let state: ImportState | null;
  try {
    state = await readState(env);
  } catch (err) {
    return c.json(
      { detail: `读取导入状态失败：${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }
  if (state) {
    return c.json(
      { detail: '数据库导入功能已关闭（此前已成功导入一次，不可重复导入）', importedAt: state.imported_at },
      403,
    );
  }

  // 1) 取文件
  let file: File;
  try {
    const form = await c.req.formData();
    const entry = form.get('file');
    if (!entry || typeof entry === 'string') {
      return c.json({ detail: '缺少文件字段（应为 board.db）' }, 400);
    }
    file = entry as File;
  } catch (err) {
    return c.json(
      { detail: `无法读取上传内容：${err instanceof Error ? err.message : String(err)}` },
      400,
    );
  }

  if (file.size === 0) return c.json({ detail: '文件为空' }, 400);
  if (file.size > MAX_DB_BYTES) {
    return c.json(
      { detail: `文件超过 ${MAX_DB_BYTES / 1024 / 1024}MB 上限（实际 ${(file.size / 1024 / 1024).toFixed(1)}MB）` },
      413,
    );
  }

  // 2) 读进内存后立即解析（不落盘、不写 R2）
  const bytes = new Uint8Array(await file.arrayBuffer());

  let parsed: ParseResult;
  try {
    parsed = await parseSqlite(bytes);
  } catch (err) {
    return c.json(
      {
        detail: `解析数据库失败：${err instanceof Error ? err.message : String(err)}`,
        hint: '请确认上传的是旧版本导出的 board.db（SQLite 格式）',
      },
      400,
    );
  }

  if (parsed.tables.length === 0) {
    return c.json({ detail: '数据库里没有找到任何可识别的表，确认是 OpenBoard 的 board.db 吗？' }, 400);
  }

  // 3) 抢占导入权（并发下只有第一个能成功）
  const previewSummary = JSON.stringify(parsed.stats);
  const claimed = await claimImportSlot(env, previewSummary);
  if (!claimed) {
    return c.json({ detail: '数据库导入功能已关闭（另一个导入正在进行或已完成）' }, 403);
  }

  // 之后任何失败都要释放占位，否则入口被永久锁死
  try {
    // 4) 逐个表合并写入
    const perTable: Record<string, { inserted: number; skipped: number; error?: string }> = {};
    const highIterationUsers: { username: string; iterations: number }[] = [];
    const unsupportedUsers: { username: string; algorithm: string }[] = [];

    // 现有用户名，用于统计"跳过"（INSERT OR IGNORE 不报具体冲突）
    const existingUsers = new Set<string>();
    try {
      const rows = await env.DB.prepare('SELECT username FROM users').all<{ username: string }>();
      for (const r of rows.results ?? []) existingUsers.add(r.username);
    } catch {
      /* 忽略：拿不到就只影响跳过计数，不影响正确性 */
    }

    const targetIter = passwordIterations(env);

    for (const table of parsed.tables) {
      const rows = parsed.rows[table] ?? [];
      const stat = { inserted: 0, skipped: 0 } as { inserted: number; skipped: number; error?: string };
      perTable[table] = stat;

      if (rows.length === 0) continue;

      // 列集合：以第一行建列，后续行若缺列一律补 null
      let columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      if (columns.length === 0) continue;
      if (columns.length > D1_MAX_PARAMS) {
        stat.error = `列数过多（${columns.length}），已跳过该表`;
        continue;
      }

      // -----------------------------------------------------------------
      // id 冲突处理 —— 这是导入最关键的一步，别改错
      // -----------------------------------------------------------------
      //
      // 旧库的主键 id 与 D1 现有数据的 id **几乎必然重叠**
      // （两个库都从 1 开始自增）。若照搬 id 走 `INSERT OR IGNORE`，
      // 会因主键冲突被静默丢弃 —— 即使 username 完全不同。
      // 实测踩过这个坑：旧库 3 个用户只进来 1 个。
      //
      // 但也不能无脑丢掉 id，因为 id 是**被其它表引用的**：
      //     groups.id          ← group_members.group_id
      //                        ← messages.room_id（群聊）
      //                        ← group_join_requests / group_invites / group_audit_logs
      //     messages.id        ← message_reads.msg_id / reactions.msg_id / ...
      //
      // 因此分两类处理：
      //
      //  A. **保留 id**（groups / messages）
      //     这两张表是"被引用方"，重编 id 会让所有引用指向错误的记录，
      //     无法在本函数内无损重建。保留 id 后，真正的冲突只可能来自
      //     种子数据 —— groups 只占 id=0（已在下面过滤掉），
      //     messages 在新库里通常是空的（实测 D1 = 0 条），
      //     所以保留 id 既安全又能保住群聊/私聊的历史关联。
      //
      //  B. **丢掉 id，交由 D1 重新分配**（其余自增主键表）
      //     这些表没有被别人引用，或引用能用 username 等业务键重建。
      //     重编 id 可避免与现有数据撞主键而丢行。
      //
      // 复合主键（message_reads、group_members）和文本主键
      // （revoked_sessions、qr_sessions）本来就没有 id 列，不受影响。
      const KEEP_ID_TABLES = new Set(['groups', 'messages']);

      const hasIdCol = columns.includes('id');
      if (hasIdCol && !KEEP_ID_TABLES.has(table)) {
        columns = columns.filter((c) => c !== 'id');
      }
      if (columns.length === 0) continue;

      const colList = columns.map((c) => `"${c}"`).join(', ');
      const placeholders = columns.map(() => '?').join(', ');
      const sql = `INSERT OR IGNORE INTO "${table}" (${colList}) VALUES (${placeholders})`;

      // 逐行过滤种子数据
      const accepted = rows.filter((row) => {
        if (table === 'users') {
          const uname = String(row.username ?? '');
          if (SEED_USERNAMES.has(uname)) return false;
          if (Number(row.role ?? 0) === 2) return false;
          // 收集密码哈希分类（只针对真正会被导入的用户）
          const ph = row.password_hash;
          if (typeof ph === 'string' && ph.length > 0) {
            if (isUnsupportedHash(ph)) {
              unsupportedUsers.push({ username: uname, algorithm: ph.split(/[:$]/)[0] || 'unknown' });
            } else {
              const n = iterationsOf(ph);
              if (n !== null && n > targetIter) {
                highIterationUsers.push({ username: uname, iterations: n });
              }
            }
          }
        }
        if (table === 'groups') {
          if (SEED_GROUP_IDS.has(Number(row.id ?? -1))) return false;
        }
        return true;
      });

      // 分片 batch 写入
      for (let i = 0; i < accepted.length; i += BATCH_SIZE) {
        const chunk = accepted.slice(i, i + BATCH_SIZE);
        const stmts = chunk.map((row) =>
          env.DB.prepare(sql).bind(...columns.map((col) => normalizeValue(row[col]))),
        );
        try {
          const results = await env.DB.batch(stmts);
          for (const r of results) {
            if (Number(r.meta?.changes ?? 0) === 1) stat.inserted++;
            else stat.skipped++;
          }
        } catch (err) {
          stat.error = `写入失败：${err instanceof Error ? err.message : String(err)}`;
          break;
        }
      }
    }

    const totalInserted = Object.values(perTable).reduce((a, t) => a + t.inserted, 0);
    const totalSkipped = Object.values(perTable).reduce((a, t) => a + t.skipped, 0);

    // 5) 落最终摘要
    const summary = JSON.stringify({
      sourceStats: parsed.stats,
      perTable,
      totalInserted,
      totalSkipped,
    });
    try {
      await env.DB.prepare('UPDATE _import_state SET source_summary = ? WHERE id = 1')
        .bind(summary)
        .run();
    } catch {
      /* 摘要写不进去不影响导入本身 */
    }

    return c.json({
      ok: true,
      importedAt: nowIso(),
      sourceStats: parsed.stats,
      ignoredTables: parsed.ignoredTables,
      perTable,
      totalInserted,
      totalSkipped,
      // 迁移后无法直接登录的账号 —— 供页面提示
      needsPasswordReset: {
        unsupported: unsupportedUsers,
        highIteration: highIterationUsers,
        note:
          `Cloudflare Workers 的 Web Crypto 不支持 scrypt；` +
          `而 pbkdf2 迭代次数高于当前套餐限额（${targetIter}）的哈希，` +
          `在 Free 计划 10ms CPU 限制下无法验证。以上账号请联系管理员重置密码。`,
      },
      message: err_note(perTable),
    });
  } catch (err) {
    // 出错了要把占位释放掉，让用户能重试
    await releaseImportSlot(env);
    return c.json(
      { detail: `导入过程中出错，已回滚导入权限，可重试：${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }
});

/** 汇总各表错误信息，有错才返回 */
function err_note(perTable: Record<string, { error?: string }>): string | undefined {
  const bad = Object.entries(perTable)
    .filter(([, v]) => v.error)
    .map(([k, v]) => `${k}: ${v.error}`);
  return bad.length ? bad.join('；') : undefined;
}

/** 手动关闭导入入口（幂等）。导入成功后其实已自动关闭，此接口用于主动放弃。 */
importRoutes.post('/import/close', async (c) => {
  const env = c.env;
  try {
    const state = await readState(env);
    if (state) return c.json({ ok: true, alreadyClosed: true, importedAt: state.imported_at });
    const claimed = await claimImportSlot(env, JSON.stringify({ manualClose: true }));
    if (!claimed) return c.json({ ok: true, alreadyClosed: true });
    return c.json({ ok: true, alreadyClosed: false });
  } catch (err) {
    return c.json(
      { detail: `关闭失败：${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }
});
