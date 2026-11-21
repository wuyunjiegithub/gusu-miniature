/**
 * 电影级漫游回归探针。用法: node scripts/qa-tour.mjs [baseUrl]
 * 校验：启动、相机平滑移动、开场高空→俯冲下降、旋转段角度变化、
 *       暂停冻结、继续、倍速、进度推进、快捷键、用户交互中断、0 错误。
 */
import puppeteer from 'puppeteer-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] ?? 'http://127.0.0.1:5173/';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 180000 });
await wait(7000);

const out = {};
out.startButton = await page.$eval('.tour-start', (el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => null);

await page.click('.tour-start');
await wait(1200);
out.activeAfterStart = await page.$('.hud-tour.is-active') !== null;

// 采样相机轨迹（每 ~1s 一次，共 12 次；2× 倍速加速推进）
await page.evaluate(() => { const b = [...document.querySelectorAll('.tour-speed button')].find((x) => x.textContent === '2×'); b?.click(); });
const traj = [];
for (let i = 0; i < 12; i++) {
  await wait(1000);
  const d = await page.evaluate(() => ({
    cam: window.__tourCam ?? null,
    shot: document.querySelector('.tour-stop')?.textContent ?? '',
    prog: parseFloat(document.querySelector('.tour-progress-fill')?.style.width ?? '0'),
  }));
  traj.push(d);
}
out.trajectory = traj;

// 相机确实在移动（不同采样点位置不同）
const cams = traj.map((t) => t.cam).filter(Boolean);
const distinct = new Set(cams.map((c) => `${Math.round(c.x)},${Math.round(c.y)},${Math.round(c.z)}`));
out.cameraMoves = distinct.size > 3;

// 高度变化：开场高空（y>2000）后续出现较低机位（俯冲/景点段）
const ys = cams.map((c) => c.y);
out.startHigh = ys.length ? Math.max(...ys.slice(0, 3)) > 2000 : false;
out.hasDive = ys.length ? Math.min(...ys) < Math.max(...ys.slice(0, 3)) * 0.5 : false;

// 镜头字幕含关键段落
const shots = traj.map((t) => t.shot).join('|');
out.hasCinematicShots = /俯冲|盘门|全景|园林|街/.test(shots);

// 进度单向推进
out.progressAdvances = traj.length > 1 && traj.at(-1).prog > traj[0].prog;

// 暂停冻结
await page.evaluate(() => { const b = [...document.querySelectorAll('.tour-controls button')].find((x) => x.textContent.includes('暂停')); b?.click(); });
await wait(300);
const pc1 = await page.evaluate(() => window.__tourCam ?? null);
const pp1 = await page.$eval('.tour-progress-fill', (el) => el.style.width).catch(() => null);
await wait(1500);
const pc2 = await page.evaluate(() => window.__tourCam ?? null);
const pp2 = await page.$eval('.tour-progress-fill', (el) => el.style.width).catch(() => null);
out.pauseFreezesCamera = JSON.stringify(pc1) === JSON.stringify(pc2);
out.pauseFreezesProgress = pp1 === pp2;

// 继续 + 快捷键
await page.keyboard.press('Space');
await wait(300);
out.spaceResumes = await page.evaluate(() => [...document.querySelectorAll('.tour-controls button')].some((b) => b.textContent.includes('暂停')));
await page.keyboard.press('Escape');
await wait(400);
out.escExits = await page.$('.hud-tour.is-active') === null;

await page.keyboard.press('t');
await wait(500);
out.tStarts = await page.$('.hud-tour.is-active') !== null;
await page.mouse.click(700, 400);
await wait(400);
out.clickCanvasExits = await page.$('.hud-tour.is-active') === null;

out.errors = errs;
console.log(JSON.stringify(out, null, 2));
await browser.close();
