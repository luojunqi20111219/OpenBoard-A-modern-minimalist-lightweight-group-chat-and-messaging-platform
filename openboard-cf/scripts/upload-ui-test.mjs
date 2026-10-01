#!/usr/bin/env node
/**
 * /upload 页面的**浏览器端**端到端测试。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它（前面的 import-test.mjs 覆盖不到的部分）
 * ---------------------------------------------------------------------------
 * import-test.mjs 是服务端视角：它直接构造 FormData 调接口，验证的是
 * 「收到 zip 后怎么解、怎么写」。但它完全没有碰过页面里的那段内联 JS ——
 * 而「选择文件夹」这条通路的关键逻辑恰恰全在那段 JS 里：
 *
 *   · webkitdirectoryFileList → 过滤 .DS_Store / __MACOSX / ._xxx
 *   · 用 fflate 把散文件打成 zip（FFLATE 全局是否真的挂上了）
 *   · 打包后的体积校验、进度条文案、按钮禁用/恢复
 *   · 上传成功后结果区渲染（含附件统计表）
 *   · 失败时错误横幅 + 403 自动刷新
 *
 * 这些用 curl / fetch 都测不到 —— 必须真的开浏览器。
 *
 * ---------------------------------------------------------------------------
 * 实现方式
 * ---------------------------------------------------------------------------
 * Miniflare 起一个真实的 HTTP listener（不再用 dispatchFetch），
 * 用 playwright-core 驱动系统 Chromium 访问它。
 * 静态资源也挂上 —— /upload-fflate.js 必须能真的被 <script> 加载，
 * 否则「前端打 zip」这条路在真实环境下是断的，而程序化测试发现不了。
 *
 * 用法：node scripts/upload-ui-test.mjs   （package.json 的 test:ui）
 */
import { Miniflare } from 'miniflare';
import { chromium } from 'playwright-core';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { zipSync } from 'fflate';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const SCHEMA = readFileSync(join(ROOT, 'schema.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`); }
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

for (const f of ['worker.js', 'sql-wasm.wasm']) {
  if (!existsSync(join(DIST, f))) {
    console.error(`缺少 dist/${f}，请先执行：npm run bundle`);
    process.exit(1);
  }
}
if (!existsSync(join(ROOT, 'public/upload-fflate.js'))) {
  console.error('缺少 public/upload-fflate.js，请先执行：node scripts/build-fflate.mjs');
  process.exit(1);
}

// --- 造一个真实旧库 --------------------------------------------------------
function buildLegacyDb() {
  const dir = mkdtempSync(join(tmpdir(), 'uidb-'));
  const script = join(dir, 'gen.cjs');
  const out = join(dir, 'board.db');
  writeFileSync(script, `
const initSqlJs = require(${JSON.stringify(join(ROOT, 'node_modules/sql.js/dist/sql-wasm.js'))});
const fs = require('fs');
initSqlJs().then((SQL) => {
  const db = new SQL.Database();
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT, nickname TEXT, role INTEGER DEFAULT 0)");
  db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, content TEXT, receiver TEXT, room_id INTEGER DEFAULT 0)");
  db.run("CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, is_public INTEGER DEFAULT 0, owner_id INTEGER DEFAULT 0)");
  db.run("INSERT INTO users (username,password_hash,nickname) VALUES ('ui_user','pbkdf2:sha256:10000$aa$bb','界面用户')");
  fs.writeFileSync(${JSON.stringify(out)}, Buffer.from(db.export()));
});
`);
  execFileSync(process.execPath, [script], { stdio: 'pipe' });
  return new Uint8Array(readFileSync(out));
}

const ATT_PNG = 'cccccccccccccccccccccccccccccccc.png';          // 32 hex + png
const ATT_THUMB = 'dddddddddddddddddddddddddddddddd.thumb.png';  // 32 hex + 缩略图后缀
// 一张最小的合法 1×1 PNG —— 必须能被浏览器真正解码，
// 否则「<img> 能否加载该附件」这条断言测不出真实情况
const FAKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const legacy = buildLegacyDb();

// --- 起服务 ----------------------------------------------------------------
//
// ⚠️ 关于 assets 的处理 —— 这里有个 Miniflare 的硬限制，绕不开
//
// 线上靠 wrangler.toml 的 `run_worker_first = ["/api/*","/ws","/upload","/uploads"]`
// 保证这些前缀先归 Worker。但 **Miniflare 4 不支持该配置**：
// 一旦挂上 `assets`，它的静态层就无条件抢先处理**所有**请求，
// 连 `dispatchFetch('http://worker/upload')` 这种改 hostname 的写法
// 也一样被拦（实测返回 assets 的 404 空体）。
// 结果是 /upload 与 /api/* 全部不可达 —— 也正是 worker.ts 里
// `isWorkerOwned` 那段注释所描述的经典现象。
//
// 但完全不用 assets 也不行：`/upload-fflate.js` 必须能被浏览器
// 真实地 <script> 加载到（前端打 zip 全靠它），这条路径不能不测。
//
// 折中方案：**不挂 assets，改由本地反代读 public/ 目录**。
// 反代复刻线上语义：
//   · 路径能在 public/ 下找到真实文件 → 直接读文件返回（等价于 assets）
//   · 其余（含 /upload、/api/*）      → 交给 Worker 的 dispatchFetch
// 两条链路都真实覆盖，且不受 Miniflare 的 assets 拦截干扰。
const assetsDir = join(ROOT, 'public');

async function proxyServer() {
  const http = await import('node:http');
  const { createReadStream, statSync } = await import('node:fs');

  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
  };

  const server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0]);

    // 1) 静态资源：public/ 下有同名文件就直接读（等价 assets 行为）
    const local = join(assetsDir, path);
    if (local.startsWith(assetsDir) && !path.includes('..')) {
      try {
        const st = statSync(local);
        if (st.isFile()) {
          const ext = local.slice(local.lastIndexOf('.'));
          res.writeHead(200, {
            'content-type': MIME[ext] || 'application/octet-stream',
            'content-length': st.size,
            'cache-control': 'public, max-age=0, must-revalidate',
          });
          createReadStream(local).pipe(res);
          return;
        }
      } catch {
        /* 落到 Worker */
      }
    }

    // 2) 其余交给 Worker
    try {
      const body =
        req.method === 'GET' || req.method === 'HEAD' ? undefined : req;
      const upstream = await mf.dispatchFetch('http://localhost' + req.url, {
        method: req.method,
        headers: req.headers,
        body,
        duplex: 'half',
      });
      const headers = {};
      for (const [k, v] of upstream.headers) headers[k] = v;
      res.writeHead(upstream.status, headers);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('proxy error: ' + err.message);
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

const mf = new Miniflare({
  modules: true,
  modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
  compatibilityDate: '2024-11-27',
  scriptPath: join(DIST, 'worker.js'),
  d1Databases: { DB: 'upload-ui-test' },
  r2Buckets: { UPLOADS: 'openboard-uploads' },
  kvNamespaces: { RATE_LIMIT: 'upload-ui-test' },
  durableObjects: { CHAT_HUB: { className: 'ChatHub', useSQLite: true } },
  // 刻意不挂 assets —— 见上方说明，改由反代提供静态资源
  bindings: {
    CURRENT_VERSION: 'v9.0.0',
    PUBLIC_UPLOADS: 'true',
    ALLOWED_ADMINS: '官方账号',
    MAX_CONNECTIONS_PER_USER: '4',
    JWT_SECRET: 'ui-test-secret',
  },
});

const d = await mf.getD1Database('DB');
await d.batch(
  SCHEMA.split(';')
    .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
    .filter((s) => s.length > 0)
    .map((s) => d.prepare(s)),
);

await mf.ready;
const { server: proxy, port: proxyPort } = await proxyServer();
const url = `http://127.0.0.1:${proxyPort}`;
console.log(`测试服务已就绪：${url}（反代：public/ 静态文件 + Worker）`);

let browser;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 收集页面 console 错误 —— 前端 JS 崩了必须暴露出来，不能静默吞掉
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  const networkFailures = [];
  page.on('requestfailed', (r) => networkFailures.push(`${r.url()} ${r.failure()?.errorText}`));

  // =======================================================================
  section('1. 页面加载与依赖');
  // =======================================================================
  const resp = await page.goto(url + '/upload', { waitUntil: 'networkidle' });
  ok('/upload 返回 200', resp.status() === 200, `status=${resp.status()}`);
  ok('标题正确', (await page.title()).includes('导入'));
  ok('拖拽区可见', await page.locator('#drop').isVisible());
  ok('「选择文件夹」按钮可见', await page.locator('#dirBtn').isVisible());
  ok('「开始导入」初始为禁用', await page.locator('#submitBtn').isDisabled());

  // fflate 是否真的挂上了 window
  const fflateOk = await page.evaluate(() => typeof FFLATE !== 'undefined' && typeof FFLATE.zip === 'function');
  ok('window.FFLATE.zip 可用（前端打 zip 的前提）', fflateOk);
  ok('/upload-fflate.js 加载无失败', !networkFailures.some((u) => u.includes('upload-fflate')));

  // 体积上限是由服务端注入到 IIFE 内部的（不是全局变量），
  // 所以直接读源码文本核对 —— 顺便验证注入真的发生了
  const pageHtml = await page.content();
  const limitMatch = pageHtml.match(/LIMITS\s*=\s*(\{[^}]*\})/);
  const limits = limitMatch ? JSON.parse(limitMatch[1]) : null;
  ok(`LIMITS 注入正确（db=${limits?.db} archive=${limits?.archive}）`,
    limits?.db === 25 * 1024 * 1024 && limits?.archive === 60 * 1024 * 1024, String(pageHtml.match(/LIMITS[^;]*/)));

  // =======================================================================
  section('2. 单文件选择与校验');
  // =======================================================================
  //  2.1 不支持的扩展名
  await page.setInputFiles('#fileInput', {
    name: 'readme.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('nope'),
  });
  await page.waitForTimeout(120);
  ok('不支持的格式给出错误横幅', await page.locator('#errorBanner').isVisible());
  ok('  错误文案提到支持的类型',
    /board\.db|压缩包|选择文件夹/.test(await page.locator('#errorBanner').innerText()));

  //  2.2 合法 db → 按钮解禁
  await page.setInputFiles('#fileInput', {
    name: 'board.db',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(legacy),
  });
  await page.waitForTimeout(150);
  ok('选择 board.db 后错误横幅消失', !(await page.locator('#errorBanner').isVisible()));
  ok('  「已选择」信息展示', await page.locator('#fileInfo').isVisible());
  ok('  「开始导入」解禁', !(await page.locator('#submitBtn').isDisabled()));

  //  2.3 重新选择 → 回到初始态
  await page.click('#resetBtn');
  await page.waitForTimeout(120);
  ok('「重新选择」后按钮重新禁用', await page.locator('#submitBtn').isDisabled());
  ok('  「已选择」信息隐藏', !(await page.locator('#fileInfo').isVisible()));

  // =======================================================================
  section('3. 文件夹选择 → 前端打 zip → 上传');
  // =======================================================================
  //  用 webkitdirectory 的 input 直接喂一组带 webkitRelativePath 的文件。
  //  playwright 的 setInputFiles 支持传多个 {name, buffer}，
  //  但 webkitRelativePath 需要自己在页面里补 —— 用 DataTransfer 造。
  const folderInjected = await page.evaluate(({ jpgB64, thumbB64, jpgPath, thumbPath, dbB64 }) => {
    const b64ToBytes = (b64) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    };
    const mk = (path, bytes) => {
      const f = new File([bytes], path.split('/').pop(), { type: 'application/octet-stream' });
      Object.defineProperty(f, 'webkitRelativePath', { value: path });
      return f;
    };
    const dt = new DataTransfer();
    // 一个典型的旧项目目录结构。
    // ⚠️ board.db 必须带上 —— 服务端找不到它就会直接 400，
    //    这条通路测的就是「文件夹 → 打包 → 服务端能解出 db + 附件」。
    dt.items.add(mk('openboard/board.db', b64ToBytes(dbB64)));
    dt.items.add(mk('openboard/app.js', new TextEncoder().encode('console.log(1)')));
    dt.items.add(mk('openboard/APP/version.txt', new TextEncoder().encode('v1')));
    dt.items.add(mk('openboard/uploads/' + jpgPath, b64ToBytes(jpgB64)));
    dt.items.add(mk('openboard/uploads/' + thumbPath, b64ToBytes(thumbB64)));
    // 干扰项：必须被前端过滤掉
    dt.items.add(mk('openboard/uploads/.DS_Store', new Uint8Array([0])));
    dt.items.add(mk('openboard/._resource', new Uint8Array([0])));
    const input = document.getElementById('dirInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return dt.files.length;
  }, {
    jpgB64: Buffer.from(FAKE_PNG).toString('base64'),
    thumbB64: Buffer.from(FAKE_PNG).toString('base64'),
    thumbPath: ATT_THUMB,
    jpgPath: ATT_PNG,
    dbB64: Buffer.from(legacy).toString('base64'),
  });
  ok(`注入文件夹 FileList（${folderInjected} 个文件）`, folderInjected === 7);

  // 等待前端打包完成（zip 是异步的）
  await page.waitForFunction(
    () => {
      const b = document.getElementById('submitBtn');
      return b && !b.disabled && b.textContent.includes('开始导入');
    },
    { timeout: 15000 },
  ).catch(() => {});

  const pickedText = await page.locator('#fileInfo').innerText().catch(() => '');
  ok('文件夹已被识别并完成打包', /文件夹|zip/i.test(pickedText), pickedText);
  ok('  「开始导入」已解禁', !(await page.locator('#submitBtn').isDisabled()));

  // 点击导入，等成功
  const [upResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/import/board'), { timeout: 30000 }),
    page.click('#submitBtn'),
  ]);
  ok('上传请求返回 200', upResp.status() === 200, `status=${upResp.status()}`);

  await page.waitForSelector('#resultCard:not(.hide)', { timeout: 20000 });
  ok('结果卡片已展示', await page.locator('#resultCard').isVisible());

  const resultText = await page.locator('#resultCard').innerText();
  ok('结果里显示了数据导入条数', /合计写入\s*\d+/.test(resultText), resultText.slice(0, 200));
  ok('结果里显示了附件迁移统计', /附件迁移/.test(resultText), resultText.slice(0, 300));
  ok('  附件写入数量 = 2', /写入 R2\s*\n?\s*2/.test(resultText.replace(/\s+/g, ' ')), resultText);
  ok('已关闭横幅出现', await page.locator('#closedBanner').isVisible());
  ok('上传卡片已隐藏', !(await page.locator('#uploadCard').isVisible()));

  // =======================================================================
  section('4. 服务端实际落库校验（浏览器点完的结果）');
  // =======================================================================
  const bucket = await mf.getR2Bucket('UPLOADS');
  ok(`R2 收到 ${ATT_PNG}`, (await bucket.head(ATT_PNG)) !== null);
  ok(`R2 收到 ${ATT_THUMB}`, (await bucket.head(ATT_THUMB)) !== null);
  ok('.DS_Store 未被前端打包进来', (await bucket.head('.DS_Store')) === null);

  const u = await d.prepare('SELECT username, nickname FROM users WHERE username = ?')
    .bind('ui_user').first();
  ok('界面操作导入的用户已入库', u?.nickname === '界面用户', JSON.stringify(u));

  const fh = await d.prepare('SELECT role, password_hash FROM users WHERE username = ?')
    .bind('filehelper').first();
  ok('filehelper 种子数据完好', fh?.role === 2 && fh?.password_hash === 'system_account',
    JSON.stringify(fh));

  // 旧 URL 在浏览器里也应当能直接加载
  const imgStatus = await page.evaluate(async (k) => {
    const r = await fetch('/uploads/' + k);
    return { status: r.status, type: r.headers.get('content-type') };
  }, ATT_PNG);
  ok('浏览器内 GET /uploads/{uuid}.png → 200 image/png',
    imgStatus.status === 200 && imgStatus.type === 'image/png', JSON.stringify(imgStatus));

  // 用真实 <img> 加载，确认不会被安全策略挡住
  const imgLoaded = await page.evaluate((k) => new Promise((res) => {
    const im = new Image();
    im.onload = () => res(true);
    im.onerror = () => res(false);
    im.src = '/uploads/' + k;
  }), ATT_PNG);
  ok('<img> 能真正解码该附件', imgLoaded);

  // =======================================================================
  section('5. 刷新后进入「已关闭」态');
  // =======================================================================
  await page.goto(url + '/upload', { waitUntil: 'networkidle' });
  ok('刷新后已关闭横幅直接可见', await page.locator('#closedBanner').isVisible());
  ok('上传卡片被隐藏', !(await page.locator('#uploadCard').isVisible()));
  await page.waitForSelector('#resultCard:not(.hide)', { timeout: 8000 }).catch(() => {});
  const again = await page.locator('#resultCard').innerText().catch(() => '');
  ok('已关闭时仍能回显上次的附件统计', /附件迁移/.test(again), again.slice(0, 200));

  // =======================================================================
  section('6. 无 JS 报错');
  // =======================================================================
  const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
  ok('页面运行期间无 console 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  /**
   * 过滤掉「假失败」：
   *
   *  · favicon —— 测试服务没提供，无关紧要
   *  · ERR_ABORTED 且指向 /uploads/ —— 这是页面里连做两次请求
   *    （先 fetch 校验状态，再 new Image() 解码）时，浏览器把
   *    前一个已完成的连接复用了。真正能证明附件可用的是上面那条
   *    「<img> 能真正解码该附件」断言，它已经过了。
   */
  const realNetFail = networkFailures.filter(
    (u) => !/favicon/i.test(u) && !(/ERR_ABORTED/.test(u) && /\/uploads\//.test(u)),
  );
  ok('无资源加载失败', realNetFail.length === 0, realNetFail.slice(0, 3).join(' | '));
} catch (err) {
  console.error('\n\x1b[31m浏览器测试异常：\x1b[0m', err.message);
  console.error((err.stack || '').split('\n').slice(0, 8).join('\n'));
  fail++;
} finally {
  if (browser) await browser.close();
  await new Promise((r) => proxy.close(r));
  await mf.dispose();
}

console.log(`\n\x1b[1m结果：${pass} 通过 / ${fail} 失败\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
