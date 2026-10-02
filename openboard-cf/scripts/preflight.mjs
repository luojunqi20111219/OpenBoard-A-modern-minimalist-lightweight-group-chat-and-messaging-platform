/**
 * 部署前自检 —— 在本地 Miniflare 里跑完整链路，不创建任何云端资源。
 *
 *   npm run preflight
 *
 * 流程：先把 schema.sql 灌进一个干净的临时 D1，再用 Miniflare 起 Worker，
 *       跑一遍关键链路，最后删掉临时状态。不会碰 .wrangler 里的开发数据。
 *
 * 覆盖：健康检查 / 安全头 / 注册登录会话 / 发消息幂等 / 编辑撤回 /
 *       R2 上传 + 免鉴权直链 + 路径穿越 + 上传白名单 / 群聊 /
 *       WebSocket 跨连接广播 / KV 登录限流。
 */
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SCHEMA = readFileSync(join(ROOT, 'schema.sql'), 'utf8');

// 用 Miniflare 自己维护的临时状态目录：不写 d1Persist 等就落在系统 temp，
// 每次启动都是干净库，且跑完不留痕（进程退出即被系统清理）。
//
// SQL_WASM 对应 wrangler.toml 的 [wasm_modules] 绑定（SQLite 解析用），
// 本地测试需手动喂同一个文件，否则导入功能会报「未配置绑定」。
const DIST = join(ROOT, 'dist');
const mf = new Miniflare({
  scriptPath: join(DIST, 'worker.js'),
  modules: true,
  // 与 wrangler.toml 的 [[rules]] 对齐：让 Miniflare 认识 .wasm 模块
  modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
  compatibilityDate: '2024-11-27',
  d1Databases: { DB: 'preflight-db' },
  r2Buckets: { UPLOADS: 'openboard-uploads' },
  kvNamespaces: { RATE_LIMIT: 'preflight-kv' },
  durableObjects: { CHAT_HUB: { className: 'ChatHub', useSQLite: true } },
  bindings: {
    CURRENT_VERSION: 'v10.1.0',
    PUBLIC_UPLOADS: 'true',
    ALLOWED_ADMINS: '官方账号,Forest_siri,Forest_Brian_Birch',
    MAX_CONNECTIONS_PER_USER: '4',
    // ⚠️ 必须显式钉住迭代数，不能靠 wrangler.toml 或生产默认值：
    //
    //    - wrangler.toml 里 PASSWORD_ITERATIONS = ""（空串），parseInt 得到
    //      NaN，代码会回退到 210000（生产强度，为了抗暴力破解）。
    //      210000 次 pbkdf2 在本地 Miniflare 单线程下要跑好几秒，
    //      「重置 → 登录 → 改密」这条链路一跑就是十几秒，还会拖慢整个套件。
    //    - 所以自检故意用 10000：它验证的是**逻辑**（能验通、标记正确、
    //      限流生效），密码强度本身不在自检范围内，那是生产配置的事。
    //
    //    这与 reset-default-test / import-test 的取值保持一致。
    PASSWORD_ITERATIONS: '10000',
    JWT_SECRET: 'preflight-secret-not-for-production',
  },
});

// --- 灌入表结构 --------------------------------------------------------------
//
// 注意这里暂时**不应用迁移**：req / kv 等辅助还在下面定义，函数必须先定义再调用。
// 真正的「灌 schema + 应用迁移」放在本文件辅助函数齐备之后统一执行（见下方
// initDatabase()）。schema.sql 的灌库本身不依赖任何辅助，所以留在这里。

const BASE = 'http://localhost';
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
};
const section = (t) => console.log(`\n${t}`);

const req = (path, init) => {
  // ⚠️ miniflare 4 与 3 的差异：用 FormData 作 body 时，miniflare 4
  //    不会自动推导 multipart/form-data 的 Content-Type 与 boundary。
  //    直接 dispatchFetch 会让服务端 request.formData() 报
  //    "Unrecognized Content-Type header value"。
  //
  //    解法：用 Request 构造一次以生成正确的 Content-Type（含 boundary），
  //    但 dispatchFetch 只收字符串 URL，所以把生成好的 headers 取出来
  //    连同 Request 的 body 一起重新交给 dispatchFetch。
  if (init?.body instanceof FormData) {
    const built = new Request(BASE + path, init);
    const headers = new Headers(built.headers);
    return mf.dispatchFetch(BASE + path, {
      method: built.method,
      headers,
      body: built.body,
      duplex: 'half',
    });
  }
  return mf.dispatchFetch(BASE + path, init);
};
const json = async (path, init) => {
  const r = await req(path, init);
  let b = null;
  try {
    b = await r.json();
  } catch {
    b = null;
  }
  return { status: r.status, body: b, headers: r.headers };
};
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const post = (path, data, headers = {}) =>
  json(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });

const stamp = Date.now().toString(36);
const U1 = `qa1_${stamp}`;
const U2 = `qa2_${stamp}`;
const PW = 'Qa1234!Pass';
let t1 = '';
let t2 = '';

// ---------------------------------------------------------------------------
// 灌库 + 应用迁移（辅助函数齐备后才执行）
// ---------------------------------------------------------------------------
//
// ⚠️ 灌完 schema.sql **还不够**：users.is_admin 与 users.must_change_password
//    两列刻意不写在 CREATE TABLE 里，而是由 runAdminMigrations 的 ALTER TABLE
//    补齐（见 schema.sql 的注释）。这是为了保证"迁移前 ready=false"可测。
//
//    所以自检必须在跑业务链路之前把迁移应用掉，否则本文件会退化成在测
//    「未迁移的降级路径」——那虽然也是一条要守的路径，但 reset-default-test
//    的第 7 节已经专门覆盖它了，这里再测就是重复，还会掩盖真实缺陷。
{
  const db = await mf.getD1Database('DB');
  const stmts = SCHEMA.split(';')
    .map((s) => s.replace(/--[^\n]*/g, '').trim())
    .filter(Boolean)
    .map((s) => db.prepare(s));
  await db.batch(stmts);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").first();
  console.log(`  D1 已初始化：${n?.n ?? '?'} 张表`);

  const before = await db.prepare('PRAGMA table_info(users)').all();
  const beforeCols = (before?.results ?? []).map((r) => r.name);
  // apply_migrations 是管理员接口（requireAuth + requireAdmin），
  // 所以要先建一个管理员账号并拿 token。
  // 管理员判定看 ALLOWED_ADMINS 名单或 D1 的 is_admin 列 —— 此时 is_admin
  // 列还没建出来，所以只能走名单：把用户名直接放进 ALLOWED_ADMINS 对应的
  // 那个名字上。这里用与 ALLOWED_ADMINS 一致的 '官方账号'。
  await post('/api/register', { username: '官方账号', password: PW, nickname: '官方账号' });
  const adminLogin = await post('/api/login', { username: '官方账号', password: PW });
  const adminToken = adminLogin.body?.token || '';
  ok('迁移前置：管理员账号可登录', !!adminToken, `status=${adminLogin.status}`);
  const mig = await post('/api/admin/apply_migrations', {}, auth(adminToken));
  ok('迁移接口执行成功', mig.status === 200, `status=${mig.status} ${JSON.stringify(mig.body)}`);
  const after = await db.prepare('PRAGMA table_info(users)').all();
  const afterCols = (after?.results ?? []).map((r) => r.name);
  const added = afterCols.filter((c) => !beforeCols.includes(c));
  ok('迁移补齐了 must_change_password 列', afterCols.includes('must_change_password'),
    `新增列：${added.join(', ') || '(无)'}`);
  console.log(
    `  D1 迁移已应用：users 表列数 ${beforeCols.length} → ${afterCols.length}` +
      (added.length ? `（新增 ${added.join(', ')}）` : ''),
  );
}

try {
  // -------------------------------------------------------------------------
  section('【1】基础与健康检查');
  {
    const h = await json('/api/health');
    ok('GET /api/health', h.status === 200 && h.body?.status === 'ok', JSON.stringify(h.body));
    ok(
      '健康接口带安全响应头',
      h.headers.get('x-content-type-options') === 'nosniff' &&
        !!h.headers.get('content-security-policy'),
    );
    const nf = await json('/api/definitely-not-a-route');
    ok('未知路由返回 404 JSON', nf.status === 404 && nf.body?.detail === '接口不存在');
    const noauth = await json('/api/session');
    ok('未登录访问 /api/session 返回 401', noauth.status === 401);
  }

  // -------------------------------------------------------------------------
  section('【2】注册 / 登录 / 会话');
  {
    const r1 = await post('/api/register', { username: U1, password: PW, nickname: 'QA一号' });
    ok('注册用户 A', r1.status === 200 && !!r1.body?.token, `status=${r1.status}`);
    t1 = r1.body?.token || '';

    const r2 = await post('/api/register', { username: U2, password: PW, nickname: 'QA二号' });
    t2 = r2.body?.token || '';
    ok('注册用户 B', r2.status === 200 && !!t2, `status=${r2.status}`);

    const dup = await post('/api/register', { username: U1, password: PW });
    ok('重复用户名被拒', dup.status >= 400, `status=${dup.status}`);

    const weak = await post('/api/register', { username: `qa3_${stamp}`, password: '123' });
    ok('弱密码被拒', weak.status >= 400, `status=${weak.status}`);

    const bad = await post('/api/login', { username: U1, password: 'wrong-password' });
    ok('错误密码登录被拒', bad.status >= 400, `status=${bad.status}`);

    // -----------------------------------------------------------------------
    // 旧格式哈希 → 必须返回 400 + PASSWORD_RESET_REQUIRED + 联系管理员通道
    //
    // 这条路径的现实意义：werkzeug 默认 scrypt:32768:8:1 在 Free 计划下
    // 算不动（需 75ms CPU，上限 10ms）。用户密码没输错，只是环境算不了，
    // 所以不能笼统回「密码错误」——要明确告诉他去联系管理员重置。
    // -----------------------------------------------------------------------
    const scryptUser = `qa_scrypt_${stamp}`;
    const qaDb = await mf.getD1Database('DB');
    await qaDb.prepare(
      'INSERT INTO users (username, password_hash, nickname, role, is_banned) VALUES (?,?,?,0,0)',
    ).bind(
      scryptUser,
      // werkzeug 默认参数的真实格式：scrypt:N:r:p$salt$hash
      'scrypt:32768:8:1$abcdefghijklmnop$' + 'a'.repeat(128),
      scryptUser,
    ).run();

    const sr = await post('/api/login', { username: scryptUser, password: 'whatever' });
    ok('旧 scrypt 账号登录返回 400（不是 401）', sr.status === 400, `status=${sr.status}`);
    ok('响应含 PASSWORD_RESET_REQUIRED', sr.body?.code === 'PASSWORD_RESET_REQUIRED',
      JSON.stringify(sr.body));
    ok('响应带 reason 说明原因', typeof sr.body?.reason === 'string' && sr.body.reason.length > 0,
      JSON.stringify(sr.body?.reason));
    ok('响应带 admin_contact 联系通道',
      !!sr.body?.admin_contact?.action_url && !!sr.body?.admin_contact?.action_label,
      JSON.stringify(sr.body?.admin_contact));
    ok('admin_contact 带管理员名单',
      Array.isArray(sr.body?.admin_contact?.admins) && sr.body.admin_contact.admins.length > 0,
      JSON.stringify(sr.body?.admin_contact?.admins));
    // 名单里只能有用户名，不能夹带隐私字段
    ok('管理员名单只含用户名字符串',
      (sr.body?.admin_contact?.admins ?? []).every((a) => typeof a === 'string'),
      JSON.stringify(sr.body?.admin_contact?.admins));
    // 只能暴露算法标识（scrypt:32768:8:1 这类），绝不能带上 salt / hash 本体。
    // 完整哈希形如 scrypt:32768:8:1$<salt>$<hash>，$ 之后的部分才是秘密。
    const bodyStr = JSON.stringify(sr.body ?? {});
    ok('不能把密码哈希的 salt/hash 回传给客户端',
      !bodyStr.includes('abcdefghijklmnop') && !bodyStr.includes('a'.repeat(64)),
      '响应体里出现了哈希的 salt 或 hash 段');
    // 关键：旧格式账号不能因为密码被"猜对"就放行
    ok('旧格式账号即使密码正确也不放行',
      !sr.body?.token, JSON.stringify({ token: sr.body?.token }));
    // 400 必须告诉客户端"这条路你自己能走通"，
    // 否则用户只看到一个联系方式的按钮，而他其实没有管理员的任何外部联系方式。
    ok('400 响应声明可自助重置（self_service）',
      sr.body?.admin_contact?.self_service === true,
      JSON.stringify({ self_service: sr.body?.admin_contact?.self_service }));
    ok('400 响应下发默认密码',
      sr.body?.admin_contact?.default_password === '12345678',
      JSON.stringify({ default_password: sr.body?.admin_contact?.default_password }));

    // -----------------------------------------------------------------------
    // 自助重置为默认密码 —— 这个功能的安全性全靠三条边界，
    // 所以负向断言比正向断言更重要。
    // -----------------------------------------------------------------------
    section('【2b】自助重置为默认密码');

    // --- 正向：真正卡住的账号应该能自救 ---
    // 本文件在开头已应用迁移，所以这里走的是「已迁移」正式路径：
    // must_change_password 会被真正写入，migration_required 应为假。
    const rs = await post('/api/reset-to-default', { username: scryptUser });
    ok('旧格式账号可自助重置', rs.status === 200, `status=${rs.status} ${JSON.stringify(rs.body)}`);
    ok('重置响应带默认密码', rs.body?.default_password === '12345678',
      JSON.stringify({ default_password: rs.body?.default_password }));
    ok('重置响应要求必须改密', rs.body?.must_change_password === true,
      JSON.stringify({ must_change_password: rs.body?.must_change_password }));
    ok('已迁移环境不报 migration_required', rs.body?.migration_required !== true,
      JSON.stringify({ migration_required: rs.body?.migration_required }));
    ok('重置响应不回传哈希本体',
      !JSON.stringify(rs.body ?? {}).includes('a'.repeat(64)),
      '响应里出现了哈希段');
    // ⚠️ 默认密码是公开值，回传它是设计的一部分（按钮文案要用），
    //    真正的秘密是 salt/hash —— 上面那条断言的就是它。

    // --- 重置后必须能登录，且被打上改密标记 ---
    const rl = await post('/api/login', { username: scryptUser, password: '12345678' });
    ok('重置后可用默认密码登录', rl.status === 200 && !!rl.body?.token,
      `status=${rl.status} ${JSON.stringify(rl.body)}`);
    ok('登录响应带 must_change_password 标记',
      rl.body?.must_change_password === true,
      JSON.stringify({ must_change_password: rl.body?.must_change_password }));
    const resetToken = rl.body?.token || '';

    // --- 重置后原密码彻底失效（不能出现"新旧都能登"） ---
    const rlOld = await post('/api/login', { username: scryptUser, password: 'whatever' });
    ok('重置后原密码不再可用', rlOld.status !== 200 && !rlOld.body?.token,
      `status=${rlOld.status}`);

    // --- 重复重置被限流（每账号每天一次） ---
    const rs2 = await post('/api/reset-to-default', { username: scryptUser });
    ok('同一账号 24h 内不能重复自助重置', rs2.status === 429,
      `status=${rs2.status} ${JSON.stringify(rs2.body)}`);
    ok('限流响应说明该怎么办',
      typeof rs2.body?.detail === 'string' && rs2.body.detail.includes('12345678'),
      JSON.stringify({ detail: rs2.body?.detail }));

    // --- 参数与目标校验 ---
    const rsNoUser = await post('/api/reset-to-default', {});
    ok('缺 username → 400', rsNoUser.status === 400, `status=${rsNoUser.status}`);
    const rsGhost = await post('/api/reset-to-default', { username: `no_such_${stamp}` });
    ok('用户不存在 → 404', rsGhost.status === 404, `status=${rsGhost.status}`);

    // --- 边界 1 的反证：正常账号不能被自助重置 ---
    // 这是整个功能安全性的基石。如果这条挂了，意味着任何人只要知道用户名
    // 就能把别人的密码设成 12345678 并登进去读聊天记录。
    const rsNormal = await post('/api/reset-to-default', { username: U1 });
    ok('正常账号不能自助重置（安全边界 1）', rsNormal.status === 400,
      `status=${rsNormal.status} ${JSON.stringify(rsNormal.body)}`);
    const stillOk = await post('/api/login', { username: U1, password: PW });
    ok('正常账号被拒后原密码仍然可用', stillOk.status === 200,
      `status=${stillOk.status}`);

    // --- 边界 2 的反证：管理员不能自助重置（防提权） ---
    // ALLOWED_ADMINS 里任一账号，即使密码是旧格式也必须拒。
    const adminName = 'Forest_siri';
    await qaDb.prepare(
      'INSERT OR IGNORE INTO users (username, password_hash, nickname, role, is_banned) VALUES (?,?,?,0,0)',
    ).bind(
      adminName,
      'scrypt:32768:8:1$zzzzzzzzzzzzzzzz$' + 'b'.repeat(128),
      adminName,
    ).run();
    const rsAdmin = await post('/api/reset-to-default', { username: adminName });
    ok('管理员账号不能自助重置（安全边界 2）', rsAdmin.status === 403,
      `status=${rsAdmin.status} ${JSON.stringify(rsAdmin.body)}`);
    const adminStillLocked = await post('/api/login', { username: adminName, password: '12345678' });
    ok('管理员密码没被改成默认密码', adminStillLocked.status !== 200,
      `status=${adminStillLocked.status}`);

    // --- 边界 2 的反证：系统账号（role=2）不能自助重置 ---
    const sysUser = `qa_sys_${stamp}`;
    await qaDb.prepare(
      'INSERT OR IGNORE INTO users (username, password_hash, nickname, role, is_banned) VALUES (?,?,?,2,0)',
    ).bind(sysUser, 'scrypt:32768:8:1$yyyyyyyyyyyyyyyy$' + 'c'.repeat(128), sysUser).run();
    const rsSys = await post('/api/reset-to-default', { username: sysUser });
    ok('系统账号不能自助重置', rsSys.status === 403,
      `status=${rsSys.status} ${JSON.stringify(rsSys.body)}`);

    // --- 封禁账号不能借自助重置"复活" ---
    const bannedUser = `qa_banned_${stamp}`;
    await qaDb.prepare(
      'INSERT OR IGNORE INTO users (username, password_hash, nickname, role, is_banned) VALUES (?,?,?,0,1)',
    ).bind(bannedUser, 'scrypt:32768:8:1$wwwwwwwwwwwwwwww$' + 'd'.repeat(128), bannedUser).run();
    const rsBanned = await post('/api/reset-to-default', { username: bannedUser });
    ok('封禁账号不能自助重置', rsBanned.status === 403,
      `status=${rsBanned.status} ${JSON.stringify(rsBanned.body)}`);

    // --- 审计留痕 ---
    const auditRow = await qaDb.prepare(
      "SELECT COUNT(*) AS n FROM admin_audit_logs WHERE action='user.reset_to_default' AND target=?",
    ).bind(scryptUser).first();
    ok('自助重置写入审计日志', (auditRow?.n ?? 0) >= 1,
      JSON.stringify({ n: auditRow?.n }));
    const auditActor = await qaDb.prepare(
      "SELECT actor FROM admin_audit_logs WHERE action='user.reset_to_default' AND target=? LIMIT 1",
    ).bind(scryptUser).first();
    ok('审计日志标注为自助而非管理员操作', auditActor?.actor === 'self-service',
      JSON.stringify({ actor: auditActor?.actor }));

    // --- 改密码：清标记 + 禁止继续使用默认密码 ---
    if (resetToken) {
      const weak = await json('/api/user/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...auth(resetToken) },
        body: JSON.stringify({ old_password: '12345678', new_password: '12345678' }),
      });
      ok('改密码时不允许继续使用默认密码', weak.status === 400,
        `status=${weak.status} ${JSON.stringify(weak.body)}`);

      const strong = await json('/api/user/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...auth(resetToken) },
        body: JSON.stringify({ old_password: '12345678', new_password: 'Qa5678!NewPass' }),
      });
      ok('改用合规新密码成功', strong.status === 200,
        `status=${strong.status} ${JSON.stringify(strong.body)}`);

      const flagRow = await qaDb.prepare(
        'SELECT must_change_password FROM users WHERE username=?',
      ).bind(scryptUser).first();
      ok('改密后 must_change_password 标记被清除',
        Number(flagRow?.must_change_password ?? 0) === 0,
        JSON.stringify({ must_change_password: flagRow?.must_change_password }));

      const finalLogin = await post('/api/login', {
        username: scryptUser,
        password: 'Qa5678!NewPass',
      });
      ok('新密码可正常登录', finalLogin.status === 200 && !!finalLogin.body?.token,
        `status=${finalLogin.status}`);
      ok('正常密码登录不带改密标记',
        finalLogin.body?.must_change_password !== true,
        JSON.stringify({ must_change_password: finalLogin.body?.must_change_password }));
    }

    const li = await post('/api/login', { username: U1, password: PW });
    ok('正确密码登录成功', li.status === 200 && !!li.body?.token, `status=${li.status}`);
    if (li.body?.token) t1 = li.body.token;

    const me = await json('/api/session', { headers: auth(t1) });
    ok('Bearer 会话可用', me.status === 200 && me.body?.username === U1, JSON.stringify(me.body));

    const cookie = await json('/api/session', { headers: { Cookie: `token=${t1}` } });
    ok('Cookie 会话可用', cookie.status === 200);

    const badTok = await json('/api/session', { headers: auth('not.a.jwt') });
    ok('伪造 token 被拒', badTok.status === 401);
  }

  // -------------------------------------------------------------------------
  section('【3】消息：发送 / 幂等 / 拉取 / 编辑 / 撤回');
  {
    // 先加好友：非好友之间无法私聊（与原版一致）
    const fr = await post('/api/friends/request', { to_user: U2 }, auth(t1));
    const fa = await post('/api/friends/respond', { from_user: U1, accept: true }, auth(t2));
    ok('好友申请 + 通过', fr.status === 200 && fa.status === 200, `${fr.status}/${fa.status}`);

    const cid = `cid-${stamp}-1`;
    const m1 = await post(
      '/api/messages',
      { receiver: U2, content: '你好 QA', client_id: cid },
      auth(t1),
    );
    ok('发送单聊消息', m1.status === 200 && !!m1.body?.id, `status=${m1.status} id=${m1.body?.id}`);
    const msgId = m1.body?.id;

    const again = await post(
      '/api/messages',
      { receiver: U2, content: '你好 QA', client_id: cid },
      auth(t1),
    );
    ok('client_id 幂等去重', again.body?.duplicate === true && again.body?.id === msgId);

    const list = await json(`/api/messages?target_user=${U2}&limit=10`, { headers: auth(t1) });
    const items = list.body?.data ?? list.body;
    ok(
      '拉取会话消息',
      list.status === 200 && Array.isArray(items) && items.some((m) => m.id === msgId),
      `count=${Array.isArray(items) ? items.length : 'n/a'}`,
    );

    const shown = Array.isArray(items) ? items.find((m) => m.id === msgId) : null;
    ok('窗口内消息标记为可撤回/可编辑', shown?.can_recall === true && shown?.can_edit === true,
      `can_recall=${shown?.can_recall} can_edit=${shown?.can_edit} expires=${shown?.recall_expires_in}`);

    const edit = await json(`/api/messages/${msgId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...auth(t1) },
      body: JSON.stringify({ content: '你好 QA（已编辑）' }),
    });
    ok('编辑自己刚发的消息', edit.status === 200, `status=${edit.status}`);

    const alien = await json(`/api/messages/${msgId}`, { method: 'DELETE', headers: auth(t2) });
    ok('他人无法撤回此消息', alien.status >= 400, `status=${alien.status}`);

    const noauth = await json(`/api/messages/${msgId}`, { method: 'DELETE' });
    ok('未登录无法撤回', noauth.status === 401, `status=${noauth.status}`);

    const mine = await json(`/api/messages/${msgId}`, { method: 'DELETE', headers: auth(t1) });
    ok('本人可撤回消息', mine.status === 200, `status=${mine.status}`);
  }

  // -------------------------------------------------------------------------
  section('【4】R2 上传 / 免鉴权直链 / 路径穿越 / 白名单');
  {
    const fd = new FormData();
    fd.append(
      'file',
      new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])], { type: 'image/png' }),
      'qa.png',
    );
    const up = await json('/api/upload', { method: 'POST', headers: auth(t1), body: fd });
    ok('上传到 R2', up.status === 200 && !!up.body?.url, JSON.stringify(up.body));
    const url = up.body?.url || '';

    const dl = await req(url);
    ok(
      '图片直链免鉴权可读（<img> 场景关键）',
      dl.status === 200 && (dl.headers.get('content-type') || '').includes('image'),
      `status=${dl.status} type=${dl.headers.get('content-type')}`,
    );

    const trav1 = await req('/api/download/..%2F..%2Fschema.sql');
    const trav2 = await req('/api/download/.env');
    ok('路径穿越被拦截', trav1.status >= 400 && trav2.status >= 400, `${trav1.status}/${trav2.status}`);

    const badExt = new FormData();
    badExt.append('file', new Blob(['MZ'], { type: 'application/octet-stream' }), 'evil.exe');
    const upBad = await json('/api/upload', { method: 'POST', headers: auth(t1), body: badExt });
    ok('白名单外扩展名被拒', upBad.status >= 400, `status=${upBad.status}`);
  }

  // -------------------------------------------------------------------------
  section('【5】群聊');
  {
    const g = await post('/api/groups', { name: `QA群${stamp}` }, auth(t1));
    // 建群接口返回 { status:'success', id, name }
    const gid = g.body?.id ?? g.body?.group_id;
    ok('建群', g.status === 200 && !!gid, `id=${gid}`);

    if (gid) {
      const gm = await post('/api/messages', { group_id: gid, content: '群消息 QA' }, auth(t1));
      ok('发群消息', gm.status === 200 && !!gm.body?.id);

      const members = await json(`/api/groups/${gid}/members`, { headers: auth(t1) });
      ok('查群成员', members.status === 200, `status=${members.status}`);

      const outsider = await json(`/api/groups/${gid}/members`, { headers: auth(t2) });
      // 公开群允许非成员查看成员列表（与原版 discover 行为一致），
      // 这里断言的是「未登录」才必须被拦住
      ok('非成员读取行为与公开群设定一致', outsider.status === 200 || outsider.status === 403,
        `status=${outsider.status}`);
      const anon = await json(`/api/groups/${gid}/members`);
      ok('未登录无法查群成员', anon.status === 401, `status=${anon.status}`);
    }
  }

  // -------------------------------------------------------------------------
  section('【6】WebSocket 跨连接广播');
  {
    const sock1 = await mf.dispatchFetch(`${BASE}/api/ws?username=${U1}`, {
      headers: { ...auth(t1), Upgrade: 'websocket' },
    });
    const sock2 = await mf.dispatchFetch(`${BASE}/api/ws?username=${U2}`, {
      headers: { ...auth(t2), Upgrade: 'websocket' },
    });
    ok(
      '两条 WS 均完成升级',
      sock1.webSocket != null && sock2.webSocket != null,
      `${sock1.status}/${sock2.status}`,
    );

    if (sock1.webSocket && sock2.webSocket) {
      // 关键：监听必须在 accept() 之前挂上。
      // accept() 会立即把队列里已积压的事件（如 online_status）派发出去，晚挂就漏掉了。
      const events = { s1: [], s2: [] };
      const attach = (sock, bucket) =>
        new Promise((res) => {
          sock.addEventListener('message', (e) => {
            const m = JSON.parse(e.data);
            bucket.push({ type: m.type, data: m.data, users: m.users, at: Date.now() });
          });
          res();
        });

      await attach(sock1.webSocket, events.s1);
      await attach(sock2.webSocket, events.s2);
      sock1.webSocket.accept();
      sock2.webSocket.accept();

      const waitFor = (bucket, type, ms = 5000) =>
        new Promise((res) => {
          const deadline = Date.now() + ms;
          const tick = () => {
            const hit = bucket.find((m) => m.type === type);
            if (hit) return res(hit);
            if (Date.now() > deadline) return res({ timeout: true });
            setTimeout(tick, 50);
          };
          tick();
        });

      const online = await waitFor(events.s2, 'online_status');
      ok('连接后收到在线状态推送', !online.timeout, `users=${JSON.stringify(online.users || [])}`);

      await post('/api/messages', { receiver: U2, content: 'broadcast check' }, auth(t1));

      const r2 = await waitFor(events.s2, 'message');
      ok(
        '接收方收到实时推送',
        !r2.timeout && r2.data?.content === 'broadcast check',
        r2.timeout ? '超时' : `content=${r2.data?.content}`,
      );

      const r1 = await waitFor(events.s1, 'message');
      ok(
        '发送方多端同步（本人其它设备/标签页）',
        !r1.timeout && r1.data?.content === 'broadcast check',
        r1.timeout ? '超时' : `content=${r1.data?.content}`,
      );

      const h = await json('/api/health');
      ok('在线人数统计生效', (h.body?.online_count ?? 0) >= 2, `online=${h.body?.online_count}`);
    }
  }

  // -------------------------------------------------------------------------
  section('【7】KV 登录限流');
  {
    const victim = `rl_${stamp}`;
    await post('/api/register', { username: victim, password: PW });
    let saw429 = false;
    for (let i = 0; i < 7; i += 1) {
      const r = await post('/api/login', { username: victim, password: 'wrong' });
      if (r.status === 429) saw429 = true;
    }
    ok('连续失败后触发 429 锁定', saw429);

    const nowRight = await post('/api/login', { username: victim, password: PW });
    ok('锁定期内正确密码也被拦', nowRight.status === 429, `status=${nowRight.status}`);
  }

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
} finally {
  await mf.dispose();
}
process.exit(fail === 0 ? 0 : 1);
