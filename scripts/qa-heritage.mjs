/**
 * 文保精细建模回归探针（QA）：node scripts/qa-heritage.mjs [baseUrl]
 *
 * 校验：
 * 1. 31 处国保/省保已注入场景几何 + 侧栏分组；
 * 2. 精细建筑群已渲染：材质分桶数、顶点规模都远超旧的"一个 box"占位；
 * 3. 建筑数据已剔除文保脚下的民居（否则精细建筑群被淹没）。
 */
import puppeteer from 'puppeteer-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] ?? 'http://127.0.0.1:5173/';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 180000 });
await page.evaluate(() => new Promise((r) => setTimeout(r, 8000)));

const info = await page.evaluate(async () => {
  const { sceneGeometry } = await import('/src/data/sceneGeometry.ts');
  const { HERITAGE_LANDMARKS } = await import('/src/data/heritage.ts');
  const keys = Object.keys(sceneGeometry.landmarks);

  const scene = window.__scene;
  // 精细建筑群按 14 个材质桶渲染；统计 heritage-* 命名的 mesh 顶点数
  let buckets = 0;
  let totalVerts = 0;
  const bucketNames = [];
  if (scene) {
    scene.traverse((o) => {
      if (!o.isMesh || !o.name?.startsWith('heritage-')) return;
      buckets += 1;
      bucketNames.push(o.name);
      totalVerts += o.geometry?.attributes?.position?.count ?? 0;
    });
  }

  // 建筑剔除：文保院落占地环内不应有城内民居实例。
  // 院落中心/半宽来自 heritage-footprints.json（与 build-buildings.mjs 同一份），
  // 因为它已经按路网避让搬到街区内，不再等于 OSM 质心。
  const { HERITAGE_FOOTPRINTS } = await import('/src/data/heritageFootprints.ts');
  const res = await fetch('/data/buildings.json');
  const data = await res.json();
  const all = [...(data.pitched ?? []), ...(data.flat ?? [])];
  const ringOf = (fp) =>
    Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2;
      const r = fp.r + 1.5;
      return [fp.x + Math.cos(a) * r, fp.z + Math.sin(a) * r];
    });
  const inRing = (ring, x, z) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  let buried = 0;
  const buriedIds = [];
  for (const h of HERITAGE_LANDMARKS) {
    const fp = HERITAGE_FOOTPRINTS[h.id];
    if (!fp || fp.hidden) continue;
    const ring = ringOf(fp);
    if (all.some((b) => inRing(ring, b[0], b[1]))) {
      buried += 1;
      buriedIds.push(h.id);
    }
  }

  const groups = [...document.querySelectorAll('.sidebar-group-title')].map((el) => el.textContent);
  const p3 = [...document.querySelectorAll('.sidebar-group')].find((g) =>
    g.textContent.includes('文保单位'),
  );

  return {
    landmarkTotal: keys.length,
    heritageInjected: HERITAGE_LANDMARKS.every((h) => sceneGeometry.landmarks[h.id]),
    heritageCount: HERITAGE_LANDMARKS.length,
    modelBuckets: buckets,
    bucketNames,
    modelVertices: totalVerts,
    buriedSites: buried,
    buriedIds,
    sidebarGroups: groups,
    p3Items: p3 ? p3.querySelectorAll('.sidebar-item').length : -1,
  };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();

// 门禁：精细模型必须有多个材质桶、足够顶点，且文保不被民居淹没
const ok =
  info.heritageInjected &&
  info.heritageCount === 31 &&
  info.modelBuckets >= 10 &&
  info.modelVertices > 20000 &&
  info.buriedSites === 0 &&
  info.p3Items === 31;
console.log(`[qa-heritage] ${ok ? 'PASS' : 'FAIL'}`);
if (!ok) process.exitCode = 1;
