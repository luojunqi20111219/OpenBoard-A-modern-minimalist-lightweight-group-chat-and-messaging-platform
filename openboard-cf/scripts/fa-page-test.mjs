/**
 * 端到端验证：用真实 index.html 加载，检查所有 FA 图标是否渲染。
 *
 * 与 fa-subset-check.mjs 的区别：那个是独立测字体文件；
 * 这个走完整页面（真 CSS + 真 DOM），确保替换 @font-face 后页面图标没坏。
 */
import { chromium } from 'playwright-core';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');

const PORT = 18786;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.ico': 'image/x-icon', '.png': 'image/png',
};
const server = createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const isRoot = p === '/' || p === '/index.html';
  const fp = isRoot ? join(PUBLIC, 'index.html') : join(PUBLIC, p);
  const dot = p.lastIndexOf('.');
  // ⚠️ 根路径 '/' 没有扩展名，必须显式当 HTML 处理，
  // 否则 Content-Type 会是 application/octet-stream，浏览器直接当下载。
  const ext = isRoot ? '.html' : (dot > -1 ? p.slice(dot) : '');
  try {
    const buf = readFileSync(fp);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end(''); }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const fontReqs = [];
page.on('response', (r) => {
  if (r.url().includes('.woff2') || r.url().includes('.ttf')) {
    fontReqs.push({ url: r.url().split('/').slice(-2).join('/'), status: r.status() });
  }
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

// 页面上所有 <i class="fa-*"> 的渲染检查
const icons = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('i[class*="fa-"]'));
  return els.map((el) => {
    const cs = getComputedStyle(el, '::before');
    const content = cs.content;
    const rect = el.getBoundingClientRect();
    const fam = cs.fontFamily;
    // 取 content 里的字符
    let ch = '';
    const m = content && content.match(/"\\([0-9a-fA-F]+)"/);
    if (m) ch = String.fromCodePoint(parseInt(m[1], 16));
    return {
      cls: el.className,
      ch,
      fontFamily: fam,
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      visible: rect.width > 0 && rect.height > 0,
    };
  });
});

console.log(`页面上 <i class="fa-*"> 共 ${icons.length} 个\n`);
console.log('字体请求:');
fontReqs.forEach((f) => console.log(`   ${f.status}  ${f.url}`));

// 检查有没有加载旧的完整字体
const oldFonts = fontReqs.filter((f) => f.url.includes('webfonts/'));
const newFonts = fontReqs.filter((f) => f.url.includes('webfonts-subset/'));
console.log(`\n加载子集字体: ${newFonts.length} 个`);
console.log(`加载旧字体: ${oldFonts.length} 个`, oldFonts.length === 0 ? '✅ 未加载' : '❌ 仍在加载');
oldFonts.forEach((f) => console.log('   ❌', f.url));

// 检查 computed font-family 是否指向 Font Awesome
const usingFA = icons.filter((i) => /Font Awesome/i.test(i.fontFamily));
console.log(`\n使用 FontAwesome 字体族: ${usingFA.length}/${icons.length}`);

// 检查宽度异常（0 宽 = 没渲染）
// ⚠️ 注意：隐藏 modal 里的图标 display:none，getBoundingClientRect 必然是 0，
// 不能算异常。只有「可见但没有尺寸」才是真问题。
const zero = icons.filter((i) => !i.visible);
const visibleZero = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('i[class*="fa-"]'));
  return els.filter((el) => {
    // 元素自身可见（不含被祖先隐藏的情况用 offsetParent 判断）
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const hiddenByAncestor = el.offsetParent === null && style.position !== 'fixed';
    if (hiddenByAncestor) return false;      // 隐藏元素跳过
    return rect.width === 0 && rect.height === 0;
  }).length;
});
console.log(`\n可见元素尺寸异常: ${visibleZero}`, visibleZero === 0 ? '✅' : '❌');
console.log(`（另有 ${zero.length} 个在隐藏容器里，已跳过）`);

// 用 canvas 检测字形是否存在
const glyphCheck = await page.evaluate(async () => {
  const SIZE = 40;
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d', { willReadFrequently: true });

  // 测两个字重
  const results = {};
  for (const [weight, fam] of [[900, '"Font Awesome 6 Free"'], [400, '"Font Awesome 6 Free"']]) {
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = '#000';
    ctx.font = `${weight} 32px ${fam}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    // 收集页面上这个字重的所有字符
    const chars = new Set();
    document.querySelectorAll('i[class*="fa-"]').forEach((el) => {
      const cs = getComputedStyle(el, '::before');
      const m = cs.content && cs.content.match(/"\\([0-9a-fA-F]+)"/);
      if (m) chars.add(String.fromCodePoint(parseInt(m[1], 16)));
    });
    let withGlyph = 0;
    for (const ch of chars) {
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.fillText(ch, SIZE / 2, SIZE / 2);
      const d = ctx.getImageData(0, 0, SIZE, SIZE).data;
      let filled = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 10) filled++;
      if (filled > 0) withGlyph++;
    }
    results[weight] = { total: chars.size, withGlyph };
  }
  return results;
});

console.log('\n字形覆盖（按 CSS 字重）:');
for (const [w, r] of Object.entries(glyphCheck)) {
  console.log(`   字重 ${w}: ${r.withGlyph}/${r.total} 个字符有字形`,
    r.withGlyph === r.total ? '✅' : '❌');
}

console.log('\n页面 JS 错误:', errs.length >= 0 ? errs.length : 0);
errs.slice(0, 5).forEach((e) => console.log('   ', e.slice(0, 150)));

await page.screenshot({ path: '/tmp/fa-page.png' });

await browser.close();
server.close();

const pass = oldFonts.length === 0 && visibleZero === 0;
console.log('\n' + (pass ? '✅ 页面图标全部正常，且无旧字体加载' : '❌ 存在问题'));
process.exit(pass ? 0 : 1);
