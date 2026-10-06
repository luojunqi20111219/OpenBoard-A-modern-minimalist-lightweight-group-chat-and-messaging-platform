import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const reqs = [];
page.on('request', (r) => reqs.push({ url: r.url(), type: r.resourceType(), t: Date.now() }));
const resp = [];
page.on('response', async (r) => {
  try {
    const h = r.headers();
    resp.push({
      url: r.url(),
      status: r.status(),
      enc: h['content-encoding'] || '-',
      len: h['content-length'] || '?',
      cf: h['cf-cache-status'] || '-',
      colo: h['cf-ray'] ? h['cf-ray'].split('-')[1] : '-',
    });
  } catch {}
});

const t0 = Date.now();
await page.goto('https://liuyan.luojunqi.xyz/', { waitUntil: 'load', timeout: 60000 });
const loadTime = Date.now() - t0;

await page.waitForTimeout(3000);

// 用 Performance API 拿精确数据
const perf = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const res = performance.getEntriesByType('resource').map((e) => ({
    name: e.name.replace(location.origin, ''),
    type: e.initiatorType,
    start: Math.round(e.startTime),
    dur: Math.round(e.duration),
    size: e.transferSize || 0,
    decoded: e.decodedBodySize || 0,
  }));
  return {
    dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
    tcp: Math.round(nav.connectEnd - nav.connectStart),
    tls: nav.secureConnectionStart ? Math.round(nav.connectEnd - nav.secureConnectionStart) : 0,
    ttfb: Math.round(nav.responseStart - nav.requestStart),
    domInteractive: Math.round(nav.domInteractive),
    domComplete: Math.round(nav.domComplete),
    loadEvent: Math.round(nav.loadEventEnd),
    resources: res,
  };
});

console.log('═══════════ 首屏时序 ═══════════');
console.log(`DNS          ${perf.dns} ms`);
console.log(`TCP 连接     ${perf.tcp} ms`);
console.log(`TLS 握手     ${perf.tls} ms`);
console.log(`首字节 TTFB  ${perf.ttfb} ms`);
console.log(`DOM 可交互   ${perf.domInteractive} ms`);
console.log(`页面加载完成 ${perf.loadEvent} ms  (实测 ${loadTime}ms)`);

console.log('\n═══════════ 资源请求 ═══════════');
console.log(`共 ${perf.resources.length} 个请求\n`);
console.log('传输量    解码后   耗时    类型        路径');
console.log('─'.repeat(80));
let totalTransfer = 0, totalDecoded = 0;
for (const r of perf.resources.sort((a, b) => a.start - b.start)) {
  totalTransfer += r.size;
  totalDecoded += r.decoded;
  console.log(
    `${String(r.size).padStart(8)}  ${String(r.decoded).padStart(8)}  ${String(r.dur).padStart(5)}ms  ${r.type.padEnd(11)} ${r.name.slice(0, 46)}`
  );
}
console.log('─'.repeat(80));
console.log(`合计传输 ${totalTransfer.toLocaleString()} B (${(totalTransfer/1024).toFixed(1)} KB)`);
console.log(`合计解码 ${totalDecoded.toLocaleString()} B (${(totalDecoded/1024).toFixed(1)} KB)`);
console.log(`压缩比   ${totalTransfer ? (totalDecoded/totalTransfer).toFixed(1) : '-'}x`);

console.log('\n═══════════ CF 缓存状态 ═══════════');
const byStatus = {};
for (const r of resp) byStatus[r.cf] = (byStatus[r.cf] || 0) + 1;
console.log(byStatus);
console.log('colo:', [...new Set(resp.map(r => r.colo))].join(', '));

await browser.close();
