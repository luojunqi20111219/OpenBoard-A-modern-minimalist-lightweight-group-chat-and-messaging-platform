/**
 * 线上同款构建产物验证（Live-contract verification）
 *
 * 为什么需要这个文件
 * ---------------------------------------------------------------------------
 * 沙箱网络对 `*.workers.dev` 与 Cloudflare 边缘 IP 的 TLS 是**阻断**的
 * （SSL_ERROR_SYSCALL / exit 35），所以无法用 curl 直接打线上 HTTP 接口，
 * 也就无法用"发一个请求看返回"的方式确认部署结果。
 *
 * 但"部署成功"本身已由 wrangler 确认（Version ID + 100% 流量 + D1 已迁移）。
 * 真正还需要证明的是：**我们构建出来并推上去的那份代码，行为是否正确**。
 *
 * 所以本脚本用 dist/worker.js —— 与 deploy 上传的**完全同一份产物** ——
 * 在一个隔离的 Miniflare 里跑完整链路，并把绑定值配成与 wrangler.toml
 * 一致。这样测的就不是"另一份代码"，而是线上正在跑的那份。
 *
 * 与 test:reset / preflight 的区别
 * ---------------------------------------------------------------------------
 *   - preflight       : 全链路冒烟，含发消息/群聊/WebSocket 等，重置只是其中一节
 *   - test:reset      : 重置功能的**边界穷举**（含未迁移降级），52 条负向断言
 *   - 本文件           : 只盯**部署契约** —— 能力探测字段、端到端闭环、
 *                       线上真实数据形态（scrypt 卡住账号）能否自救
 *
 * 运行：node scripts/live-verify.mjs
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
const PW = 'Qa9999!Pass';

let pass = 0;
let fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { fail += 1; console.log(`  \x1b[31m✗\x1b[0m ${n} ${e}`); }
};
const sec = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

for (const f of ['worker.js', 'sql-wasm.wasm']) {
  if (!existsSync(join(DIST, f))) {
    console.error(`缺少 dist/${f}，请先执行：npm run bundle`);
    process.exit(1);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'live-'));
const mf = new Miniflare({
  scriptPath: join(DIST, 'worker.js'),
  modules: true,
  modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
  compatibilityDate: '2024-11-27',
  d1Databases: { DB: 'live-db' },
  r2Buckets: { UPLOADS: 'live-uploads' },
  kvNamespaces: { RATE_LIMIT: 'live-kv' },
  durableObjects: { CHAT_HUB: { className: 'ChatHub', useSQLite: true } },
  // 与 wrangler.toml 的 [vars] 对齐。注意 ALLOWED_ADMINS 是当前线上值。
  bindings: {
    CURRENT_VERSION: 'v10.1.0',
    PUBLIC_UPLOADS: 'true',
    ALLOWED_ADMINS: '官方账号,Forest_siri,Brian_Birch',
    MAX_CONNECTIONS_PER_USER: '4',
    PASSWORD_ITERATIONS: '',
    JWT_SECRET: 'live-verify-secret-not-for-production',
  },
  d1Persist: join(dir, 'd1'),
});

// --- 灌 schema + 应用迁移（线上已经迁移过了，这里必须对齐）---
const db = await mf.getD1Database('DB');
await db.batch(
  SCHEMA.split(';')
    .map((s) => s.replace(/--[^\n]*/g, '').trim())
    .filter(Boolean)
    .map((s) => db.prepare(s)),
);

const req = (p, i) => mf.dispatchFetch(BASE + p, i);
const json = async (p, i) => {
  const r = await req(p, i);
  let b = null;
  try { b = await r.json(); } catch { b = null; }
  return { status: r.status, body: b };
};
const post = (p, d, h = {}) => json(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...h },
  body: JSON.stringify(d ?? {}),
});
const auth = (t) => ({ Authorization: `Bearer ${t}` });

// 先建管理员并应用迁移 —— 线上 users 表已有 must_change_password 列
await post('/api/register', { username: '官方账号', password: PW, nickname: '官方账号' });
{
  const login = await post('/api/login', { username: '官方账号', password: PW });
  const token = login.body?.token || '';
  const mig = await post('/api/admin/apply_migrations', {}, auth(token));
  ok('前置：迁移已应用（对齐线上状态）', mig.status === 200,
    `status=${mig.status} ${JSON.stringify(mig.body)}`);
  const cols = await db.prepare('PRAGMA table_info(users)').all();
  const names = (cols?.results ?? []).map((r) => r.name);
  ok('前置：must_change_password 列存在', names.includes('must_change_password'));
}

// ---------------------------------------------------------------------------
sec('【1】能力探测 —— 客户端就是靠这个决定显不显示按钮');
{
  const c = await json('/api/capabilities');
  ok('接口无需登录即可访问', c.status === 200, `status=${c.status}`);
  ok('声明部署形态为 cloudflare-workers', c.body?.server === 'cloudflare-workers',
    JSON.stringify(c.body?.server));
  ok('版本号为 v10.1.0', c.body?.version === 'v10.1.0', JSON.stringify(c.body?.version));
  ok('显式声明支持自助重置（普通服务端不会有这个字段）',
    c.body?.features?.self_reset_password === true,
    JSON.stringify(c.body?.features));
  ok('显式声明支持强制改密', c.body?.features?.must_change_password === true);
  // 注意：不能简单地 grep "hash" —— features 里有个叫
  // legacy_hash_unsupported 的**能力开关名**，它本身不是秘密。
  // 要断言的是"没有把密钥/凭据的值泄露出去"，所以盯的是值而非键名：
  //   - 任何看起来像哈希串的东西（长十六进制/base64 + $ 分隔）
  //   - 环境变量里那些真实密钥的值
  const bodyStr = JSON.stringify(c.body);
  ok('不回传任何密码哈希形态的字符串',
    !/\$[A-Za-z0-9+/=]{16,}/.test(bodyStr) && !/[0-9a-f]{64,}/i.test(bodyStr),
    bodyStr);
  ok('不回传密钥类配置的值',
    !bodyStr.includes('live-verify-secret-not-for-production')
      && !/"(jwt_secret|secret|password|token)"\s*:/i.test(bodyStr),
    bodyStr);

  // 反证：不存在的接口不能误报能力（客户端据此走"严格默认"分支）
  const ghost = await json('/api/not-a-real-endpoint');
  ok('不存在的接口不会误报能力', ghost.status === 404, `status=${ghost.status}`);
}

// ---------------------------------------------------------------------------
sec('【2】模拟线上那批卡住的 scrypt 账号（线上共 16 个）');
const stuck = 'live_scrypt_user';
{
  await db.prepare(
    'INSERT INTO users (username,password_hash,nickname,role,is_banned) VALUES (?,?,?,0,0)',
  ).bind(stuck, 'scrypt:32768:8:1$abcdefghijklmnop$' + 'a'.repeat(128), stuck).run();

  const l = await post('/api/login', { username: stuck, password: PW });
  ok('登录返回 400（不是 401 —— 密码没输错，是环境算不动）',
    l.status === 400, `status=${l.status}`);
  ok('带 PASSWORD_RESET_REQUIRED 标识', l.body?.code === 'PASSWORD_RESET_REQUIRED',
    JSON.stringify(l.body?.code));
  ok('明确告知可自助重置', l.body?.admin_contact?.self_service === true,
    JSON.stringify(l.body?.admin_contact?.self_service));
  ok('下发默认密码（按钮文案要用）',
    l.body?.admin_contact?.default_password === DEFAULT_PASSWORD,
    JSON.stringify(l.body?.admin_contact?.default_password));
  ok('绝不回传哈希本体（salt/hash 才是秘密）',
    !JSON.stringify(l.body).includes('a'.repeat(64)), '响应体里出现了哈希段');
}

// ---------------------------------------------------------------------------
sec('【3】自助重置 → 登录 → 强制改密 端到端');
let token = '';
{
  const r = await post('/api/reset-to-default', { username: stuck });
  ok('重置成功', r.status === 200, `status=${r.status} ${JSON.stringify(r.body)}`);
  ok('下发默认密码', r.body?.default_password === DEFAULT_PASSWORD);
  ok('要求必须改密', r.body?.must_change_password === true,
    JSON.stringify(r.body?.must_change_password));
  ok('不报 migration_required（线上已迁移）', r.body?.migration_required !== true,
    JSON.stringify(r.body?.migration_required));
  ok('响应不回传哈希本体', !JSON.stringify(r.body ?? {}).includes('a'.repeat(64)));

  const l = await post('/api/login', { username: stuck, password: DEFAULT_PASSWORD });
  ok('用 12345678 能登进去', l.status === 200 && !!l.body?.token, `status=${l.status}`);
  // ⚠️ 登录成功 code 是数字 200，失败时是字符串 —— 同名不同类型，客户端分开建模
  ok('成功响应的 code 是数字 200（与失败的字符串区分）',
    l.body?.code === 200, JSON.stringify(l.body?.code));
  ok('登录响应带 must_change_password=true（客户端据此弹全屏改密页）',
    l.body?.must_change_password === true,
    JSON.stringify(l.body?.must_change_password));
  token = l.body?.token || '';

  const old = await post('/api/login', { username: stuck, password: PW });
  ok('原密码彻底失效', old.status === 401, `status=${old.status}`);
}

// ---------------------------------------------------------------------------
sec('【4】强制改密闭环（改完必须能正常用）');
{
  const weak = await json('/api/user/password', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth(token) },
    body: JSON.stringify({ old_password: DEFAULT_PASSWORD, new_password: DEFAULT_PASSWORD }),
  });
  ok('不允许把新密码设成默认密码', weak.status === 400, `status=${weak.status}`);

  const strong = await json('/api/user/password', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...auth(token) },
    body: JSON.stringify({ old_password: DEFAULT_PASSWORD, new_password: 'My9900!Real' }),
  });
  ok('设置自己的新密码成功', strong.status === 200,
    `status=${strong.status} ${JSON.stringify(strong.body)}`);

  const fl = await post('/api/login', { username: stuck, password: 'My9900!Real' });
  ok('新密码可登录', fl.status === 200 && !!fl.body?.token, `status=${fl.status}`);
  ok('登录后不再要求改密（标记已清除）', fl.body?.must_change_password !== true,
    JSON.stringify(fl.body?.must_change_password));

  const row = await db.prepare('SELECT must_change_password FROM users WHERE username=?')
    .bind(stuck).first();
  ok('库中标记确实为 0', Number(row?.must_change_password ?? 0) === 0, JSON.stringify(row));
}

// ---------------------------------------------------------------------------
sec('【5】三条安全边界 —— 这是整个功能的安全底线');
{
  // 边界 1
  await post('/api/register', { username: 'live_normal', password: PW, nickname: '正常' });
  const n = await post('/api/reset-to-default', { username: 'live_normal' });
  ok('边界1: 正常密码账号被拒', n.status === 400, `status=${n.status}`);
  const nl = await post('/api/login', { username: 'live_normal', password: PW });
  ok('边界1: 被拒后原密码仍然可用', nl.status === 200);

  // 边界 2a
  const a2a = await post('/api/reset-to-default', { username: '官方账号' });
  ok('边界2a: 硬编码名单管理员被拒', a2a.status === 403, `status=${a2a.status}`);

  // 边界 2b
  await post('/api/register', { username: 'live_admin', password: PW, nickname: '管理' });
  await db.prepare('UPDATE users SET is_admin=1 WHERE username=?').bind('live_admin').run();
  const a2b = await post('/api/reset-to-default', { username: 'live_admin' });
  ok('边界2b: D1 is_admin=1 动态管理员被拒', a2b.status === 403, `status=${a2b.status}`);
  const ar = await db.prepare('SELECT password_hash FROM users WHERE username=?')
    .bind('live_admin').first();
  ok('边界2b: 管理员密码确实没被改成默认密码',
    !!ar?.password_hash && !String(ar.password_hash).includes(DEFAULT_PASSWORD),
    JSON.stringify({ algo: String(ar?.password_hash ?? '').slice(0, 24) }));

  // 边界 2c
  await post('/api/register', { username: 'live_role1', password: PW, nickname: '历史管理' });
  await db.prepare('UPDATE users SET role=1 WHERE username=?').bind('live_role1').run();
  const a2c = await post('/api/reset-to-default', { username: 'live_role1' });
  ok('边界2c: role=1 历史管理员被拒', a2c.status === 403, `status=${a2c.status}`);

  // 边界 2d 系统账号
  const a2d = await post('/api/reset-to-default', { username: 'filehelper' });
  ok('边界2d: 系统账号（role=2）被拒', a2d.status === 403, `status=${a2d.status}`);

  // 边界 3 限流
  await db.prepare(
    'INSERT INTO users (username,password_hash,nickname,role,is_banned) VALUES (?,?,?,0,0)',
  ).bind('live_rl', 'scrypt:32768:8:1$zzzzzzzzzzzzzzzz$' + 'b'.repeat(128), 'live_rl').run();
  const r1 = await post('/api/reset-to-default', { username: 'live_rl' });
  const r2 = await post('/api/reset-to-default', { username: 'live_rl' });
  ok('边界3: 当日首次成功', r1.status === 200, `status=${r1.status}`);
  // ⚠️ 必须是 429 而不是 400：顺序反了的话第二次会走"无需重置"分支，
  //    用户会以为按钮点错了，然后反复尝试。
  ok('边界3: 同日二次被限流 429（不是 400「无需重置」）', r2.status === 429,
    `status=${r2.status} ${JSON.stringify(r2.body)}`);
  ok('边界3: 限流提示告知该用默认密码登录',
    String(r2.body?.detail ?? '').includes(DEFAULT_PASSWORD),
    JSON.stringify(r2.body?.detail));
  const r3 = await post('/api/reset-to-default', { username: 'live_rl' },
    { 'CF-Connecting-IP': '203.0.113.99' });
  ok('边界3: 换 IP 绕不过账号级限流', r3.status === 429, `status=${r3.status}`);

  // 输入校验
  ok('缺 username → 400', (await post('/api/reset-to-default', {})).status === 400);
  ok('不存在的用户 → 404',
    (await post('/api/reset-to-default', { username: 'no_such_user_xyz' })).status === 404);
  // getUsernameByName 是大小写敏感精确匹配 —— 查不到就该 404，不能凭空放行
  const caseR = await post('/api/reset-to-default', { username: 'LIVE_RL' });
  ok('大小写变体不会凭空放行（查不到就 404）', caseR.status === 404,
    `status=${caseR.status}`);
}

// ---------------------------------------------------------------------------
sec('【6】审计日志');
{
  const a = await db.prepare(
    "SELECT actor FROM admin_audit_logs WHERE action='user.reset_to_default' AND target=? LIMIT 1",
  ).bind(stuck).first();
  ok('成功重置写入审计日志', !!a, JSON.stringify(a));
  ok('actor 标为 self-service（与管理员代操作区分）', a?.actor === 'self-service',
    JSON.stringify(a?.actor));

  const denied = await db.prepare(
    "SELECT COUNT(*) AS n FROM admin_audit_logs WHERE target='live_normal'",
  ).first();
  ok('被拒绝的重置不写审计日志', Number(denied?.n ?? 0) === 0, JSON.stringify(denied));
}

console.log(`\n\x1b[1m结果：${pass} 通过 / ${fail} 失败\x1b[0m`);
await mf.dispose();
process.exit(fail > 0 ? 1 : 0);
