#!/usr/bin/env node
/**
 * 登录态完整流程实测（用真实 Chromium 打开线上页面）
 *
 * 为什么要这个：二维码接口修好≠用户能用。必须走完
 * 「注册 → 登录 → 进主页 → 各页签」全链路，才能确认没有
 * 残留的 JS 崩溃把后续逻辑带死（`globalGroups is not iterable`
 * 就是这么被发现的 —— 它在扫码登录之前就把页面 JS 干停了）。
 */
import { chromium } from 'playwright-core';

const exec = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const HOST = 'liuyan.luojunqi.xyz';
const EDGE = '104.17.2.229';

const browser = await chromium.launch({
  executablePath: exec,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--host-resolver-rules=MAP ${HOST} ${EDGE}`,
    '--ignore-certificate-errors',
  ],
});
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 160));
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message.slice(0, 160)));

const suffix = Math.random().toString(36).slice(2, 7);
const user = 'webtest' + suffix;
const pass = 'WebTest1234!Pass';

console.log('打开页面...');
const bust = 'https://' + HOST + '/?t=' + Date.now();
await page.goto(bust, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);

console.log('注册账号:', user);
const reg = await page.evaluate(
  async (args) => {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: args.user,
        password: args.pass,
        nickname: args.user,
        remember_me: true,
        device_id: 'e2e-device',
        device_name: 'E2E Chromium',
      }),
    });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, hasToken: !!(j.token || j.access_token) };
  },
  { user, pass },
);
console.log('  ->', JSON.stringify(reg));

console.log('');
console.log('登录...');
await page.evaluate(
  async (args) => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: args.user,
        password: args.pass,
        remember_me: true,
        device_id: 'e2e-device',
        device_name: 'E2E Chromium',
      }),
    });
    const j = await res.json();
    if (typeof enterAuthenticatedSession === 'function') {
      enterAuthenticatedSession(j, true);
    }
  },
  { user, pass },
);
await page.waitForTimeout(6000);

console.log('');
console.log('检查登录后的界面状态：');
const st = await page.evaluate(() => {
  const g = typeof globalGroups !== 'undefined' ? globalGroups : undefined;
  return {
    user: typeof currentUser !== 'undefined' && currentUser ? currentUser.username : null,
    groupsIsArray: Array.isArray(g),
    groupsLen: Array.isArray(g) ? g.length : null,
    roomsRendered: document.querySelectorAll('[id^="room-btn-"]').length,
    hasInput: !!document.querySelector('#msg-input, textarea'),
  };
});
console.log('  当前用户        :', st.user);
console.log('  globalGroups 是数组:', st.groupsIsArray ? 'YES ✅' : 'NO ❌');
console.log('  globalGroups 长度 :', st.groupsLen);
console.log('  渲染的房间数    :', st.roomsRendered);
console.log('  有输入框吗      :', st.hasInput ? 'YES ✅' : 'NO ❌');

console.log('');
console.log('切到「我的二维码」页签：');
// 正确的弹窗 id 是 search-friends-modal（不是 friends-modal，别再猜了）
await page.evaluate(() => {
  if (typeof showModal === 'function') showModal('search-friends-modal');
});
await page.waitForTimeout(1200);
await page.evaluate(() => {
  if (typeof switchFriendTab === 'function') switchFriendTab('my-qr');
});
await page.waitForTimeout(3000);
const qr = await page.evaluate(() => {
  const box = document.getElementById('my-friend-qr-box');
  const canvas = box ? box.querySelector('canvas') : null;
  return {
    exists: !!box,
    hasCanvas: !!canvas,
    size: canvas ? canvas.width + 'x' + canvas.height : null,
  };
});
console.log('  二维码容器存在    :', qr.exists ? 'YES ✅' : 'NO ❌');
console.log('  好友二维码 canvas :', qr.hasCanvas ? 'YES ✅ (' + qr.size + ')' : 'NO ❌');

console.log('');
console.log('═════════ 控制台错误汇总 ═════════');
const real = errors.filter((e) => !e.includes('401'));
if (real.length === 0) console.log('  无真实错误 ✅');
else real.slice(0, 12).forEach((e) => console.log('  ❌', e));

await browser.close();
