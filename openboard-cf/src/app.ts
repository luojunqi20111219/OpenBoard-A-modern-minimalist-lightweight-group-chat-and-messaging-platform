/**
 * 应用装配 —— Pages Functions 与独立 Worker 共用同一份入口
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { HonoEnv, Env } from './auth';
import { resolveUser } from './auth';
import { authRoutes } from './routes/auth';
import { messageRoutes, uploadsAssetHandler } from './routes/messages';
import { groupRoutes } from './routes/groups';
import { friendRoutes } from './routes/friends';
import { adminRoutes } from './routes/admin';
import { importRoutes, MAX_DB_BYTES } from './routes/import';
import { MAX_ARCHIVE_BYTES } from './import/archive';
import { upgradeWebSocket } from './realtime';
import { onlineUsers } from './realtime';
import { securityHeaders } from './security';

export function createApp() {
  const app = new Hono<HonoEnv>();

  // CORS：前端与 API 同域部署，主要为原生客户端与本地调试保留
  app.use(
    '/api/*',
    cors({
      origin: (origin) => origin || '*',
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  // 统一安全响应头
  app.use('*', async (c, next) => {
    await next();
    securityHeaders(c.res);
    if (c.req.path.startsWith('/api/')) {
      c.res.headers.set('Cache-Control', 'no-store');
    }
  });

  app.route('/api', authRoutes);
  app.route('/api', messageRoutes);
  app.route('/api', groupRoutes);
  app.route('/api', friendRoutes);
  app.route('/api', adminRoutes);
  // 数据导入（一次性初始化用，见 src/routes/import.ts）
  app.route('/api', importRoutes);

  // --- 旧版静态目录兼容 -----------------------------------------------------
  //
  // 旧版（FastAPI）把 uploads/ 目录挂在 /uploads 下，历史消息里存的
  // 图片地址就是 `/uploads/{uuid}.{ext}`。导入进来的附件在 R2 里保持
  // 同名 key，这条路由把它们原样吐出来，前端零改动即可显示。
  //
  // 挂在**根部**而不是 /api 下 —— messageRoutes 整体挂在 /api 前缀，
  // 在那里注册会变成 /api/uploads/...，与旧地址对不上。
  app.get('/uploads/:filename', (c) => uploadsAssetHandler(c));

  // --- WebSocket ------------------------------------------------------------
  //
  // 共 4 条路径，都是升级到同一个 ChatHub DO：
  //
  //   /api/ws            网页端，Cookie / Authorization 携带凭证
  //   /api/ws/:token     v8 起的原生客户端路径
  //   /ws                v7 及更早的网页端路径
  //   /ws/:token         旧版安卓客户端路径（WebSocketManager.kt 拼的）
  //
  // ⚠️ 后两条是**存量 App 的生命线**：已发布的安卓客户端硬编码了
  //    baseUrl.replace("https://","wss://") + "ws/$token"，
  //    少一条就会让老用户收不到任何消息。迁移时不能图省事删掉。
  //
  // 之所以把 4 条合到一个 helper：原 Pages 版本把它们分散在
  // functions/ws.ts 和 functions/ws/[[token]].ts，逻辑重复且容易漏改。

  /** 从 Cookie 或 Authorization 头取 token */
  const tokenFromHeaders = (c: { req: { header: (k: string) => string | undefined } }) => {
    const auth = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    if (auth) return auth;
    return (
      (c.req.header('Cookie') || '')
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('token='))
        ?.slice(6) ?? null
    );
  };

  /** 统一的升级处理：解析身份 → 转发给 DO，异常带出原因 */
  const handleUpgrade = async (
    c: { env: unknown; req: { raw: Request }; json: (o: unknown, s?: number) => Response },
    token: string | null,
    label: string,
  ): Promise<Response> => {
    const e = c.env as unknown as Env;
    try {
      const user = await resolveUser(e, token);
      if (!user) return c.json({ detail: '未登录' }, 401);
      if (user.is_banned === 1) return c.json({ detail: '账号已被封禁' }, 403);
      return await upgradeWebSocket(e, c.req.raw, user.username);
    } catch (err) {
      // DO 绑定缺失或 DO 内部报错时，裸异常会变成无信息的 500（error 1101），
      // 这里把原因带出来，便于区分是配置问题还是代码问题
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(`[${label}] upgrade failed`, msg);
      return c.json({ detail: 'WebSocket 升级失败', reason: msg }, 500);
    }
  };

  app.get('/api/ws', (c) => handleUpgrade(c, tokenFromHeaders(c), 'api/ws'));
  app.get('/api/ws/:token', (c) => handleUpgrade(c, c.req.param('token'), 'api/ws/token'));
  app.get('/ws', (c) => handleUpgrade(c, tokenFromHeaders(c), 'ws'));
  app.get('/ws/:token', (c) => handleUpgrade(c, c.req.param('token'), 'ws/token'));

  // --- 旧库导入页面 ---------------------------------------------------------
  //
  // 单独由 Worker 返回 HTML（而不是放 public/upload.html），因为：
  //   1. 需要干净 URL /upload，而 assets 的 SPA 回退会把无扩展名路径
  //      一律吐成 index.html
  //   2. 页面里要注入 import 是否可用的初始状态，省掉一次额外请求
  app.get('/upload', async (c) => {
    const e = c.env as unknown as Env;
    let available = true;
    let importedAt: string | null = null;
    try {
      const row = await e.DB.prepare(
        'SELECT imported_at FROM _import_state WHERE id = 1',
      ).first<{ imported_at: string }>();
      if (row) {
        available = false;
        importedAt = row.imported_at;
      }
    } catch {
      // 表还没建 => 尚未导入过，保持可用
    }
    const html = renderUploadPage({ available, importedAt });
    return c.html(html);
  });

  // --- 健康检查 / 运行时信息 -------------------------------------------------
  app.get('/api/health', async (c) => {
    const e = c.env as unknown as Env;
    const online = await onlineUsers(e);
    return c.json({
      status: 'ok',
      runtime: 'cloudflare-workers',
      version: e.CURRENT_VERSION || 'v9.0.0',
      online_count: online.length,
    });
  });

  // --- 线上自检（Self-check）------------------------------------------------
  //
  // Worker 自己向自己发起一次真实的 WebSocket 升级，用于在生产环境验证
  // 「101 Switching Protocols」是否真的能返回。
  //
  // 存在的理由：本地 Miniflare 与线上 Cloudflare 的运行时行为不等价
  // （Miniflare 3 不支持 assets 的 run_worker_first，DO 边界行为也有差异）。
  // 早期 Pages 方案正是「本地全绿、线上 500」——因为带 webSocket 的 101
  // 响应无法穿过 Pages → DO 的服务绑定。
  //
  // 只在携带正确 flag 时启用，且不暴露任何敏感数据。
  app.get('/api/_selfcheck', async (c) => {
    if (c.req.query('key') !== 'openboard-selfcheck') {
      return c.json({ detail: '接口不存在' }, 404);
    }
    const e = c.env as unknown as Env;

    // 1) D1
    let d1 = 'skip';
    try {
      const r = await e.DB.prepare('SELECT COUNT(*) AS c FROM users').first<{ c: number }>();
      d1 = `ok:users=${r?.c ?? 0}`;
    } catch (err) {
      d1 = `fail:${err instanceof Error ? err.message : String(err)}`;
    }

    // 2) KV
    let kv = 'skip';
    try {
      if (!e.RATE_LIMIT) {
        kv = 'fail:binding-missing';
      } else {
        await e.RATE_LIMIT.put('__selfcheck', String(Date.now()), { expirationTtl: 60 });
        const got = await e.RATE_LIMIT.get('__selfcheck');
        kv = got ? 'ok' : 'fail:empty';
      }
    } catch (err) {
      kv = `fail:${err instanceof Error ? err.message : String(err)}`;
    }

    // 3) R2
    let r2 = 'skip';
    try {
      await e.UPLOADS.put('__selfcheck.txt', 'ok');
      const obj = await e.UPLOADS.get('__selfcheck.txt');
      r2 = obj ? 'ok' : 'fail:null';
      await e.UPLOADS.delete('__selfcheck.txt');
    } catch (err) {
      r2 = `fail:${err instanceof Error ? err.message : String(err)}`;
    }

    // 4) Durable Object —— 直接调用 stub，不经 HTTP
    let doCheck = 'skip';
    try {
      const stub = e.CHAT_HUB.get(e.CHAT_HUB.idFromName('selfcheck'));
      const res = await stub.fetch('https://do/online');
      const body = await res.text();
      doCheck = `ok:${res.status}:${body.slice(0, 80)}`;
    } catch (err) {
      doCheck = `fail:${err instanceof Error ? err.message : String(err)}`;
    }

    // 5) 真实 WebSocket 升级
    //
    // ⚠️ 不能用 fetch(`${origin}/api/ws/...`) 自请求——Worker 请求自己的
    //    公开域会被 Cloudflare 判为回环并拦回 `error code: 1014`。
    //
    //    改为直接调用生产代码里的 `upgradeWebSocket()`，走的是**完全相同**
    //    的函数路径（构造 Upgrade 请求 → DO stub → 101），只是省掉了一次
    //    互联网往返。因此这一步验证的就是真实链路的全部关键环节：
    //    PBKDF2 哈希（受 10ms CPU 限额约束）、D1 写入、JWT 签发、
    //    身份解析、DO WebSocket 升级并返回 101。
    let ws = 'skip';
    let auth = 'skip';
    const probeUser = `selfcheck_${Date.now()}`;
    const probePass = 'SelfCheck!2026';
    try {
      const { hashPassword } = await import('./crypto');
      const { passwordIterations } = await import('./env');
      const { createAccessToken } = await import('./auth');
      const { upgradeWebSocket: doUpgrade } = await import('./realtime');

      // 5a) 走真实注册流程（HTTP 层直接调内部函数，避免回环限制）
      const t0 = Date.now();
      const hashed = await hashPassword(probePass, passwordIterations(e));
      const hashMs = Date.now() - t0;

      const ins = await e.DB.prepare(
        'INSERT INTO users (username, password_hash, nickname, role) VALUES (?, ?, ?, 0)',
      )
        .bind(probeUser, hashed, '自检')
        .run();
      const uid = Number(ins.meta?.last_row_id ?? 0);

      const token = await createAccessToken(
        e,
        { sub: String(uid), username: probeUser, role: 0 },
        15,
      );
      await e.DB.prepare('UPDATE users SET token=? WHERE id=?').bind(token, uid).run();
      auth = `hash=${hashMs}ms token=${token ? 'ok' : 'none'}`;

      // 5b) 用真 token 解析身份
      const user = await resolveUser(e, token);
      auth += ` resolve=${user ? user.username : 'null'}`;

      // 5c) 真实 WebSocket 升级 —— 核心验证点
      if (user) {
        const fakeReq = new Request('https://openboard.local/api/ws', { method: 'GET' });
        const resp = await doUpgrade(e, fakeReq, user.username);
        ws = `status=${resp.status} webSocket=${resp.webSocket ? 'yes' : 'no'}`;
        if (resp.status !== 101 || !resp.webSocket) {
          ws += ` body=${(await resp.text()).slice(0, 120)}`;
        } else {
          resp.webSocket.accept();
          ws += ' accept=ok';
          resp.webSocket.close();
        }

        // 5d) 旧版安卓路径 —— /ws/{token} 解析出同样的身份
        const legacyUser = await resolveUser(e, token);
        const legacyResp = await doUpgrade(
          e,
          new Request('https://openboard.local/ws/x', { method: 'GET' }),
          legacyUser!.username,
        );
        ws += ` | legacy=${legacyResp.status}/${legacyResp.webSocket ? 'ws' : 'no'}`;
        try { legacyResp.webSocket?.accept(); legacyResp.webSocket?.close(); } catch { /* ignore */ }
      }

      // 5e) 无效 token 必须被拒
      const bad = await resolveUser(e, 'invalid-token-xxx');
      ws += ` | invalid=${bad === null ? 'rejected-ok' : 'LEAK!'}`;
    } catch (err) {
      ws = `fail:${err instanceof Error ? err.message : String(err)}`;
    } finally {
      try {
        await e.DB.prepare('DELETE FROM users WHERE username = ?').bind(probeUser).run();
      } catch { /* ignore */ }
    }

    return c.json({ d1, kv, r2, do: doCheck, auth, ws });
  });

  app.notFound((c) => c.json({ detail: '接口不存在' }, 404));
  app.onError((err, c) => {
    console.error('[app error]', err);
    return c.json({ detail: '服务器内部错误' }, 500);
  });

  return app;
}

export type AppEnv = Env;

// ---------------------------------------------------------------------------
// 导入页面 HTML
//
// 内联在 Worker 里（而非 public/*.html）的理由见 /upload 路由的注释。
// 页面本身无框架、无外部依赖，风格与项目其余页面（admin.html）保持一致。
// ---------------------------------------------------------------------------
function renderUploadPage(opts: { available: boolean; importedAt: string | null }): string {
  // 初始状态直接注入，避免页面先闪一下"可导入"再变成"已关闭"
  const initialState = JSON.stringify({
    available: opts.available,
    importedAt: opts.importedAt,
  }).replace(/</g, '\\u003c');

  // 体积上限从服务端注入，前端校验与后端拒绝用同一组常量，不会漂移
  const limitsJson = JSON.stringify({
    db: MAX_DB_BYTES,
    archive: MAX_ARCHIVE_BYTES,
  });

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>数据库导入 · OpenBoard</title>
<style>
  :root {
    --bg: #f5f6f8;
    --card: #ffffff;
    --fg: #1f2329;
    --muted: #8a9099;
    --line: #e5e7eb;
    --accent: #2563eb;
    --accent-hover: #1d4ed8;
    --danger: #dc2626;
    --warn: #b45309;
    --ok: #15803d;
    --warn-bg: #fffbeb;
    --ok-bg: #f0fdf4;
    --danger-bg: #fef2f2;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181d; --card: #1f2228; --fg: #e6e8ea; --muted: #9aa1ab;
      --line: #2e3238; --warn-bg: #2a2416; --ok-bg: #16241a; --danger-bg: #2a1717;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 16px; min-height: 100vh;
    background: var(--bg); color: var(--fg);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 6px; font-weight: 600; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .card {
    background: var(--card); border: 1px solid var(--line);
    border-radius: 10px; padding: 22px; margin-bottom: 16px;
  }
  #drop {
    border: 2px dashed var(--line); border-radius: 10px;
    padding: 40px 20px; text-align: center; cursor: pointer;
    transition: border-color .15s, background .15s;
  }
  #drop:hover, #drop.over { border-color: var(--accent); background: rgba(37,99,235,.05); }
  #drop .big { font-size: 15px; font-weight: 500; margin-bottom: 6px; }
  #drop .hint { color: var(--muted); font-size: 12px; }
  #fileInfo { display: none; margin-top: 14px; font-size: 13px; }
  #fileInfo.show { display: block; }
  .btn {
    appearance: none; border: 0; border-radius: 8px; padding: 10px 18px;
    font-size: 14px; font-weight: 500; cursor: pointer;
    background: var(--accent); color: #fff; transition: background .15s;
  }
  .btn:hover:not(:disabled) { background: var(--accent-hover); }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn.secondary { background: transparent; color: var(--fg); border: 1px solid var(--line); }
  .actions { margin-top: 18px; display: flex; gap: 10px; align-items: center; }
  .banner { padding: 12px 16px; border-radius: 8px; font-size: 13px; margin-bottom: 20px; }
  .banner.ok { background: var(--ok-bg); color: var(--ok); }
  .banner.warn { background: var(--warn-bg); color: var(--warn); }
  .banner.danger { background: var(--danger-bg); color: var(--danger); }
  .banner code { background: rgba(0,0,0,.06); padding: 1px 5px; border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .hide { display: none !important; }
  h3 { font-size: 14px; margin: 20px 0 4px; font-weight: 600; }
  ul { margin: 6px 0; padding-left: 20px; font-size: 13px; }
  #progressWrap { margin-top: 16px; height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; }
  #progressBar { height: 100%; width: 0; background: var(--accent); transition: width .3s; }
  #progressText { margin-top: 8px; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <h1>数据导入</h1>
  <div class="sub">把旧版（Python / FastAPI）的 <code class="mono">board.db</code> 或整个项目目录合并到当前部署</div>

  <div id="closedBanner" class="banner ok hide"></div>
  <div id="readyBanner" class="banner warn hide">
    <strong>仅可导入一次。</strong>导入成功后该入口会自动永久关闭，且上传的压缩包不会保留。
    导入采用<strong>合并</strong>方式，与现有数据冲突的记录会被跳过，不会覆盖。
  </div>
  <div id="errorBanner" class="banner danger hide"></div>

  <div class="card" id="uploadCard">
    <div id="drop">
      <div class="big">点击选择，或把文件 / 整个文件夹拖到这里</div>
      <div class="hint">
        <code class="mono">board.db</code> 只迁数据 ·
        <code class="mono">.zip</code> / <code class="mono">.tar.gz</code> / <code class="mono">.tgz</code> / 文件夹 → 连 <code class="mono">uploads/</code> 附件一起迁
      </div>
    </div>
    <input type="file" id="fileInput" accept=".db,.sqlite,.sqlite3,.zip,.tar,.tar.gz,.tgz,.gz,.z" class="hide">
    <input type="file" id="dirInput" webkitdirectory directory multiple class="hide">
    <div id="fileInfo"></div>
    <div id="progressWrap" class="hide"><div id="progressBar"></div></div>
    <div id="progressText" class="hide"></div>
    <div class="actions">
      <button class="btn" id="submitBtn" disabled>开始导入</button>
      <button class="btn secondary" id="dirBtn">选择文件夹</button>
      <button class="btn secondary" id="resetBtn">重新选择</button>
    </div>
  </div>

  <div class="card hide" id="resultCard">
    <h2 style="font-size:16px;margin:0 0 4px">导入完成</h2>
    <div class="sub" id="resultTime" style="margin-bottom:12px"></div>
    <div id="resultArchive"></div>
    <h3>各表结果</h3>
    <table><thead><tr><th>表</th><th class="num">写入</th><th class="num">跳过</th></tr></thead>
      <tbody id="resultTable"></tbody></table>
    <div id="resetSection"></div>
  </div>
</div>

<script src="/upload-fflate.js"></script>
<script>
(function () {
  var INIT = ${initialState};
  // 服务端注入的体积上限，避免前后端各写一份常量而对不上
  var LIMITS = ${limitsJson};
  var el = function (id) { return document.getElementById(id); };
  var chosenFile = null;   // 最终要上传的 File（可能是现打的 zip）
  var label = '';          // 显示用的选择描述

  function show(id) { el(id).classList.remove('hide'); }
  function hide(id) { el(id).classList.add('hide'); }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function showError(msg) {
    el('errorBanner').innerHTML = msg;
    show('errorBanner');
  }
  function setBusy(b, text) {
    var btn = el('submitBtn');
    btn.disabled = b || !chosenFile;
    btn.textContent = text || (b ? '导入中…' : '开始导入');
    el('dirBtn').disabled = b;
    el('resetBtn').disabled = b;
  }

  // --- 已关闭：隐藏上传，展示结果 ---
  if (!INIT.available) {
    hide('readyBanner');
    el('closedBanner').innerHTML =
      '数据导入功能<strong>已关闭</strong>（此前已成功导入一次，不可重复导入）。' +
      (INIT.importedAt ? '<br>导入时间：<code class="mono">' + esc(INIT.importedAt) + '</code>' : '');
    show('closedBanner');
    fetch('/api/import/status').then(function (r) { return r.json(); }).then(function (d) {
      if (!d.summary) return;
      try {
        var s = JSON.parse(d.summary);
        if (s.perTable) { renderTable(s.perTable); }
        renderArchive(s);
        show('resultCard');
      } catch (e) { /* ignore */ }
    }).catch(function () {});
    el('uploadCard').classList.add('hide');
    return;
  }
  show('readyBanner');

  // --- 选择区 ------------------------------------------------------------
  var drop = el('drop'), input = el('fileInput'), dirInput = el('dirInput');

  drop.addEventListener('click', function () { input.click(); });
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    if (!e.dataTransfer) return;
    var items = e.dataTransfer.items;
    // 拖文件夹进来时，只有走 webkitGetAsEntry 才能拿到完整目录树
    if (items && items.length && items[0].webkitGetAsEntry) {
      var entries = [];
      for (var i = 0; i < items.length; i++) {
        var entry = items[i].webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
      var hasDir = entries.some(function (en) { return en.isDirectory; });
      if (hasDir) { collectEntries(entries); return; }
    }
    if (e.dataTransfer.files.length) acceptSingle(e.dataTransfer.files[0]);
  });

  input.addEventListener('change', function () {
    if (input.files.length === 1) acceptSingle(input.files[0]);
  });
  dirInput.addEventListener('change', function () {
    if (dirInput.files.length) acceptFolder(dirInput.files);
  });
  el('dirBtn').addEventListener('click', function () { dirInput.click(); });
  el('resetBtn').addEventListener('click', function () {
    chosenFile = null; label = '';
    input.value = ''; dirInput.value = '';
    el('fileInfo').classList.remove('show');
    setBusy(false);
    hide('errorBanner');
  });

  // --- 单个文件（board.db 或压缩包）---------------------------------------
  //  正则统一用 RegExp 构造，理由见下方 acceptFolder 里的注释
  var RE_DB = new RegExp('\\.(db|sqlite|sqlite3)$');
  var RE_ARCHIVE = new RegExp('\\.(zip|tar|tar\\.gz|tgz|gz|z)$');
  var RE_PART = new RegExp('^.{0,260}\\.part$');

  function acceptSingle(f) {
    var name = (f.name || '').toLowerCase();
    var isDb = RE_DB.test(name);
    var isArchive = RE_ARCHIVE.test(name);
    if (!isDb && !isArchive) {
      showError('不支持的格式：<code class="mono">' + esc(f.name) + '</code><br>' +
        '请选择 <code class="mono">board.db</code>、压缩包（zip / tar.gz / tgz），' +
        '或点下方「选择文件夹」。');
      return;
    }
    if (!isDb && RE_PART.test(name)) {
      showError('这看起来是未完成的下载文件（.part），请等下载完成后再试。');
      return;
    }
    var limit = isDb ? LIMITS.db : LIMITS.archive;
    if (f.size > limit) {
      showError((isDb ? '数据库文件' : '压缩包') + '超过 ' + Math.round(limit / 1048576) + 'MB 上限' +
        '（当前 ' + fmtSize(f.size) + '）。<br>' +
        (isDb
          ? '若这是整个项目目录，请打包成 zip 后上传（上限 ' + Math.round(LIMITS.archive / 1048576) + 'MB）。'
          : '请分批上传：先只打包 <code class="mono">uploads/</code>，再单独传 board.db。'));
      return;
    }
    if (f.size === 0) { showError('文件为空。'); return; }

    chosenFile = f;
    label = f.name;
    showPicked(f.name, f.size, isArchive ? null : 'board.db / 单个文件');
    hide('errorBanner');
  }

  // --- 文件夹（webkitdirectory 或拖拽目录）--------------------------------
  //  前端打 zip 后再上传，复用与压缩包完全相同的服务端路径。
  //  这样服务端只需要实现一种归档解析，测试面也小。
  //  ⚠️ 正则一律用 RegExp 构造，**不要**写字面量。
  //     本函数返回的是模板字符串，里面的 \ 会被先做一层转义：
  //       写 /\/__MACOSX\// 会变成 //__MACOSX// —— 前半截成了行注释，
  //       整个 if 语句直接语法错误，导致**页面上所有 JS 全部不执行**
  //       （按钮不响应、拖拽无反应，且不报任何可见错误）。
  //     这个坑真实踩过：服务端测试全绿，页面却是死的。
  var RE_SKIP = new RegExp('\\.(DS_Store|part|crdownload)$', 'i');
  var RE_MACOSX = new RegExp('/__MACOSX/');
  var RE_DOTUNDER = new RegExp('^\\._');

  function acceptFolder(fileList) {
    var files = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      // 浏览器给的 relativePath 形如 "openboard/uploads/a.jpg"
      var rel = f.webkitRelativePath || f.relativePath || f.name;
      if (RE_SKIP.test(rel)) continue;
      if (RE_MACOSX.test(rel) || RE_DOTUNDER.test(rel.split('/').pop())) continue;
      files.push({ rel: rel, file: f });
    }
    if (!files.length) { showError('所选文件夹里没有可用文件。'); return; }

    var total = files.reduce(function (a, x) { return a + x.file.size; }, 0);
    var rootName = (files[0].rel.split('/')[0]) || 'folder';
    showError('');
    var proc = '正在打包文件夹 ' + rootName + '（' + files.length + ' 个文件，' + fmtSize(total) + '）…';
    showProgress(30, proc);

    zipFolder(files, rootName).then(function (blob) {
      if (blob.size > LIMITS.archive) {
        hideProgress();
        showError('打包后 ' + fmtSize(blob.size) + '，超过 ' + Math.round(LIMITS.archive / 1048576) + 'MB 上限。<br>' +
          '建议只把 <code class="mono">board.db</code> 和 <code class="mono">uploads/</code> 目录拖进来。');
        return;
      }
      chosenFile = new File([blob], rootName + '.zip', { type: 'application/zip' });
      label = '文件夹 ' + rootName;
      hideProgress();
      showPicked('文件夹 ' + rootName, blob.size, files.length + ' 个文件（已打包为 zip）');
      hide('errorBanner');
    }).catch(function (err) {
      hideProgress();
      showError('打包失败：' + esc(err && err.message ? err.message : String(err)));
    });
  }

  // 拖拽的目录树 → 递归收集
  function collectEntries(entries) {
    var out = [];
    var pending = entries.length;
    entries.forEach(function (entry) { walk(entry, ''); });
    function done() {
      if (pending !== 0) return;
      if (out.length) acceptFolder(fakeFileList(out));
    }
    function walk(entry, prefix) {
      if (entry.isFile) {
        entry.file(function (f) {
          out.push({ rel: prefix + entry.name, file: f });
          // 用 pending 计数不可行（目录会递归），改为延迟触发
        }, function () {});
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        reader.readEntries(function (children) {
          children.forEach(function (child) { walk(child, prefix + entry.name + '/'); });
        }, function () {});
      }
    }
    // webkitGetAsEntry 的读取是异步且层数未知，这里给一个宽裕的等待窗口
    setTimeout(done, 1200);
  }

  function fakeFileList(items) {
    // acceptFolder 只用到 length / [i].webkitRelativePath / [i].size，
    // 这里造一个最小可用的数组式对象
    var arr = items.map(function (x) {
      var f = x.file;
      try { Object.defineProperty(f, 'webkitRelativePath', { value: x.rel, configurable: true }); } catch (e) { /* ignore */ }
      return f;
    });
    arr.item = function (i) { return arr[i]; };
    return arr;
  }

  function zipFolder(files, rootName) {
    return new Promise(function (resolve, reject) {
      if (typeof FFLATE === 'undefined' || !FFLATE.zip) {
        reject(new Error('前端打包组件未加载，请改用压缩包上传'));
        return;
      }
      var inObj = {};
      var tasks = files.map(function (x) {
        return x.file.arrayBuffer().then(function (buf) {
          // 用相对路径作为 zip 内路径，服务端会自动剥掉顶层目录
          inObj[x.rel] = new Uint8Array(buf);
        });
      });
      Promise.all(tasks).then(function () {
        FFLATE.zip(inObj, { level: 6 }, function (err, data) {
          if (err) { reject(err); return; }
          resolve(new Blob([data], { type: 'application/zip' }));
        });
      }).catch(reject);
    });
  }

  // --- 展示与进度 ---------------------------------------------------------
  function showPicked(name, size, note) {
    el('fileInfo').innerHTML =
      '已选择：<strong>' + esc(name) + '</strong> ' +
      '<span class="mono">(' + fmtSize(size) + (note ? ' · ' + esc(note) : '') + ')</span>';
    el('fileInfo').classList.add('show');
    setBusy(false, '开始导入');
  }
  function showProgress(pct, text) {
    show('progressWrap'); show('progressText');
    el('progressBar').style.width = pct + '%';
    el('progressText').textContent = text || '';
  }
  function hideProgress() { hide('progressWrap'); hide('progressText'); }

  function renderTable(perTable) {
    var tb = el('resultTable');
    tb.innerHTML = '';
    Object.keys(perTable).forEach(function (t) {
      var v = perTable[t];
      var tr = document.createElement('tr');
      // 被丢弃的旧列（D1 schema 里没有）在这里就标出来，
      // 免得用户看到某张表数字不对时以为是自己导坏了
      var dropped = (v.ignoredColumns && v.ignoredColumns.length)
        ? ' <span class="sub">（忽略列：' + esc(v.ignoredColumns.join(', ')) + '）</span>'
        : '';
      tr.innerHTML =
        '<td class="mono">' + esc(t) + (v.error ? ' <span style="color:var(--danger)">（' + esc(v.error) + '）</span>' : '') + dropped + '</td>' +
        '<td class="num">' + (v.inserted || 0) + '</td>' +
        '<td class="num">' + (v.skipped || 0) + '</td>';
      tb.appendChild(tr);
    });
  }

  function renderArchive(s) {
    var box = el('resultArchive');
    box.innerHTML = '';
    var a = s && s.archive;
    if (!a) return;

    var h = document.createElement('div');
    var at = a.attachments;
    var lines = '<h3>附件迁移</h3><div class="sub" style="margin:0 0 8px">' +
      '来源：<code class="mono">' + esc(a.dbPath || '?') + '</code>（' + esc(a.format) + '）· ' +
      '扫描 ' + a.scannedFiles + ' 个文件' +
      (a.skippedFiles ? '，跳过 ' + a.skippedFiles + ' 个' : '') + '</div>';

    if (!at) {
      lines += '<div class="sub" style="margin:0">本次未包含附件（只导入了数据库）。</div>';
    } else if (at.total === 0) {
      lines += '<div class="sub" style="margin:0">压缩包里没有找到 uploads/ 附件。</div>';
    } else {
      lines += '<table><thead><tr><th>项目</th><th class="num">数量</th></tr></thead><tbody>' +
        '<tr><td>写入 R2</td><td class="num">' + at.written + '</td></tr>' +
        '<tr><td>已存在（跳过）</td><td class="num">' + at.existed + '</td></tr>' +
        (at.failed ? '<tr><td>失败</td><td class="num" style="color:var(--danger)">' + at.failed + '</td></tr>' : '') +
        '<tr><td>合计大小</td><td class="num">' + fmtSize(at.totalBytes) + '</td></tr>' +
        '</tbody></table>';
      if (at.errors && at.errors.length) {
        lines += '<div class="sub mono" style="margin-top:6px">' + at.errors.map(esc).join('<br>') + '</div>';
      }
    }
    h.innerHTML = lines;
    box.appendChild(h);
  }

  // --- 提交 ---------------------------------------------------------------
  el('submitBtn').addEventListener('click', function () {
    if (!chosenFile) return;
    setBusy(true);
    hide('errorBanner');
    showProgress(0, '正在上传并解析…');

    var fd = new FormData();
    fd.append('file', chosenFile, chosenFile.name);

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/import/board');
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      var pct = Math.round((e.loaded / e.total) * 100);
      el('progressBar').style.width = pct + '%';
      el('progressText').textContent = pct < 100
        ? '上传中… ' + pct + '%（' + fmtSize(e.loaded) + ' / ' + fmtSize(e.total) + '）'
        : '解压并写入…（含附件时可能需要一两分钟，请勿关闭页面）';
    };
    xhr.onload = function () {
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
        el('progressBar').style.width = '100%';
        el('progressText').textContent = '导入完成';
        renderResult(data);
      } else {
        hideProgress();
        showError(esc((data && data.detail) || ('导入失败（HTTP ' + xhr.status + '）')) +
          (data && data.hint ? '<br><span class="sub">' + esc(data.hint) + '</span>' : ''));
        setBusy(false, '开始导入');
        if (xhr.status === 403) setTimeout(function () { location.reload(); }, 2200);
      }
    };
    xhr.onerror = function () {
      hideProgress();
      showError('网络错误，请检查连接后重试。');
      setBusy(false, '开始导入');
    };
    xhr.send(fd);
  });

  function renderResult(d) {
    el('uploadCard').classList.add('hide');
    el('resultTime').textContent =
      '导入时间：' + (d.importedAt || '') + ' · 合计写入 ' + (d.totalInserted || 0) +
      ' 条，跳过 ' + (d.totalSkipped || 0) + ' 条 · 来源：' + esc(label || 'board.db');
    renderTable(d.perTable || {});
    renderArchive({ archive: d.archive });
    el('closedBanner').innerHTML = '导入已成功，该入口已永久关闭。';
    show('closedBanner');
    hide('readyBanner');

    var extra = el('resetSection');
    extra.innerHTML = '';

    var npr = d.needsPasswordReset || {};
    var bad = (npr.unsupported || []).concat(
      (npr.highIteration || []).map(function (u) { return { username: u.username, algorithm: 'pbkdf2 x' + u.iterations }; })
    );
    if (bad.length) {
      var h = document.createElement('div');
      h.innerHTML = '<h3>需要重置密码的账号（' + bad.length + ' 个）</h3>' +
        '<ul>' + bad.map(function (u) {
          return '<li><span class="mono">' + esc(u.username) + '</span> — ' + esc(u.algorithm) + '</li>';
        }).join('') + '</ul>' +
        '<div class="sub" style="margin:0">' + esc(npr.note || '') + '</div>';
      extra.appendChild(h);
    }

    if (d.ignoredTables && d.ignoredTables.length) {
      var ig = document.createElement('div');
      ig.innerHTML = '<h3>未导入的表</h3><div class="sub" style="margin:0">' +
        d.ignoredTables.map(esc).join('、') + '（不在迁移白名单内）</div>';
      extra.appendChild(ig);
    }

    // --- 旧库多出来的列 ---
    //  这些字段当前 schema 里没有，写入时被丢弃。数据本体没丢，
    //  但要说清楚，否则用户会以为导入失败。
    var ic = d.ignoredColumns || {};
    var icKeys = Object.keys(ic);
    if (icKeys.length) {
      var icEl = document.createElement('div');
      icEl.innerHTML = '<h3>已忽略的旧字段</h3>' +
        '<div class="sub" style="margin:0 0 6px">下面这些列来自旧版数据库，当前 Schema 中没有定义，' +
        '导入时已跳过（<strong>记录本身已完整写入</strong>，只是这些附加字段不迁移）。</div>' +
        '<ul style="margin:0">' + icKeys.map(function (t) {
          return '<li><span class="mono">' + esc(t) + '</span> — ' +
            esc((ic[t] || []).join(', ')) + '</li>';
        }).join('') + '</ul>';
      extra.appendChild(icEl);
    }

    if (d.message) {
      var w = document.createElement('div');
      w.className = 'banner warn';
      w.style.marginTop = '16px';
      w.textContent = d.message;
      extra.appendChild(w);
    }
    show('resultCard');
  }
})();
</script>
</body>
</html>`;
}
