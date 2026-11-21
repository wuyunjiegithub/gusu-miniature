/**
 * 景区石台 / 文保院落的"压路"体检。
 *
 * 两类问题分开看：
 *  1. 石台面高过路面，且几何上盖住道路 → 马路与标线被整段遮住（用户截图
 *     "拙政园右侧压马路""留园右侧压马路"）。现在石台顶面压到支路路面
 *     （1.2m）以下，路网永远在上层；这里把它做成门禁，防止以后又抬回去。
 *  2. 文保院落压路 → 建筑直接造在马路上（潘世恩宅）。院落足迹由
 *     heritage-footprints.json 求解，这里用路网净距复核。
 *
 * 用法：node scripts/qa-pad-road.mjs [url] [landmarkId]
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] ?? 'http://127.0.0.1:5188/';
const only = process.argv[3];

const roads = JSON.parse(fs.readFileSync('public/data/roads.json', 'utf8'));
const footprints = JSON.parse(fs.readFileSync('src/data/heritage-footprints.json', 'utf8')).sites;
const ROAD_HALF = { major: 13, minor: 5.5 };
/** 支路路面标高：石台必须低于它 */
const MINOR_ROAD_Y = 1.2;

const footprintBad = [];
for (const [id, fp] of Object.entries(footprints)) {
  if (fp.hidden) continue;
  let clearance = Infinity;
  for (const kind of ['major', 'minor']) {
    for (const line of roads[kind]) {
      for (let i = 0; i < line.length - 1; i += 1) {
        const [ax, az] = line[i];
        const [bx, bz] = line[i + 1];
        const dx = bx - ax;
        const dz = bz - az;
        const l2 = dx * dx + dz * dz;
        let t = l2 ? ((fp.x - ax) * dx + (fp.z - az) * dz) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(fp.x - (ax + t * dx), fp.z - (az + t * dz)) - ROAD_HALF[kind];
        if (d < clearance) clearance = d;
      }
    }
  }
  if (clearance <= fp.r - 0.5) footprintBad.push([id, fp.r, clearance]);
}

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

const pads = await page.evaluate(() => {
  const out = {};
  window.__scene.traverse((o) => {
    if (!o.name?.startsWith('pad-') || !o.geometry) return;
    const pos = o.geometry.attributes.position;
    let maxY = -1e9;
    for (let i = 0; i < pos.count; i += 1) maxY = Math.max(maxY, pos.getY(i));
    const tris = [];
    const idx = o.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let t = 0; t < n; t += 3) {
      const a = idx ? idx.getX(t) : t;
      const b = idx ? idx.getX(t + 1) : t + 1;
      const c = idx ? idx.getX(t + 2) : t + 2;
      if (pos.getY(a) < maxY - 0.3 || pos.getY(b) < maxY - 0.3 || pos.getY(c) < maxY - 0.3) continue;
      tris.push([
        [pos.getX(a), pos.getZ(a)],
        [pos.getX(b), pos.getZ(b)],
        [pos.getX(c), pos.getZ(c)],
      ]);
    }
    out[o.name.slice(4)] = { top: maxY, tris };
  });
  return out;
});
await browser.close();

const inTri = (px, pz, t) => {
  const [[x1, z1], [x2, z2], [x3, z3]] = t;
  const d = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
  if (Math.abs(d) < 1e-9) return false;
  const a = ((z2 - z3) * (px - x3) + (x3 - x2) * (pz - z3)) / d;
  const b = ((z3 - z1) * (px - x3) + (x1 - x3) * (pz - z3)) / d;
  return a >= -0.001 && b >= -0.001 && 1 - a - b >= -0.001;
};

const raised = [];
for (const [id, pad] of Object.entries(pads)) {
  if (only && id !== only) continue;
  if (pad.top <= MINOR_ROAD_Y) continue; // 台面低于路面：路网在上层，不会遮挡
  const xs = pad.tris.flatMap((t) => t.map((p) => p[0]));
  const zs = pad.tris.flatMap((t) => t.map((p) => p[1]));
  const box = [Math.min(...xs) - 20, Math.max(...xs) + 20, Math.min(...zs) - 20, Math.max(...zs) + 20];
  let hits = 0;
  for (const kind of ['major', 'minor']) {
    for (const line of roads[kind]) {
      for (let i = 0; i < line.length - 1; i += 1) {
        const [ax, az] = line[i];
        const [bx, bz] = line[i + 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 6));
        for (let s = 0; s <= steps; s += 1) {
          const x = ax + ((bx - ax) * s) / steps;
          const z = az + ((bz - az) * s) / steps;
          if (x < box[0] || x > box[1] || z < box[2] || z > box[3]) continue;
          if (pad.tris.some((t) => inTri(x, z, t))) hits += 1;
        }
      }
    }
  }
  if (hits) raised.push([id, pad.top, hits]);
}

console.log(`石台 ${Object.keys(pads).length} 个；台面高于支路且盖住马路的 ${raised.length} 个`);
for (const [id, top, hits] of raised) console.log(`  ${id}: 台面 ${top.toFixed(2)}m，压路采样点 ${hits}`);
console.log(`文保院落压路 ${footprintBad.length} 处`);
for (const [id, r, c] of footprintBad) console.log(`  ${id}: 半宽 ${r}，净距 ${c.toFixed(1)}`);

const ok = raised.length === 0 && footprintBad.length === 0;
console.log(`[qa-pad-road] ${ok ? 'PASS' : 'FAIL'}`);
if (!ok) process.exitCode = 1;
