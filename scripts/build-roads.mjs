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
const CANAL_HALF = 6;
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

/**
 * 高架/立交桥面高度（米）：OSM `bridge=yes` 默认按 7m 高架，
 * `layer` 越大越高（立交二层约 9.5m，三层约 12m）。
 * 这类路不能和地面道路叠在同一平面上，运行时单独抬高渲染并补桥墩。
 */
const elevationOf = (way) => {
  const tags = way.tags ?? {};
  if (tags.tunnel && tags.tunnel !== 'no') return 0;
  const layer = Number(tags.layer);
  const isBridge = tags.bridge && tags.bridge !== 'no';
  if (!isBridge && !(Number.isFinite(layer) && layer > 0)) return 0;
  const level = Number.isFinite(layer) && layer > 0 ? layer : 1;
  return Math.min(12, 4.5 + level * 2.5);
};

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
  const elev = elevationOf(way);
  const local = way.geometry.map((p) => toLocal(p.lon, p.lat));
  for (const boxed of clipPolyline(local, WORLD_LIMIT)) {
    for (const piece of clipToCircle(boxed, WORLD_LIMIT)) {
      // 容差放到 2~3m 时，一条 26m 宽的路在简化拐点处会横向错开近 2m，
      // 放大看就是"路忽粗忽细、边缘有台阶"。收紧到 1.2/1.6m 让边缘顺直。
      const simplified = simplify(piece, isMajor ? 1.2 : 1.6);
      if (lengthOf(simplified) < 25) {
        dropped += 1;
        continue;
      }
      (isMajor ? major : minor).push(elev > 0 ? simplified.map((p) => ({ ...p, elev })) : simplified);
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
  // 重采样会重建点对象，高架/桥梁高度要在这一步保住
  const elev = pts.find((p) => p.elev)?.elev ?? 0;
  const keepElev = (line) => (elev ? line.map((p) => ({ ...p, elev })) : line);
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

  return keepElev(simplify(out, 2));
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

/**
 * 过河段拉直：桥面上不应该有转弯。
 * 短距离过河（≤60m，正常桥位）里如果还有折点，说明这条路在河面上拐了弯，
 * 俯视就是"路在水上打了个折"。这里把落在水里的连续顶点整段去掉，
 * 由两侧岸上的点直连——桥是直的，转弯发生在岸上。
 */
/** 与 WATER_RUN_LIMIT 一致：凡是保留下来的水中段都视为桥，桥上不应有折点 */
const WATER_BRIDGE_LIMIT = WATER_RUN_LIMIT;

const straightenWaterCrossings = (pts) => {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  let i = 1;
  let fixed = 0;
  while (i < pts.length - 1) {
    if (!inWater(pts[i].x, pts[i].z)) {
      out.push(pts[i]);
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < pts.length && inWater(pts[j + 1].x, pts[j + 1].z)) j += 1;
    const run = pts.slice(i, j + 1);
    const terminal = j === pts.length - 1;
    if (lengthOf(run) <= WATER_BRIDGE_LIMIT && (terminal || j + 1 < pts.length)) {
      // 舍掉水中折点，直接连到下一处岸上点，形成直桥。
      // 末端落在水里（另一端是岸上路口）时保留最后一个点，否则会把路口甩掉。
      if (terminal) out.push(pts[j]);
      fixed += 1;
    } else {
      for (const p of run) out.push(p);
    }
    i = j + 1;
  }
  const last = pts[pts.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  if (fixed > 0) return out;
  return pts;
};

/* ---------------- 断头：接到最近的路 ---------------- */
const SNAP_DIST = 80;
/** 12m 以内直接移动端点，不补一段斜连线：补线会在路口多出一个折角 */
const SNAP_MOVE = 12;
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
        if (d <= maxDist && (!best || d < best.d)) {
          const sl = Math.hypot(dx, dz) || 1;
          best = { x: qx, z: qz, d, ux: dx / sl, uz: dz / sl };
        }
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
      // 端点必须真正落到对侧中心线上：以前 2.5m 内就不动，
      // 导致路口端头各偏一两米，端面之间露出方形缺口。
      if (near.d < 0.6) continue;
      // 连线不能穿过水面：这种情况宁可留断头，交给桥梁/河岸处理
      const mid = { x: (p.x + near.x) / 2, z: (p.z + near.z) / 2 };
      if (inWater(mid.x, mid.z)) continue;
      if (near.d <= SNAP_MOVE) {
        // 近距离直接吸附端点：两条路真正共点，不再靠一条斜线"搭"过去
        const elev = line[endPos].elev;
        line[endPos] = elev ? { x: near.x, z: near.z, elev } : { x: near.x, z: near.z };
        snapped += 1;
        continue;
      }
      // 补连线只在"顺着末段走向"时做：掉头连接会把路折回自身，末端成针尖
      const ux = p.x - q.x;
      const uz = p.z - q.z;
      const vx = near.x - p.x;
      const vz = near.z - p.z;
      const ul = Math.hypot(ux, uz) || 1;
      const vl = Math.hypot(vx, vz) || 1;
      if ((ux * vx + uz * vz) / (ul * vl) < 0.2) continue;
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
  .flatMap(splitLongWaterRuns)
  .map(straightenWaterCrossings);
minorLines = minorLines
  .map(trimWaterEnds)
  .filter(Boolean)
  .map((line) => pushOutOfWater(line, 5.5))
  .flatMap(splitLongWaterRuns)
  .map(straightenWaterCrossings);

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
 * 闭环取舍（原 dropClosedLoops 只会整条删掉，丢掉大量真实路网）。
 *
 * OSM 里首尾重合的闭环主要是两类：
 *   · 真环：环岛、环形匝道、环城支路——周长 ≈ π·直径，应保留；
 *   · 假环：同一条路被画成"去—回"两幅（相距只有几米），周长 ≈ 2·直径，
 *     按 26m 宽铺出来就是一个实心针尖（留园西北的示例最典型）。
 *
 * 对假环不整条删除，而是取主干道：从起点找回程分叉处（离起点最远的点），
 * 保留去程/回程里更长的一半。这样既消掉针尖，又保住这段路本身。
 */
const LOOP_OUT_AND_BACK = 1.35;

const openNarrowLoops = (lines) =>
  lines.flatMap((line) => {
    if (line.length < 4) return [line];
    const head = line[0];
    const tail = line[line.length - 1];
    if (Math.hypot(head.x - tail.x, head.z - tail.z) > 3) return [line];
    const len = lengthOf(line);
    let far = 0;
    let farD = -1;
    for (let i = 0; i < line.length; i += 1) {
      const d = Math.hypot(line[i].x - head.x, line[i].z - head.z);
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    if (len / (2 * Math.max(farD, 1)) > LOOP_OUT_AND_BACK) return [line];
    const outbound = line.slice(0, far + 1);
    const inbound = line.slice(far);
    const kept = lengthOf(outbound) >= lengthOf(inbound) ? outbound : inbound;
    return lengthOf(kept) >= 25 ? [kept] : [];
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

// 闭环：真环保留，假环（去—回两幅贴在一起）取主干道，消除针尖
majorLines = openNarrowLoops(majorLines);
minorLines = openNarrowLoops(minorLines);

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

/**
 * 折返尖头切除。
 * 道路数据里仍有"伸出去再折回来"的折返顶点（两条臂夹角 ≤20°）：按 26m 宽
 * 铺开就是一根黑色针尖。这里在折返点把较短的一条臂整段切掉，只留主干方向；
 * 切完不足 25m 的直接整条删除（这种本来就接不上主干道）。
 */
const HAIRPIN_ARM_DEG = 20;

const armAngle = (a, b, c) => {
  const ux = a.x - b.x;
  const uz = a.z - b.z;
  const vx = c.x - b.x;
  const vz = c.z - b.z;
  const lu = Math.hypot(ux, uz) || 1;
  const lv = Math.hypot(vx, vz) || 1;
  const dot = (ux * vx + uz * vz) / (lu * lv);
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
};

function cutHairpins(lines) {
  let cut = 0;
  let deleted = 0;
  const out = [];
  const farPoint = (line, i, dir) => {
    let j = i + dir;
    while (j > 0 && j < line.length - 1) {
      if (Math.hypot(line[j].x - line[i].x, line[j].z - line[i].z) >= 1.5) return line[j];
      j += dir;
    }
    return null;
  };
  for (const original of lines) {
    let line = original;
    let guard = 0;
    while (line.length >= 3 && guard < 12) {
      guard += 1;
      let hit = -1;
      let hitAngle = Infinity;
      for (let i = 1; i < line.length - 1; i += 1) {
        const a = farPoint(line, i, -1);
        const c = farPoint(line, i, 1);
        if (!a || !c) continue;
        const ang = armAngle(a, line[i], c);
        if (ang <= HAIRPIN_ARM_DEG && ang < hitAngle) {
          hitAngle = ang;
          hit = i;
        }
      }
      if (hit === -1) break;
      const pre = lengthOf(line.slice(0, hit + 1));
      const suf = lengthOf(line.slice(hit));
      line = pre <= suf ? line.slice(hit) : line.slice(0, hit + 1);
      cut += 1;
    }
    if (lengthOf(line) < 25) {
      deleted += 1;
      continue;
    }
    out.push(line);
  }
  if (cut > 0) console.log(`[道路] 折返尖头切除 ${cut} 处，整条删除 ${deleted} 条`);
  return out;
}

/**
 * 转角拟合：把 ≥8° 的拐点用二次贝塞尔圆滑掉，端点保持不动（路口不能漂移）。
 * 位移上限 2.2m，远小于路宽，因此路口处最多差半个车身，不会再出现"折角"。
 */
const SMOOTH_MAX_OFFSET = 2.2;

/**
 * @param maxOffset 单侧切角长度上限（米）。主干道必须给到 ~8m：
 *   26m 宽的路用 2m 圆角，外缘足够、内缘会在转角折出一条尖刺，
 *   看起来就是一个突兀的"箭头/直角"。支路 3.5m 已经够顺。
 */
function smoothCorners(lines, maxOffset = SMOOTH_MAX_OFFSET) {
  return lines.map((line) => {
    const n = line.length;
    if (n < 3) return line;
    const out = [line[0]];
    for (let i = 1; i < n - 1; i += 1) {
      const a = line[i - 1];
      const b = line[i];
      const c = line[i + 1];
      const ux = a.x - b.x;
      const uz = a.z - b.z;
      const vx = c.x - b.x;
      const vz = c.z - b.z;
      const lu = Math.hypot(ux, uz);
      const lv = Math.hypot(vx, vz);
      if (lu < 1e-6 || lv < 1e-6) {
        out.push(b);
        continue;
      }
      const dot = (ux * vx + uz * vz) / (lu * lv);
      const turn = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (turn < 0.14) {
        out.push(b);
        continue;
      }
      const d = Math.min(Math.min(lu, lv) * 0.3, maxOffset);
      if (d < 0.7) {
        out.push(b);
        continue;
      }
      const p0 = { x: b.x + (ux / lu) * d, z: b.z + (uz / lu) * d };
      const p2 = { x: b.x + (vx / lv) * d, z: b.z + (vz / lv) * d };
      for (const t of [0.25, 0.5, 0.75]) {
        const mt = 1 - t;
        const p = {
          x: mt * mt * p0.x + 2 * mt * t * b.x + t * t * p2.x,
          z: mt * mt * p0.z + 2 * mt * t * b.z + t * t * p2.z,
        };
        if (b.elev) p.elev = b.elev;
        out.push(p);
      }
    }
    out.push(line[n - 1]);
    return out;
  });
}

/** 去掉 0.5m 以内的连续点：简化/舍入后残留的微小抖动会被误判成折返 */
function denoiseLines(lines) {
  return lines.map((line) => {
    if (line.length < 3) return line;
    const out = [line[0]];
    for (let i = 1; i < line.length - 1; i += 1) {
      const last = out[out.length - 1];
      if (Math.hypot(line[i].x - last.x, line[i].z - last.z) < 0.5) continue;
      out.push(line[i]);
    }
    const tail = line[line.length - 1];
    const last = out[out.length - 1];
    if (out.length > 1 && Math.hypot(tail.x - last.x, tail.z - last.z) < 0.5) out.pop();
    out.push(tail);
    return out;
  });
}

/** 最后清一遍 <30m 且两端都接不上任何路的碎段（用户说的"只有一小段、都不连通"） */
function dropTinyFragments(lines) {
  const index = buildSegmentIndex(lines);
  let dropped = 0;
  const kept = lines.filter((line, li) => {
    if (lengthOf(line) >= 30) return true;
    if (nearestOnOthers(index, line, li, line[0], 6)) return true;
    if (nearestOnOthers(index, line, li, line[line.length - 1], 6)) return true;
    dropped += 1;
    return false;
  });
  if (dropped > 0) console.log(`[道路] 孤立碎段剔除 ${dropped} 条`);
  return kept;
}

/**
 * 断头收口（最后一道）：
 * stitch 在去重之前执行，之后 dropScenicFootpaths / dedupeOverlap 又会把线头
 * 剪掉，最终数据里仍留着大量 3~15m 没接上的路头——俯视就是一条条短黑带
 * 停在路口外一两间房的位置。这里在输出前再收一遍：
 *   · 端点 0.8m 内已有别的路 → 视为已接好；
 *   · 否则 60m 内找最近的路：连线方向与末段方向夹角 ≤60°（或几乎轴向）
 *     且不跨水 → 补一段直连线，让路口真正接上；
 *   · 两端都接不上、本身又短于 120m 的整条删除，城市里不留孤立断头小路。
 */
function sealDeadEnds(lines) {
  const SEAL = 60;
  const SEAL_FAR = 130;
  let linked = 0;
  let dropped = 0;

  /** 近距离用网格索引；远距离直接遍历所有线段（候选点只剩几十个，开销可接受） */
  const nearestFar = (line, li, p, maxDist) => {
    let best = null;
    for (let j = 0; j < lines.length; j += 1) {
      if (j === li) continue;
      const other = lines[j];
      for (let k = 0; k < other.length - 1; k += 1) {
        const a = other[k];
        const b = other[k + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len2 = dx * dx + dz * dz;
        let t = len2 > 0 ? ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const qx = a.x + t * dx;
        const qz = a.z + t * dz;
        const d = Math.hypot(p.x - qx, p.z - qz);
        if (d <= maxDist && (!best || d < best.d)) best = { x: qx, z: qz, d };
      }
    }
    return best;
  };

  for (let pass = 0; pass < 2; pass += 1) {
    const index = buildSegmentIndex(lines);
    const doomed = new Set();
    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li];
      if (line.length < 2) continue;
      let free = 0;
      for (const isHead of [true, false]) {
        const end = isHead ? line[0] : line[line.length - 1];
        const prev = isHead ? line[1] : line[line.length - 2];
        let near = nearestOnOthers(index, line, li, end, SEAL);
        // 远距离补接更严格：只接受"顺着末段方向"的连接，避免斜穿街区
        let farStrict = false;
        if (!near || near.d > SEAL) {
          const far = nearestFar(line, li, end, SEAL_FAR);
          if (far) {
            near = far;
            farStrict = true;
          }
        }
        if (near && near.d <= 0.8) continue;
        if (!near) {
          free += 1;
          continue;
        }
        const ux = end.x - prev.x;
        const uz = end.z - prev.z;
        const ul = Math.hypot(ux, uz) || 1;
        const vx = near.x - end.x;
        const vz = near.z - end.z;
        const vl = Math.hypot(vx, vz) || 1;
        const dot = (ux / ul) * (vx / vl) + (uz / ul) * (vz / vl);
        const axial = !farStrict && (Math.abs(vx) < 3.5 || Math.abs(vz) < 3.5);
        const minDot = farStrict ? 0.82 : 0.5;
        // 掉头连接（dot<0.15）一律不做：顺着末段方向的连接才是路口
        const aligned = dot >= minDot || (axial && dot >= 0.15);
        const mid = { x: (end.x + near.x) / 2, z: (end.z + near.z) / 2 };
        if (aligned && !inWater(mid.x, mid.z) && !inWater(near.x, near.z)) {
          if (isHead) line.unshift({ x: near.x, z: near.z });
          else line.push({ x: near.x, z: near.z });
          linked += 1;
        } else {
          free += 1;
        }
      }
      if (free >= 2 && lengthOf(line) < 120) doomed.add(li);
    }
    if (doomed.size === 0) break;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (doomed.has(i)) {
        lines.splice(i, 1);
        dropped += 1;
      }
    }
  }
  if (linked > 0 || dropped > 0) {
    console.log(`[道路] 断头收口：补接 ${linked} 处，删除孤立短路 ${dropped} 条`);
  }
  return lines;
}

majorLines = cutHairpins(majorLines);
minorLines = cutHairpins(minorLines);

majorLines = sealDeadEnds(majorLines);
minorLines = sealDeadEnds(minorLines);

/**
 * 断头路截尾（最后保险）：
 * 补接之后仍会剩下一些"最近的路在 130m 外、或方向差太多不能硬连"的路头。
 * 这时不再拉新路，而是从空缺端往回退，退到这条路上最后一次跟别的路相交的
 * 位置截断；一路退到底都没有交叉口的整条删除。
 *
 * 例外：端点离城墙（护城河轮廓）45m 以内视为"路到城墙为止"，保留——
 * 这是城市边界，不是断头路。
 */
function pruneDanglingTails(lines) {
  const combined = [...majorLines, ...minorLines];
  const index = buildSegmentIndex(combined);
  const nearWall = (x, z) => distToPolyline(x, z, cityRingClosed) <= 45;

  /** 从一端往回找第一个与其它道路相接的位置；返回裁剪后的折线或 null */
  const prune = (line, li, isHead) => {
    const pts = isHead ? line : [...line].reverse();
    if (pts.length < 2) return null;
    // 端头本来就接在路口/城墙上 → 不是断头，整条保留（绝大多数街段走这里）
    if (nearestOnOthers(index, line, li, pts[0], 3.2)) return line;
    if (nearWall(pts[0].x, pts[0].z)) return line;

    let result = null;
    for (let s = 0; s < pts.length - 1 && !result; s += 1) {
      const a = pts[s];
      const b = pts[s + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.ceil(len / 4));
      for (let k = 0; k <= steps && !result; k += 1) {
        const t = k / steps;
        if (k === 0 && s === 0) continue; // 悬空端本身，上面已判定
        const p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
        if (nearestOnOthers(index, line, li, p, 3.2)) {
          // 保留"从交点往城市内侧"的那一段
          result = [{ x: p.x, z: p.z }, ...pts.slice(s + 1)];
          if (!isHead) result.reverse();
          break;
        }
      }
    }
    if (!result) {
      // 退到另一端仍没有交叉口：只有另一端贴着城墙/路口时才保留
      const far = pts[pts.length - 1];
      if (nearWall(far.x, far.z)) return line;
      if (nearestOnOthers(index, line, li, far, 3.2)) return line;
      return null;
    }
    // 截完太短就不要了
    return lengthOf(result) >= 25 ? result : null;
  };

  const prunedMajor = majorLines.map((line, i) => {
    if (line.length < 2) return line;
    let out = prune(line, i, true);
    if (!out) return null;
    out = prune(out, i, false);
    return out && out.length >= 2 ? out : null;
  });
  const prunedMinor = minorLines.map((line, i) => {
    if (line.length < 2) return line;
    const li = majorLines.length + i;
    let out = prune(line, li, true);
    if (!out) return null;
    out = prune(out, li, false);
    return out && out.length >= 2 ? out : null;
  });

  const keptMajor = prunedMajor.filter(Boolean);
  const keptMinor = prunedMinor.filter(Boolean);
  const removed = majorLines.length + minorLines.length - keptMajor.length - keptMinor.length;
  if (removed > 0) console.log(`[道路] 断头截尾：整条移除 ${removed} 条无交叉状态的孤立路`);
  majorLines = keptMajor;
  minorLines = keptMinor;
  return removed;
}

pruneDanglingTails();

// 所有几何处理结束后再做一次转角拟合与碎段清理，保证输出就是最终形态。
// 注意顺序：先拟合、再去噪，然后重新跑一次闭环/尖头清理——
// 拟合和缝合都可能把已经打开的路口重新折回去。
majorLines = smoothCorners(majorLines, 8);
minorLines = smoothCorners(minorLines, 3.5);
// 拟合可能把桥位附近的点又带进水面，最后再拉直一次
majorLines = majorLines.map(straightenWaterCrossings);
minorLines = minorLines.map(straightenWaterCrossings);
majorLines = denoiseLines(majorLines);
minorLines = denoiseLines(minorLines);
majorLines = openNarrowLoops(majorLines);
minorLines = openNarrowLoops(minorLines);
majorLines = cutHairpins(majorLines);
minorLines = cutHairpins(minorLines);
majorLines = denoiseLines(majorLines);
minorLines = denoiseLines(minorLines);
majorLines = dropTinyFragments(majorLines);
minorLines = dropTinyFragments(minorLines);

/**
 * 输出前最后一轮断头收尾：
 * 拟合/去噪之后，路口端头会重新被拉开 10~60m——俯视就是一条黑带停在街区当中。
 * 这里不再做方向判断，只做两件事：
 *   · 35m 内够得着别的路 → 补一个端点到对侧中心线，形成真正的 T 口；
 *   · 够不着 → 从最后一个交叉点往回截掉悬空尾巴（整条无交叉且 <120m 的删除）。
 * 河岸边 25m 内的收头视为自然收口（河埠头），不截。
 */
function sealFinalEnds() {
  const CONNECT = 35;
  let linked = 0;
  let trimmed = 0;
  const doomed = new Set();

  for (let pass = 0; pass < 2; pass += 1) {
    const combined = [...majorLines, ...minorLines];
    const index = buildSegmentIndex(combined);
    let changed = 0;

    for (let li = 0; li < combined.length; li += 1) {
      const line = combined[li];
      if (line.length < 2) continue;

      for (const isHead of [true, false]) {
        if (line.length < 2) break;
        const p = isHead ? line[0] : line[line.length - 1];
        const near = nearestOnOthers(index, line, li, p, CONNECT);

        if (near) {
          if (near.d < 3) continue; // 已在路口上，交给最终吸附抹平
          const mid = { x: (p.x + near.x) / 2, z: (p.z + near.z) / 2 };
          if (inWater(mid.x, mid.z) || inWater(near.x, near.z)) continue;
          const add = p.elev ? { x: near.x, z: near.z, elev: p.elev } : { x: near.x, z: near.z };
          if (isHead) line.unshift(add);
          else line.push(add);
          // 两端接到同一个路口会闭出一个假环，撤销后走截尾分支
          const h = line[0];
          const t = line[line.length - 1];
          if (line.length > 2 && Math.hypot(h.x - t.x, h.z - t.z) < 4) {
            if (isHead) line.shift();
            else line.pop();
          } else {
            linked += 1;
            changed += 1;
            continue;
          }
        }

        // 够不着任何路：河边收头保留，其余从最后一个交叉点截断
        const w = nearestWater(p.x, p.z);
        if (w && w.d < w.half + 25) continue;

        const order = isHead ? line.slice() : line.slice().reverse();
        let keepFrom = -1;
        for (let s = 1; s < order.length - 1; s += 1) {
          if (nearestOnOthers(index, line, li, order[s], 3)) {
            keepFrom = s;
            break;
          }
        }
        if (keepFrom < 0) {
          if (lengthOf(line) < 120) doomed.add(line);
          break;
        }
        const kept = order.slice(keepFrom);
        if (!isHead) kept.reverse();
        if (lengthOf(kept) < 25) {
          doomed.add(line);
          break;
        }
        line.length = 0;
        line.push(...kept);
        trimmed += 1;
        changed += 1;
      }
    }
    if (changed === 0) break;
  }

  if (doomed.size > 0) {
    majorLines = majorLines.filter((l) => !doomed.has(l));
    minorLines = minorLines.filter((l) => !doomed.has(l));
  }
  console.log(
    `[道路] 断头收尾：补接 ${linked} 处、截尾 ${trimmed} 处、删除无交叉孤立路 ${doomed.size} 条`,
  );
}
sealFinalEnds();
// 补接产生的折角在这一步圆顺（端点保持不动，不会再把路口拉开）
majorLines = smoothCorners(majorLines, 8);
minorLines = smoothCorners(minorLines, 3.5);
// 端点折返必须在去水/降噪/吸附之前剪掉：后面的步骤会重新圆顺折角、
// 把线头吸到路口，如果拖到最后再剪，剪出来的短段既进不了水又被孤立。
{
  const r1 = trimHairpinTips(majorLines);
  majorLines = r1.lines;
  const r2 = trimHairpinTips(minorLines);
  minorLines = r2.lines;
  const trimmed = r1.trimmed + r2.trimmed;
  if (trimmed > 0) console.log(`[道路] 端点折返尖刺剪除 ${trimmed} 处`);
}
// 圆角拟合可能把折点带进水里：最后再拉直一次，桥上保持直行
majorLines = majorLines.map(straightenWaterCrossings);
minorLines = minorLines.map(straightenWaterCrossings);
majorLines = denoiseLines(majorLines);
minorLines = denoiseLines(minorLines);

/* ---------------- 高架/立交：从平面路网里挑出来单独抬高 ---------------- */
const OVERPASS_WATER_CLEARANCE = 28;
const overpass = [];
const collectOverpass = (lines, kind) => {
  lines.forEach((line, index) => {
    const elevated = line.filter((p) => p.elev);
    if (elevated.length < Math.max(2, line.length * 0.5)) return;
    // 跨河桥由 CanalBridges 生成石桥，再抬一层会穿模：这类留在平面
    const nearWater = line.some((p) => {
      const w = nearestWater(p.x, p.z);
      return w && w.depth > w.half - OVERPASS_WATER_CLEARANCE;
    });
    if (nearWater) return;
    overpass.push({ kind, index, h: Math.max(...elevated.map((p) => p.elev)) });
  });
};
/**
 * 最终端点吸附：把所有端点真正落到最近一条路的中心线上。
 * 前面的去水/平滑/截尾都可能把端点重新挪开 0.5~4m，
 * 渲染时端头圆角就会在路口外鼓出一个"肉瘤"（看起来像断头）。
 * 这里不再做方向判断——只横向挪几米，不会造成掉头。
 */
function finalSnapEnds(majorLines, minorLines) {
  const majorIndex = buildSegmentIndex(majorLines);
  const minorIndex = buildSegmentIndex(minorLines);
  let moved = 0;
  const scan = (lines, major) => {
    const selfIndex = major ? majorIndex : minorIndex;
    const otherIndex = major ? minorIndex : majorIndex;
    lines.forEach((line, li) => {
      if (line.length < 2) return;
      for (const atStart of [true, false]) {
        const p = atStart ? line[0] : line[line.length - 1];
        const same = nearestOnOthers(selfIndex, line, li, p, 4);
        const cross = nearestOnOthers(otherIndex, line, -1, p, 4);
        const hit = cross && (!same || cross.d < same.d) ? cross : same;
        if (!hit || hit.d < 0.4) continue;
        const next = { x: hit.x, z: hit.z };
        if (p.elev) next.elev = p.elev;
        if (atStart) line[0] = next;
        else line[line.length - 1] = next;
        moved += 1;
      }
    });
  };
  scan(majorLines, true);
  scan(minorLines, false);
  console.log(`[道路] 端点最终吸附 ${moved} 处（消除路口端头偏移）`);
}
finalSnapEnds(majorLines, minorLines);

/**
 * 输出前最后一轮"整线重合"清理。
 *
 * 前面的整线去重发生在端点吸附与圆角拟合之前，之后 finalSnapEnds 会把两条
 * 本来相差十几米的重复 way 的端点吸到同一个路口——"同一条路画两遍"又回来了。
 * 俯视下就是两条 26m 宽路面整条互相压着闪，路面也显得比实际宽。
 *
 * 判据：短的那条 90% 的采样点都落在长的那条中心线 offset 米以内、且方向一致。
 * 只与"更长且已保留"的线比较（降序处理），所以不会整片互相删空。
 */
function dedupeCovered(lines, offset, occupied = []) {
  const CELL = 40;
  const key = (ix, iz) => ix * 100000 + iz;
  const grid = new Map();
  const addSegs = (line) => {
    for (let i = 0; i < line.length - 1; i += 1) {
      const a = line[i];
      const b = line[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.5) continue;
      const seg = { ax: a.x, az: a.z, bx: b.x, bz: b.z, ux: (b.x - a.x) / len, uz: (b.z - a.z) / len };
      const x0 = Math.floor(Math.min(a.x, b.x) / CELL);
      const x1 = Math.floor(Math.max(a.x, b.x) / CELL);
      const z0 = Math.floor(Math.min(a.z, b.z) / CELL);
      const z1 = Math.floor(Math.max(a.z, b.z) / CELL);
      for (let ix = x0; ix <= x1; ix += 1)
        for (let iz = z0; iz <= z1; iz += 1) {
          const k = key(ix, iz);
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(seg);
        }
    }
  };
  /** 该点是否被一条同向中心线压住（offset < CELL，查 3×3 格就够） */
  const nearOne = (x, z, ux, uz) => {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let ix = cx - 1; ix <= cx + 1; ix += 1)
      for (let iz = cz - 1; iz <= cz + 1; iz += 1) {
        const bucket = grid.get(key(ix, iz));
        if (!bucket) continue;
        for (const s of bucket) {
          if (Math.abs(s.ux * ux + s.uz * uz) < 0.93) continue;
          const dx = s.bx - s.ax;
          const dz = s.bz - s.az;
          const l2 = dx * dx + dz * dz;
          let t = l2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          if (Math.hypot(x - s.ax - t * dx, z - s.az - t * dz) < offset) return true;
        }
      }
    return false;
  };

  for (const line of occupied) addSegs(line);
  const order = lines
    .map((line) => ({ line, len: lengthOf(line) }))
    .sort((a, b) => b.len - a.len);

  const kept = [];
  let dropped = 0;
  let meters = 0;
  for (const { line, len } of order) {
    if (len >= 40) {
      const dx = line[line.length - 1].x - line[0].x;
      const dz = line[line.length - 1].z - line[0].z;
      const dl = Math.hypot(dx, dz) || 1;
      const ux = dx / dl;
      const uz = dz / dl;
      const samples = sampleLine(line, 10);
      let near = 0;
      for (const p of samples) if (nearOne(p.x, p.z, ux, uz)) near += 1;
      if (near / samples.length >= 0.9) {
        dropped += 1;
        meters += len;
        continue;
      }
    }
    kept.push(line);
    addSegs(line);
  }
  return { kept, dropped, meters };
}

{
  const res = dedupeCovered(majorLines, 10);
  majorLines = res.kept;
  const res2 = dedupeCovered(minorLines, 6, majorLines);
  minorLines = res2.kept;
  const dropped = res.dropped + res2.dropped;
  const meters = res.meters + res2.meters;
  if (dropped > 0) {
    console.log(`[道路] 重合整线裁剪 ${dropped} 条 / ${Math.round(meters)} 米（同一路段被画了两遍）`);
  }
}

/**
 * 输出前最后一次收口。
 * finalSnapEnds 会把端点硬拽到路口中心线上，偶尔又拉出一根 2~4m 的回针
 * （俯视就是路头一根针尖）；剪掉回针后剩下的短段两头都不接路，属于纯碎片，
 * 一并删掉，避免沙盘上出现孤零零的一小截。
 */
{
  const r1 = trimHairpinTips(majorLines);
  majorLines = r1.lines;
  const r2 = trimHairpinTips(minorLines);
  minorLines = r2.lines;
  const trimmed = r1.trimmed + r2.trimmed;

  const majorIndex = buildSegmentIndex(majorLines);
  const minorIndex = buildSegmentIndex(minorLines);
  let orphans = 0;
  const pruneOrphans = (lines, index, otherIndex) => {
    const kept = [];
    lines.forEach((line, li) => {
      if (lengthOf(line) >= 30) {
        kept.push(line);
        return;
      }
      const linked = (p) =>
        Boolean(nearestOnOthers(index, line, li, p, 6)) ||
        Boolean(nearestOnOthers(otherIndex, line, -1, p, 6));
      if (linked(line[0]) || linked(line[line.length - 1])) {
        kept.push(line);
        return;
      }
      orphans += 1;
    });
    return kept;
  };
  majorLines = pruneOrphans(majorLines, majorIndex, minorIndex);
  minorLines = pruneOrphans(minorLines, minorIndex, buildSegmentIndex(majorLines));
  if (trimmed > 0) console.log(`[道路] 收尾折返尖刺剪除 ${trimmed} 处`);
  if (orphans > 0) console.log(`[道路] 收尾孤立碎段删除 ${orphans} 条`);
}

/**
 * 剪掉端点折返的"回针"。
 *
 * 少数 way 的线头会沿原路再折回去一小段（吸附/补接/数据本身），折返点处
 * 两条臂几乎重合反向。26m 宽的路面铺到那里就会收成一个针尖——俯视下就是
 * 路头多出一根细尖刺。折返只出现在线头（实测 35 头 / 24 尾、中间 0 处），
 * 所以直接丢掉线头那个多余点，保留折返点本身（它通常正是路口）。
 */
function trimHairpinTips(lines, maxAngleDeg = 22) {
  const cosLimit = Math.cos((maxAngleDeg * Math.PI) / 180);
  let trimmed = 0;
  const out = [];
  for (const raw of lines) {
    const line = raw.slice();
    let changed = true;
    while (changed && line.length > 2) {
      changed = false;
      const i = 1;
      const a = line[i - 1];
      const b = line[i];
      const c = line[i + 1];
      const ux = a.x - b.x;
      const uz = a.z - b.z;
      const vx = c.x - b.x;
      const vz = c.z - b.z;
      const lu = Math.hypot(ux, uz);
      const lv = Math.hypot(vx, vz);
      if (lu > 0.01 && lv > 0.01 && (ux * vx + uz * vz) / (lu * lv) >= cosLimit) {
        line.shift();
        trimmed += 1;
        changed = true;
        continue;
      }
      const j = line.length - 2;
      const a2 = line[j - 1];
      const b2 = line[j];
      const c2 = line[j + 1];
      const ux2 = a2.x - b2.x;
      const uz2 = a2.z - b2.z;
      const vx2 = c2.x - b2.x;
      const vz2 = c2.z - b2.z;
      const lu2 = Math.hypot(ux2, uz2);
      const lv2 = Math.hypot(vx2, vz2);
      if (lu2 > 0.01 && lv2 > 0.01 && (ux2 * vx2 + uz2 * vz2) / (lu2 * lv2) >= cosLimit) {
        line.pop();
        trimmed += 1;
        changed = true;
      }
    }
    if (line.length >= 2) out.push(line);
  }
  return { lines: out, trimmed };
}

collectOverpass(majorLines, 'major');
collectOverpass(minorLines, 'minor');
if (overpass.length > 0) {
  const hs = overpass.map((o) => o.h);
  console.log(
    `[道路] 高架/立交 ${overpass.length} 段单独抬高渲染（${Math.min(...hs).toFixed(1)}~${Math.max(...hs).toFixed(1)}m）`,
  );
}

const majorOut = round(majorLines);
const minorOut = round(minorLines);

console.log(
  `[道路] 原始 ${wayById.size}，步行道剔除 ${walkDropped}，园路剔除 ${scenicDropped}，` +
    `主干 ${majorOut.length} / 支路 ${minorOut.length}，` +
    `补接 ${snappedMajor + snappedMinor} 处，丢弃 ${dropped}`,
);

await mkdir(new URL('../public/data/', import.meta.url), { recursive: true });
const outFile = new URL('../public/data/roads.json', import.meta.url);
await writeFile(
  outFile,
  JSON.stringify({
    meta: { origin: ORIGIN, unit: 'meter' },
    major: majorOut,
    minor: minorOut,
    overpass,
  }),
);
console.log(`[输出] ${outFile.pathname}`);
