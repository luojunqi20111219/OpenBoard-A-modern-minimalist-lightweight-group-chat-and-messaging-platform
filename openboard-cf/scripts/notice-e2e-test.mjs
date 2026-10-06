/**
 * 系统公告端到端验证。
 *
 * 这个脚本回答一个具体问题：**用户点开公告面板，到底能不能看到内容？**
 *
 * 只测接口是不够的 —— 接口对了但前端渲染逻辑错了，用户照样看不到。
 * 所以这里走完整链路：真实浏览器 → 打开页面 → 登录 → 点公告按钮 → 断言 DOM。
 *
 * 用法：node scripts/notice-e2e-test.mjs
 * 前置：本地 wrangler dev 已在 8787 端口运行，数据库已初始化且有公告数据。
 */

import { chromium } from 'playwright-core';

const BASE = 'http://localhost:8787';
const USER = 'notice_e2e_user';
const PW = 'Notice8888!Pass';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? ' —— ' + detail : ''}`); }
}

// 先把测试账号建出来
await fetch(BASE + '/api/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PW, nickname: '公告测试' }),
});

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

console.log('\n═══ 打开页面并登录 ═══');
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });

// 走页面自己的登录链路。
// ⚠️ 不要自己拼 localStorage —— 页面用的键名是 'user'（见 index.html 约 569 行
//    `let currentUser = JSON.parse(localStorage.getItem('user') || ...)`），
//    而且登录后还要跑 init() 才会去调 loadNotices()。
//    这里先拿 token，再调用页面导出的 enterAuthenticatedSession()，
//    这样路径和用户真实登录完全一致。
const loginInfo = await page.evaluate(async ({ user, pw }) => {
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pw }),
  });
  return await r.json();
}, { user: USER, pw: PW });

ok('登录接口成功', !!loginInfo?.token, `body=${JSON.stringify(loginInfo)?.slice(0, 120)}`);

// 写入页面认识的那个键，再刷新，让 restoreStoredSession() 生效
await page.evaluate(({ token, user }) => {
  const userObj = { username: user, token, nickname: '公告测试', role: 0 };
  localStorage.setItem('user', JSON.stringify(userObj));
}, { token: loginInfo.token, user: USER });

await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);

let loggedIn = await page.evaluate(() => (typeof currentUser !== 'undefined') && !!currentUser);
console.log('  刷新后 currentUser:', loggedIn ? '已登录 (' + ')' : '未登录');

if (!loggedIn) {
  // 兜底：直接调用页面的登录入会话函数
  await page.evaluate(async ({ token, user }) => {
    const userObj = { username: user, token, nickname: '公告测试', role: 0 };
    if (typeof enterAuthenticatedSession === 'function') {
      enterAuthenticatedSession(userObj, true, true);
    } else {
      localStorage.setItem('user', JSON.stringify(userObj));
    }
  }, { token: loginInfo.token, user: USER });
  await page.waitForTimeout(3000);
  loggedIn = await page.evaluate(() => (typeof currentUser !== 'undefined') && !!currentUser);
  console.log('  兜底后 currentUser:', loggedIn ? '已登录' : '仍未登录');
}

ok('页面已进入登录态', loggedIn);

// ---------------------------------------------------------------------------
console.log('\n═══ 检查公告面板 ═══');

// 直接在页面上下文里调用真实的加载函数 —— 这是最贴近用户操作路径的验证
const result = await page.evaluate(async () => {
  const out = { fnExists: false, noticeBtnExists: false, dropdownExists: false };

  out.fnExists = typeof loadNotices === 'function';
  out.noticeBtnExists = !!document.getElementById('notice-btn');
  out.dropdownExists = !!document.getElementById('notice-dropdown');
  out.contentExists = !!document.getElementById('notice-content');
  out.badgeExists = !!document.getElementById('notice-badge');

  if (typeof loadNotices !== 'function') return out;

  // ⚠️ 别写 window.currentUser —— 页面里是 `let currentUser`，
  //    词法声明不会挂到 window 上，window.currentUser 永远是 undefined。
  //    直接引用标识符即可（同源的 <script> 共享全局词法环境）。
  try {
    if (!currentUser) return out;
  } catch (_) { return out; }
  out.hadUser = true;

  await loadNotices();
  await new Promise(r => setTimeout(r, 600));

  const list = document.getElementById('notice-content');
  out.html = list ? list.innerHTML : null;
  out.text = list ? list.innerText.trim() : null;
  out.itemCount = list ? list.querySelectorAll('div.p-3').length : 0;
  const badge = document.getElementById('notice-badge');
  out.badgeHidden = badge ? badge.classList.contains('hidden') : null;

  return out;
});

ok('loadNotices 函数存在', result.fnExists);
ok('notice-btn 元素存在', result.noticeBtnExists);
ok('notice-dropdown 元素存在', result.dropdownExists);
ok('notice-content 容器存在', result.contentExists);
ok('notice-badge 元素存在', result.badgeExists);

console.log('  面板文本:', JSON.stringify(result.text)?.slice(0, 150));
console.log('  公告条数:', result.itemCount);

ok('公告面板有内容渲染出来（不是空的）', !!result.text && result.text.length > 0,
   `text=${JSON.stringify(result.text)}`);
ok('公告条数 > 0', result.itemCount > 0, `itemCount=${result.itemCount}`);
ok('渲染的不是「暂无系统消息」', result.text !== '暂无系统消息', `text=${result.text}`);
ok('渲染的不是「加载失败」', !/失败/.test(result.text || ''), `text=${result.text}`);

// 再验证一次「点开按钮」这条真实用户路径
const clickResult = await page.evaluate(async () => {
  const btn = document.getElementById('notice-btn');
  if (!btn) return { clicked: false };
  btn.click();
  await new Promise(r => setTimeout(r, 800));
  const dd = document.getElementById('notice-dropdown');
  const list = document.getElementById('notice-content');
  return {
    clicked: true,
    dropdownVisible: dd ? !dd.classList.contains('hidden') : null,
    text: list ? list.innerText.trim() : null,
  };
});
ok('点击公告按钮后面板展开', clickResult.dropdownVisible === true,
   `visible=${clickResult.dropdownVisible}`);
ok('展开后仍能看到公告内容', !!clickResult.text && clickResult.text.length > 0,
   `text=${JSON.stringify(clickResult.text)?.slice(0, 80)}`);

// ---------------------------------------------------------------------------
console.log('\n═══ 控制台错误检查 ═══');
const relevant = consoleErrors.filter(e =>
  !/favicon|beacon|Failed to load resource: the server responded with a status of 404/i.test(e));
if (relevant.length) {
  console.log('  ⚠️ 捕获到错误：');
  relevant.slice(0, 8).forEach(e => console.log('     ' + e.slice(0, 160)));
} else {
  console.log('  无 JS 错误');
}

console.log('\n' + '═'.repeat(52));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  failures.forEach(f => console.log('  - ' + f));
}

await browser.close();
process.exit(fail ? 1 : 0);
