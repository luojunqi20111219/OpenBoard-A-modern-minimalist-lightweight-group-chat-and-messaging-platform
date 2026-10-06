import { chromium } from 'playwright-core';
const exec = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const HOST = 'liuyan.luojunqi.xyz', EDGE = '104.17.2.229';
const b = await chromium.launch({ executablePath: exec,
  args: ['--no-sandbox','--disable-dev-shm-usage',`--host-resolver-rules=MAP ${HOST} ${EDGE}`,'--ignore-certificate-errors'] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const bad = [];
page.on('response', r => { if (r.status() >= 400) bad.push(r.status() + '  ' + r.url()); });
await page.goto('https://' + HOST + '/?t=' + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);
console.log('=== 4xx/5xx 响应 ===');
if (!bad.length) console.log('  无 ✅');
else [...new Set(bad)].forEach(x => console.log('  ' + x));
await b.close();
