/**
 * 树-路穿模回归探针：从 window.__treePositions 读最终树位，
 * 按真实路面半宽校验「树上路」为 0，并按城内/城外分组。
 * 用法: node scripts/qa-tree-road.mjs [baseUrl]
 */
import puppeteer from 'puppeteer-core';
import { readFile } from 'node:fs/promises';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] ?? 'http://127.0.0.1:5173/';
const ROOT = new URL('../', import.meta.url);

const roads = JSON.parse(await readFile(new URL('public/data/roads.json', ROOT), 'utf8'));
const scene = JSON.parse(await readFile(new URL('src/data/scene-geometry.json', ROOT), 'utf8'));
const ROAD_HALF = { major: 13, minor: 5.5 };
const CITY = scene.cityOutline;
const pointInRing = (ring, x, z) => {
  let inside = false;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
    const [xi, zi] = ring[i], [xk, zk] = ring[k];
    if ((zi > z) !== (zk > z) && x < ((xk - xi) * (z - zi)) / (zk - zi) + xi) inside = !inside;
  }
  return inside;
};
const distSeg = (x, z, a, b) => {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
};
// 路面深度判定（与渲染一致：major 半宽13 / minor 半宽5.5）
const onRoad = (x, z) => {
  for (const kind of ['major', 'minor']) {
    for (const line of roads[kind]) {
      for (let i = 0; i < line.length - 1; i++) {
        if (Math.abs(line[i][0] - x) > 40 || Math.abs(line[i][1] - z) > 40) continue;
        if (distSeg(x, z, line[i], line[i + 1]) < ROAD_HALF[kind]) return true;
      }
    }
  }
  return false;
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  defaultViewport: { width: 1200, height: 800 },
});
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction(() => Array.isArray(window.__treePositions) && window.__treePositions.length > 0, { timeout: 120000 });
const trees = await page.evaluate(() => window.__treePositions);
await browser.close();

const area = (t) => pointInRing(CITY, t.x, t.z) ? 'inner' : (Math.hypot(t.x, t.z) < 3600 ? 'outer-near' : 'outer-far');
const counts = { inner: 0, 'outer-near': 0, 'outer-far': 0 };
for (const t of trees) counts[area(t)]++;
let onRoadCount = 0;
const samples = [];
for (const t of trees) {
  if (onRoad(t.x, t.z)) {
    onRoadCount++;
    if (samples.length < 10) samples.push({ x: Math.round(t.x), z: Math.round(t.z), area: area(t) });
  }
}
console.log(JSON.stringify({ treeTotal: trees.length, byArea: counts, treesOnRoad: onRoadCount, samples }, null, 2));
process.exitCode = onRoadCount === 0 ? 0 : 1;
