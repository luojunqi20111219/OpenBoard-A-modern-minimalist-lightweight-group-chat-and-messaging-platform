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
const mf = new Miniflare({
  scriptPath: join(ROOT, 'dist/worker.js'),
  modules: true,
  compatibilityDate: '2024-11-27',
  d1Databases: { DB: 'preflight-db' },
  r2Buckets: { UPLOADS: 'openboard-uploads' },
  kvNamespaces: { RATE_LIMIT: 'preflight-kv' },
  durableObjects: { CHAT_HUB: { className: 'ChatHub', useSQLite: true } },
  bindings: {
    CURRENT_VERSION: 'v8.0.0',
    PUBLIC_UPLOADS: 'true',
    ALLOWED_ADMINS: '官方账号,Forest_siri,Forest_Brian_Birch',
    MAX_CONNECTIONS_PER_USER: '4',
  },
});

// --- 灌入表结构 --------------------------------------------------------------
{
  const db = await mf.getD1Database('DB');
  const stmts = SCHEMA.split(';')
    .map((s) => s.replace(/--[^\n]*/g, '').trim())
    .filter(Boolean)
    .map((s) => db.prepare(s));
  await db.batch(stmts);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").first();
  console.log(`  D1 已初始化：${n?.n ?? '?'} 张表`);
}

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

const req = (path, init) => mf.dispatchFetch(BASE + path, init);
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
