/**
 * 子集字体验证 —— 让浏览器自己做像素对比（不依赖 pngjs）。
 *
 * 原理：把原字体和子集字体渲染到两个离屏 canvas，读像素做 diff。
 * 关键：必须用 FontFace API 显式加载字体，并等 status === 'loaded'。
 */
import { chromium } from 'playwright-core';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');

const ICONS = {
  'address-card': [0xf2bb, 900], ban: [0xf05e, 900], bars: [0xf0c9, 900],
  bell: [0xf0f3, 900], camera: [0xf030, 900], check: [0xf00c, 900],
  'chevron-right': [0xf054, 900], 'cloud-arrow-up': [0xf0ee, 900],
  compass: [0xf14e, 900], copy: [0xf0c5, 400], crown: [0xf521, 900],
  download: [0xf019, 900], 'face-smile': [0xf118, 400],
  'file-arrow-down': [0xf56d, 900], 'file-export': [0xf56e, 900],
  'file-import': [0xf56f, 900], 'folder-open': [0xf07c, 900],
  gamepad: [0xf11b, 900], gear: [0xf013, 900], hashtag: [0x23, 900],
  image: [0xf03e, 900], laptop: [0xf109, 900],
  'magnifying-glass': [0xf002, 900], 'paper-plane': [0xf1d8, 900],
  paperclip: [0xf0c6, 900], plus: [0x2b, 900],
  'right-from-bracket': [0xf2f5, 900], share: [0xf064, 900],
  star: [0xf005, 400], thumbtack: [0xf08d, 900],
  'user-minus': [0xf503, 900], 'user-plus': [0xf234, 900],
  users: [0xf0c0, 900], xmark: [0xf00d, 900],
};

const PORT = 18785;
const server = createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>fa-test</title></head><body>ok</body></html>');
  }
  const fp = join(PUBLIC, p);
  try {
    const buf = readFileSync(fp);
    res.writeHead(200, {
      'Content-Type': p.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  } catch { res.writeHead(404); res.end(''); }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${PORT}/static/vendor/fontawesome`;

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
// ⚠️ 必须在同源页面里跑。about:blank 下 FontFace 加载跨域字体
// 会报 "A network error occurred"（Chrome 的同源策略）。
// 所以先导航到本地服务器上的一个真实路径。
await page.goto(`http://127.0.0.1:${PORT}/`, {
  waitUntil: 'domcontentloaded',
});

const out = await page.evaluate(async ({ ICONS, base }) => {
  // 用 FontFace API 显式加载四个字体
  const defs = [
    ['FOrig900', `${base}/webfonts/fa-solid-900.woff2`, 900],
    ['FOrig400', `${base}/webfonts/fa-regular-400.woff2`, 400],
    ['FSub900', `${base}/webfonts-subset/fa-solid-900.woff2`, 900],
    ['FSub400', `${base}/webfonts-subset/fa-regular-400.woff2`, 400],
  ];
  const loadLog = [];
  for (const [fam, url, w] of defs) {
    try {
      const ff = new FontFace(fam, `url(${url})`, { weight: String(w) });
      const loaded = await ff.load();
      document.fonts.add(loaded);
      loadLog.push(`${fam}: ${loaded.status}`);
    } catch (e) {
      loadLog.push(`${fam}: FAIL ${e.message}`);
    }
  }
  await document.fonts.ready;

  const SIZE = 48;
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    return c;
  };
  const oC = mk(), sC = mk();
  const oX = oC.getContext('2d', { willReadFrequently: true });
  const sX = sC.getContext('2d', { willReadFrequently: true });

  function draw(ctx, ch, fam, weight) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = '#000';
    ctx.font = `${weight} 36px "${fam}"`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(ch, SIZE / 2, SIZE / 2);
    return ctx.getImageData(0, 0, SIZE, SIZE).data;
  }

  const results = [];
  for (const [name, [cp, w]] of Object.entries(ICONS)) {
    const ch = String.fromCodePoint(cp);
    const fam = w === 900 ? 'F' : 'F';
    const oD = draw(oX, ch, `FOrig${w}`, w);
    const sD = draw(sX, ch, `FSub${w}`, w);

    // 统计非白像素（字形覆盖）
    const cover = (d) => {
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 200) n++;   // 非白
      }
      return n;
    };
    const oPx = cover(oD), sPx = cover(sD);
    let diff = 0;
    for (let i = 0; i < oD.length; i += 4) {
      if (Math.abs(oD[i] - sD[i]) > 40) diff++;
    }
    results.push({
      name, cp: cp.toString(16), w,
      oPx, sPx, diff,
      ratio: diff / (SIZE * SIZE),
    });
  }
  return { loadLog, results };
}, { ICONS, base });

console.log('字体加载:');
out.loadLog.forEach((l) => console.log('   ' + l));
console.log();

const R = out.results;
const empty = R.filter((r) => r.sPx === 0);
const far = R.filter((r) => r.sPx > 0 && r.ratio > 0.05);

console.log('图标'.padEnd(22) + '原字形px'.padEnd(12) + '子集px'.padEnd(12) + '差异像素'.padEnd(12) + '判定');
console.log('─'.repeat(74));
for (const r of R) {
  const ok = r.sPx > 0 && r.ratio <= 0.05;
  console.log(
    r.name.padEnd(22) +
    String(r.oPx).padEnd(12) + String(r.sPx).padEnd(12) +
    `${r.diff} (${(r.ratio * 100).toFixed(1)}%)`.padEnd(12) +
    (r.sPx === 0 ? '❌ 无字形' : ok ? '✅' : '⚠️ 差异大')
  );
}
console.log('─'.repeat(74));
console.log(`子集字体有字形: ${R.length - empty.length}/${R.length}`);

await browser.close();
server.close();

const pass = empty.length === 0;
console.log('\n' + (pass ? '✅ 子集字体包含全部图标字形' : '❌ 有图标缺失'));
process.exit(pass ? 0 : 1);
