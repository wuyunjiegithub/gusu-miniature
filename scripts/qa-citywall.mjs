/**
 * 城墙连续性探针：沿 cityOutline 每 2m 向下打一条射线，检查该处是否有墙顶
 * （y > 5m）。城门洞口是"应当断"的位置，按 CITY_GATES 的半宽排除。
 *
 * 用来锁住"盘门段城墙在水面上凭空截断"这类问题：Panmen 的墙段与 CityWall
 * 的留口必须严格同源，否则两端各缺 30~50m，视觉上就是一段墙悬在河心。
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] ?? 'http://127.0.0.1:5188/';
const SAMPLE = 2;

const ring = JSON.parse(fs.readFileSync('src/data/scene-geometry.json', 'utf8')).cityOutline;

/** 九个城门的原址经纬度（与 src/data/cityGates.ts 一致），投影到轮廓求里程 */
const ORIGIN = { lon: 120.621, lat: 31.311 };
const M_LAT = 111320;
const M_LON = M_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);
const TARGETS = [
  ['阊门', 120.6013986, 31.3173146],
  ['胥门', 120.6083156, 31.2994969],
  ['金门', 120.6012, 31.3053],
  ['平门', 120.6074628, 31.3287192],
  ['齐门', 120.6216, 31.332],
  ['娄门', 120.6428, 31.3235],
  ['相门', 120.6435, 31.312],
  ['葑门', 120.6363, 31.2962],
  ['盘门', 120.6128, 31.2888],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  protocolTimeout: 600000,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForFunction(() => Boolean(window.__scene), { timeout: 120000 });
await new Promise((r) => setTimeout(r, 2500));

const n = ring.length;
const cum = [0];
for (let i = 1; i <= n; i += 1) {
  const a = ring[i - 1];
  const b = ring[i % n];
  cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
}
const total = cum[n];

const gates = TARGETS.map(([name, lon, lat]) => {
  const vx = (lon - ORIGIN.lon) * M_LON;
  const vz = -(lat - ORIGIN.lat) * M_LAT;
  let best = { d: Infinity, s: 0 };
  for (let i = 0; i < n; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((vx - a[0]) * dx + (vz - a[1]) * dz) / len2)) : 0;
    const d = Math.hypot(vx - (a[0] + t * dx), vz - (a[1] + t * dz));
    if (d < best.d) best = { d, s: cum[i] + t * Math.sqrt(len2) };
  }
  return { name, s: best.s, half: name === '盘门' ? 165 : 23 };
});

const samples = [];
for (let s = 0; s < total; s += SAMPLE) {
  let i = 0;
  while (i < n - 1 && cum[i + 1] < s) i += 1;
  const f = (s - cum[i]) / (cum[i + 1] - cum[i] || 1);
  const a = ring[i];
  const b = ring[(i + 1) % n];
  samples.push([s, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
}

const hits = await page.evaluate((pts) => {
  const THREE = window.__THREE;
  const scene = window.__scene;
  // 只挑"墙候选"：几何顶面在 5~12m、水平展开 >40m 的网格（城墙/盘门墙段），
  // 全场景射线检测太慢（几万个实例）
  const walls = [];
  scene.traverse((o) => {
    if (!o.geometry || o.visible === false) return;
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox;
    if (!b) return;
    const spanX = b.max.x - b.min.x;
    const spanZ = b.max.z - b.min.z;
    if (Math.max(spanX, spanZ) < 40) return;
    if (b.max.y < 5 || b.max.y > 13) return;
    walls.push(o);
  });
  const rc = new THREE.Raycaster();
  const out = [];
  for (const [s, x, z] of pts) {
    rc.set(new THREE.Vector3(x, 80, z), new THREE.Vector3(0, -1, 0));
    const hit = rc.intersectObjects(walls, false)[0];
    out.push([s, hit ? hit.point.y : -999]);
  }
  return { walls: walls.length, out };
}, samples);
await browser.close();
const rows = hits.out;
console.log(`墙体候选网格 ${hits.walls} 个`);
const gaps = [];
let run = null;
for (const [s, y] of rows) {
  const inGate = gates.some((g) => Math.abs(s - g.s) < g.half + 2);
  if (y > 5 || inGate) {
    if (run) {
      gaps.push(run);
      run = null;
    }
  } else if (!run) run = [s, s];
  else run[1] = s;
}
if (run) gaps.push(run);

const bad = gaps.filter(([a, b]) => b - a > 6);
console.log(`城墙采样 ${rows.length} 点，缺口段 ${gaps.length} 个（>6m 的 ${bad.length} 个）`);
for (const [a, b] of bad) console.log(`  缺口 s=${a.toFixed(0)}..${b.toFixed(0)} 长 ${(b - a).toFixed(0)}m`);
if (bad.length) process.exitCode = 1;
