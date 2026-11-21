import fs from 'node:fs';
import path from 'node:path';
import { gate, report } from './lib/qa-gate.mjs';

const root = path.resolve(import.meta.dirname, '..');
const roads = JSON.parse(fs.readFileSync(path.join(root, 'public/data/roads.json'), 'utf8'));
const buildings = JSON.parse(fs.readFileSync(path.join(root, 'public/data/buildings.json'), 'utf8'));
const sg = JSON.parse(fs.readFileSync(path.join(root, 'src/data/scene-geometry.json'), 'utf8'));

const MOAT_INNER = 4.6;
const MOAT_OUTER = MOAT_INNER + 120;
const ring = sg.cityOutline;

const pointInRing = (x, z) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};
const d2s = (x, z, a, b) => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 ? ((x - a[0]) * dx + (z - a[1]) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
};
const distRing = (x, z) => {
  let best = Infinity;
  for (let i = 0; i < ring.length; i += 1) best = Math.min(best, d2s(x, z, ring[i], ring[(i + 1) % ring.length]));
  return best;
};
/** 0 = 陆地，>0 = 在护城河水面内的深度 */
const moatDepth = (x, z) => {
  if (pointInRing(x, z)) return 0;
  const d = distRing(x, z);
  if (d <= MOAT_INNER || d >= MOAT_OUTER) return 0;
  return Math.min(d - MOAT_INNER, MOAT_OUTER - d);
};

// ---- 1) 道路进护城河
let roadPts = 0;
let roadWet = 0;
const wetRoads = [];
for (const kind of ['major', 'minor']) {
  for (const line of roads[kind]) {
    let wet = 0;
    let total = 0;
    for (let i = 0; i < line.length - 1; i += 1) {
      const a = line[i];
      const b = line[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(len / 6));
      for (let s = 0; s < steps; s += 1) {
        const t = (s + 0.5) / steps;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[1] + (b[1] - a[1]) * t;
        total += 1;
        if (moatDepth(x, z) > 8) wet += 1;
      }
    }
    roadPts += total;
    roadWet += wet;
    if (wet > 0) wetRoads.push({ kind, wet, total, head: line[0] });
  }
}
console.log(`[道路] 采样点 ${roadPts}，落在护城河水面内 ${roadWet}（占 ${((100 * roadWet) / roadPts).toFixed(2)}%）`);
console.log(`[道路] 涉水折线 ${wetRoads.length} 条`);
wetRoads
  .sort((a, b) => b.wet - a.wet)
  .slice(0, 12)
  .forEach((r) => {
    console.log(`  ${r.kind} 端点(${r.head[0].toFixed(0)},${r.head[1].toFixed(0)}) 涉水${r.wet}/${r.total}点`);
  });

// ---- 2) 建筑进护城河 / 压路
const ROAD_HALF = { major: 13, minor: 5.5 };
const segs = [];
for (const kind of ['major', 'minor']) {
  for (const line of roads[kind]) {
    for (let i = 0; i < line.length - 1; i += 1) segs.push({ kind, a: line[i], b: line[i + 1] });
  }
}
const CELL = 60;
const grid = new Map();
const key = (i, j) => `${i},${j}`;
segs.forEach((s) => {
  const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / CELL);
  const x1 = Math.floor(Math.max(s.a[0], s.b[0]) / CELL);
  const z0 = Math.floor(Math.min(s.a[1], s.b[1]) / CELL);
  const z1 = Math.floor(Math.max(s.a[1], s.b[1]) / CELL);
  for (let gx = x0; gx <= x1; gx += 1)
    for (let gz = z0; gz <= z1; gz += 1) {
      const k = key(gx, gz);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(s);
    }
});
const nearRoads = (x, z, r) => {
  const cx = Math.floor(x / CELL);
  const cz = Math.floor(z / CELL);
  const out = [];
  for (let i = cx - 1; i <= cx + 1; i += 1)
    for (let j = cz - 1; j <= cz + 1; j += 1) {
      const arr = grid.get(key(i, j));
      if (arr) out.push(...arr);
    }
  return out.filter((s) => d2s(x, z, s.a, s.b) < r);
};

let inMoat = 0;
let onRoad = 0;
let total = 0;
const samples = { inMoat: [], onRoad: [] };
for (const group of ['pitched', 'flat', 'outer']) {
  for (const rec of buildings[group] ?? []) {
    const [x, z, w, d, rot, h] = rec;
    total += 1;
    const ca = Math.cos(rot);
    const sa = Math.sin(rot);
    // 取四角 + 中心
    const pts = [
      [0, 0],
      [w / 2, d / 2],
      [-w / 2, d / 2],
      [w / 2, -d / 2],
      [-w / 2, -d / 2],
    ].map(([lx, lz]) => [x + lx * ca + lz * sa, z - lx * sa + lz * ca]);
    if (pts.some(([px, pz]) => moatDepth(px, pz) > 4)) {
      inMoat += 1;
      if (samples.inMoat.length < 8) samples.inMoat.push({ group, x: +x.toFixed(0), z: +z.toFixed(0), w: +w.toFixed(0), h: +h.toFixed(0) });
    }
    const hit = pts.find(([px, pz]) => {
      const near = nearRoads(px, pz, 40);
      return near.some((s) => d2s(px, pz, s.a, s.b) < ROAD_HALF[s.kind]);
    });
    if (hit) {
      onRoad += 1;
      if (samples.onRoad.length < 8) samples.onRoad.push({ group, x: +x.toFixed(0), z: +z.toFixed(0), w: +w.toFixed(0), d: +d.toFixed(0) });
    }
  }
}
console.log(`[建筑] 共 ${total}，落在护城河水面内 ${inMoat}，压到路面 ${onRoad}`);
if (samples.inMoat.length) console.log('  进水样例', samples.inMoat);
if (samples.onRoad.length) console.log('  压路样例', samples.onRoad);

// 门禁：护城河里绝不能有建筑（基线=0）；建筑压路是已知可接受瑕疵（基线≈2515），不门禁。
gate('建筑总数（防空数据）', total, { min: 20000, note: '基线=25506' });
gate('护城河内建筑数', inMoat, { max: 2, note: '基线=0，>2 视为建筑/水体错位' });
report('qa-moat');
