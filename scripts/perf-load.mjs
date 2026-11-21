/**
 * 首屏加载耗时诊断：node scripts/perf-load.mjs [url]
 * 输出：导航各阶段耗时、长任务、首帧时间、总阻塞时间
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);

const t0 = Date.now();
page.on('console', (m) => {
  const t = ((Date.now() - t0) / 1000).toFixed(2);
  if (m.type() === 'error' || m.type() === 'warning') return;
  console.log(`[${t}s][console] ${m.text().slice(0, 160)}`);
});

await page.evaluateOnNewDocument(() => {
  window.__long = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__long.push({ start: Math.round(e.startTime), dur: Math.round(e.duration), name: e.name });
    }
  }).observe({ entryTypes: ['longtask'] });
  window.__firstPaint = null;
  const tick = (ts) => {
    if (window.__firstPaint === null) window.__firstPaint = Math.round(ts);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

await page.goto(BASE, { waitUntil: 'load', timeout: 300000 });
const loadMs = Date.now() - t0;
console.log(`[load 事件] ${loadMs} ms`);

// 等画布出现非空像素
const canvasTime = await page.evaluate(async () => {
  const start = performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (performance.now() - start < 120000) {
    const c = document.querySelector('canvas');
    if (c && c.width > 10) {
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (gl) {
        const px = new Uint8Array(4 * 16);
        gl.readPixels(Math.floor(c.width / 2), Math.floor(c.height / 2), 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, px);
        if (px.some((v, i) => i % 4 !== 3 && v > 0)) return Math.round(performance.now());
      }
    }
    await sleep(100);
  }
  return -1;
});
console.log(`[画布出图] ${canvasTime} ms（相对 navigationStart）`);

const stats = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const res = performance.getEntriesByType('resource')
    .map((r) => ({ n: r.name.split('/').pop(), d: Math.round(r.duration), size: r.transferSize }))
    .sort((a, b) => b.d - a.d)
    .slice(0, 12);
  return {
    domInteractive: Math.round(nav.domInteractive),
    domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
    loadEnd: Math.round(nav.loadEventEnd),
    long: window.__long ?? [],
    slowRes: res,
  };
});
console.log(`[导航] domInteractive ${stats.domInteractive}ms · DCL ${stats.domContentLoaded}ms · load ${stats.loadEnd}ms`);
const totalLong = stats.long.reduce((a, e) => a + e.dur, 0);
console.log(`[长任务] ${stats.long.length} 个，累计阻塞 ${totalLong}ms`);
stats.long.slice(0, 10).forEach((e) => console.log(`   +${e.start}ms  ${e.dur}ms`));
console.log('[最慢资源]');
stats.slowRes.forEach((r) => console.log(`   ${String(r.d).padStart(6)}ms  ${(r.size / 1024).toFixed(0)}KB  ${r.n}`));

await browser.close();
