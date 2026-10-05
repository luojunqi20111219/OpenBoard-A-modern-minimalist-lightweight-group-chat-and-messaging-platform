#!/usr/bin/env node
/**
 * 时区修复的端到端验收（用真实 dist/worker.js 跑）。
 *
 * 为什么需要它：timezone-test.mjs 是单元级断言；这个脚本跑的是
 * **完整的注册 → 登录 → 发消息 → 拉列表** 链路，直接断言语义：
 *   「服务端返回的 time 解析后必须 ≈ 现在（误差 < 60s）」
 * 这正是修复前会失败的断言（那时差 8 小时 = 28800s）。
 *
 * 用法：node scripts/tz-local-e2e.mjs
 */
import { Miniflare } from 'miniflare';
import fs from 'fs';
import path from 'path';

const mf = new Miniflare({
  modules: true,
  modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
  scriptPath: 'dist/worker.js',
  compatibilityDate: '2024-11-01',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'openboard-db' },
  kvNamespaces: ['RATE_LIMIT'],
  r2Buckets: ['UPLOADS'],
  durableObjects: { CHAT_HUB: { className: 'ChatHub', useSQLite: true } },
  bindings: {
    JWT_SECRET: 'test-secret-tz-live',
    ALLOWED_ADMINS: '官方账号',
    PUBLIC_UPLOADS: 'true',
    CURRENT_VERSION: 'v10.3.0',
    PASSWORD_ITERATIONS: '10000',
  },
});

const BASE = 'http://localhost';
const SCHEMA = fs.readFileSync('schema.sql', 'utf8');

async function j(res) { const t = await res.text(); try { return JSON.parse(t); } catch { return { __raw: t }; } }

// 先建表（Miniflare 的 D1 是空库）
{
  const db0 = await mf.getD1Database('DB');
  const stmts = SCHEMA.split(';')
    .map((x) => x.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
    .filter((x) => x.length > 0);
  await db0.batch(stmts.map((x) => db0.prepare(x)));
  console.log('schema 已建，共', stmts.length, '条语句');
}

const localNow = Date.now();
console.log('本机现在(东八区):', new Date(localNow).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
console.log('');

const u = 'tz' + Math.random().toString(36).slice(2, 7);
const p = 'Tz1234!Pass';

let r = await mf.dispatchFetch(BASE + '/api/register', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: u, password: p, nickname: u }),
});
console.log('注册:', r.status, JSON.stringify(await j(r)).slice(0, 150));

r = await mf.dispatchFetch(BASE + '/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: u, password: p }),
});
const lj = await j(r);
console.log('登录:', r.status, JSON.stringify(lj).slice(0, 200));
const token = lj.token || lj.access_token || (lj.data && lj.data.token);

const auth = { 'content-type': 'application/json', authorization: 'Bearer ' + token };
r = await mf.dispatchFetch(BASE + '/api/messages', {
  method: 'POST', headers: auth,
  body: JSON.stringify({ room_id: 0, content: 'tz check ' + Date.now() }),
});
const sj = await j(r);
console.log('发消息:', r.status, JSON.stringify(sj).slice(0, 300));

// 发消息接口本身不回 time，改从**消息列表**取（这才是客户端渲染用的数据）
const lr = await mf.dispatchFetch(BASE + '/api/messages?room_id=0&limit=5', { headers: auth });
const lj3 = await j(lr);
const arr = Array.isArray(lj3) ? lj3 : (lj3.messages || lj3.data || []);
console.log('');
console.log('拉取消息列表:', lr.status, '条数=', arr.length);
if (arr.length) console.log('第一条原始:', JSON.stringify(arr[arr.length - 1]).slice(0, 300));
const last = arr[arr.length - 1] || {};
const t = last.time || last.created_at;

console.log('');
console.log('════════════ 关键结果 ════════════');
console.log('服务端返回 time   :', JSON.stringify(t));
console.log('末尾带 Z 吗       :', /[Zz]$/.test(String(t)) ? 'YES ✅' : 'NO ❌');

const parsed = Date.parse(String(t));
const drift = Math.abs(parsed - Date.now()) / 1000;
console.log('按东八区显示      :', new Date(parsed).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
console.log('与现在偏差(秒)    :', drift.toFixed(1));
console.log('判定              :', drift < 60 ? '✅ 时间正确（不再早 8 小时）' : '❌ 偏差 ' + (drift / 3600).toFixed(1) + ' 小时');

// 数据库里落库的必须是裸 UTC
const db = await mf.getD1Database('DB');
const row = await db.prepare('SELECT created_at FROM messages ORDER BY id DESC LIMIT 1').first();
console.log('');
console.log('落库 created_at(应无 Z):', JSON.stringify(row?.created_at));

// 日聚合口径不能坏
const agg = await db.prepare("SELECT date('now') AS today").first();
console.log("SQLite date('now') :", JSON.stringify(agg?.today));

await mf.dispose();
