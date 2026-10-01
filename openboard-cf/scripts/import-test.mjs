#!/usr/bin/env node
/**
 * 数据库导入功能的端到端测试（本地 Miniflare）。
 *
 * 覆盖：
 *   1. 首次导入成功，各表行数正确
 *   2. 种子数据filehelper / groups.id=0 不被覆盖
 *   3. 合并语义：已存在的 username 被跳过而非覆盖
 *   4. 密码哈希分类：scrypt 与高迭代 pbkdf2 被列进 needsPasswordReset
 *   5. 「仅一次」闸门：第二次导入返回 403
 *   6. 畸形文件（非 SQLite）被拒且不消耗导入名额
 *   7. 幂等：导入完成后 /api/import/status 显示 available=false
 *
 * 需要先跑 `npm run bundle`（产出 dist/worker.js + dist/import.js + dist/sql-wasm.wasm）。
 */
import { Miniflare } from 'miniflare';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const BASE = 'http://localhost';
const SCHEMA = readFileSync(join(ROOT, 'schema.sql'), 'utf8');

// --- 断言辅助 --------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`); }
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// --- 前置检查 --------------------------------------------------------------
for (const f of ['worker.js', 'sql-wasm.wasm']) {
  if (!existsSync(join(DIST, f))) {
    console.error(`缺少 dist/${f}，请先执行：npm run bundle`);
    process.exit(1);
  }
}

// --- 造测试用旧库 ----------------------------------------------------------
// 用项目自带的 sql.js 生成，保证格式与真实旧库一致
function buildLegacyDb() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-'));
  const script = join(dir, 'gen.cjs');
  const out = join(dir, 'legacy.db');
  writeFileSync(script, `
const initSqlJs = require(${JSON.stringify(join(ROOT, 'node_modules/sql.js/dist/sql-wasm.js'))});
const fs = require('fs');
initSqlJs().then((SQL) => {
  const db = new SQL.Database();
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT, nickname TEXT, role INTEGER DEFAULT 0, avatar TEXT)");
  db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, content TEXT, receiver TEXT, room_id INTEGER DEFAULT 0, client_id TEXT)");
  db.run("CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, is_public INTEGER DEFAULT 0, owner_id INTEGER DEFAULT 0)");
  db.run("CREATE TABLE friends (id INTEGER PRIMARY KEY AUTOINCREMENT, user_a TEXT, user_b TEXT, UNIQUE(user_a, user_b))");
  // 1) 可直接登录（pbkdf2 低迭代）
  db.run("INSERT INTO users (username,password_hash,nickname,role) VALUES ('old_low','pbkdf2:sha256:10000$aa$bb','低迭代',0)");
  // 2) 高迭代 pbkdf2 → 应被列出
  db.run("INSERT INTO users (username,password_hash,nickname,role) VALUES ('old_high','pbkdf2:sha256:260000$cc$dd','高迭代',0)");
  // 3) scrypt → 应被列出
  db.run("INSERT INTO users (username,password_hash,nickname,role) VALUES ('old_scrypt','scrypt:32768:8:1$ee$ff','脚本',0)");
  // 4) 同名种子账号 → 必须被跳过，不能覆盖真实的 filehelper
  db.run("INSERT INTO users (username,password_hash,nickname,role) VALUES ('filehelper','HACKED','假助手',0)");
  // 5) 与现有 D1 数据同名的用户 → 应被跳过（合并语义）
  db.run("INSERT INTO users (username,password_hash,nickname,role) VALUES ('existing_user','pbkdf2:sha256:10000$xx$yy','已存在',0)");
  db.run("INSERT INTO messages (name,content,receiver,room_id) VALUES ('old_low','历史消息一','old_high',0)");
  db.run("INSERT INTO messages (name,content,receiver,room_id) VALUES ('old_low','历史消息二','old_high',0)");
  // id=0 的公共大厅 → 不能被旧库覆盖
  db.run("INSERT INTO groups (id,name,is_public,owner_id) VALUES (0,'假大厅',1,0)");
  db.run("INSERT INTO groups (id,name,is_public,owner_id) VALUES (7,'老群',0,1)");
  db.run("INSERT INTO friends (user_a,user_b) VALUES ('old_low','old_high')");
  fs.writeFileSync(${JSON.stringify(out)}, Buffer.from(db.export()));
  console.log('ok');
});
`);
  execFileSync(process.execPath, [script], { stdio: 'pipe' });
  const buf = readFileSync(out);
  return new Uint8Array(buf);
}

// --- 起 Miniflare ----------------------------------------------------------
//
// SQL_WASM 对应 wrangler.toml 的 [wasm_modules] 绑定。
// 早期版本这里需要显式列模块清单（因为用过动态 import），
// 现已改为静态打进 worker.js，只需喂好绑定即可。
const mf = new Miniflare({
  modules: true,
  // 与 wrangler.toml 的 [[rules]] 对齐：让 Miniflare 认识 .wasm 模块
  modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
  compatibilityDate: '2024-11-27',
  scriptPath: join(DIST, 'worker.js'),
  d1Databases: { DB: 'import-test-db' },
  r2Buckets: { UPLOADS: 'openboard-uploads' },
  kvNamespaces: { RATE_LIMIT: 'import-test-kv' },
  durableObjects: { CHAT_HUB: { className: 'ChatHub', useSQLite: true } },
  bindings: {
    CURRENT_VERSION: 'v9.0.0',
    PUBLIC_UPLOADS: 'true',
    ALLOWED_ADMINS: '官方账号',
    MAX_CONNECTIONS_PER_USER: '4',
    JWT_SECRET: 'test-secret-key-for-import-test',
  },
});

// --- 请求辅助（含 Miniflare 4 的 FormData 兼容处理）------------------------
const req = (path, init) => {
  if (init?.body instanceof FormData) {
    const built = new Request(BASE + path, init);
    return mf.dispatchFetch(BASE + path, {
      method: built.method,
      headers: new Headers(built.headers),
      body: built.body,
      duplex: 'half',
    });
  }
  return mf.dispatchFetch(BASE + path, init);
};
const json = async (path, init) => {
  const r = await req(path, init);
  let body = null;
  try { body = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body, text: JSON.stringify(body) };
};
const uploadDb = (bytes, filename = 'board.db') => {
  const fd = new FormData();
  fd.append('file', new Blob([bytes]), filename);
  return json('/api/import/board', { method: 'POST', body: fd });
};

try {
  // --- 准备：灌 schema，造一条"已存在"的用户 -------------------------------
  section('准备');
  const db = await mf.getD1Database('DB');
  const stmts = SCHEMA.split(';')
    .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
    .filter((s) => s.length > 0);
  await db.batch(stmts.map((s) => db.prepare(s)));
  ok('schema 灌入成功', true);

  await db.prepare(
    'INSERT INTO users (username, password_hash, nickname, role) VALUES (?, ?, ?, 0)',
  ).bind('existing_user', 'pbkdf2:sha256:10000$zz$zz', '原有用户').run();
  const before = await db.prepare('SELECT COUNT(*) AS c FROM users').first();
  // schema 的种子数据只有 filehelper，加上刚插入的 existing_user = 2
  ok(`初始 users 数 = 2（实际 ${before.c}）`, before.c === 2);

  // --- 1. 初始状态：入口可用 ----------------------------------------------
  section('1. 初始状态');
  const s0 = await json('/api/import/status');
  ok('status 返回 200', s0.status === 200, s0.text);
  ok('available = true', s0.body?.available === true, s0.text);

  // --- 2. 畸形文件被拒，且不消耗名额 ---------------------------------------
  section('2. 畸形文件防护');
  const junk = new TextEncoder().encode('this is definitely not a sqlite file'.padEnd(200, 'x'));
  const rJunk = await uploadDb(junk, 'notadb.db');
  ok('非 SQLite 文件被拒（4xx）', rJunk.status >= 400 && rJunk.status < 500, rJunk.text);
  ok('拒绝原因可读', /SQLite|解析/.test(rJunk.body?.detail || ''), rJunk.text);
  const sAfterJunk = await json('/api/import/status');
  ok('畸形文件未消耗导入名额', sAfterJunk.body?.available === true, sAfterJunk.text);

  // --- 3. 首次导入 ---------------------------------------------------------
  section('3. 首次导入');
  const legacy = buildLegacyDb();
  ok(`测试旧库已生成 (${legacy.length} 字节)`, legacy.length > 100);

  const r1 = await uploadDb(legacy);
  ok('导入返回 200', r1.status === 200, r1.text);
  ok('ok = true', r1.body?.ok === true, r1.text);

  const per = r1.body?.perTable || {};
  // 旧库 5 个用户里：filehelper 被种子保护提前过滤（不计入 skipped），
  // existing_user 走 INSERT OR IGNORE 冲突跳过 → inserted=3, skipped=1
  ok(`users 写入 3 跳过 1（实际 ${per.users?.inserted}/${per.users?.skipped}）`,
    per.users?.inserted === 3 && per.users?.skipped === 1,
    JSON.stringify(per.users));
  ok(`messages 写入 2（实际 ${per.messages?.inserted}）`, per.messages?.inserted === 2);
  ok(`groups 写入 1（id=0 被跳过，实际 ${per.groups?.inserted}）`, per.groups?.inserted === 1,
    JSON.stringify(per.groups));
  ok(`friends 写入 1（实际 ${per.friends?.inserted}）`, per.friends?.inserted === 1);

  // --- 4. 种子数据保护 -----------------------------------------------------
  section('4. 种子数据保护');
  const fh = await db.prepare('SELECT password_hash, role FROM users WHERE username = ?')
    .bind('filehelper').first();
  ok('filehelper 仍是系统账号 role=2', fh?.role === 2, JSON.stringify(fh));
  ok('filehelper 密码未被旧库覆盖', fh?.password_hash === 'system_account', JSON.stringify(fh));

  const hall = await db.prepare('SELECT name FROM groups WHERE id = 0').first();
  ok('groups.id=0 仍是「公共大厅」', hall?.name === '公共大厅', JSON.stringify(hall));

  const grp7 = await db.prepare('SELECT name FROM groups WHERE id = 7').first();
  ok('老群 id=7 已导入', grp7?.name === '老群', JSON.stringify(grp7));

  // --- 5. 合并语义 ---------------------------------------------------------
  section('5. 合并语义（冲突跳过）');
  const ex = await db.prepare('SELECT password_hash, nickname FROM users WHERE username = ?')
    .bind('existing_user').first();
  ok('existing_user 的密码未被旧库覆盖', ex?.password_hash === 'pbkdf2:sha256:10000$zz$zz', JSON.stringify(ex));
  ok('existing_user 的昵称未被覆盖', ex?.nickname === '原有用户', JSON.stringify(ex));

  const totalUsers = await db.prepare('SELECT COUNT(*) AS c FROM users').first();
  // filehelper + existing_user + old_low + old_high + old_scrypt = 5
  ok(`导入后 users 总数 = 5（实际 ${totalUsers.c}）`, totalUsers.c === 5);

  // --- 6. 密码哈希分类 -----------------------------------------------------
  section('6. 密码哈希分类');
  const npr = r1.body?.needsPasswordReset || {};
  const unsupported = npr.unsupported || [];
  const highIter = npr.highIteration || [];
  ok(`scrypt 账号被列出（old_scrypt）`,
    unsupported.some((u) => u.username === 'old_scrypt'),
    JSON.stringify(unsupported));
  ok(`高迭代账号被列出（old_high）`,
    highIter.some((u) => u.username === 'old_high' && u.iterations === 260000),
    JSON.stringify(highIter));
  ok(`可直接登录的账号未被误报（old_low 不在列表）`,
    !unsupported.some((u) => u.username === 'old_low') &&
    !highIter.some((u) => u.username === 'old_low'));

  // --- 7. 仅一次闸门 -------------------------------------------------------
  section('7. 「仅一次」闸门');
  const s1 = await json('/api/import/status');
  ok('导入后 available = false', s1.body?.available === false, s1.text);
  ok('返回了导入时间', typeof s1.body?.importedAt === 'string', s1.text);

  const r2 = await uploadDb(legacy);
  ok('第二次导入被拒（403）', r2.status === 403, r2.text);
  ok('拒绝原因可读', /已关闭|已导入/.test(r2.body?.detail || ''), r2.text);

  const totalUsers2 = await db.prepare('SELECT COUNT(*) AS c FROM users').first();
  ok('第二次导入未产生任何数据变更', totalUsers2.c === 5, `实际 ${totalUsers2.c}`);

  const msgCount = await db.prepare('SELECT COUNT(*) AS c FROM messages').first();
  ok('messages 仍为 2 条（未重复插入）', msgCount.c === 2, `实际 ${msgCount.c}`);

  // --- 8. 页面可访问 -------------------------------------------------------
  section('8. /upload 页面');
  const page = await req('/upload');
  const html = await page.text();
  ok('/upload 返回 200', page.status === 200, `status=${page.status}`);
  ok('页面包含标题', html.includes('数据库导入'), '');
  ok('页面注入了已关闭状态', /"available":\s*false/.test(html), '');
} catch (err) {
  console.error('\n\x1b[31m测试异常：\x1b[0m', err.message);
  console.error((err.stack || '').split('\n').slice(0, 8).join('\n'));
  fail++;
} finally {
  await mf.dispose();
}

console.log(`\n\x1b[1m结果：${pass} 通过 / ${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
