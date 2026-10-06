/**
 * Tailwind 预编译前后视觉一致性测试。
 *
 * 思路：用同一个 Chromium 实例打开两份页面
 *   A 版（对照）= 用原始 Play CDN 的 tailwindcss-3.4.17.js
 *   B 版（新版）= 用预编译的 tailwind.css
 * 页面内容完全一致，唯一差别就是样式来源。
 * 然后对页面上每个元素取 computed style 的关键属性，逐项比对。
 *
 * 这样能抓到「某个类在预编译产物里缺失」导致的样式塌陷 —— 这是本优化最大的风险点。
 *
 * 用法：node scripts/tailwind-parity-test.mjs
 */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PUBLIC = join(ROOT, 'public');
const VENDOR = join(PUBLIC, 'static', 'vendor');

const TMP = '/tmp/tw-parity';
if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });

// ── 1. 造两份 HTML ────────────────────────────────────────────
const originalHtml = readFileSync(join(PUBLIC, 'index.html'), 'utf8');

// A 版：把预编译 link 换回原来的 Play CDN script
const htmlA = originalHtml.replace(
  /<link href="\/static\/vendor\/tailwind\.css" rel="stylesheet">/,
  '<script src="/static/vendor/tailwindcss-3.4.17.js"></script>'
);
// B 版：保持预编译
const htmlB = originalHtml;

writeFileSync(join(TMP, 'a.html'), htmlA);
writeFileSync(join(TMP, 'b.html'), htmlB);

// ── 2. 关键属性（只取受 Tailwind 影响、且对视觉有决定性的）──
const PROPS = [
  'display', 'position',
  'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'backgroundColor', 'color', 'borderTopWidth', 'borderTopColor', 'borderTopStyle',
  'borderRadius', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'gap',
  'opacity', 'overflowX', 'overflowY', 'boxShadow', 'textAlign',
  'zIndex', 'transform', 'transitionProperty', 'cursor',
];

// ── 3. 采集函数（注入到页面执行） ─────────────────────────────
function collect() {
  const PROPS = window.__PROPS__;
  function cls(el) {
    return (el.getAttribute && el.getAttribute('class')) || '';
  }
  // 优先采集含 tailwind class 的元素；全都要也可以，但会很多
  const all = Array.from(document.querySelectorAll('*'));
  const out = [];
  for (const el of all) {
    const c = cls(el);
    if (!c) continue;
    // 跳过纯 fa- / 纯 id 用途的元素？不跳，照样比
    const cs = getComputedStyle(el);
    const style = {};
    for (const p of PROPS) {
      const v = cs[p];
      if (v !== undefined && v !== null && v !== '') style[p] = v;
    }
    out.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: c,
      style,
    });
  }
  return out;
}

// ── 4. 跑对比 ─────────────────────────────────────────────────
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

async function capture(file, useCdn) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // 用本地静态服务器托管（file:// 下 module script + CORS 会出问题）
  await page.goto(`http://127.0.0.1:${PORT}/${file}`, { waitUntil: 'domcontentloaded' });
  // 等 Tailwind Play CDN 编译完成（它会异步注入 style）
  if (useCdn) {
    await page.waitForFunction(
      () => {
        // Play CDN 完成后会给 <head> 插一个 <style> 且内容很长
        const styles = Array.from(document.querySelectorAll('head style'));
        return styles.some((s) => s.textContent.length > 5000);
      },
      { timeout: 20000 }
    );
  } else {
    await page.waitForLoadState('load');
  }
  await page.waitForTimeout(600);

  await page.addInitScript(() => {});
  const data = await page.evaluate(
    ({ props }) => {
      window.__PROPS__ = props;
      return (function collect() {
        const PROPS = window.__PROPS__;
        function cls(el) {
          return (el.getAttribute && el.getAttribute('class')) || '';
        }
        const all = Array.from(document.querySelectorAll('*'));
        const out = [];
        for (const el of all) {
          const c = cls(el);
          if (!c) continue;
          const cs = getComputedStyle(el);
          const style = {};
          for (const p of PROPS) {
            const v = cs[p];
            if (v !== undefined && v !== null && v !== '') style[p] = v;
          }
          out.push({ tag: el.tagName.toLowerCase(), id: el.id || '', cls: c, style });
        }
        return out;
      })();
    },
    { props: PROPS }
  );

  await page.close();
  return { data, errors };
}

// 起个静态服务器
import { createServer } from 'http';
import { readFileSync as rf } from 'fs';
const PORT = 18777;
const server = createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/' || p === '/a.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(join(TMP, 'a.html')));
  }
  if (p === '/b.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(join(TMP, 'b.html')));
  }
  // 静态资源从 public 里找
  const fp = join(PUBLIC, p);
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
            : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    return res.end(buf);
  } catch {
    res.writeHead(404);
    return res.end('nf');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const A = await capture('a.html', true); // Play CDN
const B = await capture('b.html', false); // 预编译

await browser.close();
server.close();

// ── 5. 比对 ───────────────────────────────────────────────────
// 归一化：transitionProperty 这类多值属性，Play CDN 和预编译产物都会输出多条
// transition-property 作为 fallback（顺序不同），getComputedStyle 只返回第一条，
// 会造成「只有 -webkit-text-decoration-color 有/无」的假差异。
// 归一化方式：拆成集合后排序再拼回，两边集合内容一致就视为相同。
const MULTI_VALUE_PROPS = new Set(['transitionProperty', 'transitionDuration', 'transitionTimingFunction', 'fontFamily']);
function norm(prop, v) {
  if (v === undefined || v === null) return v;
  if (MULTI_VALUE_PROPS.has(prop)) {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort()
      .join(',');
  }
  return v;
}

console.log(`\n采集元素：A(CDN) ${A.data.length} 个 / B(预编译) ${B.data.length} 个`);
console.log(`页面错误：A ${A.errors.length} 个 / B ${B.errors.length} 个`);
if (A.errors.length) A.errors.slice(0, 5).forEach((e) => console.log('   A ERR:', e.slice(0, 160)));
if (B.errors.length) B.errors.slice(0, 5).forEach((e) => console.log('   B ERR:', e.slice(0, 160)));

// 按 (tag,cls,出现序号) 对齐 —— 两边 DOM 应该完全一样
const key = (e, i) => `${e.tag}|${e.cls}|${e.id}`;
const mapB = new Map();
B.data.forEach((e, i) => {
  const k = key(e, i);
  if (!mapB.has(k)) mapB.set(k, []);
  mapB.get(k).push(e);
});

let diffs = [];
let compared = 0;
for (const ea of A.data) {
  const k = key(ea);
  const bucket = mapB.get(k);
  if (!bucket || !bucket.length) continue; // B 里没有同款元素，跳过（DOM 统计差异）
  const eb = bucket.shift();
  compared++;
  for (const p of PROPS) {
    const va = norm(p, ea.style[p]);
    const vb = norm(p, eb.style[p]);
    if (va === undefined && vb === undefined) continue;
    if (va !== vb) {
      diffs.push({ cls: ea.cls, id: ea.id, tag: ea.tag, prop: p, cdn: va, pre: vb });
    }
  }
}

console.log(`\n实际比对元素对：${compared}`);
console.log(`样式差异项：${diffs.length}`);

if (diffs.length) {
  console.log('\n=== 差异明细（前 60 条）===');
  const byClass = new Map();
  for (const d of diffs) {
    const kk = `${d.prop} @@ ${d.cls}`;
    if (!byClass.has(kk)) byClass.set(kk, []);
    byClass.get(kk).push(d);
  }
  let n = 0;
  for (const [kk, list] of byClass) {
    console.log(`\n[${n + 1}] ${kk}  (${list.length} 处)`);
    console.log(`     CDN  : ${list[0].cdn}`);
    console.log(`     预编译: ${list[0].pre}`);
    console.log(`     示例 : <${list[0].tag} id="${list[0].id}">`);
    if (++n >= 60) break;
  }
} else {
  console.log('\n✅ 零差异 —— 预编译 CSS 与 Play CDN 渲染结果完全一致');
}

// 存明细
writeFileSync('/tmp/tw-parity/diffs.json', JSON.stringify(diffs, null, 2));
console.log('\n明细已存 /tmp/tw-parity/diffs.json');

process.exit(diffs.length ? 1 : 0);
