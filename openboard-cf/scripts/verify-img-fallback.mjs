// 直接验证 onerror 兜底逻辑本身（不依赖线上脏数据）
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox','--disable-dev-shm-usage'] });
const page = await (await b.newContext()).newPage();
await page.setContent('<div id="t"></div>');

const r = await page.evaluate(async () => {
  const host = document.getElementById('t');
  // 复刻线上那段 onerror 逻辑
  host.innerHTML = `<img id="im" src="https://invalid.example/nope.jpg"
    data-original="https://invalid.example/orig.jpg" loading="lazy"
    onerror="if(!this.dataset.fallback){this.dataset.fallback='1';this.src=this.dataset.original;}else{this.replaceWith(Object.assign(document.createElement('span'),{className:'ph',textContent:'图片加载失败'}))}">`;
  await new Promise(r => setTimeout(r, 3000));
  const im = document.getElementById('im');
  const span = host.querySelector('span');
  return {
    imgStillThere: !!im,
    srcNow: im ? im.src : null,
    fallbackFlag: im ? im.dataset.fallback : null,
    replacedBySpan: !!span,
    spanText: span ? span.textContent : null,
  };
});

console.log('=== onerror 兜底行为 ===');
console.log('  <img> 还在吗      :', r.imgStillThere);
console.log('  已切到原图地址吗  :', r.srcNow, r.srcNow && r.srcNow.includes('orig.jpg') ? '✅' : '❌');
console.log('  fallback 标记已置 :', r.fallbackFlag === '1' ? 'YES ✅' : 'NO');
console.log('  后退为占位元素    :', r.replacedBySpan ? 'YES ✅' : 'NO');
console.log('  占位文案          :', JSON.stringify(r.spanText));
await b.close();
