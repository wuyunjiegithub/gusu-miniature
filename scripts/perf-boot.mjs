/**
 * 启动阶段时间线：node scripts/perf-boot.mjs
 * 依次在若干时间点截图，并记录 #boot 是否还在，用于确认"启动页 → 出图"的过渡。
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const STAMPS = [400, 1200, 2500, 4000, 7000, 12000];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));

const t0 = Date.now();
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 300000 });

for (const ms of STAMPS) {
  const wait = ms - (Date.now() - t0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const boot = await page.evaluate(() => {
    const el = document.getElementById('boot');
    return el ? (el.classList.contains('is-done') ? 'fading' : 'visible') : 'removed';
  });
  await page.screenshot({ path: `.screenshots/qa/boot-${ms}.png` });
  console.log(`${String(ms).padStart(5)}ms  #boot=${boot}`);
}
await browser.close();
