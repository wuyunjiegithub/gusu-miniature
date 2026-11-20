/**
 * 道路数据处理（M1）：OSM highway → 局部米制折线，按等级分组
 * 输入 data/raw/roads-*.json / greater-roads-*.json / greater-streets-*.json
 * 输出 public/data/roads.json
 * 结构: { major: [[[x,z],...]], minor: [[[x,z],...]] }
 * 用法: node scripts/build-roads.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ORIGIN = { lon: 120.621, lat: 31.311 };
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);
const toLocal = (lon, lat) => ({
  x: (lon - ORIGIN.lon) * M_PER_DEG_LON,
  z: -(lat - ORIGIN.lat) * M_PER_DEG_LAT,
});

const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const MINOR = new Set([
  'residential',
  'unclassified',
  'living_street',
  'pedestrian',
  'service',
  'footway',
  'cycleway',
  'path',
]);

/** 城外数据止于约 5.8km（西至寒山寺一带），再远没有城市肌理 */
const WORLD_LIMIT = 5800;

/**
 * 折线裁剪到 ±WORLD_LIMIT 方框（Liang–Barsky 逐段）。
 * OSM 的 way 会整条返回，跨出查询框的路段可能伸到 12km 外。
 */
function clipPolyline(points, limit) {
  const boxes = [];
  let current = [];
  const flush = () => {
    if (current.length > 1) boxes.push(current);
    current = [];
  };
  const clipSegment = (a, b) => {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const p = [-dx, dx, -dz, dz];
    const q = [a.x + limit, limit - a.x, a.z + limit, limit - a.z];
    let t0 = 0;
    let t1 = 1;
    for (let i = 0; i < 4; i += 1) {
      if (p[i] === 0) {
        if (q[i] < 0) return null;
      } else {
        const r = q[i] / p[i];
        if (p[i] < 0) {
          if (r > t1) return null;
          if (r > t0) t0 = r;
        } else {
          if (r < t0) return null;
          if (r < t1) t1 = r;
        }
      }
    }
    return [t0, t1];
  };

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const hit = clipSegment(a, b);
    if (!hit) {
      flush();
      continue;
    }
    const [t0, t1] = hit;
    const s = t0 === 0 ? a : { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 };
    const e = t1 === 1 ? b : { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
    if (current.length === 0) {
      current = [s, e];
    } else {
      const tail = current[current.length - 1];
      if (Math.abs(tail.x - s.x) < 1e-6 && Math.abs(tail.z - s.z) < 1e-6) current.push(e);
      else {
        flush();
        current = [s, e];
      }
    }
  }
  flush();
  return boxes;
}

/** Douglas-Peucker 简化（局部米制，容差米） */
function simplify(points, tolerance) {
  if (points.length <= 3) return points;
  const sqTol = tolerance * tolerance;
  const sqSegDist = (p, a, b) => {
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = 0;
    if (len2 > 0) t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
    const px = a.x + t * dx - p.x;
    const pz = a.z + t * dz - p.z;
    return px * px + pz * pz;
  };
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [s, e] = stack.pop();
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i += 1) {
      const d = sqSegDist(points[i], points[s], points[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > sqTol && idx !== -1) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const lengthOf = (pts) => {
  let sum = 0;
  for (let i = 0; i < pts.length - 1; i += 1) sum += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
  return sum;
};

const wayById = new Map();
const tileNames = [];
for (let r = 0; r < 3; r += 1) {
  for (let c = 0; c < 3; c += 1) {
    tileNames.push(`roads-${r}-${c}.json`);
    tileNames.push(`greater-roads-${r}-${c}.json`);
    tileNames.push(`streets-${r}-${c}.json`);
  }
}
for (const name of tileNames) {
  let text;
  try {
    text = await readFile(new URL(`../data/raw/${name}`, import.meta.url), 'utf8');
  } catch {
    continue; // 城外瓦片可能尚未抓取
  }
  for (const el of JSON.parse(text).elements ?? []) {
    if (el.type === 'way' && el.geometry?.length >= 2) wayById.set(el.id, el);
  }
}

const major = [];
const minor = [];
let dropped = 0;

for (const way of wayById.values()) {
  const kind = way.tags?.highway;
  if (!MAJOR.has(kind) && !MINOR.has(kind)) {
    dropped += 1;
    continue;
  }
  const isMajor = MAJOR.has(kind);
  const local = way.geometry.map((p) => toLocal(p.lon, p.lat));
  for (const piece of clipPolyline(local, WORLD_LIMIT)) {
    // 支路在城外数量大，用更粗的容差压低顶点数与包体
    const simplified = simplify(piece, isMajor ? 2 : 3);
    if (lengthOf(simplified) < 25) {
      dropped += 1;
      continue;
    }
    const line = simplified.map((p) => [
      Math.round(p.x * 10) / 10,
      Math.round(p.z * 10) / 10,
    ]);
    (isMajor ? major : minor).push(line);
  }
}

console.log(`[道路] 原始 ${wayById.size}，保留 主干 ${major.length} / 支路 ${minor.length}，丢弃 ${dropped}`);

await mkdir(new URL('../public/data/', import.meta.url), { recursive: true });
const outFile = new URL('../public/data/roads.json', import.meta.url);
await writeFile(outFile, JSON.stringify({ meta: { origin: ORIGIN, unit: 'meter' }, major, minor }));
console.log(`[输出] ${outFile.pathname}`);
