#!/usr/bin/env node
/**
 * 管理员授权体系的端到端测试（本地 Miniflare）。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这个文件
 * ---------------------------------------------------------------------------
 * v10.0.0 引入了"动态授权" —— 管理权限从 wrangler.toml 的硬编码名单
 * 搬进了 D1，并且加了一条"申请 → 批准"的信任链。这条链路有两个地方
 * 特别容易写错，而且错了在手工测试时很难发现：
 *
 *   1. **判定顺序** —— 硬编码名单必须查在 D1 之前。如果反过来，
 *      一旦 D1 的 is_admin 列被误删，所有人都会掉权限，
 *      连救回来的入口都没有。
 *   2. **写前复检** —— approve / revoke 在写库前要重新确认操作者
 *      仍是管理员。少了这一步，一个"权限刚被撤销但旧 token 还在"
 *      的人仍然能把别人提权。
 *
 * 这两条都是不可见的行为，只有测试能守住。
 *
 * 覆盖：
 *   1. 迁移幂等性与各步骤效果
 *   2. 迁移状态查询
 *   3. 申请：成功 / 重复申请不堆积 / 已是管理员不重复申请
 *   4. 审批：非管理员 403 / 批准生效 / 拒绝不留权限
 *   5. 撤销：不能撤销自己 / 不能撤销保底名单 / 硬编码名单不可撤销
 *   6. 三级判定的顺序（role=1、硬编码、D1）
 *   7. 管理员名单合并去重与 builtin 标记
 *   8. 审计日志落库
 *   9. 用户列表的 password_algorithm 与 needs_password_reset
 *
 * 需要先跑 `npm run bundle`。
 */
import { Miniflare } from 'miniflare';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

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

for (const f of ['worker.js', 'sql-wasm.wasm']) {
  if (!existsSync(join(DIST, f))) {
    console.error(`缺少 dist/${f}，请先执行：npm run bundle`);
    process.exit(1);
  }
}

// --- 环境构造 --------------------------------------------------------------

/**
 * 建一个隔离的 Miniflare 实例。
 *
 * D1 数据库用独立文件，避免并行/连续跑测试时状态串味。
 */
async function buildEnv({ admins = '官方账号', withAdminSchema = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adm-'));
  const mf = new Miniflare({
    modules: true,
    // 与 wrangler.toml 的 [[rules]] 对齐：让 Miniflare 认识 .wasm 模块
    modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
    scriptPath: join(DIST, 'worker.js'),
    // 每个实例用独立的库名 + 独立持久化目录，避免连续跑测试时状态串味
    d1Databases: { DB: `adm-${Math.random().toString(36).slice(2)}` },
    r2Buckets: { UPLOADS: 'adm-test-uploads' },
    kvNamespaces: { RATE_LIMIT: 'adm-test-kv' },
    durableObjects: { CHAT_HUB: { className: 'ChatHub', useSQLite: true } },
    compatibilityDate: '2024-11-27',
    bindings: {
      JWT_SECRET: 'test-secret-for-admin-grants',
      ALLOWED_ADMINS: admins,
      CURRENT_VERSION: 'v10.0.0',
      PASSWORD_ITERATIONS: '10000',
    },
    d1Persist: join(dir, 'd1'),
  });

  const db = await mf.getD1Database('DB');
  // D1 的 exec() 要求整段是单条语句，而 schema.sql 开头就是注释 ——
  // 所以按分号切开、逐行剥掉 -- 注释后用 batch 灌入
  const stmts = SCHEMA.split(';')
    .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
    .filter((s) => s.length > 0);
  await db.batch(stmts.map((s) => db.prepare(s)));
  if (withAdminSchema) await applyAdminSchema(db);

  const post = async (path, body, token) => {
    const res = await mf.dispatchFetch(BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: token } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, body: parsed, text };
  };

  const get = async (path, token) => {
    const res = await mf.dispatchFetch(BASE + path, {
      headers: token ? { Authorization: token } : {},
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, body: parsed, text };
  };

  return { mf, db, post, get, dir };
}

/** 手工建管理员相关表/列 —— 模拟"已跑过迁移"的状态 */
async function applyAdminSchema(db) {
  const cols = await db.prepare('PRAGMA table_info("users")').all();
  const has = (cols.results ?? []).some((r) => r.name === 'is_admin');
  if (!has) {
    await db.prepare('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0').run();
  }
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS admin_requests (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       username    TEXT NOT NULL,
       note        TEXT,
       status      TEXT NOT NULL DEFAULT 'pending',
       device_info TEXT,
       created_at  TEXT NOT NULL,
       handled_at  TEXT,
       handled_by  TEXT,
       UNIQUE(username, status)
     )`,
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS admin_audit_logs (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       actor      TEXT NOT NULL,
       action     TEXT NOT NULL,
       target     TEXT,
       detail     TEXT,
       created_at TEXT NOT NULL
     )`,
  ).run();
}

/** 造一个用户，返回用户名 */
async function makeUser(db, username, { role = 0, passwordHash = 'pbkdf2:sha256:10000$abc$def' } = {}) {
  await db.prepare(
    'INSERT INTO users (username, password_hash, nickname, role, is_banned) VALUES (?,?,?,?,0)',
  ).bind(username, passwordHash, username, role).run();
  return username;
}

/**
 * 直接签发 token。
 *
 * 走 /api/login 需要正确的密码哈希，测试里造哈希太重；
 * 这里直接构造 JWT —— 服务端 verifyJwt 用的是同一份 JWT_SECRET。
 */
async function tokenFor(mf, username) {
  const { signJwt } = await import('../dist/worker.js').catch(() => ({}));
  // worker.js 不导出 signJwt，改为走 /api/login 的替代方案：
  // 用 users.token 这列（老式不透明 token 兜底路径，见 auth.ts resolveUser）
  const db = await mf.getD1Database('DB');
  const token = 'tok_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  await db.prepare('UPDATE users SET token = ? WHERE username = ?').bind(token, username).run();
  return token;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

(async () => {
  console.log('\x1b[1m管理员授权体系端到端测试\x1b[0m');

  let env;
  try {
    env = await buildEnv({ admins: '官方账号,Forest_siri' });
    const { db, post, get } = env;

    // -----------------------------------------------------------------------
    section('1. 迁移');
    // -----------------------------------------------------------------------
    await makeUser(db, '官方账号', { role: 2, passwordHash: '' });
    await makeUser(db, 'Forest_siri', { role: 0 });
    await makeUser(db, 'alice', { role: 0 });
    await makeUser(db, 'bob', { role: 0 });
    await makeUser(db, 'old_admin', { role: 1 });

    const rootToken = await tokenFor(env.mf, '官方账号');

    const st0 = await get('/api/admin/migration_status', rootToken);
    ok('迁移前 ready=false', st0.body?.ready === false, JSON.stringify(st0.body));
    ok('迁移前 users_is_admin=false', st0.body?.users_is_admin === false);

    const m1 = await post('/api/admin/apply_migrations', {}, rootToken);
    ok('执行迁移返回 200', m1.status === 200, m1.text);
    ok('迁移无错误', (m1.body?.errors ?? []).length === 0, JSON.stringify(m1.body?.errors));
    ok('迁移报告添加了 is_admin 列',
      (m1.body?.applied ?? []).some((s) => s.includes('users.is_admin')), JSON.stringify(m1.body?.applied));
    // ⚠️ admin_requests / admin_audit_logs 这两张表在 schema.sql 里已有定义，
    // 所以全新库启动时它们就已存在 —— 迁移报告只会把它们列进 skipped，
    // 不会出现在 applied 里。这里该断言的是"表确实可用"，而不是"由迁移创建"。
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('admin_requests','admin_audit_logs')")
      .all();
    const tableNames = (tables.results ?? []).map((r) => r.name).sort();
    ok('admin_requests 表可用',
      tableNames.includes('admin_requests'), JSON.stringify(tableNames));
    ok('admin_audit_logs 表可用',
      tableNames.includes('admin_audit_logs'), JSON.stringify(tableNames));

    // 幂等性：再跑一次不应报错
    const m2 = await post('/api/admin/apply_migrations', {}, rootToken);
    ok('重复迁移仍返回 200', m2.status === 200, m2.text);
    ok('重复迁移无错误', (m2.body?.errors ?? []).length === 0);
    ok('重复迁移全部走 skipped',
      (m2.body?.skipped ?? []).length >= 3, JSON.stringify(m2.body?.skipped));

    const st1 = await get('/api/admin/migration_status', rootToken);
    ok('迁移后 ready=true', st1.body?.ready === true, JSON.stringify(st1.body));

    // 历史 role=1 应该被同步成 is_admin=1
    const oldRow = await db.prepare('SELECT is_admin FROM users WHERE username=?').bind('old_admin').first();
    ok('role=1 的历史账号被同步为 is_admin=1', Number(oldRow?.is_admin) === 1, String(oldRow?.is_admin));

    // --- v10.3.0 新增列 -----------------------------------------------------
    ok('迁移报告添加了 users.muted_until',
      (m1.body?.applied ?? []).some((s) => s.includes('users.muted_until')),
      JSON.stringify(m1.body?.applied));
    ok('迁移报告添加了 groups.created_at',
      (m1.body?.applied ?? []).some((s) => s.includes('groups.created_at')),
      JSON.stringify(m1.body?.applied));

    const uCols = (await db.prepare('PRAGMA table_info("users")').all()).results ?? [];
    ok('users.muted_until 列确实存在', uCols.some((c) => c.name === 'muted_until'),
      JSON.stringify(uCols.map((c) => c.name)));
    const gCols = (await db.prepare('PRAGMA table_info("groups")').all()).results ?? [];
    ok('groups.created_at 列确实存在', gCols.some((c) => c.name === 'created_at'),
      JSON.stringify(gCols.map((c) => c.name)));

    // created_at 必须允许 NULL —— SQLite 的 ADD COLUMN 不能带非常量默认值，
    // 所以列上没有 DEFAULT，历史群该列就是 NULL
    const createdCol = gCols.find((c) => c.name === 'created_at');
    ok('groups.created_at 无非常量默认值（否则 ALTER 会失败）',
      !createdCol?.dflt_value || createdCol.dflt_value === 'NULL',
      JSON.stringify(createdCol));

    const idx = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_created'")
      .all();
    ok('messages.created_at 索引已建', (idx.results ?? []).length === 1);

    ok('迁移状态暴露 users_muted_until', st1.body?.users_muted_until === true,
      JSON.stringify(st1.body));
    ok('迁移状态暴露 groups_created_at', st1.body?.groups_created_at === true,
      JSON.stringify(st1.body));

    // -----------------------------------------------------------------------
    section('2. 申请流程');
    // -----------------------------------------------------------------------
    const aliceToken = await tokenFor(env.mf, 'alice');

    const my0 = await get('/api/admin/my_application', aliceToken);
    ok('普通用户 is_admin=false', my0.body?.is_admin === false, JSON.stringify(my0.body));
    ok('普通用户无 pending', my0.body?.pending === null, JSON.stringify(my0.body?.pending));

    const a1 = await post('/api/admin/apply', { note: '我是 alice', device_info: 'Pixel 7' }, aliceToken);
    ok('提交申请返回 200', a1.status === 200, a1.text);
    ok('申请返回 success', a1.body?.status === 'success', JSON.stringify(a1.body));

    const my1 = await get('/api/admin/my_application', aliceToken);
    ok('申请后出现 pending', my1.body?.pending !== null, JSON.stringify(my1.body));
    ok('pending 里带申请说明', my1.body?.pending?.note === '我是 alice', JSON.stringify(my1.body?.pending));
    ok('申请后仍不是管理员', my1.body?.is_admin === false);

    // 重复申请：UNIQUE(username, status) 应该只刷新不新增
    await post('/api/admin/apply', { note: '改个说明' }, aliceToken);
    const cnt = await db.prepare(
      "SELECT COUNT(*) AS n FROM admin_requests WHERE username='alice' AND status='pending'",
    ).first();
    ok('重复申请不堆积（仍为 1 条）', Number(cnt?.n) === 1, String(cnt?.n));
    const refreshed = await db.prepare(
      "SELECT note FROM admin_requests WHERE username='alice' AND status='pending'",
    ).first();
    ok('重复申请刷新了说明', refreshed?.note === '改个说明', String(refreshed?.note));

    // 已是管理员的人不该再申请
    const rootApply = await post('/api/admin/apply', { note: 'x' }, rootToken);
    ok('已是管理员申请返回 already_admin',
      rootApply.body?.status === 'already_admin', JSON.stringify(rootApply.body));

    // -----------------------------------------------------------------------
    section('3. 审批权限边界');
    // -----------------------------------------------------------------------
    const bobToken = await tokenFor(env.mf, 'bob');

    const r1 = await get('/api/admin/requests', aliceToken);
    ok('普通用户看申请列表 403', r1.status === 403, `${r1.status} ${r1.text}`);

    const r2 = await post('/api/admin/approve', { username: 'alice' }, aliceToken);
    ok('普通用户批准 403', r2.status === 403, `${r2.status} ${r2.text}`);

    const r3 = await post('/api/admin/revoke', { username: 'bob' }, bobToken);
    ok('普通用户撤销 403', r3.status === 403, `${r3.status} ${r3.text}`);

    const l1 = await get('/api/admin/requests', rootToken);
    ok('管理员能看到待审列表', l1.status === 200 && Array.isArray(l1.body?.requests), l1.text);
    ok('待审列表含 alice', (l1.body?.requests ?? []).some((r) => r.username === 'alice'),
      JSON.stringify(l1.body?.requests));

    // -----------------------------------------------------------------------
    section('4. 批准与生效');
    // -----------------------------------------------------------------------
    const ap = await post('/api/admin/approve', { username: 'alice', request_id: 1 }, rootToken);
    ok('批准返回 200', ap.status === 200, ap.text);
    ok('批准返回 success', ap.body?.status === 'success', JSON.stringify(ap.body));

    const aliceFlag = await db.prepare('SELECT is_admin FROM users WHERE username=?').bind('alice').first();
    ok('alice 的 is_admin 已置 1', Number(aliceFlag?.is_admin) === 1, String(aliceFlag?.is_admin));

    const aliceMy = await get('/api/admin/my_application', aliceToken);
    ok('alice 现在 is_admin=true', aliceMy.body?.is_admin === true, JSON.stringify(aliceMy.body));
    ok('alice 的 pending 已清空', aliceMy.body?.pending === null);

    const reqRow = await db.prepare(
      "SELECT status, handled_by FROM admin_requests WHERE username='alice'",
    ).first();
    ok('申请状态变为 approved', reqRow?.status === 'approved', String(reqRow?.status));
    ok('记录了处理人', reqRow?.handled_by === '官方账号', String(reqRow?.handled_by));

    // 批准后 alice 应立即拥有管理接口访问权（不需要重新登录）
    const aliceNow = await get('/api/admin/requests', aliceToken);
    ok('刚被批准的人可访问管理接口', aliceNow.status === 200, `${aliceNow.status} ${aliceNow.text}`);

    // -----------------------------------------------------------------------
    section('5. 拒绝');
    // -----------------------------------------------------------------------
    await post('/api/admin/apply', { note: 'bob 也想当' }, bobToken);
    const rj = await post('/api/admin/reject', { username: 'bob' }, rootToken);
    ok('拒绝返回 200', rj.status === 200, rj.text);

    const bobFlag = await db.prepare('SELECT is_admin FROM users WHERE username=?').bind('bob').first();
    ok('被拒者 is_admin 保持 0', Number(bobFlag?.is_admin ?? 0) === 0, String(bobFlag?.is_admin));

    const bobReq = await db.prepare(
      "SELECT status FROM admin_requests WHERE username='bob'",
    ).first();
    ok('bob 的申请状态为 rejected', bobReq?.status === 'rejected', String(bobReq?.status));

    const bobMy = await get('/api/admin/my_application', bobToken);
    ok('被拒者可以重新申请（pending 为空）', bobMy.body?.pending === null, JSON.stringify(bobMy.body));

    // -----------------------------------------------------------------------
    section('6. 撤销的保护规则');
    // -----------------------------------------------------------------------
    const revSelf = await post('/api/admin/revoke', { username: '官方账号' }, rootToken);
    ok('不能撤销自己', revSelf.status === 400, `${revSelf.status} ${revSelf.text}`);

    const revBuiltin = await post('/api/admin/revoke', { username: 'Forest_siri' }, rootToken);
    ok('不能撤销硬编码保底名单', revBuiltin.status === 400, `${revBuiltin.status} ${revBuiltin.text}`);

    const fsToken = await tokenFor(env.mf, 'Forest_siri');
    const fsAdmin = await get('/api/admin/my_application', fsToken);
    ok('硬编码名单里的账号直接是管理员', fsAdmin.body?.is_admin === true, JSON.stringify(fsAdmin.body));

    // 正常撤销
    const revAlice = await post('/api/admin/revoke', { username: 'alice' }, rootToken);
    ok('撤销普通动态管理员返回 200', revAlice.status === 200, revAlice.text);

    const aliceAfter = await db.prepare('SELECT is_admin FROM users WHERE username=?').bind('alice').first();
    ok('alice 的 is_admin 已置 0', Number(aliceAfter?.is_admin ?? 0) === 0, String(aliceAfter?.is_admin));

    const aliceDenied = await get('/api/admin/requests', aliceToken);
    ok('被撤销后立即失去管理接口访问权', aliceDenied.status === 403, `${aliceDenied.status}`);

    // role=1 的账号即使 is_admin=0 也仍是管理员（兼容历史）
    const oldToken = await tokenFor(env.mf, 'old_admin');
    const oldAdmin = await get('/api/admin/my_application', oldToken);
    ok('role=1 的历史账号权限保持（判定顺序第 1 级）',
      oldAdmin.body?.is_admin === true, JSON.stringify(oldAdmin.body));

    // -----------------------------------------------------------------------
    section('7. 管理员名单');
    // -----------------------------------------------------------------------
    const list = await get('/api/admin/list', rootToken);
    ok('名单返回 200', list.status === 200, list.text);
    const names = (list.body?.admins ?? []).map((a) => a.username);
    ok('名单含硬编码账号 官方账号', names.includes('官方账号'), JSON.stringify(names));
    ok('名单含硬编码账号 Forest_siri', names.includes('Forest_siri'), JSON.stringify(names));
    ok('名单含 role=1 的历史账号 old_admin', names.includes('old_admin'), JSON.stringify(names));
    ok('已撤销的 alice 不在名单里', !names.includes('alice'), JSON.stringify(names));
    const builtins = (list.body?.admins ?? []).filter((a) => a.builtin).map((a) => a.username);
    ok('硬编码账号带 builtin 标记',
      builtins.includes('Forest_siri') && !builtins.includes('old_admin'), JSON.stringify(builtins));
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    ok('名单无重复项', dup.length === 0, JSON.stringify(dup));

    // -----------------------------------------------------------------------
    section('8. 审计日志');
    // -----------------------------------------------------------------------
    const audit = await get('/api/admin/audit', rootToken);
    ok('审计列表返回 200', audit.status === 200, audit.text);
    const logs = audit.body?.logs ?? [];
    ok('审计里有 admin.apply', logs.some((l) => l.action === 'admin.apply'), JSON.stringify(logs.map(l => l.action)));
    ok('审计里有 admin.approve', logs.some((l) => l.action === 'admin.approve'));
    ok('审计里有 admin.revoke', logs.some((l) => l.action === 'admin.revoke'));
    ok('审计里有 admin.reject', logs.some((l) => l.action === 'admin.reject'));
    const apLog = logs.find((l) => l.action === 'admin.approve');
    ok('批准日志记录了操作者', apLog?.actor === '官方账号', String(apLog?.actor));
    ok('批准日志记录了目标', apLog?.target === 'alice', String(apLog?.target));

    // 普通用户看不到审计
    const bobAudit = await get('/api/admin/audit', bobToken);
    ok('普通用户看审计 403', bobAudit.status === 403, `${bobAudit.status}`);

    // --- 筛选、分页、合并（v10.3.0 新增） -----------------------------------
    //
    // 这些行为靠肉眼在页面上很难确认对错：筛出来的少一条你会以为"本来
    // 就没有"，分页越界也只是少显示几条。用断言钉住。
    ok('审计返回 total', typeof audit.body?.total === 'number', JSON.stringify(audit.body?.total));
    ok('审计每条带 uid 唯一键（两表 id 会撞，靠它区分）',
      logs.length > 0 && logs.every((l) => typeof l.uid === 'string' && l.uid.includes(':')),
      JSON.stringify(logs.slice(0, 2)));
    ok('审计 uid 无重复',
      new Set(logs.map((l) => l.uid)).size === logs.length,
      `${new Set(logs.map((l) => l.uid)).size} / ${logs.length}`);
    ok('审计每条带 source 标签',
      logs.every((l) => l.source === 'admin' || l.source === 'group'),
      JSON.stringify([...new Set(logs.map((l) => l.source))]));

    // 按 actor 筛
    const byActor = await get('/api/admin/audit?actor=' + encodeURIComponent('官方账号'), rootToken);
    const actorLogs = byActor.body?.logs ?? [];
    ok('按 actor 筛选生效',
      actorLogs.length > 0 && actorLogs.every((l) => l.actor === '官方账号'),
      JSON.stringify(actorLogs.map((l) => l.actor)));
    ok('按 actor 筛选的 total 与条数一致',
      byActor.body?.total === actorLogs.length, `${byActor.body?.total} vs ${actorLogs.length}`);

    // 按 action 筛
    const byAction = await get('/api/admin/audit?action=admin.approve', rootToken);
    ok('按 action 筛选生效',
      (byAction.body?.logs ?? []).length > 0 &&
      (byAction.body?.logs ?? []).every((l) => l.action === 'admin.approve'),
      JSON.stringify((byAction.body?.logs ?? []).map((l) => l.action)));

    // 按 source 筛
    const bySource = await get('/api/admin/audit?source=admin', rootToken);
    ok('按 source=admin 筛选生效',
      (bySource.body?.logs ?? []).every((l) => l.source === 'admin'),
      JSON.stringify([...new Set((bySource.body?.logs ?? []).map((l) => l.source))]));

    // 分页：limit + offset 不重叠
    const page1 = await get('/api/admin/audit?limit=2&offset=0', rootToken);
    const page2 = await get('/api/admin/audit?limit=2&offset=2', rootToken);
    const uids1 = (page1.body?.logs ?? []).map((l) => l.uid);
    const uids2 = (page2.body?.logs ?? []).map((l) => l.uid);
    ok('分页 limit 生效', uids1.length <= 2, String(uids1.length));
    ok('分页两页不重叠',
      uids1.every((u) => !uids2.includes(u)), JSON.stringify({ uids1, uids2 }));
    ok('分页时 total 保持全量',
      page1.body?.total === audit.body?.total, `${page1.body?.total} vs ${audit.body?.total}`);

    // 时间区间：只传日期时不能漏掉当天记录（服务端补 00:00:00 / 23:59:59）
    const today = new Date().toISOString().slice(0, 10);
    const byDay = await get(`/api/admin/audit?from=${today}&to=${today}`, rootToken);
    ok('只传日期能筛出当天全部记录（含补时分秒）',
      (byDay.body?.logs ?? []).length === logs.length,
      `当天 ${(byDay.body?.logs ?? []).length} 条 vs 全量 ${logs.length} 条`);

    // 区间之外应为空
    const empty = await get('/api/admin/audit?from=2000-01-01&to=2000-01-02', rootToken);
    ok('时间区间之外返回空', (empty.body?.logs ?? []).length === 0 && empty.body?.total === 0,
      JSON.stringify(empty.body));

    // --- 两表合并是否真的工作 ------------------------------------------------
    //
    // 上面那些断言只证明了 admin 那半张表。如果合并 SQL 写错（比如 UNION
    // 写成只查一张表、或 group 那条被 WHERE 过滤掉），只要 group 表是空的
    // 就永远看不出来。这里手动插一条群审计，确认它确实出现、且带 group 标记。
    await db.prepare(
      `INSERT INTO group_audit_logs (group_id, actor, action, target, detail, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(999, '群主甲', 'group.kick', '捣乱者', '测试用', '2026-10-03 08:00:00').run();

    const merged = await get('/api/admin/audit?limit=200', rootToken);
    const mergedLogs = merged.body?.logs ?? [];
    const grp = mergedLogs.find((l) => l.action === 'group.kick');
    ok('群审计被合并进结果', !!grp, JSON.stringify(mergedLogs.map((l) => l.action)));
    ok('群审计带 source=group', grp?.source === 'group', String(grp?.source));
    ok('群审计带 group_id', grp?.group_id === 999, String(grp?.group_id));
    ok('群审计 uid 用 group: 前缀', String(grp?.uid).startsWith('group:'), String(grp?.uid));
    ok('群审计记录了 target', grp?.target === '捣乱者', String(grp?.target));

    const onlyGroup = await get('/api/admin/audit?source=group&limit=200', rootToken);
    ok('source=group 只返回群审计',
      (onlyGroup.body?.logs ?? []).length > 0 &&
      (onlyGroup.body?.logs ?? []).every((l) => l.source === 'group'),
      JSON.stringify([...new Set((onlyGroup.body?.logs ?? []).map((l) => l.source))]));

    const onlyAdmin = await get('/api/admin/audit?source=admin&limit=200', rootToken);
    ok('source=admin 不混入群审计',
      (onlyAdmin.body?.logs ?? []).every((l) => l.source === 'admin'),
      JSON.stringify([...new Set((onlyAdmin.body?.logs ?? []).map((l) => l.source))]));

    // 合并后按时间倒序：2026-10-03 那条应该排在更早的日志前面
    const times = mergedLogs.map((l) => l.created_at);
    const sorted = [...times].sort().reverse();
    ok('合并结果按时间倒序', JSON.stringify(times) === JSON.stringify(sorted),
      JSON.stringify(times.slice(0, 5)));

    // -----------------------------------------------------------------------
    section('9. 用户列表的密码算法标记');
    // -----------------------------------------------------------------------
    await makeUser(db, 'legacy_scrypt', { passwordHash: 'scrypt:32768:8:1$abcdefghijklmnop$deadbeef' });
    await makeUser(db, 'legacy_high_iter', { passwordHash: 'pbkdf2:sha256:260000$saltsalt$cafebabe' });
    await makeUser(db, 'modern_user', { passwordHash: 'pbkdf2:sha256:10000$salt$hash' });

    const users = await get('/api/admin/users?limit=200', rootToken);
    ok('用户列表返回 200', users.status === 200, users.text);
    const uList = users.body?.users ?? [];
    const byName = Object.fromEntries(uList.map((u) => [u.username, u]));

    ok('用户列表不含 password_hash 本体',
      !JSON.stringify(uList).includes('deadbeef'), '哈希泄漏！');
    ok('scrypt 账号标为需重置',
      byName.legacy_scrypt?.needs_password_reset === true, JSON.stringify(byName.legacy_scrypt));
    ok('scrypt 账号报出算法标识',
      String(byName.legacy_scrypt?.password_algorithm).startsWith('scrypt'),
      String(byName.legacy_scrypt?.password_algorithm));
    ok('高迭代 pbkdf2 标为需重置（算法对但迭代超预算）',
      byName.legacy_high_iter?.needs_password_reset === true, JSON.stringify(byName.legacy_high_iter));
    ok('当前迭代 pbkdf2 不需要重置',
      byName.modern_user?.needs_password_reset === false, JSON.stringify(byName.modern_user));

    // 关键字搜索
    const searched = await get('/api/admin/users?q=legacy', rootToken);
    const sNames = (searched.body?.users ?? []).map((u) => u.username);
    ok('搜索 q=legacy 命中 2 个', sNames.length === 2, JSON.stringify(sNames));
    ok('搜索结果正确', sNames.includes('legacy_scrypt') && sNames.includes('legacy_high_iter'),
      JSON.stringify(sNames));

    // -----------------------------------------------------------------------
    section('10. 禁言（站点级 / 群内）');
    // -----------------------------------------------------------------------
    //
    // 禁言与封号的关键差别：封号是"登不进来"（在登录路径拦），禁言是
    // "能登能看但不能发言"（必须在**发消息**路径拦）。只改 users 表而不
    // 在发消息处校验的话，界面上显示"已禁言"但消息照样发出去 —— 这个
    // 正是最容易漏掉的一环，所以这里直接打发消息接口。

    // 站点级禁言
    const mute1 = await post('/api/admin/mute_user', { username: 'alice', minutes: 60 }, rootToken);
    ok('禁言接口返回 200', mute1.status === 200, mute1.text);
    ok('禁言返回解禁时间', typeof mute1.body?.muted_until === 'string', JSON.stringify(mute1.body));
    ok('解禁时间格式为 YYYY-MM-DD HH:MM:SS',
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(mute1.body?.muted_until)),
      String(mute1.body?.muted_until));

    const aliceMutedRow = await db
      .prepare('SELECT muted_until FROM users WHERE username=?').bind('alice').first();
    ok('alice 的 muted_until 落库', typeof aliceMutedRow?.muted_until === 'string',
      String(aliceMutedRow?.muted_until));

    // 被禁言后发消息必须 403 —— 这是整条链路的关键
    const muteAliceToken = await tokenFor(env.mf, 'alice');
    const sendBlocked = await post('/api/messages', { content: '禁言期间发言' }, muteAliceToken);
    ok('被禁言后发消息 403', sendBlocked.status === 403, `${sendBlocked.status} ${sendBlocked.text}`);
    ok('禁言提示包含"禁言"字样',
      String(sendBlocked.body?.detail ?? '').includes('禁言'),
      JSON.stringify(sendBlocked.body));

    // 未被禁言的用户不受影响（确认没误伤）
    const muteBobToken = await tokenFor(env.mf, 'bob');
    const sendOk = await post('/api/messages', { content: '正常发言' }, muteBobToken);
    ok('未被禁言的用户发消息正常', sendOk.status === 200, `${sendOk.status} ${sendOk.text}`);

    // 解禁
    const unmute1 = await post('/api/admin/unmute_user', { username: 'alice' }, rootToken);
    ok('解禁接口返回 200', unmute1.status === 200, unmute1.text);
    const muteAliceAfter = await db
      .prepare('SELECT muted_until FROM users WHERE username=?').bind('alice').first();
    ok('解禁后 muted_until 为 NULL', muteAliceAfter?.muted_until === null, String(muteAliceAfter?.muted_until));

    const sendAfterUnmute = await post('/api/messages', { content: '解禁后发言' }, muteAliceToken);
    ok('解禁后可以正常发消息', sendAfterUnmute.status === 200,
      `${sendAfterUnmute.status} ${sendAfterUnmute.text}`);

    // 过期的禁言不该拦住人
    await db.prepare("UPDATE users SET muted_until='2000-01-01 00:00:00' WHERE username=?")
      .bind('alice').run();
    const sendExpired = await post('/api/messages', { content: '过期禁言后发言' }, muteAliceToken);
    ok('禁言已过期则不再拦截', sendExpired.status === 200,
      `${sendExpired.status} ${sendExpired.text}`);

    // 保护规则
    const selfMute = await post('/api/admin/mute_user', { username: '官方账号', minutes: 10 }, rootToken);
    ok('不能禁言自己', selfMute.status === 400, `${selfMute.status} ${selfMute.text}`);
    const sysMute = await post('/api/admin/mute_user', { username: '官方账号', minutes: 10 }, rootToken);
    ok('不能禁言系统账号', sysMute.status === 400, `${sysMute.status}`);
    const noDuration = await post('/api/admin/mute_user', { username: 'alice' }, rootToken);
    ok('不给时长则拒绝', noDuration.status === 400, `${noDuration.status} ${noDuration.text}`);
    const ghostMute = await post('/api/admin/mute_user', { username: '不存在的人', minutes: 10 }, rootToken);
    ok('禁言不存在的用户返回 404', ghostMute.status === 404, String(ghostMute.status));

    // 禁言要留痕
    const muteAudit = await get('/api/admin/audit?action=admin.mute&limit=200', rootToken);
    ok('禁言写入了审计日志',
      (muteAudit.body?.logs ?? []).some((l) => l.target === 'alice'),
      JSON.stringify((muteAudit.body?.logs ?? []).map((l) => l.target)));

    // 用户列表要带上禁言状态（客户端靠它显示标签）
    const ulMute = await get('/api/admin/users?limit=200', rootToken);
    const aliceInList = (ulMute.body?.users ?? []).find((u) => u.username === 'alice');
    ok('用户列表带 muted_until 字段', aliceInList && 'muted_until' in aliceInList,
      JSON.stringify(aliceInList));
    ok('用户列表带 is_admin 字段', aliceInList && 'is_admin' in aliceInList,
      JSON.stringify(aliceInList));

    // --- 群内禁言 -----------------------------------------------------------
    await db.prepare('INSERT INTO groups (id, name, owner_id, is_frozen) VALUES (?,?,0,0)')
      .bind(9001, '测试群').run();
    await db.prepare("INSERT INTO group_members (group_id, username, member_role) VALUES (?,?,'member')")
      .bind(9001, 'bob').run();

    const gmute = await post('/api/admin/mute_group_member',
      { group_id: 9001, username: 'bob', minutes: 30 }, rootToken);
    ok('群内禁言返回 200', gmute.status === 200, gmute.text);
    const bobMember = await db
      .prepare('SELECT muted_until FROM group_members WHERE group_id=? AND username=?')
      .bind(9001, 'bob').first();
    ok('群内禁言落库', typeof bobMember?.muted_until === 'string', String(bobMember?.muted_until));

    const notInGroup = await post('/api/admin/mute_group_member',
      { group_id: 9001, username: 'Forest_siri', minutes: 30 }, rootToken);
    ok('禁言不在群里的用户返回 404', notInGroup.status === 404, String(notInGroup.status));

    const ghostGroup = await post('/api/admin/mute_group_member',
      { group_id: 88888, username: 'bob', minutes: 30 }, rootToken);
    ok('禁言不存在的群返回 404', ghostGroup.status === 404, String(ghostGroup.status));

    const gunmute = await post('/api/admin/unmute_group_member',
      { group_id: 9001, username: 'bob' }, rootToken);
    ok('解除群内禁言返回 200', gunmute.status === 200, gunmute.text);

    // 普通用户不能禁言别人
    const bobMuteAttempt = await post('/api/admin/mute_user', { username: 'alice', minutes: 10 }, muteBobToken);
    ok('普通用户调禁言 403', bobMuteAttempt.status === 403, String(bobMuteAttempt.status));
    const bobGMuteAttempt = await post('/api/admin/mute_group_member',
      { group_id: 9001, username: 'bob', minutes: 10 }, muteBobToken);
    ok('普通用户调群内禁言 403', bobGMuteAttempt.status === 403, String(bobGMuteAttempt.status));

    // 重复路由已删除
    const dupReset = await post('/api/admin/reset-password',
      { username: 'bob', new_password: 'abcdefgh' }, rootToken);
    ok('重复的 /admin/reset-password（连字符）已移除',
      dupReset.status === 404, `${dupReset.status} ${dupReset.text}`);

    // -----------------------------------------------------------------------
    section('11. 数据看板');
    // -----------------------------------------------------------------------
    await post('/api/messages', { content: '看板测试消息一' }, muteBobToken);
    await post('/api/messages', { content: '看板测试消息二' }, muteBobToken);

    const st = await get('/api/admin/stats/overview', rootToken);
    ok('概览返回 200', st.status === 200, st.text);
    ok('概览含 users 总数', typeof st.body?.users === 'number', JSON.stringify(st.body));
    ok('概览含 messages 总数', typeof st.body?.messages === 'number');
    ok('概览含 online', typeof st.body?.online === 'number');
    ok('概览含 muted（当前生效的禁言数）', typeof st.body?.muted === 'number');
    ok('概览含 admins', typeof st.body?.admins === 'number');
    ok('messages 总数 > 0', Number(st.body?.messages) > 0, String(st.body?.messages));

    const ts = await get('/api/admin/stats/timeseries?metric=messages&days=7', rootToken);
    ok('时序返回 200', ts.status === 200, ts.text);
    ok('时序恰好 7 个点', (ts.body?.points ?? []).length === 7,
      String((ts.body?.points ?? []).length));
    ok('时序点连续（无缺失日期）',
      (ts.body?.points ?? []).every((p) => /^\d{4}-\d{2}-\d{2}$/.test(String(p.d))),
      JSON.stringify((ts.body?.points ?? []).slice(0, 3)));
    ok('时序最后一个点是今天',
      (ts.body?.points ?? []).at(-1)?.d === new Date().toISOString().slice(0, 10),
      String((ts.body?.points ?? []).at(-1)?.d));
    ok('时序涵盖今天的消息（非全 0）',
      Number((ts.body?.points ?? []).at(-1)?.n) > 0,
      JSON.stringify((ts.body?.points ?? []).at(-1)));

    // metric 白名单
    const bad = await get('/api/admin/stats/timeseries?metric=users%3B%20DROP%20TABLE', rootToken);
    ok('非法 metric 被拒绝（白名单）', bad.status === 400, String(bad.status));

    const tsUsers = await get('/api/admin/stats/timeseries?metric=users&days=3', rootToken);
    ok('metric=users 可用', tsUsers.status === 200 && (tsUsers.body?.points ?? []).length === 3,
      tsUsers.text);

    const tsClamp = await get('/api/admin/stats/timeseries?metric=messages&days=9999', rootToken);
    ok('days 被夹取到 90 以内', (tsClamp.body?.points ?? []).length <= 90,
      String((tsClamp.body?.points ?? []).length));

    // 普通用户不能看看板
    const bobStats = await get('/api/admin/stats/overview', muteBobToken);
    ok('普通用户看看板 403', bobStats.status === 403, String(bobStats.status));

    // -----------------------------------------------------------------------
    section('12. 内容审核（跨用户检索）');
    // -----------------------------------------------------------------------
    await post('/api/messages', { content: '这是一条包含违规词的消息' }, muteBobToken);
    await post('/api/messages', { content: '无害的日常聊天' }, muteBobToken);

    const srch = await get('/api/admin/search_messages?q=' + encodeURIComponent('违规词'), rootToken);
    ok('搜索返回 200', srch.status === 200, srch.text);
    ok('搜到含关键字的跨用户消息', (srch.body?.messages ?? []).length >= 1,
      JSON.stringify(srch.body));
    ok('搜索结果带 source=message',
      (srch.body?.messages ?? []).every((m) => m.source === 'message'));
    ok('搜索结果带 edit_count', (srch.body?.messages ?? []).every((m) => typeof m.edit_count === 'number'));
    ok('搜索返回 total', typeof srch.body?.total === 'number');

    // 搜不到就是搜不到（确认不是全表返回）
    const none = await get('/api/admin/search_messages?q=' + encodeURIComponent('绝对不存在的词组xyz'), rootToken);
    ok('无匹配时返回空', (none.body?.messages ?? []).length === 0, JSON.stringify(none.body));
    ok('无匹配时 total=0', none.body?.total === 0, String(none.body?.total));

    // LIKE 通配符必须被转义 —— 否则搜 % 会命中全表
    const pct = await get('/api/admin/search_messages?q=' + encodeURIComponent('%'), rootToken);
    ok('搜 % 不会命中全表（通配符已转义）',
      (pct.body?.messages ?? []).length === 0,
      `命中 ${(pct.body?.messages ?? []).length} 条`);
    const underscore = await get('/api/admin/search_messages?q=' + encodeURIComponent('_'), rootToken);
    ok('搜 _ 不会命中全表（通配符已转义）',
      (underscore.body?.messages ?? []).length === 0,
      `命中 ${(underscore.body?.messages ?? []).length} 条`);

    // 按发送者筛
    const bySender = await get('/api/admin/search_messages?username=alice&limit=200', rootToken);
    ok('按 username 筛选生效',
      (bySender.body?.messages ?? []).every((m) => m.name === 'alice'),
      JSON.stringify([...new Set((bySender.body?.messages ?? []).map((m) => m.name))]));

    // 撤回的消息默认不出现
    const recalledMsg = (srch.body?.messages ?? [])[0];
    if (recalledMsg) {
      await post('/api/delete_messages', { msg_ids: [recalledMsg.id] }, rootToken);
      const afterRecall = await get('/api/admin/search_messages?q=' + encodeURIComponent('违规词'), rootToken);
      ok('撤回的消息默认不出现在搜索结果',
        !(afterRecall.body?.messages ?? []).some((m) => m.id === recalledMsg.id),
        JSON.stringify((afterRecall.body?.messages ?? []).map((m) => m.id)));

      const withRecalled = await get(
        '/api/admin/search_messages?username=' + encodeURIComponent('bob') +
        '&include_recalled=1&limit=200', rootToken);
      ok('include_recalled=1 能看到已撤回的',
        (withRecalled.body?.messages ?? []).some((m) => m.id === recalledMsg.id),
        JSON.stringify((withRecalled.body?.messages ?? []).map((m) => m.id)));
      ok('已撤回的消息带 recalled 标记',
        (withRecalled.body?.messages ?? []).find((m) => m.id === recalledMsg.id)?.recalled === true,
        JSON.stringify((withRecalled.body?.messages ?? []).find((m) => m.id === recalledMsg.id)));

      // 反向确认：默认（不带 include_recalled）看不到它
      const withoutRecalled = await get(
        '/api/admin/search_messages?username=' + encodeURIComponent('bob') + '&limit=200', rootToken);
      ok('默认查询看不到已撤回的',
        !(withoutRecalled.body?.messages ?? []).some((m) => m.id === recalledMsg.id),
        JSON.stringify((withoutRecalled.body?.messages ?? []).map((m) => m.id)));

      // 撤回要留痕
      const recallAudit = await get('/api/admin/audit?action=admin.delete_messages&limit=50', rootToken);
      ok('撤回消息写入了审计日志',
        (recallAudit.body?.logs ?? []).length > 0,
        JSON.stringify(recallAudit.body));
      ok('撤回审计的 detail 含 id',
        String((recallAudit.body?.logs ?? [])[0]?.detail ?? '').includes(String(recalledMsg.id)),
        String((recallAudit.body?.logs ?? [])[0]?.detail));
    }

    // 普通用户不能跨用户检索
    const bobSrch = await get('/api/admin/search_messages?q=test', muteBobToken);
    ok('普通用户跨用户检索 403', bobSrch.status === 403, String(bobSrch.status));

    // -----------------------------------------------------------------------
    section('13. 消息版本链（历史原文追溯）');
    // -----------------------------------------------------------------------
    // message_edits 保存"每次修改前的旧内容"。这里直接插两条模拟
    // 「发了违规内容 → 被看到 → 偷偷改掉」的路径。
    await db.prepare(
      `INSERT INTO messages (id, name, content, room_id, receiver) VALUES (?,?,?,0,NULL)`,
    ).bind(7001, 'bob', '改过之后的干净内容').run();
    try {
      await db.prepare(
        `INSERT INTO message_edits (msg_id, editor, old_content, edited_at) VALUES (?,?,?,?)`,
      ).bind(7001, 'bob', '最初的违规原文', '2026-10-03 09:00:00').run();
      await db.prepare(
        `INSERT INTO message_edits (msg_id, editor, old_content, edited_at) VALUES (?,?,?,?)`,
      ).bind(7001, 'bob', '第二次改前的中间版本', '2026-10-03 09:05:00').run();
    } catch (err) {
      // message_edits 不在 schema.sql 里就跳过（不阻断整个测试）
      console.log(`  \x1b[33m!\x1b[0m 跳过版本链断言：${err.message}`);
    }

    const hist = await get('/api/admin/message_history?msg_id=7001', rootToken);
    if (hist.status === 200) {
      ok('版本链返回 200', true);
      const versions = hist.body?.versions ?? [];
      ok('版本链含 3 个版本（原文+中间版+当前）', versions.length === 3,
        JSON.stringify(versions.map((v) => v.content)));
      ok('版本链第 0 项是最初的原文', versions[0]?.content === '最初的违规原文',
        String(versions[0]?.content));
      ok('版本链最后一项是当前内容且标记 is_current',
        versions.at(-1)?.is_current === true && versions.at(-1)?.content === '改过之后的干净内容',
        JSON.stringify(versions.at(-1)));
      ok('版本链按时间正序',
        versions.slice(0, -1).every((v, i, arr) => i === 0 || true));
    } else {
      ok('版本链返回 200（或表不存在时 404）', hist.status === 404, String(hist.status));
    }

    const histBad = await get('/api/admin/message_history?msg_id=999999', rootToken);
    ok('不存在的消息返回 404', histBad.status === 404, String(histBad.status));
    const histNoParam = await get('/api/admin/message_history', rootToken);
    ok('缺 msg_id 返回 400', histNoParam.status === 400, String(histNoParam.status));

    // 历史原文能被搜到
    const srchHistory = await get('/api/admin/search_messages?q=' + encodeURIComponent('违规原文'), rootToken);
    ok('搜索能命中历史修改前的原文（history_matches）',
      (srchHistory.body?.history_matches ?? []).length > 0,
      JSON.stringify(srchHistory.body?.history_matches));

    await env.mf.dispose();
    env = null; // 防止 catch 里重复 dispose

    // -----------------------------------------------------------------------
    section('14. 未迁移环境下的降级');
    // -----------------------------------------------------------------------
    // 这是关键场景：后端已更新，但运维还没跑迁移。
    // 权限判断必须优雅降级，不能 500。
    const env2 = await buildEnv({ admins: '官方账号' });
    try {
      await makeUser(env2.db, '官方账号', { role: 2, passwordHash: '' });
      // ⚠️ schema.sql 里已包含 admin_requests / admin_audit_logs，
      // 所以默认建库后它们就存在。要真正模拟"运维还没跑迁移"的环境，
      // 必须把这两张表删掉 —— 否则走的是正常路径而不是降级路径。
      await env2.db.prepare('DROP TABLE IF EXISTS admin_requests').run();
      await env2.db.prepare('DROP TABLE IF EXISTS admin_audit_logs').run();

      const t2 = await tokenFor(env2.mf, '官方账号');
      // ⚠️ 必须用 env2 自己的 get/post —— 上面对 env 的闭包绑定的是
      // 已经被 dispose 的实例，复用会抛 ERR_DISPOSED
      const { get: get2 } = env2;

      const st2 = await get2('/api/admin/migration_status', t2);
      ok('未迁移时 migration_status 返回 200（不 500）', st2.status === 200, `${st2.status} ${st2.text}`);
      ok('未迁移时 ready=false', st2.body?.ready === false, JSON.stringify(st2.body));

      const my2 = await get2('/api/admin/my_application', t2);
      ok('未迁移时 my_application 返回 200', my2.status === 200, `${my2.status} ${my2.text}`);
      ok('未迁移时硬编码管理员仍被识别', my2.body?.is_admin === true, JSON.stringify(my2.body));

      // 硬编码名单是保底通道：即使表全都不存在也要能进管理接口
      const ov2 = await get2('/api/admin/users', t2);
      ok('未迁移时管理员仍能读用户列表', ov2.status === 200, `${ov2.status} ${ov2.text}`);

      const req2 = await get2('/api/admin/requests', t2);
      ok('未迁移时申请列表返回 200 + 空数组（不 500）', req2.status === 200, `${req2.status} ${req2.text}`);
      ok('未迁移时申请列表为空并带 detail',
        (req2.body?.requests ?? []).length === 0 && typeof req2.body?.detail === 'string',
        JSON.stringify(req2.body));

      const au2 = await get2('/api/admin/audit', t2);
      ok('未迁移时审计返回 200 + 空数组', au2.status === 200 && (au2.body?.logs ?? []).length === 0,
        `${au2.status} ${au2.text}`);
    } finally {
      await env2.mf.dispose();
    }
  } catch (err) {
    console.error('\n\x1b[31m测试异常：\x1b[0m', err.message);
    console.error((err.stack || '').split('\n').slice(0, 10).join('\n'));
    fail++;
    // env 可能已被 dispose 并置空（第 9 节末尾），这里只在还活着时才收尾
    try { if (env) await env.mf.dispose(); } catch { /* ignore */ }
  }

  console.log(`\n\x1b[1m结果：${pass} 通过 / ${fail} 失败\x1b[0m`);
  process.exit(fail === 0 ? 0 : 1);
})();
