// 登录态下抓 4xx/5xx，定位那条 404 到底是谁
import { chromium } from 'playwright-core';
const exec = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const HOST = 'liuyan.luojunqi.xyz', EDGE = '104.17.2.229';
const b = await chromium.launch({ executablePath: exec,
  args: ['--no-sandbox','--disable-dev-shm-usage',`--host-resolver-rules=MAP ${HOST} ${EDGE}`,'--ignore-certificate-errors'] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const bad = [];
page.on('response', r => { if (r.status() >= 400) bad.push(r.status() + '  ' + r.request().method() + '  ' + r.url()); });

const u = 'w404' + Math.random().toString(36).slice(2, 7);
const p = 'WebTest1234!Pass';

await page.goto('https://' + HOST + '/?t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);
await page.evaluate(async (a) => {
  await fetch('/api/register', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ username:a.u, password:a.p, nickname:a.u, remember_me:true, device_id:'d', device_name:'D' }) });
  const r = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ username:a.u, password:a.p, remember_me:true, device_id:'d', device_name:'D' }) });
  const j = await r.json();
  if (typeof enterAuthenticatedSession === 'function') enterAuthenticatedSession(j, true);
}, { u, p });
await page.waitForTimeout(7000);

console.log('=== 登录态下 4xx/5xx ===');
if (!bad.length) console.log('  无 ✅');
else [...new Set(bad)].forEach(x => console.log('  ' + x));
await b.close();
