/**
 * 验证存量 Android 客户端能收到消息。
 *
 * 复刻 WebSocketManager.kt 的真实连接方式：
 *   baseUrl.replace("https://","wss://") + "ws/$token"   →  路径 /ws/{token}
 * 并按 WsMessage.kt 的 WsData 字段逐个核对广播载荷。
 *
 * ---------------------------------------------------------------------------
 * 迁移到 Workers 后的简化（2026-09-30）
 * ---------------------------------------------------------------------------
 * 旧版本要起两个 Miniflare worker（pages-app + do-test）并用 service binding
 * 串起来，因为 Pages 的 URL 空间来自模板 worker、DO 又必须住在独立脚本里。
 *
 * 现在 DO 与 Worker 同脚本，**只需起一个 worker**：
 *   - 不再需要 proxy worker
 *   - 不再需要解释「Miniflare 跨 worker 转发丢 getSetCookie」这个偏差
 *     （那个偏差本身就是 Pages 架构的产物，现在整类问题都不存在了）
 *   - 测试直接跑 dist/worker.js，与线上产物完全一致
 */
import { Miniflare } from 'miniflare';
import { readFileSync, existsSync } from 'node:fs';

if (!existsSync('dist/worker.js')) {
  console.error('❌ 缺少构建产物 dist/worker.js，请先执行： npm run check:android');
  process.exit(1);
}

const SCHEMA = readFileSync('schema.sql', 'utf8');
const B = 'http://localhost';

// 不设任何 *Persist 选项：Miniflare 落在系统临时目录，每次干净环境，退出即清理。
// DO 用 SQLite 后端（useSQLite: true），与线上 new_sqlite_classes 一致。
//
// ⚠️ 这里**刻意不挂 assets**（尽管 wrangler.toml 里有 [assets]）。
//    Miniflare 3.2025xxx 的 assets 路由器会把所有请求先拦下来（含 /api/*），
//    Worker 的 fetch 根本不会被调用 —— 实测 /api/health 返回空 404 而非报错，
//    极难排查。而线上运行时（新版）支持 assets.run_worker_first，
//    行为与本地的老 Miniflare 不同。
//    本脚本聚焦「API + WebSocket 是否正常」，因此只挂必要绑定；
//    静态资源与路由分流由 scripts/verify-assets.mjs 单独验证。
const mf = new Miniflare({
  modules: true,
  // 与 wrangler.toml 的 [[rules]] 对齐：让 Miniflare 认识 .wasm 模块
  modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
  compatibilityDate: '2024-11-27',
  scriptPath: 'dist/worker.js',
  bindings: { CURRENT_VERSION: 'v9.0.0' },
  d1Databases: { DB: 'android' },
  r2Buckets: { UPLOADS: 'u' },
  kvNamespaces: { RATE_LIMIT: 'k' },
  durableObjects: { CHAT_HUB: { className: 'ChatHub', useSQLite: true } },
});

let pass = 0;
let fail = 0;
const ok = (n, c, x = '') => {
  if (c) {
    pass++;
    console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${n}${x ? ' — ' + x : ''}`);
  }
};

const J = (t) => ({ 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) });
const onB = (path, init) => mf.dispatchFetch(B + path, init);
const postB = (path, data, t) => onB(path, { method: 'POST', headers: J(t), body: JSON.stringify(data) });

// ═══ 0. 灌 schema + 直写两个账号 ═══════════════════════════════════════════
console.log('\n【0】准备数据');
const db = await mf.getD1Database('DB');
await db.batch(
  SCHEMA.split(';').map((s) => s.replace(/--[^\n]*/g, '').trim()).filter(Boolean).map((s) => db.prepare(s)),
);

const TOK_PHONE = 'andtok-phone-0001';
const TOK_WEB = 'andtok-web-0002';
for (const [u, t] of [['android_phone', TOK_PHONE], ['web_other', TOK_WEB]]) {
  await db
    .prepare('INSERT INTO users (username, password_hash, nickname, role, token) VALUES (?, ?, ?, 0, ?)')
    .bind(u, 'pbkdf2$placeholder', u, t)
    .run();
}
const cnt = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
ok("D1 就绪，账号已写入", (cnt?.n ?? 0) >= 2, `users=${cnt?.n}`);

await db
  .prepare('INSERT OR IGNORE INTO friends (user_a, user_b) VALUES (?, ?)')
  .bind('android_phone', 'web_other')
  .run();

const hb = await onB('/api/health');
ok('Worker /api/health 正常', hb.status === 200, `status=${hb.status}`);

// ═══ 1. 安卓客户端的真实连接地址 ═══════════════════════════════════════════
console.log('\n【1】按 WebSocketManager.kt 的方式连接');
// 说明：Android 用的是 wss://（见 WebSocketManager.kt 的 replace）。
// 但本处是在 Miniflare 进程内做 dispatchFetch，它只认 http/https，
// 传 ws:// 会直接抛 "Fetch API cannot load"，被 onError 兜成 500。
// 所以这里用 http:// 表达「同一个 URL 路径 + Upgrade: websocket 头」，
// 协议差异由真实网络层处理，不影响被测的握手逻辑与路由匹配。
const wsPath = `/ws/${TOK_PHONE}`;
console.log(`     路径: ${wsPath.replace(TOK_PHONE, '{token}')}   （客户端侧为 wss:// 前缀）`);
const up = await onB(wsPath, { headers: { Upgrade: 'websocket' } });
ok('握手 101', up.status === 101 && up.webSocket != null, `status=${up.status}`);
if (!up.webSocket) {
  console.log('\n⚠️ 握手失败，后续断言跳过');
  await mf.dispose();
  process.exit(1);
}

const got = [];
const sock = up.webSocket;
// 监听必须在 accept() 之前挂上，否则连接时的首批事件会漏掉
await new Promise((r) => {
  sock.addEventListener('message', (e) => {
    try {
      got.push(JSON.parse(e.data));
    } catch {
      /* 忽略非 JSON */
    }
  });
  r();
});
sock.accept();
await new Promise((r) => setTimeout(r, 500));
ok('连接后收到 online_status', got.some((m) => m.type === 'online_status'), got.map((m) => m.type).join(',') || '(无)');

// ═══ 2. 私聊消息字段映射 ═══════════════════════════════════════════════════
console.log('\n【2】收到私聊消息');
const send = await postB('/api/messages', { receiver: 'android_phone', content: '给安卓的消息' }, TOK_WEB);
ok('发送方 HTTP 200', send.status === 200, `status=${send.status} ${(await send.text()).slice(0, 120)}`);
await new Promise((r) => setTimeout(r, 1500));

const m = got.find((x) => x.type === 'message');
ok('收到 type="message"', !!m, got.map((x) => x.type).join(',') || '(无)');
if (m) {
  const d = m.data || {};
  console.log('\n【3】WsMessage.kt / WsData 字段映射');
  const fields = [
    ['id 为数字', typeof d.id === 'number'],
    ['content 正确', d.content === '给安卓的消息'],
    ['name（发送者）', d.name === 'web_other'],
    ['receiver', d.receiver === 'android_phone'],
    ['room_id 为 0（私聊）', d.room_id === 0],
    ['nickname 存在', typeof d.nickname === 'string'],
    ['client_id 字段存在', 'client_id' in d],
    ['can_recall 字段存在', 'can_recall' in d],
    ['can_edit 字段存在', 'can_edit' in d],
    ['read_count 字段存在', 'read_count' in d],
    ['reply_to 字段存在', 'reply_to' in d],
  ];
  for (const [n, c] of fields) ok(n, c);
  console.log(`     实际载荷: ${JSON.stringify(d).slice(0, 300)}`);
}

// ═══ 3. 群消息 ═════════════════════════════════════════════════════════════
console.log('\n【4】群消息广播');
const g = await (await postB('/api/groups', { name: '安卓测试群' }, TOK_WEB)).json();
if (g.id) {
  await postB(`/api/groups/${g.id}/invite`, { usernames: ['android_phone'] }, TOK_WEB);
  got.length = 0;
  await postB('/api/messages', { room_id: g.id, content: '群里的消息' }, TOK_WEB);
  await new Promise((r) => setTimeout(r, 1500));
  const gm = got.find((x) => x.type === 'message');
  ok('安卓端收到群消息', !!gm && gm.data?.room_id === g.id, gm ? `room_id=${gm.data?.room_id}` : '未收到');
} else {
  ok('建群成功', false, JSON.stringify(g).slice(0, 120));
}

// ═══ 4. 撤回事件 ═══════════════════════════════════════════════════════════
console.log('\n【5】撤回事件');
const sent = await (await postB('/api/messages', { receiver: 'android_phone', content: '待撤回' }, TOK_WEB)).json();
got.length = 0;
await onB(`/api/messages/${sent.id}`, { method: 'DELETE', headers: J(TOK_WEB) });
await new Promise((r) => setTimeout(r, 1200));
ok('收到 recall 事件', got.some((x) => x.type === 'recall'), got.map((x) => x.type).join(',') || '(无)');

// ═══ 5. 鉴权边界 ═══════════════════════════════════════════════════════════
console.log('\n【6】鉴权边界');
const bad = await onB('/ws/definitely-not-a-token', { headers: { Upgrade: 'websocket' } });
ok('伪造 token 返回 401（不是 500）', bad.status === 401, `status=${bad.status}`);

// ═══ 6. 两条 URL 带 token 的路径都要能连 ═══════════════════════════════════
console.log('\n【7】URL 携带 token 的两条路径');
const paths = [
  [`/ws/${TOK_WEB}`, '旧版安卓 /ws/{token}'],
  [`/api/ws/${TOK_WEB}`, 'v8 原生 /api/ws/{token}'],
];
for (const [p, label] of paths) {
  const r = await onB(p, { headers: { Upgrade: 'websocket' } });
  ok(`${label} 握手 101`, r.status === 101 && r.webSocket != null, `status=${r.status}`);
  if (r.webSocket) r.webSocket.accept();
}

console.log(`\n${'─'.repeat(52)}\n通过 ${pass} 项，失败 ${fail} 项`);
await mf.dispose();
process.exit(fail === 0 ? 0 : 1);
