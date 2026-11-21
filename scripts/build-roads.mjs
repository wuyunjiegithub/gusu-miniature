/**
 * 道路数据处理（M1）：OSM highway → 局部米制折线，按等级分组
 * 输入 data/raw/roads-*.json / greater-roads-*.json / greater-streets-*.json
 * 输出 public/data/roads.json
 * 结构: { major: [[[x,z],...]], minor: [[[x,z],...]] }
 * 用法: node scripts/build-roads.mjs
 *
 * 除了投影与分组，这里还做四件事，避免沙盘上出现"不符合常识"的路：
 *   1. 只保留通车道路：步行道/自行车道/台阶在 1:1 米制沙盘里就是一条条黑带，
 *      而且它们天然断在院门口，正是"断头路"的主要来源，整体剔除；
 *   2. 道路不得伸进水面：端点在河里时退回岸上；
 *   3. 道路不得穿山：落在山体占地内的点被剔除并断开；
 *   4. 断头处尽量接到最近的路：45m 内找得到别的路就补一段连线；
 *      接不上又是孤零零一小段的（<300m），整段删除。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ORIGIN = { lon: 120.621, lat: 31.311 };
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);
const toLocal = (lon, lat) => ({
  x: (lon - ORIGIN.lon) * M_PER_DEG_LON,
  z: -(lat - ORIGIN.lat) * M_PER_DEG_LAT,
});

const MAJOR = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
]);
/**
 * 立交匝道（*_link）单独按支路宽度画：
 * 新庄立交一带十几条匝道以 20° 锐角互交，按 26m 主干道宽度渲染会在路口
 * 挤出一大片三角形黑面（留园西北最明显）。匝道本身只有 7~9m 宽，
 * 放回支路档（11m）后锐角处只剩窄窄一条，与真实立交观感一致。
 */
const MINOR = new Set([
  'residential',
  'unclassified',
  'living_street',
  'pedestrian',
  'service',
  'motorway_link',
  'trunk_link',
  'primary_link',
  'secondary_link',
  'tertiary_link',
]);
/** 步行道类：沙盘尺度下画成路面反而破坏路网观感，整体不要 */
const WALK = new Set(['footway', 'cycleway', 'path', 'steps', 'corridor', 'construction']);

/** 城外数据止于约 5.8km（西至寒山寺一带），再远没有城市肌理 */
const WORLD_LIMIT = 5890;

const sceneGeo = JSON.parse(
  await readFile(new URL('../src/data/scene-geometry.json', import.meta.url), 'utf8'),
);
const HILLS = JSON.parse(await readFile(new URL('../src/data/hills.json', import.meta.url), 'utf8'));

const cityRing = sceneGeo.cityOutline;
const cityRingClosed = [...cityRing, cityRing[0]];
const CANAL_HALF = 15;
const MOAT_INNER = 4.6;
const MOAT_OUTER = MOAT_INNER + 120;
// 外环水道顺序 [山塘河, 上塘河]：山塘河按模型内河 8m 宽绘制，其余仍按 26m。
const SHANTANG_HALF = 4;
const SHANGTANG_HALF = 13;
const outerWaterHalf = (i) => (i === 0 ? SHANTANG_HALF : SHANGTANG_HALF);

/** 折线裁剪到 ±WORLD_LIMIT 方框（Liang–Barsky 逐段）。 */
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

/** 折线裁到半径圆内（圆外部分断开，跨界处补交点） */
function clipToCircle(points, radius) {
  const pieces = [];
  let current = [];
  const pushPoint = (p) => {
    const last = current[current.length - 1];
    if (last && Math.hypot(last.x - p.x, last.z - p.z) < 0.01) return;
    current.push(p);
  };
  const flush = () => {
    if (current.length > 1) pieces.push(current);
    current = [];
  };

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const ra = Math.hypot(a.x, a.z);
    const rb = Math.hypot(b.x, b.z);
    const cross = ra > radius !== rb > radius;
    const edge = () => {
      const t = (radius - ra) / (rb - ra);
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    };

    if (ra <= radius) {
      pushPoint(a);
    } else if (cross) {
      flush();
      current = [edge()];
    } else {
      flush();
    }

    if (rb <= radius) {
      pushPoint(b);
    } else if (cross) {
      pushPoint(edge());
      flush();
    }
  }
  flush();
  return pieces;
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

/* ---------------- 几何测试 ---------------- */

const pointInRing = (ring, x, z) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};

const distToPolyline = (x, z, path) => {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i += 1) {
    const [x1, z1] = path[i];
    const [x2, z2] = path[i + 1];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - x1) * dx + (z - z1) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - (x1 + t * dx), z - (z1 + t * dz)));
  }
  return best;
};

/** 水面：城内河道 / 护城河 / 山塘河，任一处即算落水 */
const waterways = sceneGeo.waterways ?? [];
const outerWaterways = sceneGeo.outerWaterways ?? [];
const inWater = (x, z) => {
  for (const line of waterways) {
    if (distToPolyline(x, z, line) < CANAL_HALF) return true;
  }
  for (let i = 0; i < outerWaterways.length; i += 1) {
    if (distToPolyline(x, z, outerWaterways[i]) < outerWaterHalf(i)) return true;
  }
  if (!pointInRing(cityRing, x, z)) {
    const d = distToPolyline(x, z, cityRingClosed);
    if (d >= MOAT_INNER - 0.6 && d < MOAT_OUTER) return true;
  }
  return false;
};

const hillSpots = HILLS.map((hill) => {
  const p = toLocal(hill.lon, hill.lat);
  return { ...p, r: hill.radius * 0.98 };
});
const inHill = (x, z) => hillSpots.some((h) => Math.hypot(x - h.x, z - h.z) < h.r);

/* ---------------- 读取 ---------------- */

const wayById = new Map();
const tileNames = [];
for (let r = 0; r < 3; r += 1) {
  for (let c = 0; c < 3; c += 1) {
    tileNames.push(`roads-${r}-${c}.json`);
    tileNames.push(`greater-roads-${r}-${c}.json`);
    tileNames.push(`streets-${r}-${c}.json`);
    // 更广 bbox 的外城居住区街巷（lon 120.5358~120.6966 / lat 31.2355~31.3776）。
    // 历史上抓取过但从未被读取，导致 5.2km 外城路网静默缺了 1744 条街巷。
    // 与 streets-* 按 way id 去重，重叠部分不会重复计入。
    tileNames.push(`greater-streets-${r}-${c}.json`);
  }
}
for (const name of tileNames) {
  let text;
  try {
    text = await readFile(new URL(`../data/raw/${name}`, import.meta.url), 'utf8');
  } catch {
    continue;
  }
  for (const el of JSON.parse(text).elements ?? []) {
    if (el.type === 'way' && el.geometry?.length >= 2) wayById.set(el.id, el);
  }
}

const major = [];
const minor = [];
let dropped = 0;
let walkDropped = 0;

for (const way of wayById.values()) {
  const kind = way.tags?.highway;
  if (WALK.has(kind)) {
    walkDropped += 1;
    continue;
  }
  if (!MAJOR.has(kind) && !MINOR.has(kind)) {
    dropped += 1;
    continue;
  }
  const isMajor = MAJOR.has(kind);
  const local = way.geometry.map((p) => toLocal(p.lon, p.lat));
  for (const boxed of clipPolyline(local, WORLD_LIMIT)) {
    for (const piece of clipToCircle(boxed, WORLD_LIMIT)) {
      const simplified = simplify(piece, isMajor ? 2 : 3);
      if (lengthOf(simplified) < 25) {
        dropped += 1;
        continue;
      }
      (isMajor ? major : minor).push(simplified);
    }
  }
}

/* ---------------- 山体：整段切断 ---------------- */
const splitByPredicate = (pts, predicate) => {
  const pieces = [];
  let current = [];
  for (const p of pts) {
    if (predicate(p.x, p.z)) {
      if (current.length > 1) pieces.push(current);
      current = [];
    } else {
      current.push(p);
    }
  }
  if (current.length > 1) pieces.push(current);
  return pieces;
};

const trimmedByHill = (lines) =>
  lines.flatMap((line) => splitByPredicate(line, inHill).filter((p) => lengthOf(p) >= 25));

/* ---------------- 水面：端部退回岸上 ---------------- */
const trimWaterEnds = (pts) => {
  let start = 0;
  while (start < pts.length && inWater(pts[start].x, pts[start].z)) start += 1;
  let end = pts.length - 1;
  while (end > start && inWater(pts[end].x, pts[end].z)) end -= 1;
  if (end - start < 1) return null;
  let out = pts.slice(start, end + 1);
  // 端点在岸上但线段跨水（桥位）：把端点挪到岸线，交给桥梁几何衔接
  const shoreSnap = (p, q) => {
    // p 在岸上，q 在水里：沿线段找最后一个岸上点
    let last = p;
    for (let s = 1; s <= 8; s += 1) {
      const t = s / 8;
      const x = p.x + (q.x - p.x) * t;
      const z = p.z + (q.z - p.z) * t;
      if (inWater(x, z)) break;
      last = { x, z };
    }
    return last;
  };
  if (out.length >= 2 && inWater(out[1].x, out[1].z)) out[0] = shoreSnap(out[0], out[1]);
  if (out.length >= 2 && inWater(out[out.length - 2].x, out[out.length - 2].z)) {
    out[out.length - 1] = shoreSnap(out[out.length - 1], out[out.length - 2]);
  }
  return lengthOf(out) >= 25 ? out : null;
};

/* ---------------- 水面：顺河并行的长区段要切掉 ----------------
 * 垂直于护城河过河时，路面落在水下 100m 左右，这段正好被桥面盖住，保留没问题。
 * 但有些道路顺着河岸在 120m 宽的水带里并行几百米，沙盘上就是"路修进了河里"。
 * 以 WATER_RUN_LIMIT 为界：短的是过河（留），长的是并行（整段切掉，两端收到岸边）。
 */
const WATER_RUN_LIMIT = 205;

/* ---------------- 水面：并行重叠段推到岸上 ----------------
 * 山塘河、上塘河沿岸有大量"沿河街"：OSM 里河与路是两条平行线，中心距常常
 * 小于 河半宽 + 路半宽（13 + 13 = 26m），整条路泡在水里。俯视就是"河被路面
 * 压断"——路面把 26m 宽的河带整段盖住，河只在路口两侧露出来。
 *
 * 这里不再"切掉"这些段（切了就是断头路），而是保住折线连续性、把重叠段
 * 沿法线推到岸外（水面半宽 + 路半宽 + 2m 绿化带）：
 *   · 跨河的短段（沿路长度 ≤ 60m）是桥位，保持原样交给 CanalBridges；
 *   · 沿河并行的长段（> 60m）整段推离，两端 20m 内位移量渐变，不产生折角。
 */
const WATER_PARALLEL_LIMIT = 60;
const WATER_OFFSET_MARGIN = 2;
const WATER_RESAMPLE = 4;

/** 点到折线的最近点（含指向外侧的法向） */
function nearestOnPolyline(x, z, line) {
  let best = null;
  for (let i = 0; i < line.length - 1; i += 1) {
    const [x1, z1] = line[i];
    const [x2, z2] = line[i + 1];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - x1) * dx + (z - z1) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = x1 + t * dx;
    const qz = z1 + t * dz;
    const d = Math.hypot(x - qx, z - qz);
    if (!best || d < best.d) {
      const len = Math.sqrt(len2) || 1;
      best = { d, qx, qz, nx: dz / len, nz: -dx / len };
    }
  }
  return best;
}

/** 最近一处水面的穿入深度（> 0 表示落在水里）与最近点/法向 */
function nearestWater(x, z) {
  let best = null;
  const consider = (line, half) => {
    const hit = nearestOnPolyline(x, z, line);
    if (!hit) return;
    const depth = half - hit.d;
    if (!best || depth > best.depth) best = { ...hit, depth, half };
  };
  for (const line of waterways) consider(line, CANAL_HALF);
  for (let i = 0; i < outerWaterways.length; i += 1) consider(outerWaterways[i], outerWaterHalf(i));
  // 护城河是一条沿城墙的环带：不补进来的话，贴着外岸走的道路永远不会被推离水面，
  // 4m 采样时就会连成几百米的"水中长桥"（桥面顺着河铺了 400m）。
  if (!pointInRing(cityRing, x, z)) {
    const hit = nearestOnPolyline(x, z, cityRingClosed);
    if (hit && hit.d >= MOAT_INNER - 0.6 && hit.d < MOAT_OUTER) {
      const depth = MOAT_OUTER - hit.d;
      if (!best || depth > best.depth) best = { ...hit, depth, half: MOAT_OUTER };
    }
  }
  return best;
}

/** 到城墙线（护城河内岸）的最近距离，用来区分"过河"和"顺河" */
const ringDistance = (x, z) => nearestOnPolyline(x, z, cityRingClosed)?.d ?? Infinity;

const pushOutOfWater = (pts, roadHalf) => {
  if (pts.length < 2) return pts;
  // 顶点间距可能是 50~100m（simplify 过），先按 4m 重采样才能识别"沿河并行"
  const samples = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(len / WATER_RESAMPLE));
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      samples.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  samples.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].z });
  if (samples.length < 2) return pts;

  const info = samples.map((p) => nearestWater(p.x, p.z));
  const runs = [];
  let i = 0;
  while (i < samples.length) {
    if (!(info[i] && info[i].depth > 0)) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < samples.length && info[j + 1] && info[j + 1].depth > 0) j += 1;
    const runLen = lengthOf(samples.slice(i, j + 1));
    if (runLen > WATER_PARALLEL_LIMIT) {
      // 过护城河的跨度约 116~140m，两端分别落在内岸和外岸，距城墙的落差很大；
      // 这种是真正的过河，要留给桥，不能被当成"顺河并行"推到岸上。
      const drop = Math.abs(ringDistance(samples[i].x, samples[i].z) - ringDistance(samples[j].x, samples[j].z));
      const crossingMoat = drop > 55;
      if (!(crossingMoat && runLen < 220)) runs.push([i, j]);
    }
    i = j + 1;
  }
  if (!runs.length) return pts;

  const out = samples.map((p) => ({ x: p.x, z: p.z }));
  const push = (p) => {
    // 迭代：推离一条河后可能落进相邻水道，取"穿入最浅"的结果
    let best = { ...p };
    let bestDepth = (nearestWater(p.x, p.z)?.depth ?? -Infinity);
    let cur = { ...p };
    for (let iter = 0; iter < 5; iter += 1) {
      const w = nearestWater(cur.x, cur.z);
      if (!w || w.depth <= 0) break;
      const target = w.half + roadHalf + WATER_OFFSET_MARGIN;
      let ux = cur.x - w.qx;
      let uz = cur.z - w.qz;
      const len = Math.hypot(ux, uz);
      if (len < 0.5) {
        ux = w.nx;
        uz = w.nz;
      } else {
        ux /= len;
        uz /= len;
      }
      cur = { x: w.qx + ux * target, z: w.qz + uz * target };
      const depth = nearestWater(cur.x, cur.z)?.depth ?? -Infinity;
      if (depth < bestDepth) {
        bestDepth = depth;
        best = { ...cur };
      }
      if (depth <= 0) break;
    }
    return best;
  };

  for (const [i0, i1] of runs) {
    for (let k = i0; k <= i1; k += 1) out[k] = push(out[k]);

    // 位移量做一次 [0.25,0.5,0.25] 平滑：并行的路被推开后仍是一条顺滑的弯道，
    // 而不是在段口突然拐一下
    const shifted = out.slice(i0, i1 + 1).map((p, idx) => ({
      x: p.x - samples[i0 + idx].x,
      z: p.z - samples[i0 + idx].z,
    }));
    for (let k = 0; k < shifted.length; k += 1) {
      const a = shifted[Math.max(0, k - 1)];
      const b = shifted[k];
      const c = shifted[Math.min(shifted.length - 1, k + 1)];
      const sx = a.x * 0.25 + b.x * 0.5 + c.x * 0.25;
      const sz = a.z * 0.25 + b.z * 0.5 + c.z * 0.25;
      const s = samples[i0 + k];
      out[i0 + k] = { x: s.x + sx, z: s.z + sz };
    }
    // 平滑后可能又压回水里，再推一次
    for (let k = i0; k <= i1; k += 1) {
      const w = nearestWater(out[k].x, out[k].z);
      if (w && w.depth > 0) out[k] = push(out[k]);
    }
  }

  return simplify(out, 2);
};

const splitLongWaterRuns = (pts) => {
  const pieces = [];
  let cur = [];
  let i = 0;
  while (i < pts.length) {
    if (!inWater(pts[i].x, pts[i].z)) {
      cur.push(pts[i]);
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < pts.length && inWater(pts[j + 1].x, pts[j + 1].z)) j += 1;
    const runLen = lengthOf(pts.slice(i, j + 1));
    if (runLen <= WATER_RUN_LIMIT) {
      for (let k = i; k <= j; k += 1) cur.push(pts[k]);
    } else {
      if (cur.length >= 2) pieces.push(cur);
      cur = [];
    }
    i = j + 1;
  }
  if (cur.length >= 2) pieces.push(cur);
  return pieces.filter((p) => lengthOf(p) >= 25);
};

/* ---------------- 断头：接到最近的路 ---------------- */
const SNAP_DIST = 80;
const SNAP_CELL = 60;

function buildSegmentIndex(lines) {
  const grid = new Map();
  const key = (cx, cz) => `${cx},${cz}`;
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    for (let i = 0; i < line.length - 1; i += 1) {
      const a = line[i];
      const b = line[i + 1];
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minZ = Math.min(a.z, b.z);
      const maxZ = Math.max(a.z, b.z);
      for (let cx = Math.floor(minX / SNAP_CELL); cx <= Math.floor(maxX / SNAP_CELL); cx += 1) {
        for (let cz = Math.floor(minZ / SNAP_CELL); cz <= Math.floor(maxZ / SNAP_CELL); cz += 1) {
          const k = key(cx, cz);
          let arr = grid.get(k);
          if (!arr) grid.set(k, (arr = []));
          arr.push({ li, a, b });
        }
      }
    }
  }
  return { grid, key };
}

function nearestOnOthers(index, line, lineIndex, p, maxDist) {
  let best = null;
  const cx = Math.floor(p.x / SNAP_CELL);
  const cz = Math.floor(p.z / SNAP_CELL);
  for (let i = -1; i <= 1; i += 1) {
    for (let j = -1; j <= 1; j += 1) {
      const arr = index.grid.get(index.key(cx + i, cz + j));
      if (!arr) continue;
      for (const seg of arr) {
        if (seg.li === lineIndex) continue;
        const dx = seg.b.x - seg.a.x;
        const dz = seg.b.z - seg.a.z;
        const len2 = dx * dx + dz * dz;
        let t = len2 > 0 ? ((p.x - seg.a.x) * dx + (p.z - seg.a.z) * dz) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const qx = seg.a.x + t * dx;
        const qz = seg.a.z + t * dz;
        const d = Math.hypot(p.x - qx, p.z - qz);
        if (d <= maxDist && (!best || d < best.d)) best = { x: qx, z: qz, d };
      }
    }
  }
  return best;
}

function stitch(lines) {
  const index = buildSegmentIndex(lines);
  let snapped = 0;
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    if (line.length < 2) continue;
    for (const [endPos, neighborPos] of [
      [0, 1],
      [line.length - 1, line.length - 2],
    ]) {
      const p = line[endPos];
      const q = line[neighborPos];
      const near = nearestOnOthers(index, line, li, p, SNAP_DIST);
      if (!near) continue;
      // 已经贴上了就不动；否则补一段短连线，让路口真正接上
      if (near.d < 2.5) continue;
      // 连线不能穿过水面：这种情况宁可留断头，交给桥梁/河岸处理
      const mid = { x: (p.x + near.x) / 2, z: (p.z + near.z) / 2 };
      if (inWater(mid.x, mid.z)) continue;
      if (endPos === 0) line.unshift({ x: near.x, z: near.z });
      else line.push({ x: near.x, z: near.z });
      snapped += 1;
      void q;
    }
  }
  return snapped;
}

/** 断头且孤立：两端 SNAP_DIST 内都没有别的路，且本身很短 → 整段删掉 */
function dropOrphans(lines) {
  const index = buildSegmentIndex(lines);
  return lines.filter((line, li) => {
    if (lengthOf(line) >= 300) return true;
    const head = nearestOnOthers(index, line, li, line[0], SNAP_DIST);
    const tail = nearestOnOthers(index, line, li, line[line.length - 1], SNAP_DIST);
    return Boolean(head || tail);
  });
}

/**
 * 景区内部的园路：OSM 里大量 `service` / `pedestrian` 巷道其实就是园林、
 * 寺庙、校园里的游园步道。按 5.5m 路面画出来就是一条条黑带横穿景区，
 * 既穿过石台（把石台啃出缺口），又和园墙、假山、水池撞在一起。
 *
 * 判定：折线 60% 以上的点落在某个景点轮廓内，且自身不长（<320m）。
 * 长路不删——那是贴着景区走的外围街道（如平江路、山塘街本身）。
 */
const scenicRings = Object.entries(sceneGeo.landmarks)
  .filter(([, geo]) => Array.isArray(geo.outline) && geo.outline.length > 2)
  .map(([id, geo]) => ({ id, ring: geo.outline }));

function insideScenic(line) {
  let hit = 0;
  for (const p of line) {
    for (const { ring } of scenicRings) {
      if (pointInRing(ring, p.x, p.z)) {
        hit += 1;
        break;
      }
    }
  }
  return hit / line.length;
}

function dropScenicFootpaths(lines) {
  let dropped = 0;
  const kept = lines.filter((line) => {
    // 长路不删：那是贴着景区走的外围街道（石路步行街一带整片都算景区范围）
    if (lengthOf(line) >= 320) return true;
    if (line.length < 3) return true;
    if (insideScenic(line) < 0.6) return true;
    dropped += 1;
    return false;
  });
  return { kept, dropped };
}

let majorLines = trimmedByHill(major).map((l) => l.map((p) => ({ ...p })));
let minorLines = trimmedByHill(minor).map((l) => l.map((p) => ({ ...p })));

// 先按路宽把"泡在河里"的并行段推到岸上，再兜底切掉仍然过长的水中段
majorLines = majorLines
  .map(trimWaterEnds)
  .filter(Boolean)
  .map((line) => pushOutOfWater(line, 13))
  .flatMap(splitLongWaterRuns);
minorLines = minorLines
  .map(trimWaterEnds)
  .filter(Boolean)
  .map((line) => pushOutOfWater(line, 5.5))
  .flatMap(splitLongWaterRuns);

/* ---------------- 双幅路合并（老城内） ---------------- */

/**
 * OSM 把同一条主干道拆成南北两幅、各建一条 way（中间是绿化带/干将河）。
 * 两条中心线只隔 10~30m，各自按 26m 宽铺出来后会叠成一条 50m 宽的"双条沥青带"：
 * 路面画出两套标线，路口节点翻倍，斑马线在路中间叠成一排斜跨路面的白梯子
 * （干将路东段、双塔东北最典型）。
 *
 * 老城内街坊尺度都在 100m 以上，两条同等级主干道不可能只隔 30m，
 * 因此判定为同一走廊：短线落在长线 36m 走廊内的部分裁掉，只保留一条主干道。
 * 双幅路是快速路/干道的特征，城外辅路多，不做这个处理。
 */
const CARRIAGE_MAX_OFFSET = 36;
const CARRIAGE_OVERLAP = 0.85;
const CARRIAGE_DIR_DOT = 0.87;
const CARRIAGE_LEN_RATIO = 1.2;
const CARRIAGE_MIN_PIECE = 30;

const bboxOf = (line) => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of line) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
};

const lineDir = (line) => {
  const a = line[0];
  const b = line[line.length - 1];
  const d = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return [(b.x - a.x) / d, (b.z - a.z) / d];
};

const pointSegDist = (px, pz, a, b) => {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - a.x) * dx + (pz - a.z) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a.x + t * dx), pz - (a.z + t * dz));
};

const distToLine = (px, pz, line) => {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i += 1) {
    const d = pointSegDist(px, pz, line[i], line[i + 1]);
    if (d < best) best = d;
  }
  return best;
};

/** 沿折线每 10m 采样，返回采样点 */
const sampleLine = (line, step) => {
  const out = [];
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.round(d / step));
    for (let k = 0; k <= n; k += 1) {
      const f = k / n;
      out.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f });
    }
  }
  return out;
};

function dropParallelCarriageways(lines) {
  const n = lines.length;
  const lens = lines.map(lengthOf);
  const boxes = lines.map(bboxOf);
  const dirs = lines.map(lineDir);
  const samples = lines.map((line) => (lengthOf(line) >= 80 ? sampleLine(line, 10) : []));
  let dropped = 0;
  let meters = 0;
  const out = [];

  for (let i = 0; i < n; i += 1) {
    const line = lines[i];
    const li = lens[i];
    if (li < 80 || line.length < 2) {
      out.push(line);
      continue;
    }
    const mid = line[Math.floor(line.length / 2)];
    if (!pointInRing(cityRing, mid.x, mid.z)) {
      out.push(line);
      continue;
    }

    // 找出把这条线整段包在走廊里的更长主干道
    const hosts = [];
    for (let j = 0; j < n; j += 1) {
      if (j === i || lens[j] < li * CARRIAGE_LEN_RATIO) continue;
      const a = boxes[i];
      const b = boxes[j];
      if (a.minX - 45 > b.maxX || b.minX - 45 > a.maxX) continue;
      if (a.minZ - 45 > b.maxZ || b.minZ - 45 > a.maxZ) continue;
      if (Math.abs(dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1]) < CARRIAGE_DIR_DOT) continue;
      let near = 0;
      for (const p of samples[i]) {
        if (distToLine(p.x, p.z, lines[j]) < CARRIAGE_MAX_OFFSET) near += 1;
      }
      if (near / samples[i].length >= CARRIAGE_OVERLAP) hosts.push(lines[j]);
    }
    if (hosts.length === 0) {
      out.push(line);
      continue;
    }

    // 走廊内的部分裁掉，走廊外保留（短线可能还有自己的延伸段）
    const kept = [];
    let current = [];
    const flush = () => {
      if (current.length >= 2 && lengthOf(current) >= CARRIAGE_MIN_PIECE) kept.push(current);
      current = [];
    };
    for (let s = 0; s < line.length - 1; s += 1) {
      const a = line[s];
      const b = line[s + 1];
      const segLen = Math.hypot(b.x - a.x, b.z - a.z);
      const count = Math.max(1, Math.ceil(segLen / 4));
      for (let k = 0; k < count; k += 1) {
        const f = (k + 1) / count;
        const px = a.x + (b.x - a.x) * f;
        const pz = a.z + (b.z - a.z) * f;
        const inside = hosts.some((h) => distToLine(px, pz, h) < CARRIAGE_MAX_OFFSET);
        if (inside) {
          flush();
        } else {
          if (current.length === 0) current.push({ x: a.x, z: a.z });
          current.push({ x: px, z: pz });
        }
      }
    }
    flush();

    if (kept.length === 0) {
      dropped += 1;
      meters += li;
    } else {
      const keptLen = kept.reduce((sum, l) => sum + lengthOf(l), 0);
      meters += Math.max(0, li - keptLen);
      out.push(...kept);
    }
  }

  if (dropped > 0 || meters > 1) {
    console.log(
      `[道路] 双幅路合并：裁掉 ${Math.round(meters)} 米（${dropped} 条整条移除，只留一幅主干道）`,
    );
  }
  return out;
}

majorLines = dropParallelCarriageways(majorLines);

const snappedMajor = stitch(majorLines);
const snappedMinor = stitch(minorLines);
majorLines = dropOrphans(majorLines);
minorLines = dropOrphans(minorLines);

const scenicMajor = dropScenicFootpaths(majorLines);
const scenicMinor = dropScenicFootpaths(minorLines);
majorLines = scenicMajor.kept;
minorLines = scenicMinor.kept;
const scenicDropped = scenicMajor.dropped + scenicMinor.dropped;

/**
 * 闭环剔除：OSM 里大量 `service` / 匝道是首尾重合的闭合环路（停车场、小区
 * 内部道路、立交环形匝道）。按带状面渲染后，锐角处就是一个细长的黑色尖刺
 * （留园西北的新庄立交最明显）。这类环路在 1:1 沙盘上看不出"环"，只贡献噪声，
 * 整条剔除；周长 > 400m 的大环保留（可能是真正的环城支路）。
 */
const CLOSED_LOOP_LIMIT = 400;

const dropClosedLoops = (lines) =>
  lines.filter((line) => {
    if (line.length < 4) return true;
    const head = line[0];
    const tail = line[line.length - 1];
    if (Math.hypot(head.x - tail.x, head.z - tail.z) > 3) return true;
    return lengthOf(line) > CLOSED_LOOP_LIMIT;
  });

const round = (lines) =>
  lines.map((line) => line.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10]));

/**
 * 缠绕折线剔除。
 * OSM 把院落、广场里一堆 `service` 小巷链成一条来回折返的折线时（全晋会馆
 * 下方最典型：178m 的线在 45m 见方的框里来回穿），按 11m 宽铺出来就是
 * 两大块带虚线的黑色"沥青平台"，怎么看都不像路。
 * 判据用"绕行系数" = 折线总长 / 包围盒对角线：正常街道接近 1，绕圈的数倍。
 */
const TANGLE_RATIO = 3.0;
const TANGLE_MAX_LEN = 400;

function dropTangled(lines) {
  let dropped = 0;
  let meters = 0;
  const kept = lines.filter((line) => {
    if (line.length < 3) return true;
    const len = lengthOf(line);
    if (len > TANGLE_MAX_LEN) return true;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of line) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const diag = Math.hypot(maxX - minX, maxZ - minZ);
    if (diag < 8 || len / diag <= TANGLE_RATIO) return true;
    dropped += 1;
    meters += len;
    return false;
  });
  if (dropped > 0) console.log(`[道路] 缠绕折线剔除 ${dropped} 条 / ${Math.round(meters)} 米`);
  return kept;
}

/** 折线中点（按里程），用于区分"同起终点的不同路线" */
function midpointOf(line) {
  const total = lengthOf(line);
  let acc = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const seg = Math.hypot(line[i + 1].x - line[i].x, line[i + 1].z - line[i].z);
    if (acc + seg >= total / 2) {
      const t = seg > 0 ? (total / 2 - acc) / seg : 0;
      return { x: line[i].x + (line[i + 1].x - line[i].x) * t, z: line[i].z + (line[i + 1].z - line[i].z) * t };
    }
    acc += seg;
  }
  return line[line.length - 1];
}

/**
 * 去重：OSM 常把同一条路拆成两三条几乎重合的 way（双线/上下行/重复导入）。
 * 两条线首尾距离和 < 14m 且长度相近、中点也接近时，视为同一条，只保留先出现的那条。
 * 不这样做时，两条同高路面在俯视下互相 z-fighting，车道线也会一明一暗地闪。
 */
function dedupeLines(lines, alreadyKept = []) {
  const metricsOf = (line) => ({
    len: lengthOf(line),
    head: line[0],
    tail: line[line.length - 1],
    mid: midpointOf(line),
  });
  const isDup = (a, b) => {
    const lmin = Math.min(a.len, b.len);
    if (lmin < 15) return false;
    if (Math.abs(a.len - b.len) > Math.max(30, lmin * 0.35)) return false;
    const d1 = Math.hypot(a.head.x - b.head.x, a.head.z - b.head.z) +
      Math.hypot(a.tail.x - b.tail.x, a.tail.z - b.tail.z);
    const d2 = Math.hypot(a.head.x - b.tail.x, a.head.z - b.tail.z) +
      Math.hypot(a.tail.x - b.head.x, a.tail.z - b.head.z);
    if (Math.min(d1, d2) >= 14) return false;
    return Math.hypot(a.mid.x - b.mid.x, a.mid.z - b.mid.z) < 20 + lmin * 0.05;
  };
  const kept = [];
  const keptMetrics = [];
  const otherMetrics = alreadyKept.map(metricsOf);
  for (const line of lines) {
    const m = metricsOf(line);
    if (keptMetrics.some((n) => isDup(m, n)) || otherMetrics.some((n) => isDup(m, n))) continue;
    kept.push(line);
    keptMetrics.push(m);
  }
  return kept;
}

majorLines = dropClosedLoops(majorLines);
minorLines = dropClosedLoops(minorLines);

// 缠绕折线（院落/广场里被 OSM 链成来回折返的 service 巷）必须在去重前剔除，
// 否则 11m 宽铺出来就是一块块带虚线的黑色沥青平台。
majorLines = dropTangled(majorLines);
minorLines = dropTangled(minorLines);

const majorCountBefore = majorLines.length;
const minorCountBefore = minorLines.length;
const keptMajor = dedupeLines(majorLines);
const keptMinor = dedupeLines(minorLines, keptMajor);
const deduped = (majorCountBefore - keptMajor.length) + (minorCountBefore - keptMinor.length);
majorLines = keptMajor;
minorLines = keptMinor;
if (deduped > 0) console.log(`[道路] 重合路段去重 ${deduped} 条`);

/**
 * 段级去重：整线去重只能处理"首尾都几乎重合"的两条 way，
 * 但 OSM 里更常见的是"一条路的中段被另一条 way 完整覆盖"（上下行分开画、
 * 主辅路共用一段、同一段被重复导入）。
 * 这些重叠段会让两条同高路面在俯视下互相 z-fighting，车道线一明一暗地闪。
 *
 * 做法：先把主干作为"已占用"集合，再按长度从长到短扫支路，凡是中心线
 * 与已占用路段重合（间距 < 2.6m 且方向一致）的连续区间直接丢掉；
 * 被丢的区间本来就被保留下来的那条路盖着，所以路网连通性不受影响。
 *
 * 单轮无法收敛：一条被裁成几段后产生的"碎片"要等下一轮才会被别人检查到，
 * 所以外层反复跑，直到裁不动（<20m）为止。
 */
function dedupeOverlapPass(lines, occupied) {
  const CELL = 32;
  const cells = new Map();
  const cellKey = (ix, iz) => ix * 100000 + iz;
  const all = [];

  const addSeg = (a, b, lineId, tag) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.5) return;
    const seg = { a, b, ux: (b.x - a.x) / len, uz: (b.z - a.z) / len, lineId, tag };
    const idx = all.push(seg) - 1;
    const x0 = Math.floor(Math.min(a.x, b.x) / CELL);
    const x1 = Math.floor(Math.max(a.x, b.x) / CELL);
    const z0 = Math.floor(Math.min(a.z, b.z) / CELL);
    const z1 = Math.floor(Math.max(a.z, b.z) / CELL);
    for (let ix = x0; ix <= x1; ix += 1)
      for (let iz = z0; iz <= z1; iz += 1) {
        const k = cellKey(ix, iz);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(idx);
      }
  };

  const addLine = (line, tag) => {
    const id = `${tag}:${all.length}`;
    for (let i = 0; i < line.length - 1; i += 1) addSeg(line[i], line[i + 1], id, tag);
    return id;
  };
  for (const line of occupied) addLine(line, 'occupied');

  /** 该点是否已有一条同向的路盖在上面（忽略自己） */
  const covered = (x, z, ux, uz, selfId) => {
    const bucket = cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!bucket) return false;
    for (const si of bucket) {
      const s = all[si];
      if (s.lineId === selfId) continue;
      if (Math.abs(s.ux * ux + s.uz * uz) < 0.75) continue;
      const dx = s.b.x - s.a.x;
      const dz = s.b.z - s.a.z;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((x - s.a.x) * dx + (z - s.a.z) * dz) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      if (Math.hypot(x - (s.a.x + t * dx), z - (s.a.z + t * dz)) < 2.6) return true;
    }
    return false;
  };

  // 长的先留：两条重复段里保留更长/更完整的那条
  const order = lines
    .map((line, i) => ({ line, i, len: lengthOf(line) }))
    .sort((a, b) => b.len - a.len);
  const keptAt = new Map();
  let cutMeters = 0;

  for (const { line, i } of order) {
    const selfId = `self:${i}`;
    const marks = [];
    let ux = 1;
    let uz = 0;
    for (let k = 0; k < line.length - 1; k += 1) {
      const a = line[k];
      const b = line[k + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.5) continue;
      ux = (b.x - a.x) / len;
      uz = (b.z - a.z) / len;
      const steps = Math.max(1, Math.ceil(len / 4));
      for (let s = 0; s < steps; s += 1) {
        const t = s / steps;
        marks.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, ux, uz });
      }
    }
    marks.push({ x: line[line.length - 1].x, z: line[line.length - 1].z, ux, uz });

    const keptRuns = [];
    let run = [];
    for (const m of marks) {
      if (covered(m.x, m.z, m.ux, m.uz, selfId)) {
        if (run.length > 1) keptRuns.push(run);
        run = [];
      } else {
        run.push(m);
      }
    }
    if (run.length > 1) keptRuns.push(run);

    const pieces = keptRuns
      .map((r) => ({ points: r, len: lengthOf(r) }))
      .filter((r) => r.len >= 12);
    const removed = lengthOf(marks) - pieces.reduce((s, r) => s + r.len, 0);
    if (removed < 6) {
      // 基本没被覆盖：原样保留，避免采样把折线打散
      keptAt.set(i, line);
      addLine(line, 'occupied');
      continue;
    }
    cutMeters += removed;
    // pieces 为空 = 整条都被别的路盖着，直接丢弃
    keptAt.set(i, pieces.map((p) => p.points));
    for (const piece of pieces) addLine(piece, 'occupied');
  }

  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const v = keptAt.get(i) ?? lines[i];
    if (!Array.isArray(v) || v.length === 0) continue;
    // v 可能是原折线（点数组），也可是裁剪后的若干折线（点数组的数组）
    if (Array.isArray(v[0])) out.push(...v);
    else out.push(v);
  }
  return { out, cutMeters };
}

function dedupeOverlap(lines, occupied = []) {
  let current = lines;
  let total = 0;
  for (let pass = 0; pass < 5; pass += 1) {
    const res = dedupeOverlapPass(current, occupied);
    current = res.out;
    total += res.cutMeters;
    if (res.cutMeters < 20) break;
  }
  if (total > 0) console.log(`[道路] 重叠路段裁剪 ${Math.round(total)} 米`);
  return current;
}

majorLines = dedupeOverlap(majorLines);
minorLines = dedupeOverlap(minorLines, majorLines);

const majorOut = round(majorLines);
const minorOut = round(minorLines);

console.log(
  `[道路] 原始 ${wayById.size}，步行道剔除 ${walkDropped}，园路剔除 ${scenicDropped}，` +
    `主干 ${majorOut.length} / 支路 ${minorOut.length}，` +
    `补接 ${snappedMajor + snappedMinor} 处，丢弃 ${dropped}`,
);

await mkdir(new URL('../public/data/', import.meta.url), { recursive: true });
const outFile = new URL('../public/data/roads.json', import.meta.url);
await writeFile(outFile, JSON.stringify({ meta: { origin: ORIGIN, unit: 'meter' }, major: majorOut, minor: minorOut }));
console.log(`[输出] ${outFile.pathname}`);
