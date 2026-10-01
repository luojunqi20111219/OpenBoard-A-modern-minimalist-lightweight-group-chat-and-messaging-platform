#!/usr/bin/env node
/**
 * 数据导入功能的端到端测试（本地 Miniflare）。
 *
 * 覆盖：
 *   1. 首次导入成功，各表行数正确
 *   2. 种子数据filehelper / groups.id=0 不被覆盖
 *   3. 合并语义：已存在的 username 被跳过而非覆盖
 *   4. 密码哈希分类：scrypt 与高迭代 pbkdf2 被列进 needsPasswordReset
 *   5. 「仅一次」闸门：第二次导入返回 403
 *   6. 畸形文件（非 SQLite）被拒且不消耗导入名额
 *   7. 幂等：导入完成后 /api/import/status 显示 available=false
 *   8. 【压缩包导入】zip 内含 board.db + uploads/ 附件：
 *        · 附件写入 R2 且 key 与旧文件名逐字节相同
 *        · 旧消息里的 /uploads/xxx 与 /api/download/xxx 均可访问
 *        · 附件名的 uuid 形态校验（不匹配的文件不入库）
 *
 * 需要先跑 `npm run bundle`（产出 dist/worker.js 与 dist/sql-wasm.wasm）。
 */
import { Miniflare } from 'miniflare';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { zipSync } from 'fflate';

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

// --- 造「压缩包 + 附件」测试数据 -------------------------------------------
//
// 模拟旧项目根目录：board.db 与 uploads/ 同级。
// 附件名严格用 32 位 hex（uuid4().hex）+ 扩展名，与旧版
// app/routes/messages.py 的 `f"{uuid.uuid4().hex}.{ext}"` 一致。
const ATT_JPG = 'a1b2c3d4e5f60718293a4b5c6d7e8f90.jpg';       // 32 hex + jpg
const ATT_THUMB = '112233445566778899aabbccddeeff00.thumb.jpg'; // 缩略图
const ATT_PDF = 'fedcba9876543210fedcba9876543210.pdf';        // 32 hex + pdf
const ATT_BAD = 'not-a-uuid.jpg';                              // 不合规 → 应被忽略

/** 一个最小的合法 JPEG 头（够识别成图片，不必真能解码） */
const FAKE_JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const FAKE_PDF = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');

/**
 * 造一个「整个项目根目录」的 zip。
 *
 * 层级刻意设计成有包裹目录（openboard/）且有干扰项（node_modules/、
 * __MACOSX/、APP/、app.js），用来验证：
 *   · 包裹目录能被自动剥掉
 *   · board.db 能在多层目录中被找到
 *   · uploads/ 的附件能被完整收集
 *   · 不合规命名的文件被忽略
 */
function buildProjectZip(legacy, { withUploads = true } = {}) {
  const entries = {
    'openboard/board.db': legacy,
    'openboard/app.js': new TextEncoder().encode('// legacy frontend'),
    'openboard/APP/app.js': new TextEncoder().encode('// legacy app'),
    'openboard/requirements.txt': new TextEncoder().encode('fastapi\nuvicorn\n'),
    // 干扰项：不该被当成 db
    'openboard/node_modules/sql.js/package.json': new TextEncoder().encode('{"name":"sql.js"}'),
    '__MACOSX/openboard/._board.db': new Uint8Array([0, 1, 2, 3]),
  };
  if (withUploads) {
    entries['openboard/uploads/' + ATT_JPG] = FAKE_JPG;
    entries['openboard/uploads/' + ATT_THUMB] = FAKE_JPG;
    entries['openboard/uploads/' + ATT_PDF] = FAKE_PDF;
    entries['openboard/uploads/' + ATT_BAD] = FAKE_JPG; // 命名不合规
    entries['openboard/uploads/.DS_Store'] = new Uint8Array([0]);
  }
  return zipSync(entries, { level: 6 });
}

/** 只含 board.db 的 zip（验证「压缩包里没附件」的路径） */
function buildDbOnlyZip(legacy) {
  return zipSync({ 'board.db': legacy, 'README.md': new TextEncoder().encode('# hi') }, { level: 6 });
}

/** 不含 board.db 的 zip（验证错误提示） */
function buildNoDbZip() {
  return zipSync(
    {
      ['proj/uploads/' + ATT_JPG]: FAKE_JPG,
      'proj/app.js': new TextEncoder().encode('x'),
    },
    { level: 6 },
  );
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
const uploadFile = (bytes, filename, mime = 'application/octet-stream') => {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), filename);
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

  // 压缩包也应被同一道闸门拦住
  const r2zip = await uploadFile(buildProjectZip(legacy), 'openboard.zip', 'application/zip');
  ok('已关闭时压缩包同样被拒（403）', r2zip.status === 403, r2zip.text);

  // --- 8. 页面可访问 -------------------------------------------------------
  section('8. /upload 页面');
  const page = await req('/upload');
  const html = await page.text();
  ok('/upload 返回 200', page.status === 200, `status=${page.status}`);
  ok('页面包含标题', html.includes('数据导入'), '');
  ok('页面注入了已关闭状态', /"available":\s*false/.test(html), '');
  ok('页面注入了体积上限常量', /LIMITS\s*=\s*\{/.test(html), '');
  ok('页面引用了前端 zip 组件', html.includes('/upload-fflate.js'), '');
  ok('页面提供「选择文件夹」入口', html.includes('webkitdirectory'), '');

  // -------------------------------------------------------------------------
  // 内联脚本语法校验 —— 这条断言救过一次命，别删
  //
  // renderUploadPage 返回的是**模板字符串**，里面的正则字面量会被先做一层
  // 转义。曾经写过 /\/__MACOSX\//，实际产出变成 //__MACOSX// ——
  // 前半截成了行注释，整个 <script> 语法错误，页面所有 JS 静默不执行
  // （按钮无反应、拖拽没响应，控制台只有一条 'Unexpected token'）。
  //
  // 服务端接口测试全绿、页面却是死的 —— 只有真开浏览器才发现。
  // 这里用 new Function 做语法解析（不执行），比开浏览器便宜得多，
  // 能在 npm run test:import 阶段就拦住这类错误。
  // -------------------------------------------------------------------------
  const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  ok(`页面含 ${inlineScripts.length} 段内联脚本`, inlineScripts.length >= 1,
    String(inlineScripts.length));
  let syntaxErr = null;
  for (const code of inlineScripts) {
    try {
      new Function(code);
    } catch (e) {
      syntaxErr = e.message;
    }
  }
  ok('内联脚本语法正确（能通过解析）', syntaxErr === null, String(syntaxErr));
  ok('  未出现被模板字符串吃掉的正则（// 注释化）',
    !/if\s*\(\s*\/\/[A-Za-z]/.test(html), '疑似正则字面量被转义成了行注释');
} catch (err) {
  console.error('\n\x1b[31m测试异常：\x1b[0m', err.message);
  console.error((err.stack || '').split('\n').slice(0, 8).join('\n'));
  fail++;
} finally {
  await mf.dispose();
}

// ===========================================================================
// 压缩包导入 —— 独立一套 Miniflare + D1
//
// 为什么独立：导入是「仅一次」的，主流程跑完名额就没了。
// 这里重新起一份干净环境，才能验证 zip → board.db + uploads/ 附件
// 的完整链路（含 R2 落盘与旧 URL 可访问性）。
// ===========================================================================
const buildEnv = (dbName, kvName, secret) => {
  const mf = new Miniflare({
    modules: true,
    modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
    compatibilityDate: '2024-11-27',
    scriptPath: join(DIST, 'worker.js'),
    d1Databases: { DB: dbName },
    r2Buckets: { UPLOADS: 'openboard-uploads' },
    kvNamespaces: { RATE_LIMIT: kvName },
    durableObjects: { CHAT_HUB: { className: 'ChatHub', useSQLite: true } },
    bindings: {
      CURRENT_VERSION: 'v9.0.0',
      PUBLIC_UPLOADS: 'true',
      ALLOWED_ADMINS: '官方账号',
      MAX_CONNECTIONS_PER_USER: '4',
      JWT_SECRET: secret,
    },
  });
  const doReq = (path, init) => {
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
  const doJson = async (path, init) => {
    const r = await doReq(path, init);
    let body = null;
    try { body = await r.json(); } catch { /* ignore */ }
    return { status: r.status, body, text: JSON.stringify(body) };
  };
  const post = (bytes, filename, mime = 'application/octet-stream') => {
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: mime }), filename);
    return doJson('/api/import/board', { method: 'POST', body: fd });
  };
  return { mf, req: doReq, json: doJson, post };
};

// --- 9. 边界：不含 board.db / 只含 db 的压缩包 ------------------------------
await (async () => {
  const env = buildEnv('import-zip-test-db', 'import-zip-test-kv', 'secret-zip-1');
  try {
    section('9. 压缩包边界情形');
    const d = await env.mf.getD1Database('DB');
    const stmts = SCHEMA.split(';')
      .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
      .filter((s) => s.length > 0);
    await d.batch(stmts.map((s) => d.prepare(s)));
    ok('独立环境 schema 灌入成功', true);

    const legacy = buildLegacyDb();

    // 9.1 不含 board.db 的压缩包
    const rNoDb = await env.post(buildNoDbZip(), 'proj.zip', 'application/zip');
    ok('不含 board.db 的压缩包被拒（400）', rNoDb.status === 400, rNoDb.text);
    ok('提示里点明缺少 board.db', /board\.db/.test(rNoDb.body?.detail || ''), rNoDb.text);
    const sMid = await env.json('/api/import/status');
    ok('被拒的压缩包未消耗导入名额', sMid.body?.available === true, sMid.text);

    // 9.2 一堆非压缩非 db 的字节 + .zip 扩展名 → 应被识别并给出可读错误
    const junkZip = new Uint8Array(300).fill(0x41);
    const rJunk = await env.post(junkZip, 'fake.zip', 'application/zip');
    ok('伪装成 zip 的垃圾数据被拒', rJunk.status >= 400 && rJunk.status < 500, rJunk.text);
    const sMid2 = await env.json('/api/import/status');
    ok('再次确认名额未消耗', sMid2.body?.available === true, sMid2.text);

    // 9.3 只含 board.db、无 uploads/
    const rDbOnly = await env.post(buildDbOnlyZip(legacy), 'board-only.zip', 'application/zip');
    ok('纯 db 压缩包导入成功（200）', rDbOnly.status === 200, rDbOnly.text);
    ok('archive.format = zip', rDbOnly.body?.archive?.format === 'zip',
      JSON.stringify(rDbOnly.body?.archive));
    ok('attachments.total = 0', rDbOnly.body?.archive?.attachments?.total === 0,
      JSON.stringify(rDbOnly.body?.archive?.attachments));
    ok('识别出根目录的 board.db', rDbOnly.body?.archive?.dbPath === 'board.db',
      String(rDbOnly.body?.archive?.dbPath));
    ok('扫描到的文件数已统计', (rDbOnly.body?.archive?.scannedFiles || 0) >= 2,
      JSON.stringify(rDbOnly.body?.archive));

    // 本环境没有预置 existing_user，旧库 5 个用户里只有 filehelper 被种子保护过滤
    const per = rDbOnly.body?.perTable || {};
    ok(`users 写入 4 跳过 0（实际 ${per.users?.inserted}/${per.users?.skipped}）`,
      per.users?.inserted === 4 && per.users?.skipped === 0, JSON.stringify(per.users));
    ok(`messages 写入 2（实际 ${per.messages?.inserted}）`, per.messages?.inserted === 2);
  } catch (err) {
    console.error('\n\x1b[31m压缩包边界测试异常：\x1b[0m', err.message);
    console.error((err.stack || '').split('\n').slice(0, 8).join('\n'));
    fail++;
  } finally {
    await env.mf.dispose();
  }
})();

// --- 10. 整个项目根目录 zip（含 uploads/ 附件）-----------------------------
await (async () => {
  const env = buildEnv('import-full-zip-db', 'import-full-zip-kv', 'secret-zip-2');
  try {
    section('10. 整个项目根目录 zip（含 uploads/ 附件）');
    const d = await env.mf.getD1Database('DB');
    const stmts = SCHEMA.split(';')
      .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
      .filter((s) => s.length > 0);
    await d.batch(stmts.map((s) => d.prepare(s)));

    const legacy = buildLegacyDb();
    const zipBytes = buildProjectZip(legacy);
    ok(`测试 zip 已生成（${(zipBytes.length / 1024).toFixed(1)} KB）`, zipBytes.length > 200);

    const r = await env.post(zipBytes, 'openboard.zip', 'application/zip');
    ok('项目 zip 导入返回 200', r.status === 200, r.text);

    const arch = r.body?.archive || {};
    const at = arch.attachments || {};
    ok('archive.format = zip', arch.format === 'zip', JSON.stringify(arch));
    ok('包裹目录已剥离（dbPath = board.db）', arch.dbPath === 'board.db', String(arch.dbPath));

    // --- 10.1 附件统计 ---
    //  uploads/ 下：jpg / thumb.jpg / pdf 合规；not-a-uuid.jpg 与 .DS_Store 不合规
    ok(`附件总数 = 3（实际 ${at.total}）`, at.total === 3, JSON.stringify(at));
    ok(`附件写入 = 3（实际 ${at.written}）`, at.written === 3, JSON.stringify(at));
    ok(`附件失败 = 0（实际 ${at.failed}）`, at.failed === 0, JSON.stringify(at));
    ok(`附件总字节 > 0（实际 ${at.totalBytes}）`, (at.totalBytes || 0) > 0, JSON.stringify(at));

    // --- 10.2 R2 落盘：key 必须与旧文件名逐字节相同 ---
    const bucket = await env.mf.getR2Bucket('UPLOADS');
    const oJpg = await bucket.get(ATT_JPG);
    ok(`R2 存在 ${ATT_JPG}`, oJpg !== null);
    ok('jpg 的 contentType = image/jpeg', oJpg?.httpMetadata?.contentType === 'image/jpeg',
      String(oJpg?.httpMetadata?.contentType));
    const jpgBody = oJpg ? new Uint8Array(await oJpg.arrayBuffer()) : new Uint8Array();
    ok('jpg 内容与源文件一致（未被改编码）',
      jpgBody.length === FAKE_JPG.length && jpgBody[0] === 0xff && jpgBody[1] === 0xd8,
      `len=${jpgBody.length}`);

    ok(`R2 存在缩略图 ${ATT_THUMB}`, (await bucket.head(ATT_THUMB)) !== null);
    const oPdf = await bucket.head(ATT_PDF);
    ok(`R2 存在 ${ATT_PDF}`, oPdf !== null);
    ok('pdf 的 contentType = application/pdf', oPdf?.httpMetadata?.contentType === 'application/pdf',
      String(oPdf?.httpMetadata?.contentType));

    ok('不合规命名的附件被忽略', (await bucket.head(ATT_BAD)) === null);
    ok('.DS_Store 未被写成附件', (await bucket.head('.DS_Store')) === null);

    // --- 10.3 旧附件 URL 必须可用（迁移是否真正成功的判据）---
    //  a) 旧版静态目录：/uploads/{uuid}.{ext}
    const u1 = await env.req('/uploads/' + ATT_JPG);
    ok('GET /uploads/{uuid}.jpg → 200', u1.status === 200, `status=${u1.status}`);
    ok('  返回 image/jpeg', u1.headers.get('content-type') === 'image/jpeg',
      String(u1.headers.get('content-type')));

    //  b) 旧版下载接口：/api/download/{uuid}.{ext}?name={显示名}
    const u2 = await env.req('/api/download/' + ATT_PDF + '?name=' + encodeURIComponent('报告.pdf'));
    ok('GET /api/download/{uuid}.pdf?name= → 200', u2.status === 200, `status=${u2.status}`);
    const cd = u2.headers.get('content-disposition') || '';
    ok('  带 attachment 语义', cd.startsWith('attachment'), cd);
    ok('  同时给出 ASCII 降级名与 UTF-8 编码名',
      cd.includes("filename*=UTF-8''") && cd.includes('%E6%8A%A5%E5%91%8A'), cd);

    //  c) 缩略图（前端 <img src> 用的就是它）
    const u3 = await env.req('/uploads/' + ATT_THUMB);
    ok('GET /uploads/{uuid}.thumb.jpg → 200', u3.status === 200, `status=${u3.status}`);

    //  d) 穿越与越权防护
    const u4 = await env.req('/uploads/..%2F..%2Fetc%2Fpasswd');
    ok('路径穿越被拒', u4.status === 400 || u4.status === 404, `status=${u4.status}`);
    const u5 = await env.req('/uploads/00000000000000000000000000000000.jpg');
    ok('不存在的附件 → 404', u5.status === 404, `status=${u5.status}`);

    //  e) 导入预览接口：/api/import/attachment/:key
    const u6 = await env.req('/api/import/attachment/' + ATT_JPG);
    ok('导入预览接口可读附件 → 200', u6.status === 200, `status=${u6.status}`);
    const u7 = await env.req('/api/import/attachment/..%2Fsecret');
    ok('预览接口拒绝非法 key', u7.status === 400 || u7.status === 404, `status=${u7.status}`);

    // --- 10.4 数据侧仍然正确 ---
    const per = r.body?.perTable || {};
    ok(`users 写入 4 跳过 0（实际 ${per.users?.inserted}/${per.users?.skipped}）`,
      per.users?.inserted === 4 && per.users?.skipped === 0, JSON.stringify(per.users));
    ok(`messages 写入 2（实际 ${per.messages?.inserted}）`, per.messages?.inserted === 2);
    ok(`groups 写入 1（实际 ${per.groups?.inserted}）`, per.groups?.inserted === 1,
      JSON.stringify(per.groups));

    const fh = await d.prepare('SELECT role, password_hash FROM users WHERE username = ?')
      .bind('filehelper').first();
    ok('filehelper 未被压缩包里的旧库覆盖',
      fh?.role === 2 && fh?.password_hash === 'system_account', JSON.stringify(fh));
    const hall = await d.prepare('SELECT name FROM groups WHERE id = 0').first();
    ok('groups.id=0 仍是「公共大厅」', hall?.name === '公共大厅', JSON.stringify(hall));

    // --- 10.5 闸门仍然生效，且 R2 不被扰动 ---
    const s3 = await env.json('/api/import/status');
    ok('导入后 available = false', s3.body?.available === false, s3.text);

    const before = await bucket.head(ATT_JPG);
    const rAgain = await env.post(zipBytes, 'openboard.zip', 'application/zip');
    ok('重复导入被 403 拦截', rAgain.status === 403, rAgain.text);
    const after = await bucket.head(ATT_JPG);
    ok('R2 附件未被扰动', before?.etag === after?.etag, `${before?.etag} vs ${after?.etag}`);

    // 摘要里应带上附件信息（页面「已关闭」状态靠它回显）
    const st = await env.json('/api/import/status');
    let sum = null;
    try { sum = JSON.parse(st.body?.summary || 'null'); } catch { /* ignore */ }
    ok('摘要中记录了归档与附件信息', !!sum?.archive && !!sum?.attachments,
      JSON.stringify(sum?.attachments));
  } catch (err) {
    console.error('\n\x1b[31m项目 zip 测试异常：\x1b[0m', err.message);
    console.error((err.stack || '').split('\n').slice(0, 8).join('\n'));
    fail++;
  } finally {
    await env.mf.dispose();
  }
})();

console.log(`\n\x1b[1m结果：${pass} 通过 / ${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
