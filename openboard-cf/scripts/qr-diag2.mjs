import { Miniflare } from 'miniflare';
import fs from 'fs';

const mf = new Miniflare({
  modules: true,
  modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
  scriptPath: 'dist/worker.js',
  d1Databases: { DB: 'q' + Date.now() },
  r2Buckets: { UPLOADS: 'q' }, kvNamespaces: { RATE_LIMIT: 'q' },
  durableObjects: { CHAT_HUB: { className: 'ChatHub', useSQLite: true } },
  compatibilityDate: '2024-11-27',
  bindings: { JWT_SECRET: 't', ALLOWED_ADMINS: 'a', PASSWORD_ITERATIONS: '10000' },
  assets: { directory: 'public', binding: 'ASSETS', notFoundHandling: 'single-page-application', runWorkerFirst: ['/api/*'] },
});

const db = await mf.getD1Database('DB');
const SCHEMA = fs.readFileSync('schema.sql', 'utf8');
await db.batch(SCHEMA.split(';').map(s => s.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim()).filter(s => s).map(s => db.prepare(s)));

console.log('--- 无 assets 干扰，逐个测 ---');
for (const p of ['/api/qr/generate', '/api/health', '/api/messages?room_id=0', '/static/vendor/qrcode.min.js']) {
  const r = await mf.dispatchFetch('http://localhost' + p);
  const body = await r.text();
  console.log(String(r.status).padEnd(5), p.padEnd(38), '|', body.slice(0, 80).replace(/\n/g, ' '));
}
await mf.dispose();
