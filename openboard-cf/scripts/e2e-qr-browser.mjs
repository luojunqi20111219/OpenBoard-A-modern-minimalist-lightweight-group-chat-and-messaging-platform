// 用真实 Chromium 打开线上页面，点「扫码登录」，看是否真的出二维码
import { chromium } from 'playwright-core';
import path from 'path';

const exec = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const HOST = 'liuyan.luojunqi.xyz';
const EDGE = '104.17.2.229';

const browser = await chromium.launch({
  executablePath: exec,
  args: ['--no-sandbox', '--disable-dev-shm-usage',
         `--host-resolver-rules=MAP ${HOST} ${EDGE}`,
         '--ignore-certificate-errors'],
});
// 禁用缓存，否则会拿到上次访问留下的旧 HTML
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, bypassCSP: true });
await ctx.route('**/*', r => r.continue());
const page = await ctx.newPage();

const errors = [], failed = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('requestfailed', r => failed.push(r.url() + ' :: ' + (r.failure()?.errorText || '')));

console.log('打开页面...');
await page.goto(`https://${HOST}/?nocache=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);
console.log('  标题:', await page.title());

// 打开登录弹窗
console.log('\n打开登录弹窗...');
await page.evaluate(() => {
  if (typeof showModal === 'function') showModal('login-modal');
});
await page.waitForTimeout(1500);

// 切到扫码登录
console.log('切到「扫码登录」页签...');
await page.evaluate(() => {
  if (typeof switchAuthTab === 'function') switchAuthTab('qr');
});
await page.waitForTimeout(5000);

// 检查二维码容器
const result = await page.evaluate(() => {
  const box = document.getElementById('qr-code-box');
  const msg = document.getElementById('qr-status-msg');
  const canvas = box ? box.querySelector('canvas') : null;
  const img = box ? box.querySelector('img') : null;
  return {
    boxHtmlLen: box ? box.innerHTML.length : -1,
    boxText: box ? box.innerText.trim() : '(no box)',
    hasCanvas: !!canvas,
    canvasSize: canvas ? `${canvas.width}x${canvas.height}` : null,
    hasImg: !!img,
    msg: msg ? msg.innerText.trim() : '',
    stillGenerating: box ? box.innerHTML.includes('正在生成') : false,
    showFailed: box ? box.innerHTML.includes('生成失败') : false,
    showExpired: box ? box.innerHTML.includes('已失效') : false,
  };
});

console.log('\n═══════════ 二维码渲染结果 ═══════════');
console.log('  容器内容长度  :', result.boxHtmlLen);
console.log('  容器内文字    :', JSON.stringify(result.boxText));
console.log('  有 canvas 吗  :', result.hasCanvas ? `YES ✅ (${result.canvasSize})` : 'NO ❌');
console.log('  有 img 吗     :', result.hasImg);
console.log('  还在"生成中"  :', result.stillGenerating ? 'YES ❌' : 'NO ✅');
console.log('  显示"生成失败":', result.showFailed ? 'YES ❌' : 'NO ✅');
console.log('  显示"已失效"  :', result.showExpired ? 'YES ❌' : 'NO ✅');
console.log('  状态提示      :', JSON.stringify(result.msg));

console.log('\n═══════════ 控制台错误 ═══════════');
if (errors.length === 0) console.log('  无 ✅');
else errors.slice(0, 10).forEach(e => console.log('  ❌', e.slice(0, 200)));

console.log('\n═══════════ 失败请求 ═══════════');
if (failed.length === 0) console.log('  无 ✅');
else failed.slice(0, 10).forEach(f => console.log('  ❌', f.slice(0, 200)));

await browser.close();
