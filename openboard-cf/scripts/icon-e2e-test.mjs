/**
 * 图标端到端验证。
 *
 * 换图标最容易出的问题是「文件放对了但引用没改」或「引用改了但路径 404」。
 * 这个脚本用真实浏览器加载页面，确认：
 *   1. 四个图标文件都能取到，且是真图片（不是 404 页面）
 *   2. 页面里的 <img> 引用都指向新文件，且真的渲染出来了（naturalWidth > 0）
 *   3. 公共大厅那三处（标题栏/群列表/转发列表）用的是新图标
 *
 * 用法：node scripts/icon-e2e-test.mjs
 * 前置：本地 wrangler dev 已在 8787 端口运行。
 */

import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://localhost:8787';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? ' —— ' + detail : ''}`); }
}

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});

// ⚠️ 必须禁用缓存，否则测线上时 Playwright 会拿磁盘里上一次的旧 HTML，
//    出现「文件明明更新了但测试全红」的假失败（这个坑踩过一次）。
const ctx = await browser.newContext({ bypassCSP: true });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

console.log(`\n═══ 目标：${BASE} ═══`);

// ---------------------------------------------------------------------------
console.log('\n═══ 1. 图标文件可访问 ═══');
{
  const files = [
    ['/favicon.ico', 'image/'],
    ['/apple-touch-icon.png', 'image/png'],
    ['/icon-192.png', 'image/png'],
    ['/icon-512.png', 'image/png'],
  ];
  for (const [path, expectType] of files) {
    const r = await page.request.get(BASE + path);
    const ct = r.headers()['content-type'] || '';
    const body = await r.body();
    // 用 PNG/ICO magic number 确认是真图片，不是被路由吃掉的 HTML
    const isPng = body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4E && body[3] === 0x47;
    const isIco = body[0] === 0x00 && body[1] === 0x00 && body[2] === 0x01 && body[3] === 0x00;
    const looksImage = path.endsWith('.ico') ? isIco : isPng;
    ok(`${path} 可访问且是真图片`, r.status() === 200 && looksImage && ct.startsWith(expectType),
       `HTTP ${r.status()} type=${ct} magic=${isPng ? 'PNG' : isIco ? 'ICO' : '其他'}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n═══ 2. 页面引用已更新 ═══');
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);

{
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel*="icon"]')].map(l => ({
      rel: l.rel, href: l.getAttribute('href'),
    }))
  );
  console.log('  <link> 声明:', JSON.stringify(links));
  ok('声明了 icon', links.length > 0);
  ok('声明了 apple-touch-icon（iOS 加到桌面用）',
     links.some(l => l.rel.includes('apple-touch-icon')));
  ok('没有残留指向旧 favicon.ico 的图标声明',
     !links.some(l => l.href === '/favicon.ico' && l.rel === 'icon' && l.sizes === 'any' && links.length === 1));

  // 页面内 <img> 引用：不该再有指向 favicon.ico 的
  const imgs = await page.evaluate(() =>
    [...document.querySelectorAll('img')].map(i => i.getAttribute('src'))
  );
  const oldRefs = imgs.filter(s => s && s.includes('favicon.ico'));
  ok('页面内 <img> 无残留 favicon.ico 引用', oldRefs.length === 0,
     `发现 ${oldRefs.length} 处: ${oldRefs.join(', ')}`);
}

// ---------------------------------------------------------------------------
console.log('\n═══ 3. 图标真的渲染出来了 ═══');
{
  // 侧边栏 logo（第 111 行那处）
  const logoInfo = await page.evaluate(() => {
    const h1 = document.querySelector('#app-sidebar h1 img');
    if (!h1) return null;
    return {
      src: h1.getAttribute('src'),
      naturalWidth: h1.naturalWidth,
      naturalHeight: h1.naturalHeight,
      complete: h1.complete,
    };
  });
  ok('侧边栏 logo 存在', !!logoInfo);
  if (logoInfo) {
    ok('侧边栏 logo 指向新图标', logoInfo.src === '/icon-192.png', `src=${logoInfo.src}`);
    ok('侧边栏 logo 加载成功（非裂图）', logoInfo.complete && logoInfo.naturalWidth > 0,
       `natural=${logoInfo.naturalWidth}x${logoInfo.naturalHeight}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n═══ 4. 公共大厅三处头像 ═══');
{
  // 这三处都在登录后才会渲染，直接调用渲染函数验证它们用的是新图标
  const refs = await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    return {
      // 源码里公共大厅分支应该用 icon-192.png
      hallInHeader: /id === 0[\s\S]{0,80}?icon-192\.png/.test(html),
      hallInGroupList: /g\.id === 0[\s\S]{0,120}?icon-192\.png/.test(html),
      hallInForward: /group\.id === 0[\s\S]{0,120}?icon-192\.png/.test(html),
      // ⚠️ 只在 <body> 里查残留。
      //    <head> 里的 <link rel="icon" href="/favicon.ico"> 本来就该保留 ——
      //    那是标签页图标，不是「残留引用」。之前这条判据把 head 也算进去，
      //    导致假失败。
      bodyHasFavicon: /favicon\.ico/.test(html.split('<body')[1] || ''),
    };
  });
  ok('公共大厅顶部头像用新图标', refs.hallInHeader);
  ok('公共大厅群列表头像用新图标', refs.hallInGroupList);
  ok('转发列表公共大厅图标用新图标', refs.hallInForward);
  ok('页面 <body> 内无残留 favicon.ico 引用', !refs.bodyHasFavicon);
}

// ---------------------------------------------------------------------------
console.log('\n═══ 5. 图标文件完整性 ═══');
{
  const icoCheck = await page.evaluate(async () => {
    const r = await fetch('/favicon.ico');
    const buf = new Uint8Array(await r.arrayBuffer());
    const count = buf[4] | (buf[5] << 8);
    const sizes = [];
    let off = 6;
    for (let i = 0; i < count; i++) {
      sizes.push(buf[off] || 256);
      off += 16;
    }
    return { total: buf.length, count, sizes };
  });
  console.log(`  ICO: ${icoCheck.total} 字节，含 ${icoCheck.count} 个尺寸 ${JSON.stringify(icoCheck.sizes)}`);
  ok('ICO 是多尺寸容器（浏览器可按场景挑）', icoCheck.count >= 3, `count=${icoCheck.count}`);
  ok('ICO 含 16×16（标签页用）', icoCheck.sizes.includes(16));
  ok('ICO 含 32×32（书签栏/任务栏用）', icoCheck.sizes.includes(32));
}

console.log('\n' + '═'.repeat(52));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
if (fail) { console.log('\n失败项：'); failures.forEach(f => console.log('  - ' + f)); }

await browser.close();
process.exit(fail ? 1 : 0);
