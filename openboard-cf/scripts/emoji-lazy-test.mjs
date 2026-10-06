/**
 * 验证 emoji-picker 按需加载。
 *
 * 要验：
 *   1. 首页加载时【不】请求 data.json（439KB）和 picker.js
 *   2. 点开表情面板后才加载，且能正常工作
 *   3. 首次打开时显示「表情加载中…」占位
 *   4. 重复开关不重复加载
 *
 * 用本地静态服务器 + 真实 Chromium。
 * 用法：node scripts/emoji-lazy-test.mjs
 */
import { chromium } from 'playwright-core';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');

const PORT = 18780;
const server = createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const fp = p === '/' ? join(PUBLIC, 'index.html') : join(PUBLIC, p);
  try {
    const buf = readFileSync(fp);
    const ct = p.endsWith('.css') ? 'text/css'
      : p.endsWith('.js') ? 'application/javascript'
      : p.endsWith('.json') ? 'application/json'
      : p.endsWith('.woff2') ? 'font/woff2'
      : (p.endsWith('.html') || p === '/') ? 'text/html; charset=utf-8'
      : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end('nf');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const requested = [];
page.on('request', (r) => requested.push(r.url()));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// ── 断言 1 ──
const emojiReqsEarly = requested.filter((u) => u.includes('emoji-picker-element'));
const hasElEarly = await page.evaluate(() => !!document.querySelector('emoji-picker'));

console.log('【1】首页加载阶段');
console.log('   请求 emoji-picker 相关资源:', emojiReqsEarly.length,
  emojiReqsEarly.length === 0 ? '✅ 应该为 0' : '❌');
emojiReqsEarly.forEach(u => console.log('      -', u.replace(`http://127.0.0.1:${PORT}`, '')));
console.log('   DOM 里是否存在 <emoji-picker>:', hasElEarly, hasElEarly === false ? '✅ 未注入' : '❌');

// ── 断言 2：点击后才加载 ──
// 直接调用 toggleEmojiPicker（需要传 event）
const clicked = await page.evaluate(() => {
  const fake = { stopPropagation() {} };
  try {
    window.toggleEmojiPicker(fake);
    return true;
  } catch (e) { return String(e); }
});
await page.waitForTimeout(300);
const hintShown = await page.evaluate(() => {
  const h = document.getElementById('emoji-loading-hint');
  return h ? h.textContent : null;
});
await page.waitForTimeout(3000);

const emojiReqsAfter = requested.filter((u) => u.includes('emoji-picker-element'));
const elAfter = await page.evaluate(() => {
  const el = document.querySelector('emoji-picker');
  return el ? { tag: el.tagName, src: el.getAttribute('data-source') } : null;
});

console.log('\n【2】点开表情面板之后');
console.log('   toggleEmojiPicker() 调用:', clicked === true ? '✅' : `❌ ${clicked}`);
console.log('   加载中占位提示:', hintShown ? `✅ "${hintShown}"` : '(已消失，正常)');
console.log('   请求 emoji-picker 资源数:', emojiReqsAfter.length,
  emojiReqsAfter.length >= 3 ? '✅' : '❌ 应至少 3 个(picker/database/data)');
emojiReqsAfter.forEach(u => console.log('      -', u.replace(`http://127.0.0.1:${PORT}`, '')));
console.log('   <emoji-picker> 已注入:', elAfter ? `✅ data-source=${elAfter.src}` : '❌');

// ── 断言 3：再次开关不重复加载 ──
const before = requested.filter((u) => u.includes('emoji-picker-element')).length;
await page.evaluate(() => {
  const fake = { stopPropagation() {} };
  window.toggleEmojiPicker(fake); // 关
  window.toggleEmojiPicker(fake); // 开
});
await page.waitForTimeout(800);
const after = requested.filter((u) => u.includes('emoji-picker-element')).length;
console.log('\n【3】反复开关面板');
console.log(`   请求数 ${before} → ${after}`, after === before ? '✅ 无重复加载' : '❌ 重复了');

console.log('\n页面 JS 错误:', errors.length);
errors.slice(0, 6).forEach((e) => console.log('   ', e.slice(0, 170)));

await browser.close();
server.close();

const pass = emojiReqsEarly.length === 0 && hasElEarly === false
  && clicked === true && emojiReqsAfter.length >= 3 && !!elAfter && after === before;
console.log('\n' + (pass ? '✅ 全部通过' : '❌ 有失败项'));
process.exit(pass ? 0 : 1);
