/**
 * 接口返回格式一致性验证。
 *
 * 背景：这轮修掉了一类系统性 bug —— 后端有一批接口返回【裸数组】，
 * 而前端 index.html 统一按 {status, data} 包装格式解析。
 * 结果就是功能静默失效：不报错、不崩溃，只是永远显示「暂无数据」。
 *
 * 这个脚本把每个受影响接口的实际返回拿下来，逐项断言
 * 「前端要用的每个字段是否真的存在」，防止以后再有人改回去。
 *
 * 用法：node scripts/api-shape-test.mjs
 * 前置：本地 wrangler dev 已在 8787 端口运行，且数据库已初始化。
 */

const BASE = 'http://localhost:8787';

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? ' —— ' + detail : ''}`); }
}

async function req(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = token;
  const r = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, raw: text };
}

// ---------------------------------------------------------------------------
console.log('\n═══ 准备测试数据 ═══');

const USER = 'shape_test_user';
const PW = 'Shape8888!Pass';

await req('/api/register', { method: 'POST', body: { username: USER, password: PW, nickname: '格式测试' } });
const login = await req('/api/login', { method: 'POST', body: { username: USER, password: PW } });
const TOKEN = login.json?.token;
ok('登录拿到 token', !!TOKEN, `status=${login.status} body=${login.raw.slice(0, 120)}`);
if (!TOKEN) { console.log('\n无法登录，后续测试跳过'); process.exit(1); }

// 造一条公告 + 一条收藏表情 + 一条会话设置 + 一条登录记录
// 公告走管理员接口太重，这里直接依赖 /api/notifications 的 target_user IS NULL 广播查询
// 由注册流程本身产生的通知也够用；为了确保列表非空，这里再触发一次好友请求类通知。
// 简化：只要接口格式对就行，空数组同样能验证字段存在性。

// ---------------------------------------------------------------------------
console.log('\n═══ 1. GET /api/notifications（系统公告）═══');
{
  const r = await req('/api/notifications', { token: TOKEN });
  ok('HTTP 200', r.status === 200, `got ${r.status}`);
  ok('不是裸数组（后端已包装）', !Array.isArray(r.json), `typeof=${Array.isArray(r.json) ? 'array' : typeof r.json}`);
  ok('有 status 字段且为 success', r.json?.status === 'success', `status=${r.json?.status}`);
  ok('有 data 字段且为数组', Array.isArray(r.json?.data), `data=${JSON.stringify(r.json?.data)?.slice(0, 60)}`);
  ok('有 last_read_id 字段（小红点判定用）', 'last_read_id' in (r.json || {}), `keys=${Object.keys(r.json || {})}`);
}

console.log('\n═══ 2. GET /api/favorites/emojis（收藏表情）═══');
{
  // 先加一个，确保列表非空
  await req('/api/favorites/emojis', { method: 'POST', token: TOKEN, body: { emoji: '😀' } });
  const r = await req('/api/favorites/emojis', { token: TOKEN });
  ok('HTTP 200', r.status === 200, `got ${r.status}`);
  ok('不是裸数组', !Array.isArray(r.json));
  ok('status === success', r.json?.status === 'success', `status=${r.json?.status}`);
  ok('data 是数组', Array.isArray(r.json?.data), `data=${JSON.stringify(r.json?.data)?.slice(0, 60)}`);
  ok('data 里确实有刚加的表情', Array.isArray(r.json?.data) && r.json.data.includes('😀'),
     `data=${JSON.stringify(r.json?.data)}`);
}

console.log('\n═══ 3. GET /api/user/login-history（登录记录）═══');
{
  const r = await req('/api/user/login-history', { token: TOKEN });
  ok('HTTP 200', r.status === 200, `got ${r.status}`);
  ok('不是裸数组', !Array.isArray(r.json));
  ok('status === success', r.json?.status === 'success', `status=${r.json?.status}`);
  ok('data 是数组（前端读 history.data）', Array.isArray(r.json?.data),
     `实际 keys=${Object.keys(r.json || {})}`);
  ok('有内容（刚才登录过）', Array.isArray(r.json?.data) && r.json.data.length > 0,
     `length=${r.json?.data?.length}`);
}

console.log('\n═══ 4. GET /api/conversation-settings（会话置顶/免打扰）═══');
{
  const r = await req('/api/conversation-settings', { token: TOKEN });
  ok('HTTP 200', r.status === 200, `got ${r.status}`);
  ok('不是裸数组', !Array.isArray(r.json));
  ok('status === success', r.json?.status === 'success', `status=${r.json?.status}`);
  ok('data 是数组（前端读 result.data）', Array.isArray(r.json?.data),
     `实际 keys=${Object.keys(r.json || {})}`);
}

console.log('\n═══ 5. GET /api/users（用户列表 + 拉黑列表）═══');
{
  const r = await req('/api/users', { token: TOKEN });
  ok('HTTP 200', r.status === 200, `got ${r.status}`);
  ok('不是裸数组', !Array.isArray(r.json));
  ok('status === success（前端 if 依赖它）', r.json?.status === 'success', `status=${r.json?.status}`);
  ok('有 blocked_users 字段（前端盖「已拉黑」红标用）', Array.isArray(r.json?.blocked_users),
     `blocked_users=${JSON.stringify(r.json?.blocked_users)}`);
  ok('data 是数组', Array.isArray(r.json?.data), `实际 keys=${Object.keys(r.json || {})}`);
}

console.log('\n═══ 6. GET /api/favorites/messages（收藏消息）═══');
{
  const r = await req('/api/favorites/messages', { token: TOKEN });
  ok('HTTP 200', r.status === 200, `got ${r.status}`);
  ok('不是裸数组', !Array.isArray(r.json));
  ok('status === success', r.json?.status === 'success', `status=${r.json?.status}`);
  ok('data 是数组（前端读 result.data）', Array.isArray(r.json?.data),
     `实际 keys=${Object.keys(r.json || {})}`);
}

console.log('\n═══ 7. GET /api/messages/:id/reads（已读回执）═══');
{
  // 需要一条真实消息 id；没有就用 1，接口对不存在的 id 也应返回规范结构
  const r = await req('/api/messages/1/reads', { token: TOKEN });
  ok('HTTP 200', r.status === 200, `got ${r.status}`);
  ok('不是裸数组', !Array.isArray(r.json));
  ok('status === success', r.json?.status === 'success', `status=${r.json?.status}`);
  ok('data 是数组（前端读 result.data）', Array.isArray(r.json?.data),
     `实际 keys=${Object.keys(r.json || {})}`);
}

// ---------------------------------------------------------------------------
console.log('\n' + '═'.repeat(52));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部通过 —— 前后端返回格式已一致。');
