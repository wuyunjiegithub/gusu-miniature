/**
 * 视觉复核截图：无头 Chrome 打开本地 dev server，
 * 通过 URL 的 cam/target 参数与 UI 按钮组合出机位、昼夜与四季。
 *
 * 用法: node scripts/shoot.mjs [baseUrl]
 */
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://localhost:5174/';
const OUT = '.screenshots';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const settle = (page, ms) => page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);

async function clickText(page, text, selector = 'button') {
  const ok = await page.evaluate(
    (label, sel) => {
      const el = [...document.querySelectorAll(sel)].find((b) => b.textContent?.trim() === label);
      if (!el) return false;
      el.click();
      return true;
    },
    text,
    selector,
  );
  if (!ok) console.warn(`[warn] 未找到: ${text}`);
  await settle(page, 800);
}

async function clickLandmark(page, name) {
  const ok = await page.evaluate((label) => {
    const el = [...document.querySelectorAll('.sidebar-item-name')].find(
      (n) => n.textContent?.trim() === label,
    );
    if (!el) return false;
    el.closest('button')?.click();
    return true;
  }, name);
  if (!ok) console.warn(`[warn] 未找到景点: ${name}`);
  await settle(page, 2400);
}

async function shoot(page, name) {
  await settle(page, 600);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`[shot] ${name}`);
}

await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
  ],
  defaultViewport: { width: 1600, height: 1000 },
});

/** 打开一个机位：cam/target 走 URL 参数（仅在 dev 生效） */
async function open(page, query = '') {
  await page.goto(`${BASE}${query}`, { waitUntil: 'networkidle2', timeout: 120000 });
  await settle(page, 8000);
}

const page = await browser.newPage();
page.on('pageerror', (err) => console.log(`[pageerror] ${err.message.slice(0, 200)}`));
page.on('console', (msg) => {
  const text = msg.text();
  if (msg.type() === 'error') console.log(`[console.error] ${text.slice(0, 180)}`);
});

// 1. 全景 / 四季 / 夜景
await open(page);
await shoot(page, '01-panorama');
await clickText(page, '冬');
await shoot(page, '02-winter-day');
await clickText(page, '夜晚');
await shoot(page, '03-winter-night');
await clickText(page, '春');
await shoot(page, '04-spring-night');
await clickText(page, '白天');

// 2. 景点聚焦
for (const name of ['盘门', '山塘街', '拙政园', '留园', '网师园']) {
  await clickLandmark(page, name);
  await shoot(page, `10-landmark-${name}`);
}

// 3. 局部机位：城墙与护城河、路口标线
await open(page, '?cam=-150,260,2900&target=-700,0,2350');
await shoot(page, '20-panmen-gate');
await open(page, '?cam=1500,300,1200&target=900,0,1250');
await shoot(page, '21-junction-markings');
await open(page, '?cam=-2200,340,-1600&target=-2600,0,-1350');
await shoot(page, '22-wall-moat');

await browser.close();
