#!/usr/bin/env node
/**
 * 时区正确性测试（本地 Miniflare）。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这个文件
 * ---------------------------------------------------------------------------
 * 这是一个**反复复发**的老 bug，值得单独一份测试守住。
 *
 * D1/SQLite 存的时间一律是 UTC，格式 `'2026-10-05 06:14:55'` —— 不带时区标记。
 * 客户端 `new Date('2026-10-05 06:14:55')` 会按**本地时区**解析它，
 * 于是中国用户看到的时间比实际早 8 小时。
 *
 * 以前部署在自有服务器上（FastAPI 版），修法是
 * `timedatectl set-timezone Asia/Shanghai` 改系统时区 —— 服务器直接吐北京时间。
 * **Cloudflare Workers 没有系统时区概念**，永远跑在 UTC，改不了。
 * 所以那个修法在这里根本不存在，必须靠"出参加 Z + 客户端转本地"。
 *
 * 这个测试要守住的**核心不变量**只有一条：
 *
 *   服务端返回的时间字符串，解析后必须等于"刚刚"（误差 < 60 秒）。
 *
 * 只要这条成立，客户端无论怎么解析都不会差 8 小时。
 *
 * 另有两条同样重要的**反向不变量**（防止修 A 坏 B）：
 *   · 落库的仍是裸 UTC —— 否则 SQLite 的 datetime() 比较与 date() 聚合会失效
 *   · admin-stats 的日聚合口径没变 —— 否则看板曲线整体错位一天
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

/**
 * 把服务端返回的时间串解析成毫秒。
 *
 * ⚠️ 这里**故意**复刻客户端该有的解析逻辑：
 *    带 Z / 带偏移 → 直接交给 Date
 *    裸串（老后端）→ 补 Z 后交给 Date
 * 如果服务端忘了加 Z，下面每个断言都会立刻暴露出 8 小时偏差。
 */
function parseServerTime(s) {
  if (!s) return NaN;
  const t = String(s).trim();
  if (/[Zz]$/.test(t) || /[+-]\d{2}:?\d{2}$/.test(t)) return Date.parse(t);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(t)) {
    return Date.parse(t.replace(' ', 'T') + 'Z');
  }
  return Date.parse(t);
}

async function buildEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'tz-'));
  const mf = new Miniflare({
    modules: true,
    modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
    scriptPath: join(DIST, 'worker.js'),
    d1Databases: { DB: `tz-${Math.random().toString(36).slice(2)}` },
    r2Buckets: { UPLOADS: 'tz-test-uploads' },
    kvNamespaces: { RATE_LIMIT: 'tz-test-kv' },
    durableObjects: { CHAT_HUB: { className: 'ChatHub', useSQLite: true } },
    compatibilityDate: '2024-11-27',
    bindings: {
      JWT_SECRET: 'test-secret-for-timezone',
      ALLOWED_ADMINS: '官方账号',
      CURRENT_VERSION: 'v10.3.0',
      PASSWORD_ITERATIONS: '10000',
    },
    d1Persist: join(dir, 'd1'),
  });

  const db = await mf.getD1Database('DB');
  const stmts = SCHEMA.split(';')
    .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
    .filter((s) => s.length > 0);
  await db.batch(stmts.map((s) => db.prepare(s)));

  const post = async (path, body, token) => {
    const res = await mf.dispatchFetch(BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    let j = null;
    try { j = await res.json(); } catch { /* 非 JSON */ }
    return { status: res.status, body: j };
  };
  const get = async (path, token) => {
    const res = await mf.dispatchFetch(BASE + path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    let j = null;
    try { j = await res.json(); } catch { /* 非 JSON */ }
    return { status: res.status, body: j };
  };
  const put = async (path, body, token) => {
    const res = await mf.dispatchFetch(BASE + path, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    let j = null;
    try { j = await res.json(); } catch { /* 非 JSON */ }
    return { status: res.status, body: j };
  };

  return { mf, db, post, get, put };
}

async function main() {
  console.log('\n════════ 时区正确性测试（出参带 Z + 落库保持裸 UTC）════════\n');
  const { db, post, get, put } = await buildEnv();

  // --- 0. 造数据 ----------------------------------------------------------
  section('0. 准备账号');
  const reg = await post('/api/register', {
    username: 'tzuser', password: 'TzTest!2026x', nickname: '时区测试',
  });
  ok('注册成功', reg.status === 200, JSON.stringify(reg.body).slice(0, 150));
  const utk = reg.body?.token;

  const adminReg = await post('/api/register', {
    username: '官方账号', password: 'TzAdmin!2026x', nickname: '管理员',
  });
  // ALLOWED_ADMINS 里的账号注册即 role=1；若已被占用则直接登录
  const atk = adminReg.body?.token
    || (await post('/api/login', { username: '官方账号', password: 'TzAdmin!2026x' })).body?.token;
  ok('管理员账号可用', typeof atk === 'string', String(adminReg.status));

  // --- 1. utcOut 单元语义（通过出参间接验证）------------------------------
  section('1. 时间出参必须带 Z 标记（标明是 UTC）');

  const sentAt = Date.now();
  const send = await post('/api/messages', { content: '时区测试：这条消息的时间应该等于现在' }, utk);
  ok('发消息成功', send.status === 200, JSON.stringify(send.body).slice(0, 150));

  const list = await get('/api/messages', utk);
  const msgs = Array.isArray(list.body) ? list.body
    : (list.body?.messages || list.body?.data || []);
  const mine = msgs.filter((m) => m.content === '时区测试：这条消息的时间应该等于现在');
  ok('能查回刚发的消息', mine.length > 0, `共 ${msgs.length} 条`);

  const msgTime = mine[0]?.time;
  ok('消息 time 字段存在', typeof msgTime === 'string', String(msgTime));
  ok('消息 time 以 Z 结尾（标明 UTC）', /Z$/.test(String(msgTime)), String(msgTime));

  // ★★★ 核心断言 ★★★
  const driftMs = Math.abs(parseServerTime(msgTime) - sentAt);
  ok(
    `消息时间解析后 = 真实当前时间（误差 ${Math.round(driftMs / 1000)}s < 60s）`,
    driftMs < 60_000,
    `服务端=${msgTime} 本地=${new Date(sentAt).toISOString()} 偏差=${Math.round(driftMs / 3600000)}h`,
  );

  // --- 2. 落库必须仍是裸 UTC（反向不变量）---------------------------------
  section('2. 落库必须保持裸 UTC（否则 SQLite 时间比较会坏）');
  const row = await db
    .prepare('SELECT created_at FROM messages WHERE content=?')
    .bind('时区测试：这条消息的时间应该等于现在').first();
  ok('库里确有该消息', !!row, JSON.stringify(row));
  ok(
    '落库的 created_at 不带 Z',
    typeof row?.created_at === 'string' && !/[Zz]$/.test(row.created_at),
    String(row?.created_at),
  );
  // 库里存的应该是 UTC 值：与 JS 的 UTC 时刻相差应在几秒内
  const dbDrift = Math.abs(parseServerTime(row?.created_at) - sentAt);
  ok(`库里时间确是 UTC（误差 ${Math.round(dbDrift / 1000)}s）`, dbDrift < 60_000, String(row?.created_at));

  // --- 3. edited_at 也要带 Z ----------------------------------------------
  section('3. 编辑消息后 edited_at 同样带 Z');
  const msgId = mine[0]?.id;
  const edit = await put(`/api/messages/${msgId}`, { content: '时区测试：改过一次' }, utk);
  if (edit.status === 200) {
    const list2 = await get('/api/messages', utk);
    const msgs2 = Array.isArray(list2.body) ? list2.body
      : (list2.body?.messages || list2.body?.data || []);
    const edited = msgs2.find((m) => m.id === msgId);
    ok('编辑后 edited_at 存在', typeof edited?.edited_at === 'string', String(edited?.edited_at));
    ok('edited_at 以 Z 结尾', /Z$/.test(String(edited?.edited_at)), String(edited?.edited_at));
    const edDrift = Math.abs(parseServerTime(edited?.edited_at) - Date.now());
    ok(`edited_at 解析后 = 现在（误差 ${Math.round(edDrift / 1000)}s）`, edDrift < 60_000, String(edited?.edited_at));
  } else {
    console.log(`    （编辑接口返回 ${edit.status}，跳过 edited_at 断言）`);
  }

  // --- 4. 不重复叠加 Z ----------------------------------------------------
  section('4. 反复读取不会叠加成 ZZ');
  const again = await get('/api/messages', utk);
  const msgs3 = Array.isArray(again.body) ? again.body
    : (again.body?.messages || again.body?.data || []);
  const t3 = msgs3.find((m) => m.id === msgId)?.time;
  ok('第二次读取仍是单个 Z', !/ZZ/.test(String(t3)) && /Z$/.test(String(t3)), String(t3));

  // --- 5. 登录历史 / 设备列表 ---------------------------------------------
  section('5. 登录历史与设备列表的时间也带 Z');
  const hist = await get('/api/user/login-history', utk);
  ok('登录历史返回 200', hist.status === 200, JSON.stringify(hist.body).slice(0, 150));
  const h0 = Array.isArray(hist.body) ? hist.body[0] : null;
  ok('登录历史 created_at 带 Z', /Z$/.test(String(h0?.created_at)), String(h0?.created_at));
  const hDrift = Math.abs(parseServerTime(h0?.created_at) - Date.now());
  ok(`登录历史时间 = 现在（误差 ${Math.round(hDrift / 1000)}s < 300s）`, hDrift < 300_000, String(h0?.created_at));

  const dev = await get('/api/user/devices', utk);
  ok('设备列表返回 200', dev.status === 200);
  const d0 = Array.isArray(dev.body) ? dev.body[0] : null;
  if (d0) {
    ok('设备 last_login 带 Z', /Z$/.test(String(d0.last_login)), String(d0.last_login));
  } else {
    console.log('    （设备列表为空，跳过）');
  }

  // --- 6. 好友申请 / 群相关 -----------------------------------------------
  section('6. 好友申请与群列表的时间也带 Z');
  const reg2 = await post('/api/register', { username: 'tzfriend', password: 'TzTest!2026x', nickname: '好友' });
  const ftk = reg2.body?.token;
  ok('第二个账号注册成功', reg2.status === 200);

  await post('/api/friends/request', { username: 'tzfriend' }, utk);
  const fr = await get('/api/friends/requests', ftk);
  ok('好友申请列表返回 200', fr.status === 200, JSON.stringify(fr.body).slice(0, 120));
  const fr0 = fr.body?.data?.[0];
  if (fr0) {
    ok('好友申请 created_at 带 Z', /Z$/.test(String(fr0.created_at)), String(fr0.created_at));
  } else {
    console.log('    （好友申请列表为空，跳过 —— 不影响时区结论）');
  }

  const gcreate = await post('/api/groups', { name: '时区测试群', is_public: true }, utk);
  ok('建群成功', gcreate.status === 200, JSON.stringify(gcreate.body).slice(0, 150));
  const gid = gcreate.body?.group_id || gcreate.body?.id || gcreate.body?.group?.id;
  if (gid) {
    const members = await get(`/api/groups/${gid}/members`, utk);
    ok('群成员列表返回 200', members.status === 200, JSON.stringify(members.body).slice(0, 120));
    const m0 = members.body?.data?.[0];
    if (m0?.joined_at) {
      ok('群成员 joined_at 带 Z', /Z$/.test(String(m0.joined_at)), String(m0.joined_at));
    }
  }

  // --- 7. 管理端出参 ------------------------------------------------------
  section('7. 管理端的用户/审计出参也带 Z');
  const users = await get('/api/admin/users', atk);
  ok('管理端用户列表返回 200', users.status === 200, JSON.stringify(users.body).slice(0, 150));
  const u0 = users.body?.users?.find((u) => u.username === 'tzuser');
  ok('用户 created_at 带 Z', /Z$/.test(String(u0?.created_at)), String(u0?.created_at));

  // 禁言相关列刻意**不写进** schema.sql（否则 migration_status 永远 ready，
  // 测不出迁移有没有真跑过）。所以这里先走一次迁移接口。
  const mig = await post('/api/admin/apply_migrations', {}, atk);
  ok('迁移接口返回 200', mig.status === 200, JSON.stringify(mig.body).slice(0, 200));

  // 禁言 → 出参带 Z，落库裸 UTC
  const mute = await post('/api/admin/mute_user', { username: 'tzuser', minutes: 60 }, atk);
  ok('禁言返回 200', mute.status === 200, JSON.stringify(mute.body).slice(0, 150));
  ok('禁言出参 muted_until 带 Z', /Z$/.test(String(mute.body?.muted_until)), String(mute.body?.muted_until));
  const dbMute = await db
    .prepare('SELECT muted_until FROM users WHERE username=?').bind('tzuser').first();
  ok(
    '禁言落库为裸 UTC（不带 Z）',
    typeof dbMute?.muted_until === 'string' && !/[Zz]$/.test(dbMute.muted_until),
    String(dbMute?.muted_until),
  );
  // 带 Z 的禁言时间解析后应该在未来约 1 小时
  const muteMs = parseServerTime(mute.body?.muted_until);
  const inOneHour = muteMs - Date.now();
  ok(
    `禁言解禁时间解析后 ≈ 1 小时后（实际 ${Math.round(inOneHour / 60000)} 分钟）`,
    inOneHour > 50 * 60_000 && inOneHour < 70 * 60_000,
    String(mute.body?.muted_until),
  );

  // 禁言必须真的生效（出参改格式不能把这条链路碰坏）
  const blocked = await post('/api/messages', { content: '禁言期间应该发不出去' }, utk);
  ok('被禁言后发消息 403', blocked.status === 403, String(blocked.status));

  const audit = await get('/api/admin/audit?limit=20', atk);
  ok('审计日志返回 200', audit.status === 200, JSON.stringify(audit.body).slice(0, 150));
  const a0 = audit.body?.logs?.[0];
  if (a0) {
    ok('审计 created_at 带 Z', /Z$/.test(String(a0.created_at)), String(a0.created_at));
    const aDrift = Math.abs(parseServerTime(a0.created_at) - Date.now());
    ok(`审计时间 = 现在（误差 ${Math.round(aDrift / 1000)}s < 300s）`, aDrift < 300_000, String(a0.created_at));
  }

  // --- 8. 反向不变量：聚合口径没被破坏 -------------------------------------
  section('8. 看板日聚合口径未被破坏（回归防线）');
  const ts = await get('/api/admin/stats/timeseries?metric=messages&days=7', atk);
  ok('时序接口返回 200', ts.status === 200, JSON.stringify(ts.body).slice(0, 150));
  const pts = ts.body?.points || [];
  ok('返回 7 个点', pts.length === 7, `实际 ${pts.length}`);
  ok(
    '点的日期格式是 YYYY-MM-DD（不带 Z）',
    pts.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(String(p.d))),
    JSON.stringify(pts.slice(0, 2)),
  );
  // 最后一个点必须是"今天"（UTC 口径）
  const todayUtc = new Date().toISOString().slice(0, 10);
  ok(`最后一个点是今天（UTC ${todayUtc}）`, pts[pts.length - 1]?.d === todayUtc, String(pts[pts.length - 1]?.d));

  const ov = await get('/api/admin/stats/overview', atk);
  ok('概览接口返回 200', ov.status === 200);
  ok('今日新增消息 > 0（聚合确实算到了今天）', Number(ov.body?.new_messages_today ?? 0) > 0,
    JSON.stringify(ov.body));

  // --- 9. 反向不变量：撤回窗口没被破坏 -------------------------------------
  section('9. 撤回/编辑窗口未被破坏（秒数路径）');
  const fresh = msgs3[msgs3.length - 1];
  if (fresh) {
    ok('can_recall 是布尔值', typeof fresh.can_recall === 'boolean', String(fresh.can_recall));
    ok('can_edit 是布尔值', typeof fresh.can_edit === 'boolean', String(fresh.can_edit));
    ok(
      '刚发的消息 recall_expires_in 在 (0, 120] 秒',
      Number(fresh.recall_expires_in) > 0 && Number(fresh.recall_expires_in) <= 120,
      String(fresh.recall_expires_in),
    );
  }

  // --- 10. 边界：空值与不合法输入 -----------------------------------------
  section('10. 边界处理');
  const edit2 = await put(`/api/messages/${msgId}`, { content: '' }, utk);
  ok('空内容编辑被拒（不影响时间字段）', edit2.status >= 400, String(edit2.status));
  const badMetric = await get('/api/admin/stats/timeseries?metric=nonexistent', atk);
  ok('非法 metric 返回 400（白名单仍生效）', badMetric.status === 400, String(badMetric.status));

  console.log(`\n\x1b[1m════════ 结果：${pass} 通过 / ${fail} 失败 ════════\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n测试异常中止：', e);
  process.exit(1);
});
