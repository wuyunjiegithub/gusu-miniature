/**
 * 通用机位截图（QA 用）：node scripts/qa-shot.mjs baseUrl name=cam|target ...
 * 例: node scripts/qa-shot.mjs http://127.0.0.1:5173/ hill=-4700,520,1400|-5100,120,650
 */
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173/';
const OUT = '.screenshots/qa';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const views = process.argv.slice(3).map((arg) => {
  const eq = arg.indexOf('=');
  const name = arg.slice(0, eq);
  // 支持 name=cam|target 和 name=cam|target|time=night,season=winter
  const parts = arg.slice(eq + 1).split('|');
  return { name, cam: parts[0], target: parts[1], extra: parts[2] ?? '' };
});

const settle = (page, ms) => page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);
/** 模型生成较慢时可 WAIT_MS=35000 覆盖 */
const WAIT = Number(process.env.WAIT_MS ?? 18000);

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (err) => console.log(`[pageerror] ${err.message.slice(0, 200)}`));
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    console.log(`[${msg.type()}] ${msg.text().slice(0, 240)}`);
  }
});

for (const view of views) {
  const sep = BASE.includes('?') ? '&' : '?';
  let url = `${BASE}${sep}cam=${view.cam}&target=${view.target}`;
  if (view.extra) {
    // 值本身可能含逗号（如 hide=roads,water），没有等号的片段并回上一个值
    const pairs = [];
    for (const piece of view.extra.split(',')) {
      const eq2 = piece.indexOf('=');
      if (eq2 > 0) pairs.push([piece.slice(0, eq2), piece.slice(eq2 + 1)]);
      else if (pairs.length > 0) pairs[pairs.length - 1][1] += `,${piece}`;
    }
    for (const [k, v] of pairs) if (k && v) url += `&${k}=${v}`;
  }
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 180000 });
  await settle(page, WAIT);
  await page.screenshot({ path: `${OUT}/${view.name}.png` });
  console.log(`[shot] ${view.name}`);
}

await browser.close();
