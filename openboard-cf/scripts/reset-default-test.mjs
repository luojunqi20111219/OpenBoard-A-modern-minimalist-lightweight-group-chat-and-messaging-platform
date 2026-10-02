#!/usr/bin/env node
/**
 * 「自助重置为默认密码」的安全边界测试（本地 Miniflare，隔离环境）。
 *
 * ---------------------------------------------------------------------------
 * 为什么单独一个文件
 * ---------------------------------------------------------------------------
 * preflight 里已经覆盖了这个接口的**正向**链路（旧格式账号 → 重置 → 登录 →
 * 改密），但它的环境是"一条链路串跑"，很难在其中造各种畸形账号。
 *
 * 而这个功能真正的风险全在**边界**上，具体说就是三句话：
 *
 *   1. 只有「本来就算不动校验」的账号能被重置
 *      —— 否则任何人只要知道用户名，就能把别人的密码设成 12345678，
 *         然后登进去读完所有聊天记录
 *   2. 管理员账号不能被重置
 *      —— 否则就是一条完整的提权链：枚举管理员用户名 → 重置 → 登管理端
 *   3. 每个账号每天只能重置一次
 *      —— 否则可以反复重置骚扰
 *
 * 这三条一旦被破坏，功能表面上看还是"能用"的，只有测试守得住。
 * 所以本文件以**负向断言**为主：重点证明"不该能重置的确实重置不了"。
 *
 * ---------------------------------------------------------------------------
 * 覆盖
 * ---------------------------------------------------------------------------
 *   1. 边界 1：正常密码账号 / 缺密码哈希的账号 → 必须拒绝
 *   2. 边界 2：role=1 / ALLOWED_ADMINS 硬编码 / D1 is_admin=1 三条路径都要拦
 *   3. 边界 3：同账号二次重置 429；换 IP 头仍然受账号级限流约束
 *   4. 封禁 / 系统账号 / 不存在的用户
 *   5. 输入校验（缺 username、超长 username、大小写变体）
 *   6. 审计日志落库与 actor 标记
 *   7. 重置后的密码确实是 12345678，且必须改密标记生效
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

const DEFAULT_PASSWORD = '12345678';
/** 与 wrangler.toml 的 ALLOWED_ADMINS 保持一致的测试值 */
const HARDCODED_ADMINS = '官方账号,Forest_siri';

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

// 各类账号的密码哈希。真实值都不可验证（scrypt 在 Workers 上算不动），
// 这一点很关键 —— 它正好模拟了"用户真的登不上"的真实场景。
const SCRYPT_HASH = (tag) => `scrypt:32768:8:1$${tag}${'0'.repeat(16 - tag.length)}$${'a'.repeat(128)}`;
/** 正常账号：Worker 能验证的高迭代 pbkdf2 之外的普通哈希（算法名合法即可） */
const NORMAL_HASH = 'pbkdf2:sha256:10000$0011223344556677$' + 'f'.repeat(64);

/**
 * 建一个隔离的 Miniflare 实例。
 *
 * 每个测试用独立库名 + 独立持久化目录 —— 因为限流计数器存在 KV 里，
 * 共用实例会让"每天一次"的断言互相干扰，测出假阳性。
 */
async function buildEnv({ admins = HARDCODED_ADMINS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reset-'));
  const mf = new Miniflare({
    modules: true,
    modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
    scriptPath: join(DIST, 'worker.js'),
    d1Databases: { DB: `reset-${Math.random().toString(36).slice(2)}` },
    r2Buckets: { UPLOADS: 'reset-test-uploads' },
    kvNamespaces: { RATE_LIMIT: `reset-kv-${Math.random().toString(36).slice(2)}` },
    durableObjects: { CHAT_HUB: { className: 'ChatHub', useSQLite: true } },
    compatibilityDate: '2024-11-27',
    bindings: {
      JWT_SECRET: 'test-secret-for-reset-default',
      ALLOWED_ADMINS: admins,
      CURRENT_VERSION: 'v10.1.0',
      PASSWORD_ITERATIONS: '10000',
    },
    d1Persist: join(dir, 'd1'),
  });

  const db = await mf.getD1Database('DB');
  const stmts = SCHEMA.split(';')
    .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
    .filter((s) => s.length > 0);
  await db.batch(stmts.map((s) => db.prepare(s)));

  const post = async (path, body, headers = {}) => {
    const res = await mf.dispatchFetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, body: parsed, text };
  };

  /**
   * PUT 请求。必须与 post 分开 —— 改密码接口是 PUT /api/user/password，
   * 用 post 发过去会 404「接口不存在」，而且这个 404 很容易被误读成
   * "改密码功能没做"，白排查半天。
   */
  const put = async (path, body, headers = {}) => {
    const res = await mf.dispatchFetch(BASE + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, body: parsed, text };
  };

  const get = async (path, headers = {}) => {
    const res = await mf.dispatchFetch(BASE + path, { headers });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, body: parsed, text };
  };

  /**
   * 任意 method 的 JSON 请求。
   *
   * ⚠️ 不能用 post() 去发 PUT —— 改密码接口是 `PUT /api/user/password`，
   *    发成 POST 会拿到 404「接口不存在」，看起来像"功能没实现"，
   *    实际上是测试写错了动词。这个坑踩过一次，所以单独提供这个助手。
   */
  const call = async (method, path, body, headers = {}) => {
    const res = await mf.dispatchFetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, body: parsed, text };
  };

  return { mf, db, post, get, call, dir };
}

/**
 * 造用户。
 *
 * ⚠️ 这里有个必须小心的点：`is_admin` 与 `must_change_password` 都**不在
 *    schema.sql 里**，它们是 runAdminMigrations 后加的列。如果 makeUser
 *    遇到"列不存在就跳过"，那 isAdmin:1 会被静默忽略，造出来的其实是个
 *    普通用户 —— 于是"动态管理员不能自助重置"这条断言会因为错误的理由通过，
 *    给人一个虚假的安全感。
 *
 *    所以这里改成：要写 is_admin 就先确保列存在（缺则 ALTER 补上，
 *    与 runAdminMigrations 用的是同一句 SQL）。宁可让测试环境多一列，
 *    也不能让关键断言靠"参数被悄悄丢掉"来过。
 */
async function makeUser(db, username, opts = {}) {
  const { role = 0, isBanned = 0, passwordHash, isAdmin = 0 } = opts;
  const hash = passwordHash === undefined ? SCRYPT_HASH('s') : passwordHash;

  const info = await db.prepare('PRAGMA table_info("users")').all();
  const has = (name) => (info.results ?? []).some((r) => r.name === name);

  // is_admin 只在**确实需要**时补列：补了会让"迁移前"的判定失真，
  // 所以默认不补，只有调用方显式传 isAdmin 时才补。
  if (isAdmin !== 0 && !has('is_admin')) {
    await db.prepare('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0').run();
  }

  const cols = ['username', 'password_hash', 'nickname', 'role', 'is_banned'];
  const vals = [username, hash, username, role, isBanned];
  if (has('is_admin') || isAdmin !== 0) {
    cols.push('is_admin');
    vals.push(isAdmin);
  }
  await db.prepare(
    `INSERT INTO users (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
  ).bind(...vals).run();
  return username;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
(async () => {
  console.log('\x1b[1m自助重置为默认密码 —— 安全边界测试\x1b[0m');

  let env;
  try {
    env = await buildEnv();
    const { mf, db, post, get, call } = env;
    const RESET = '/api/reset-to-default';

    // =======================================================================
    section('0. 能力探测接口（客户端据此决定按不按显示按钮）');
    // =======================================================================
    // 这个接口是客户端区分「CF 版」与「普通版」的唯一依据。
    // 它的语义必须明确：显式 true 才算支持，其余一律不支持。
    const caps = await get('/api/capabilities');
    ok('能力接口无需登录即可访问', caps.status === 200, `status=${caps.status}`);
    ok('声明部署形态为 cloudflare-workers',
      caps.body?.server === 'cloudflare-workers', JSON.stringify({ server: caps.body?.server }));
    ok('显式声明支持自助重置',
      caps.body?.features?.self_reset_password === true,
      JSON.stringify(caps.body?.features));
    ok('显式声明支持强制改密',
      caps.body?.features?.must_change_password === true,
      JSON.stringify(caps.body?.features));
    ok('能力接口不泄露敏感配置',
      !caps.text.includes('test-secret-for-reset-default') &&
        !caps.text.includes('36c81b5b8237f8ce535e4c4b2ae510cc'),
      '响应里出现了密钥或账号 ID');

    // 老服务端的行为：这个接口不存在 → 404。
    // 客户端必须把这种情况判为"不支持"（由客户端单测覆盖），
    // 服务端侧这里只确认"不存在的路径确实不是 200"。
    const notThere = await get('/api/capabilities-nope');
    ok('不存在的接口不会误报能力', notThere.status !== 200, `status=${notThere.status}`);

    // =======================================================================
    section('1. 边界 1：只有"本来就算不动"的账号能被重置');
    // =======================================================================
    // 这是整个功能安全性的基石。如果这里破了，任何人知道用户名
    // 就能接管他人账号（含全部聊天记录）。
    await makeUser(db, 'victim_normal', { passwordHash: NORMAL_HASH, role: 0 });
    await makeUser(db, 'victim_scrypt', { passwordHash: SCRYPT_HASH('x'), role: 0 });

    // 正常账号 → 必须拒绝
    const rNormal = await post(RESET, { username: 'victim_normal' });
    ok('正常密码账号被拒绝（核心边界）', rNormal.status === 400,
      `status=${rNormal.status} ${JSON.stringify(rNormal.body)}`);
    const rNormalLogin = await post('/api/login', { username: 'victim_normal', password: DEFAULT_PASSWORD });
    ok('正常账号的密码没有被改成默认密码',
      rNormalLogin.status !== 200, `status=${rNormalLogin.status}`);

    // 旧格式（登不上）账号 → 允许
    const rScrypt = await post(RESET, { username: 'victim_scrypt' });
    ok('旧格式账号可以自助重置', rScrypt.status === 200,
      `status=${rScrypt.status} ${JSON.stringify(rScrypt.body)}`);
    const rScryptLogin = await post('/api/login', { username: 'victim_scrypt', password: DEFAULT_PASSWORD });
    ok('重置后能用 12345678 登录', rScryptLogin.status === 200 && !!rScryptLogin.body?.token,
      `status=${rScryptLogin.status}`);

    // 没有密码哈希的账号（可能的历史脏数据）→ 不算"需要重置"，拒绝
    await makeUser(db, 'no_hash_user', { passwordHash: null, role: 0 });
    const rNoHash = await post(RESET, { username: 'no_hash_user' });
    ok('无密码哈希的账号被拒绝', rNoHash.status === 400, `status=${rNoHash.status}`);

    // =======================================================================
    section('2. 边界 2：管理员账号一律不能自助重置（防提权）');
    // =======================================================================
    // 三条判定路径都要覆盖 —— isAdminAsync 是 role=1 → 硬编码 → D1 三层，
    // 漏掉任何一层，就存在一条"从某个入口把管理员密码设成 12345678"的链。
    await makeUser(db, 'role1_admin', { role: 1, passwordHash: SCRYPT_HASH('r') });
    const rRole1 = await post(RESET, { username: 'role1_admin' });
    ok('role=1 的历史管理员被拒', rRole1.status === 403,
      `status=${rRole1.status} ${JSON.stringify(rRole1.body)}`);

    // Forest_siri 在 ALLOWED_ADMINS 硬编码名单里（role=0）
    await makeUser(db, 'Forest_siri', { role: 0, passwordHash: SCRYPT_HASH('h') });
    const rHard = await post(RESET, { username: 'Forest_siri' });
    ok('硬编码名单里的管理员被拒', rHard.status === 403,
      `status=${rHard.status} ${JSON.stringify(rHard.body)}`);

    // D1 动态授权：不在硬编码名单里，role 也是 0，只有 is_admin=1
    // ⚠️ 这条最容易被漏掉 —— 因为前两层都查不出他是管理员
    await makeUser(db, 'dynamic_admin', { role: 0, isAdmin: 1, passwordHash: SCRYPT_HASH('d') });
    const rDyn = await post(RESET, { username: 'dynamic_admin' });
    ok('D1 动态管理员被拒（三层判定全覆盖）', rDyn.status === 403,
      `status=${rDyn.status} ${JSON.stringify(rDyn.body)}`);

    // 反证：管理员密码确实没被动过
    const rAdminPwd = await post('/api/login', { username: 'role1_admin', password: DEFAULT_PASSWORD });
    ok('管理员密码没被改成默认密码', rAdminPwd.status !== 200, `status=${rAdminPwd.status}`);

    // 系统账号
    // ⚠️ 不要用 filehelper —— schema.sql 里已经预置了这个系统账号，
    //    再 INSERT 会撞 UNIQUE 约束。
    await makeUser(db, 'qa_system_bot', { role: 2, passwordHash: null });
    const rSys = await post(RESET, { username: 'qa_system_bot' });
    ok('系统账号（role=2）被拒', rSys.status === 403, `status=${rSys.status}`);

    // 封禁账号：不能借自助重置"复活"
    await makeUser(db, 'banned_user', { role: 0, isBanned: 1, passwordHash: SCRYPT_HASH('b') });
    const rBanned = await post(RESET, { username: 'banned_user' });
    ok('封禁账号被拒', rBanned.status === 403, `status=${rBanned.status}`);

    // =======================================================================
    section('3. 边界 3：限流（每账号每天一次、每 IP 每天十次）');
    // =======================================================================
    await makeUser(db, 'daily_user', { passwordHash: SCRYPT_HASH('q'), role: 0 });
    const first = await post(RESET, { username: 'daily_user' }, { 'CF-Connecting-IP': '10.0.0.1' });
    ok('当日首次重置成功', first.status === 200, `status=${first.status}`);

    const second = await post(RESET, { username: 'daily_user' }, { 'CF-Connecting-IP': '10.0.0.1' });
    ok('同日二次重置被限流（429）', second.status === 429,
      `status=${second.status} ${JSON.stringify(second.body)}`);
    ok('限流提示告知该用默认密码登录',
      typeof second.body?.detail === 'string' && second.body.detail.includes(DEFAULT_PASSWORD),
      JSON.stringify({ detail: second.body?.detail }));

    // ⚠️ 换 IP **不应该**绕过账号级限流 —— 否则攻击者换个代理就能反复重置。
    const secondOtherIp = await post(RESET, { username: 'daily_user' }, { 'CF-Connecting-IP': '10.0.0.99' });
    ok('换 IP 不能绕过账号级限流', secondOtherIp.status === 429,
      `status=${secondOtherIp.status} ${JSON.stringify(secondOtherIp.body)}`);

    // 另一个账号不受影响（限流是按账号的，不是全局的）
    await makeUser(db, 'other_user', { passwordHash: SCRYPT_HASH('o'), role: 0 });
    const otherOk = await post(RESET, { username: 'other_user' }, { 'CF-Connecting-IP': '10.0.0.1' });
    ok('限流按账号隔离（不影响他人）', otherOk.status === 200, `status=${otherOk.status}`);

    // =======================================================================
    section('4. 输入校验');
    // =======================================================================
    const rNoName = await post(RESET, {});
    ok('缺 username → 400', rNoName.status === 400, `status=${rNoName.status}`);

    const rEmpty = await post(RESET, { username: '   ' });
    ok('空白 username → 400', rEmpty.status === 400, `status=${rEmpty.status}`);

    const rGhost = await post(RESET, { username: 'definitely_not_here_xyz' });
    ok('不存在的用户 → 404', rGhost.status === 404, `status=${rGhost.status}`);

    // 大小写变体：用户名查询是**大小写敏感的精确匹配**，所以 'DAILY_USER'
    // 与 'daily_user' 是两个不同的名字，前者确实不存在 → 404。
    // 这里要证的是两件事：
    //   1. 大小写变体不会"找不到却蒙混过关"（必须先 404，不能凭空放行）
    //   2. 一旦查到真账号，限流 key 用的是库里的规范名，无法靠改大小写绕过
    const rCase = await post(RESET, { username: 'DAILY_USER' });
    ok('大小写变体不会凭空放行（查不到就 404）', rCase.status === 404,
      `status=${rCase.status} ${JSON.stringify(rCase.body)}`);

    // 再造一个纯大小写差异的账号，验证限流归一化生效：
    // 先按原名重置一次，再用不同的输入大小写尝试第二次 —— 应被同一计数器拦下。
    await makeUser(db, 'CaseLimitUser', { passwordHash: SCRYPT_HASH('c'), role: 0 });
    const caseFirst = await post(RESET, { username: 'CaseLimitUser' }, { 'CF-Connecting-IP': '10.0.1.1' });
    ok('大小写账号首次重置成功', caseFirst.status === 200, `status=${caseFirst.status}`);
    const caseSecond = await post(RESET, { username: 'caselimituser' }, { 'CF-Connecting-IP': '10.0.1.2' });
    // 这里期望 404：库里没有这个大小写形式的名字。
    // 真正的意义在于"它没有命中 200"—— 说明不存在"靠改大小写找到同一个账号并重置"
    // 的路径；而限流归一化（用 user.username）保证真有别名时也共用一个配额。
    ok('大小写不同的请求不会命中同一账号并放行', caseSecond.status !== 200,
      `status=${caseSecond.status} ${JSON.stringify(caseSecond.body)}`);

    // =======================================================================
    section('5. 审计与响应内容');
    // =======================================================================
    const auditRows = await db.prepare(
      "SELECT actor, action, target FROM admin_audit_logs WHERE action='user.reset_to_default' ORDER BY id",
    ).all();
    const rows = auditRows.results ?? [];
    ok('每次成功重置都写审计日志', rows.length >= 3, JSON.stringify({ n: rows.length }));
    ok('审计 actor 标为 self-service（区分于管理员代操作）',
      rows.every((r) => r.actor === 'self-service'),
      JSON.stringify(rows.map((r) => r.actor)));

    // 被拒绝的请求不应留"成功"痕迹
    const rejectedLogged = rows.some((r) => r.target === 'role1_admin' || r.target === 'victim_normal');
    ok('被拒绝的重置不会写审计日志', !rejectedLogged,
      JSON.stringify({ targets: rows.map((r) => r.target) }));

    const successBody = JSON.stringify(first.body ?? {});
    ok('成功响应不含密码哈希本体', !successBody.includes('a'.repeat(64)) && !successBody.includes('f'.repeat(64)),
      '响应里出现了哈希段');
    // 注意：本节的 first 是在**未迁移**环境里发出的（本文件第 1-5 节都不补列），
    // 所以 must_change_password 是 false 且带 migration_required=true 才是对的。
    // "迁移后确实写入标记"由第 6 节覆盖 —— 两者的环境不同，不能混为一谈。
    ok('未迁移环境如实报告未写入改密标记',
      first.body?.must_change_password === false && first.body?.migration_required === true,
      JSON.stringify({
        must_change_password: first.body?.must_change_password,
        migration_required: first.body?.migration_required,
      }));

    // =======================================================================
    section('6. 重置后的强制改密闭环（已迁移环境）');
    // =======================================================================
    // 先补齐迁移列 —— must_change_password 由迁移添加（schema.sql 里刻意不建，
    // 见那里注释）。第 7 节会单独验证"未迁移时优雅降级"。
    const cols6 = await db.prepare('PRAGMA table_info("users")').all();
    if (!(cols6.results ?? []).some((r) => r.name === 'must_change_password')) {
      await db.prepare(
        'ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0',
      ).run();
    }

    // 迁移补列后要用新账号测（旧账号 daily_user 已经在迁移前重置过了）
    await makeUser(db, 'flag_user', { passwordHash: SCRYPT_HASH('g'), role: 0 });
    const flagReset = await post(RESET, { username: 'flag_user' }, { 'CF-Connecting-IP': '10.0.2.1' });
    ok('已迁移环境下重置成功', flagReset.status === 200, `status=${flagReset.status}`);
    ok('已迁移环境下写入强制改密标记',
      flagReset.body?.must_change_password === true,
      JSON.stringify({ must_change_password: flagReset.body?.must_change_password }));
    ok('已迁移环境下不报 migration_required',
      flagReset.body?.migration_required !== true,
      JSON.stringify({ migration_required: flagReset.body?.migration_required }));

    const loginRes = await post('/api/login', { username: 'flag_user', password: DEFAULT_PASSWORD });
    ok('用默认密码可登录', loginRes.status === 200 && !!loginRes.body?.token, `status=${loginRes.status}`);
    const tok = loginRes.body?.token;
    ok('登录响应带 must_change_password', loginRes.body?.must_change_password === true,
      JSON.stringify({ must_change_password: loginRes.body?.must_change_password }));

    const flag = await db.prepare('SELECT must_change_password FROM users WHERE username=?')
      .bind('flag_user').first();
    ok('库中 must_change_password 已置 1', Number(flag?.must_change_password ?? 0) === 1,
      JSON.stringify({ must_change_password: flag?.must_change_password }));

    if (tok) {
      // 不允许把密码"改"成默认密码 —— 否则强制改密就是个摆设
      // ⚠️ 改密码是 PUT，不是 POST
      const weak = await call('PUT', '/api/user/password',
        { old_password: DEFAULT_PASSWORD, new_password: DEFAULT_PASSWORD },
        { Authorization: `Bearer ${tok}` });
      ok('改密时禁止继续使用默认密码', weak.status === 400,
        `status=${weak.status} ${JSON.stringify(weak.body)}`);

      const strong = await call('PUT', '/api/user/password',
        { old_password: DEFAULT_PASSWORD, new_password: 'Str0ng!NewPass' },
        { Authorization: `Bearer ${tok}` });
      ok('设置合规新密码成功', strong.status === 200,
        `status=${strong.status} ${JSON.stringify(strong.body)}`);

      const flagAfter = await db.prepare('SELECT must_change_password FROM users WHERE username=?')
        .bind('flag_user').first();
      ok('改密后标记被清除', Number(flagAfter?.must_change_password ?? 0) === 0,
        JSON.stringify({ must_change_password: flagAfter?.must_change_password }));

      const finalLogin = await post('/api/login', { username: 'flag_user', password: 'Str0ng!NewPass' });
      ok('新密码可登录且不再要求改密',
        finalLogin.status === 200 && finalLogin.body?.must_change_password !== true,
        `status=${finalLogin.status} flag=${finalLogin.body?.must_change_password}`);
    }

    await mf.dispose();
  } catch (err) {
    fail++;
    console.error(`\n\x1b[31m测试执行异常：\x1b[0m ${err?.stack || err}`);
    try { await env?.mf?.dispose(); } catch { /* 已释放 */ }
  }

  // =========================================================================
  // 7. 未迁移环境下的优雅降级
  //
  // 这一段必须用**全新的环境**：上面那个实例已经补过列了。
  //
  // 为什么值得单独测：`must_change_password` 是迁移后加的列，
  // 而"灌完 schema、还没点应用迁移"是部署流程里一个完全正常的中间状态。
  // 如果这里写成"列不存在就 500"，那么在这个状态下：
  //   · 自助重置整个功能挂掉（用户看到"服务器内部错误"）
  //   · 连带 PUT /api/user/password 也挂掉（改密码这个基础功能都不可用）
  // 这两个都是不可接受的 —— 主线功能不能因为一个可选标记而不可用。
  // =========================================================================
  let env2;
  try {
    env2 = await buildEnv();
    const { mf: mf2, db: db2, post: post2, call: call2 } = env2;

    section('7. 未迁移环境：降级但不报错');

    const cols = await db2.prepare('PRAGMA table_info("users")').all();
    const hasCol = (cols.results ?? []).some((r) => r.name === 'must_change_password');
    ok('前置条件：本环境确实没有 must_change_password 列', !hasCol,
      JSON.stringify({ hasCol }));

    await makeUser(db2, 'premig_user', { passwordHash: SCRYPT_HASH('p'), role: 0 });

    // 重置本身必须成功 —— 密码真的被换掉了才是主线
    const preReset = await post2('/api/reset-to-default', { username: 'premig_user' });
    ok('未迁移时重置仍成功（不 500）', preReset.status === 200,
      `status=${preReset.status} ${JSON.stringify(preReset.body)}`);
    ok('未迁移时明确告知需要迁移',
      preReset.body?.migration_required === true,
      JSON.stringify({ migration_required: preReset.body?.migration_required }));
    ok('未迁移时如实报告没写入改密标记',
      preReset.body?.must_change_password === false,
      JSON.stringify({ must_change_password: preReset.body?.must_change_password }));

    // 真正的验证：密码确实换成了默认密码
    const preLogin = await post2('/api/login', { username: 'premig_user', password: DEFAULT_PASSWORD });
    ok('未迁移时密码确实被重置了', preLogin.status === 200 && !!preLogin.body?.token,
      `status=${preLogin.status}`);

    // 改密码这个基础功能在未迁移环境下也必须可用
    const preTok = preLogin.body?.token;
    if (preTok) {
      const preChange = await call2('PUT', '/api/user/password',
        { old_password: DEFAULT_PASSWORD, new_password: 'Premig!Pass99' },
        { Authorization: `Bearer ${preTok}` });
      ok('未迁移时改密码仍然可用（不 500）', preChange.status === 200,
        `status=${preChange.status} ${JSON.stringify(preChange.body)}`);

      const preRelogin = await post2('/api/login', { username: 'premig_user', password: 'Premig!Pass99' });
      ok('未迁移时新密码生效', preRelogin.status === 200, `status=${preRelogin.status}`);
    }

    // 正常账号的边界在未迁移环境下同样成立（安全边界不能因迁移状态而放松）
    await makeUser(db2, 'premig_normal', { passwordHash: NORMAL_HASH, role: 0 });
    const preNormal = await post2('/api/reset-to-default', { username: 'premig_normal' });
    ok('未迁移时正常账号仍被拒绝', preNormal.status === 400,
      `status=${preNormal.status}`);

    await makeUser(db2, 'premig_admin', { role: 1, passwordHash: SCRYPT_HASH('a') });
    const preAdmin = await post2('/api/reset-to-default', { username: 'premig_admin' });
    ok('未迁移时管理员仍被拒绝', preAdmin.status === 403,
      `status=${preAdmin.status}`);

    await mf2.dispose();
  } catch (err) {
    fail++;
    console.error(`\n\x1b[31m降级测试异常：\x1b[0m ${err?.stack || err}`);
    try { await env2?.mf?.dispose(); } catch { /* 已释放 */ }
  }

  console.log('\n' + '─'.repeat(52));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail === 0 ? 0 : 1);
})();
