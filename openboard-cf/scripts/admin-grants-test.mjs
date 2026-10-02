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

    await env.mf.dispose();
    env = null; // 防止 catch 里重复 dispose

    // -----------------------------------------------------------------------
    section('10. 未迁移环境下的降级');
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
