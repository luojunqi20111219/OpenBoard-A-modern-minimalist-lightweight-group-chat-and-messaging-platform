/**
 * 验证 html5-qrcode 按需加载是否正常工作。
 *
 * 要验三件事：
 *   1. 首页加载时不请求 html5-qrcode.min.js（这才是优化的意义）
 *   2. 点「开启摄像头」后才发起该请求，且加载成功
 *   3. window.Html5Qrcode 加载后确实可用（能实例化）
 *
 * 用法：node scripts/qr-lazy-test.mjs
 */
import { chromium } from 'playwright-core';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');

const PORT = 18778;
const server = createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  let fp = p === '/' ? join(PUBLIC, 'index.html') : join(PUBLIC, p);
  try {
    const buf = readFileSync(fp);
    const ct = p.endsWith('.css')
      ? 'text/css'
      : p.endsWith('.js')
        ? 'application/javascript'
        : p.endsWith('.json')
          ? 'application/json'
          : p.endsWith('.woff2')
            ? 'font/woff2'
            : p.endsWith('.html') || p === '/'
              ? 'text/html; charset=utf-8'
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

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// ── 断言 1：首页没请求 html5-qrcode ──
const early = requested.filter((u) => u.includes('html5-qrcode'));
const hasGlobalEarly = await page.evaluate(() => typeof window.Html5Qrcode);

console.log('【1】首页加载阶段');
console.log('   请求 html5-qrcode.min.js 次数:', early.length, early.length === 0 ? '✅' : '❌ 应该为 0');
console.log('   window.Html5Qrcode 类型:', hasGlobalEarly, hasGlobalEarly === 'undefined' ? '✅ 未加载' : '❌ 不该提前加载');

// ── 断言 2：调用 ensureHtml5Qrcode 后才加载 ──
const loaded = await page.evaluate(async () => {
  try {
    await window.ensureHtml5Qrcode?.();
    return { ok: !!window.Html5Qrcode, err: null };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
});
await page.waitForTimeout(500);

const after = requested.filter((u) => u.includes('html5-qrcode'));

console.log('\n【2】调用 ensureHtml5Qrcode() 之后');
console.log('   请求 html5-qrcode.min.js 次数:', after.length, after.length >= 1 ? '✅' : '❌ 应该至少 1 次');
console.log('   window.Html5Qrcode 已加载:', loaded.ok ? '✅' : `❌ ${loaded.err}`);

// ── 断言 3：能实例化 ──
const usable = await page.evaluate(() => {
  try {
    // 造个容器，避免 Html5Qrcode 因为找不到元素而抛「元素不存在」
    const d = document.createElement('div');
    d.id = '__qr_probe__';
    document.body.appendChild(d);
    const inst = new window.Html5Qrcode('__qr_probe__');
    const ok = typeof inst.scanFile === 'function' && typeof inst.start === 'function';
    d.remove();
    return ok;
  } catch (e) {
    return 'ERR: ' + String(e);
  }
});
console.log('\n【3】能否实例化并拿到 scanFile/start');
console.log('   结果:', usable, usable === true ? '✅' : '❌');

// ── 断言 4：重复调用不重复加载 ──
const before = requested.filter((u) => u.includes('html5-qrcode')).length;
await page.evaluate(() => window.ensureHtml5Qrcode());
await page.evaluate(() => window.ensureHtml5Qrcode());
await page.waitForTimeout(400);
const after2 = requested.filter((u) => u.includes('html5-qrcode')).length;
console.log('\n【4】重复调用 ensureHtml5Qrcode() 3 次');
console.log(`   请求次数 ${before} → ${after2}`, after2 === before ? '✅ 无重复加载' : '❌ 重复了');

console.log('\n页面 JS 错误:', errors.length);
errors.slice(0, 5).forEach((e) => console.log('   ', e.slice(0, 160)));

await browser.close();
server.close();

const pass = early.length === 0 && hasGlobalEarly === 'undefined' && loaded.ok && usable === true && after2 === before && errors.length === 0;
console.log('\n' + (pass ? '✅ 全部通过' : '❌ 有失败项'));
process.exit(pass ? 0 : 1);
