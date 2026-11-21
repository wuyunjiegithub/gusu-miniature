/**
 * 几何常识检查（QA）：断头路 / 建筑压路 / 道路入水 / 建筑入水
 * 用法: node scripts/qa-geometry.mjs
 * 只读分析，不修改数据。
 */
import { readFile } from 'node:fs/promises';
import { gate, report } from './lib/qa-gate.mjs';

const root = new URL('../', import.meta.url);
const roads = JSON.parse(await readFile(new URL('public/data/roads.json', root), 'utf8'));
const buildings = JSON.parse(await readFile(new URL('public/data/buildings.json', root), 'utf8'));
const scene = JSON.parse(await readFile(new URL('src/data/scene-geometry.json', root), 'utf8'));

const cityRing = scene.cityOutline;
const canals = scene.waterways ?? [];
const outerWater = scene.outerWaterways ?? [];

/* ---------- 空间索引 ---------- */
const CELL = 50;
const grid = new Map();
const key = (cx, cz) => `${cx},${cz}`;
const addSeg = (seg, gi) => {
  const minX = Math.min(seg.a[0], seg.b[0]);
  const maxX = Math.max(seg.a[0], seg.b[0]);
  const minZ = Math.min(seg.a[1], seg.b[1]);
  const maxZ = Math.max(seg.a[1], seg.b[1]);
  for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx += 1) {
    for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz += 1) {
      const k = key(cx, cz);
      let arr = grid.get(k);
      if (!arr) grid.set(k, (arr = []));
      arr.push({ seg, gi });
    }
  }
};
const segList = [];
let lineId = 0;
const addLine = (pts, group) => {
  lineId += 1;
  const id = lineId;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const seg = { a: pts[i], b: pts[i + 1], group, id };
    segList.push(seg);
    addSeg(seg, group);
  }
};
roads.major.forEach((l) => addLine(l, 'major'));
roads.minor.forEach((l) => addLine(l, 'minor'));

const distPointSeg = (px, pz, a, b) => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - a[0]) * dx + (pz - a[1]) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), pz - (a[1] + t * dz));
};

const nearSegs = (x, z, r = 30) => {
  const out = [];
  const r2 = r + CELL;
  for (let cx = Math.floor((x - r2) / CELL); cx <= Math.floor((x + r2) / CELL); cx += 1) {
    for (let cz = Math.floor((z - r2) / CELL); cz <= Math.floor((z + r2) / CELL); cz += 1) {
      const arr = grid.get(key(cx, cz));
      if (arr) out.push(...arr);
    }
  }
  return out;
};

const inRing = (ring, x, z) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};
const ringClosed = [...cityRing, cityRing[0]];

/* ---------- 1. 断头路 ---------- */
const lineWidths = { major: 26 / 2, minor: 11 / 2 };
const dangling = [];
let currentId = 0;
for (const group of ['major', 'minor']) {
  for (const line of roads[group]) {
    currentId += 1;
    if (line.length < 2) continue;
    for (const [endIdx] of [[0], [line.length - 1]]) {
      const p = line[endIdx];
      // 端点周围有没有"别的路"接近（自身这条线不算）
      let best = Infinity;
      for (const { seg } of nearSegs(p[0], p[1], 40)) {
        if (seg.id === currentId) continue;
        const d = distPointSeg(p[0], p[1], seg.a, seg.b);
        if (d < 1.5) {
          best = 0;
          break;
        }
        if (d < best) best = d;
      }
      const limit = lineWidths[group] + 6;
      if (best > limit) dangling.push({ group, p, dist: best, len: line.length });
    }
  }
}
console.log(`\n=== 断头路 ===`);
console.log(`总端点数 ${roads.major.length * 2 + roads.minor.length * 2}，悬空端点 ${dangling.length}`);
const bucket = (d) => (d < 60 ? '<60m' : d < 300 ? '60-300m' : '>300m');
const counts = {};
for (const d of dangling) counts[`${d.group}-${bucket(d.dist)}`] = (counts[`${d.group}-${bucket(d.dist)}`] ?? 0) + 1;
console.log(counts);
console.log('最近 25 个（悬空 60m 内的地方最刺眼）:');
for (const d of dangling.filter((x) => x.dist < 60).slice(0, 25)) {
  console.log(`  ${d.group} (${d.p[0].toFixed(0)}, ${d.p[1].toFixed(0)}) 距最近路 ${d.dist.toFixed(1)}m`);
}

/* ---------- 2. 建筑压路 ---------- */
const W = { major: 13, minor: 5.5 };
const onRoad = [];
const checkBox = (rec, group, source) => {
  const [x, z, w, d, rot] = rec;
  const ca = Math.cos(rot);
  const sa = Math.sin(rot);
  // 沿矩形内部采样（0.5m 步长受性能限制，用 6x6 采样足够定位）
  const nx = 6;
  const nz = 6;
  let worst = null;
  for (let iu = 0; iu <= nx; iu += 1) {
    for (let iv = 0; iv <= nz; iv += 1) {
      const lx = (iu / nx - 0.5) * w;
      const lz = (iv / nz - 0.5) * d;
      const wx = x + lx * ca + lz * sa;
      const wz = z - lx * sa + lz * ca;
      for (const { seg, gi } of nearSegs(wx, wz, 30)) {
        const dist = distPointSeg(wx, wz, seg.a, seg.b);
        const limit = W[gi];
        if (dist < limit) {
          if (!worst || limit - dist > worst.over) worst = { over: limit - dist, gi, wx, wz };
        }
      }
    }
  }
  if (worst) onRoad.push({ source, group, x, z, w, d, over: worst.over, gi: worst.gi, at: [worst.wx, worst.wz] });
};
for (const rec of buildings.pitched) checkBox(rec, 'real', 'pitched');
for (const rec of buildings.flat) checkBox(rec, 'real', 'flat');
for (const rec of buildings.outer) checkBox(rec, 'outer', 'outer');
console.log(`\n=== 建筑压路 ===`);
const bySrc = {};
for (const r of onRoad) bySrc[`${r.source}/${r.group}`] = (bySrc[`${r.source}/${r.group}`] ?? 0) + 1;
console.log(bySrc, '总计', onRoad.length);
console.log('压得最深的 12 个:');
for (const r of [...onRoad].sort((a, b) => b.over - a.over).slice(0, 12)) {
  console.log(`  ${r.source} ${r.group} 中心(${r.x.toFixed(0)}, ${r.z.toFixed(0)}) 尺寸 ${r.w.toFixed(1)}x${r.d.toFixed(1)} 侵入 ${r.over.toFixed(1)}m`);
}

/* ---------- 3. 道路入水 ---------- */
const CANAL_HALF = 15;
const MOAT = 120;
const waterHit = (x, z) => {
  for (const line of canals) {
    for (let i = 0; i < line.length - 1; i += 1) {
      if (distPointSeg(x, z, line[i], line[i + 1]) < CANAL_HALF) return 'canal';
    }
  }
  if (!inRing(cityRing, x, z)) {
    for (let i = 0; i < ringClosed.length - 1; i += 1) {
      if (distPointSeg(x, z, ringClosed[i], ringClosed[i + 1]) < MOAT) return 'moat';
    }
  }
  for (const line of outerWater) {
    for (let i = 0; i < line.length - 1; i += 1) {
      if (distPointSeg(x, z, line[i], line[i + 1]) < 15) return 'outer';
    }
  }
  return null;
};
const roadInWater = [];
for (const group of ['major', 'minor']) {
  for (const line of roads[group]) {
    for (let i = 0; i < line.length - 1; i += 1) {
      const a = line[i];
      const b = line[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(len / 5));
      let hits = 0;
      for (let s = 0; s <= steps; s += 1) {
        const t = s / steps;
        if (waterHit(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) hits += 1;
      }
      if (hits > 0) roadInWater.push({ group, a, b, ratio: hits / (steps + 1) });
    }
  }
}
console.log(`\n=== 道路入水 ===`);
console.log(`涉水路段 ${roadInWater.length} 段，共 ${(roadInWater.reduce((s, r) => s + r.ratio, 0) * 5).toFixed(0)}m（估算）`);
const waterBuckets = {};
for (const r of roadInWater) waterBuckets[r.group] = (waterBuckets[r.group] ?? 0) + 1;
console.log(waterBuckets);
console.log('完全没入水（ratio=1）的前 15 段:');
for (const r of roadInWater.filter((r) => r.ratio > 0.95).slice(0, 15)) {
  console.log(`  ${r.group} (${r.a[0].toFixed(0)}, ${r.a[1].toFixed(0)}) → (${r.b[0].toFixed(0)}, ${r.b[1].toFixed(0)})`);
}

/* ---------- 4. 建筑入水 ---------- */
const bInWater = [];
const checkWater = (rec, source) => {
  const [x, z, w, d, rot] = rec;
  const ca = Math.cos(rot);
  const sa = Math.sin(rot);
  for (const [iu, iv] of [
    [0, 0],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ]) {
    const wx = x + (iu * w) / 2;
    const wz = z + (iv * d) / 2;
    const px = x + ((iu * w) / 2) * ca + ((iv * d) / 2) * sa;
    const pz = z - ((iu * w) / 2) * sa + ((iv * d) / 2) * ca;
    void wx;
    void wz;
    if (waterHit(px, pz)) {
      bInWater.push({ source, x, z, at: [px, pz] });
      return;
    }
  }
};
for (const rec of buildings.pitched) checkWater(rec, 'pitched');
for (const rec of buildings.flat) checkWater(rec, 'flat');
for (const rec of buildings.outer) checkWater(rec, 'outer');
console.log(`\n=== 建筑入水 ===  ${bInWater.length}`);
const bw = {};
for (const r of bInWater) bw[r.source] = (bw[r.source] ?? 0) + 1;
console.log(bw);
for (const r of bInWater.slice(0, 10)) console.log(`  ${r.source} (${r.x.toFixed(0)}, ${r.z.toFixed(0)})`);

// 门禁：只卡"完全没入水"的灾难情况。
// 注意这里的统计把跨河桥面也算成涉水路段：现有 7 座跨护城河桥（跨度 115~138m）
// 与 1 座城内河桥的桥面本身就在水面之上，合计约 300 余段，属正常。
// "水中长段是否被桥面覆盖"由 qa-water-road.ts 单独校验，所以上限放到 700
// 仍能拦住真正的灾难（整条路压到河上）。
gate('建筑入水总数', bInWater.length, { max: 8, note: '基线=1' });
gate('涉水路段总数', roadInWater.length, { max: 700, note: '基线≈350（含跨河桥面，桥面由 qa-water-road 校验）' });
gate('道路总段数（防空数据）', segList.length, { min: 3000, note: '基线≈4626' });
gate('建筑总数（防空数据）', buildings.pitched.length + buildings.flat.length + buildings.outer.length, { min: 20000, note: '基线=25506' });
report('qa-geometry');
