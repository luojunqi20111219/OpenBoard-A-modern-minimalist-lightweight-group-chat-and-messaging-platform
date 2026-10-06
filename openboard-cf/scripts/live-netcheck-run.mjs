import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox','--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type()==='error') errs.push('C: '+m.text().slice(0,100)); });

// 直接访问线上（同源，无 CORS 问题）
await page.goto('https://liuyan.luojunqi.xyz/netcheck', { waitUntil:'domcontentloaded', timeout:60000 });
await page.click('#btn');
await page.waitForTimeout(50000);

console.log('总分:', await page.textContent('#scoreTxt'));
console.log('提示:', await page.textContent('#scoreHint'));
console.log();
const rows = await page.$$eval('#results .row', els => els.map(e => ({
  c: e.className.replace('row ',''),
  n: e.querySelector('.name')?.textContent||'',
  d: e.querySelector('.detail')?.textContent||'',
})));
rows.forEach(r => console.log(`[${r.c}] ${r.n}\n      ${r.d}`));
console.log('\nJS 错误:', errs.length);
errs.slice(0,4).forEach(e=>console.log('   ',e));
await browser.close();
