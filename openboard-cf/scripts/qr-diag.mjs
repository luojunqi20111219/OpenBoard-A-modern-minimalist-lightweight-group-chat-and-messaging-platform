// 诊断二维码接口：本地 Miniflare 跑真实 bundle
import { Miniflare } from 'miniflare';
import fs from 'fs';

const mf = new Miniflare({
  modules: true,
  modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
  scriptPath: 'dist/worker.js',
  d1Databases: { DB: 'qr-' + Math.random().toString(36).slice(2) },
  r2Buckets: { UPLOADS: 'qr-test' },
  kvNamespaces: { RATE_LIMIT: 'qr-test' },
  durableObjects: { CHAT_HUB: { className: 'ChatHub', useSQLite: true } },
  compatibilityDate: '2024-11-27',
  bindings: { JWT_SECRET: 't', ALLOWED_ADMINS: '官方账号', CURRENT_VERSION: 'v10.3.1', PASSWORD_ITERATIONS: '10000' },
});

const db = await mf.getD1Database('DB');
const SCHEMA = fs.readFileSync('schema.sql', 'utf8');
const stmts = SCHEMA.split(';').map(s => s.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim()).filter(s => s);
await db.batch(stmts.map(s => db.prepare(s)));

console.log('=== 1. 静态资源 /static/vendor/qrcode.min.js ===');
for (const p of ['/static/vendor/qrcode.min.js', '/static/vendor/html5-qrcode.min.js']) {
  const r = await mf.dispatchFetch('http://localhost' + p);
  console.log('  ', p, '->', r.status, (r.headers.get('content-type') || ''));
}

console.log('');
console.log('=== 2. /api/qr/generate ===');
const g = await mf.dispatchFetch('http://localhost/api/qr/generate');
const gt = await g.text();
console.log('   status =', g.status);
console.log('   body   =', gt.slice(0, 200));

console.log('');
console.log('=== 3. /api/qr/status ===');
let qid = null;
try { qid = JSON.parse(gt).qr_id; } catch {}
if (qid) {
  const s = await mf.dispatchFetch('http://localhost/api/qr/status?qr_id=' + qid);
  console.log('   status =', s.status, 'body =', (await s.text()).slice(0, 200));
}

await mf.dispose();
