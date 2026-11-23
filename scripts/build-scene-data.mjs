/**
 * 数据构建：data/raw/*.json → 统一局部米制坐标 → src/data/scene-geometry.json
 * 同时渲染古城轮廓参考图（SVG → PNG，sharp）
 *
 * 坐标系统一定义（与 src/constants/geo.ts 保持一致，唯一原点）：
 *   原点 = 古城几何中心 (120.621°E, 31.311°N)，1 单位 = 1 米，+x = 东，-z = 北
 *
 * 用法: node scripts/build-scene-data.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ORIGIN = { lon: 120.621, lat: 31.311 }; // 必须与 src/constants/geo.ts 一致
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);

const RAW_DIR = new URL('../data/raw/', import.meta.url);
const OUT_JSON = new URL('../src/data/scene-geometry.json', import.meta.url);
const OUT_PNG = new URL('../public/textures/suzhou-old-city-outline.png', import.meta.url);

/* ---------------- 基础几何工具 ---------------- */

const toLocal = (lon, lat) => ({
  x: (lon - ORIGIN.lon) * M_PER_DEG_LON,
  z: -(lat - ORIGIN.lat) * M_PER_DEG_LAT,
});

const pointKey = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
const isClosed = (pts) => pts.length > 3 && pointKey(pts[0]) === pointKey(pts[pts.length - 1]);

/** 折线/环面积（局部米制，shoelace） */
function areaM2(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    sum += pts[i].x * pts[i + 1].z - pts[i + 1].x * pts[i].z;
  }
  return Math.abs(sum / 2);
}

/** 射线法：点是否在环内（局部米制坐标） */
function ringContains(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const { x: xi, z: zi } = ring[i];
    const { x: xj, z: zj } = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Douglas-Peucker 简化（局部米制坐标，容差单位：米） */
function simplify(points, tolerance) {
  if (points.length <= 4) return points;
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

/**
 * 将 way 集合按端点共享串接成折线/闭合环。
 * snapM > 0 时对端点做容差吸附（OSM 中城内水道碎片端点常不共享节点，存在米级缝隙）。
 */
function chainWays(ways, snapM = 0) {
  const ends = [];
  ways.forEach((w, i) => {
    const g = w.geometry;
    ends.push({ i, end: 'start', p: g[0] }, { i, end: 'end', p: g[g.length - 1] });
  });
  // 端点聚类：完全相同坐标必同簇；snapM > 0 时额外做容差吸附
  // （OSM 中城内水道碎片端点常不共享节点，存在米级缝隙）
  const clusterOf = new Array(ends.length).fill(-1);
  const clusterPos = [];
  const exactKey = new Map();
  ends.forEach((e, idx) => {
    const k = pointKey(e.p);
    if (exactKey.has(k)) {
      clusterOf[idx] = exactKey.get(k);
      return;
    }
    if (snapM > 0) {
      for (let c = 0; c < clusterPos.length; c += 1) {
        const dLat = (e.p.lat - clusterPos[c].lat) * M_PER_DEG_LAT;
        const dLon = (e.p.lon - clusterPos[c].lon) * M_PER_DEG_LON;
        if (dLat * dLat + dLon * dLon <= snapM * snapM) {
          clusterOf[idx] = c;
          exactKey.set(k, c);
          return;
        }
      }
    }
    clusterOf[idx] = clusterPos.length;
    exactKey.set(k, clusterOf[idx]);
    clusterPos.push(e.p);
  });
  const endpointMap = new Map();
  ends.forEach((e, idx) => {
    const k = clusterOf[idx];
    if (!endpointMap.has(k)) endpointMap.set(k, []);
    endpointMap.get(k).push({ i: e.i, end: e.end });
  });

  const used = new Array(ways.length).fill(false);
  const chains = [];
  for (let i = 0; i < ways.length; i += 1) {
    if (used[i]) continue;
    used[i] = true;
    const pts = [...ways[i].geometry];
    let headCluster = clusterOf[2 * i];
    let tailCluster = clusterOf[2 * i + 1];
    for (;;) {
      // 向后延伸
      const cands = (endpointMap.get(tailCluster) ?? []).filter((c) => !used[c.i]);
      if (cands.length === 0) break;
      const c = cands[0];
      used[c.i] = true;
      const g = ways[c.i].geometry;
      if (c.end === 'start') {
        pts.push(...g.slice(1));
        tailCluster = clusterOf[2 * c.i + 1];
      } else {
        pts.push(...g.slice(0, -1).reverse());
        tailCluster = clusterOf[2 * c.i];
      }
    }
    for (;;) {
      // 向前延伸
      const cands = (endpointMap.get(headCluster) ?? []).filter((c) => !used[c.i]);
      if (cands.length === 0) break;
      const c = cands[0];
      used[c.i] = true;
      const g = ways[c.i].geometry;
      if (c.end === 'end') {
        pts.unshift(...g.slice(0, -1));
        headCluster = clusterOf[2 * c.i];
      } else {
        pts.unshift(...g.slice(1).reverse());
        headCluster = clusterOf[2 * c.i + 1];
      }
    }
    chains.push(pts);
  }
  return chains;
}

const toLocalLine = (lonlat) => lonlat.map((p) => toLocal(p.lon, p.lat));
const round1 = (pts) => pts.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10]);

const loadRaw = async (name) => {
  const text = await readFile(new URL(name, RAW_DIR), 'utf8');
  return JSON.parse(text);
};

/* ---------------- 1. 古城轮廓：从水系中提取外城河闭合环 ---------------- */

const wayById = new Map();
// 优先读合并文件（首次抓取产物），否则回退到分块文件
let merged = null;
try {
  merged = await loadRaw('waterways.json');
} catch {
  merged = null;
}
if (merged) {
  for (const el of merged.elements ?? []) {
    if (el.type === 'way' && el.geometry) wayById.set(el.id, el);
  }
} else {
  for (const file of ['waterways-sw.json', 'waterways-se.json', 'waterways-nw.json', 'waterways-ne.json']) {
    const json = await loadRaw(file);
    for (const el of json.elements ?? []) {
      if (el.type === 'way' && el.geometry) wayById.set(el.id, el);
    }
  }
}
const waterWays = [...wayById.values()];
console.log(`[水系] 合并去重后 ${waterWays.length} 条 way`);

/**
 * 提取护城河闭合环：
 * 优先用命名为"外城河"的 way 串环（它们在交叉口与别的河流共享节点，
 * 通用串链会在交叉口把环切断，所以先单独处理命名段）；失败再回退全域串链。
 */
const originLocal = { x: 0, z: 0 };
const candidateRings = [];

const moatWays = waterWays.filter((w) => w.tags?.name === '外城河');
if (moatWays.length > 0) {
  for (const chain of chainWays(moatWays)) {
    if (isClosed(chain)) candidateRings.push(toLocalLine(chain));
  }
}
if (candidateRings.length === 0) {
  for (const chain of chainWays(waterWays)) {
    if (isClosed(chain)) candidateRings.push(toLocalLine(chain));
  }
}

const enclosing = candidateRings
  .filter((ring) => ringContains(ring, originLocal.x, originLocal.z))
  .filter((ring) => areaM2(ring) >= 8e6) // 排除小水池
  .sort((a, b) => areaM2(a) - areaM2(b));

if (enclosing.length === 0) {
  throw new Error('未找到包围古城中心的水系闭合环，检查 waterways 原始数据');
}
// 最小包围环即护城河（外城河）；更大的包围环（如运河回路）被排序排除
const cityOutlineLocal = simplify(enclosing[0], 1.5);
console.log(
  `[轮廓] 外城河闭合环 ${enclosing[0].length} 点 → 简化后 ${cityOutlineLocal.length} 点，面积 ${(areaM2(enclosing[0]) / 1e6).toFixed(2)} km²`,
);

/* ---------------- 2. 城内水系（先串链成连续水道，再裁剪到轮廓内） ---------------- */

const waterways = [];
for (const chain of chainWays(waterWays, 60)) {
  if (chain.length < 2) continue;
  const local = toLocalLine(chain);
  // 仅保留两端点都在城内的线段
  const segs = [];
  for (let i = 0; i < local.length - 1; i += 1) {
    if (ringContains(cityOutlineLocal, local[i].x, local[i].z) &&
        ringContains(cityOutlineLocal, local[i + 1].x, local[i + 1].z)) {
      segs.push([local[i], local[i + 1]]);
    }
  }
  if (segs.length === 0) continue;
  const flat = [];
  for (const [a, b] of segs) flat.push(a, b); // 保持 {x,z} 对象供 round1 使用
  waterways.push(round1(flat));
}
// 盘门水门不再作为城内河道输出：它在城墙外要降到护城河标高，
// 由 WaterSystem 的 PANMEN_GATE 单独铺水面（避免两层水面叠在一起）。

/**
 * 城内河道是沙盘骨架，必须连成网。
 * OSM 里散落着若干 10~80m 的孤立水系段（断头浜、院内水池），按 30m 宽铺出来
 * 就是城市中间一块块蓝色水洼，既不成河也不可能行船。这里整体剔除，
 * 只保留两类：长度 ≥150m 的主河道；两端都贴着别的河道或护城河的短段。
 */
const distToSeg = (x, z, a, b) => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
};
const lineLen = (l) => {
  let s = 0;
  for (let i = 0; i < l.length - 1; i += 1) s += Math.hypot(l[i + 1][0] - l[i][0], l[i + 1][1] - l[i][1]);
  return s;
};
const ringDistToOutline = (x, z) => {
  let best = Infinity;
  for (let i = 0; i < cityOutlineLocal.length - 1; i += 1) {
    best = Math.min(
      best,
      distToSeg(x, z, [cityOutlineLocal[i].x, cityOutlineLocal[i].z], [cityOutlineLocal[i + 1].x, cityOutlineLocal[i + 1].z]),
    );
  }
  return best;
};
const keptWaterways = waterways.filter((line, i) => {
  if (lineLen(line) >= 150) return true;
  for (const end of [line[0], line[line.length - 1]]) {
    let best = ringDistToOutline(end[0], end[1]);
    for (let j = 0; j < waterways.length && best > 40; j += 1) {
      if (j === i) continue;
      const other = waterways[j];
      for (let k = 0; k < other.length - 1 && best > 40; k += 1) {
        best = Math.min(best, distToSeg(end[0], end[1], other[k], other[k + 1]));
      }
    }
    if (best > 40) return false;
  }
  return true;
});
const waterDropped = waterways.length - keptWaterways.length;
waterways.length = 0;
waterways.push(...keptWaterways);
console.log(`[水系] 城内线段组 ${waterways.length} 组（剔除孤立水洼 ${waterDropped} 段）`);

/* ---------------- 2.5 历史河道主干（三横四直） ----------------
 * OSM 在古城内只剩环城河内侧一条水道，城区中部是"干的"，而苏州古城的
 * 骨架恰恰是"三横四直"的直河。这里按老城实际走向补三条主干：
 *   干将河（中横 z≈60）、十全河（南横 z≈1000）、临顿河（中直 x≈600）。
 * 全部正交直线、两端穿过城墙伸进护城河，与街网同向，避免出现斜穿街区的怪河。
 */
const CITY_CANAL_SPECS = [
  { name: '干将河', a: [-2600, 60], b: [2600, 60] },
  { name: '十全河', a: [-2400, 1000], b: [2400, 1000] },
  { name: '临顿河', a: [600, -2600], b: [600, 2600] },
];

/** 直线裁剪到城廓内，返回落在环内的那一段（两端点正好在城墙上） */
const clipStraightToRing = (a, b) => {
  const N = 400;
  let first = null;
  let last = null;
  for (let i = 0; i <= N; i += 1) {
    const t = i / N;
    const x = a[0] + (b[0] - a[0]) * t;
    const z = a[1] + (b[1] - a[1]) * t;
    if (ringContains(cityOutlineLocal, x, z)) {
      if (first === null) first = t;
      last = t;
    }
  }
  if (first === null || last === null || last - first < 1e-4) return null;
  const at = (t) => [
    Math.round((a[0] + (b[0] - a[0]) * t) * 10) / 10,
    Math.round((a[1] + (b[1] - a[1]) * t) * 10) / 10,
  ];
  return [at(first), at(last)];
};

let curatedCanals = 0;
for (const spec of CITY_CANAL_SPECS) {
  const line = clipStraightToRing(spec.a, spec.b);
  if (!line) continue;
  waterways.push(line);
  curatedCanals += 1;
}
console.log(`[水系] 补画历史河道主干 ${curatedCanals} 条（干将河 / 十全河 / 临顿河）`);

/* ---------------- 2a. 地图水道退出"自带河道"的模型范围 ---------------- */

/**
 * 平江路等景点模型内部已经自带水面网格（平江路：7m 宽的平江河，位于街道西侧）。
 * OSM 城内水道在这些位置再铺一条 30m 宽的河，同一条河就出现两份且互不对齐，
 * 模型沿河民居直接被泡进水里（平江路东北角最明显）。
 * 模型是位置固定的既有资产，所以让"地图水道"退出模型包围盒：
 * 盒内的水道段裁掉，该处只保留模型自带的那条河。
 */
const MODEL_BOUNDS = JSON.parse(
  await readFile(new URL('../src/data/model-bounds.json', import.meta.url), 'utf8'),
);
/** 自带 water 网格的模型（读 GLB header 得出），只有它们需要避让 */
const MODEL_WATER_IDS = [
  'canglangting', 'liuyuan', 'pingjiang', 'shantangjie', 'shizilin',
  'suzhou-museum', 'wangshiyuan', 'xiyuansi', 'zhuozhengyuan',
];
const waterBoxes = MODEL_WATER_IDS
  .map((id) => MODEL_BOUNDS[id])
  .filter(Boolean)
  .map(([minX, maxX, minZ, maxZ]) => ({ minX, maxX, minZ, maxZ }));

/** 线段与轴对齐包围盒的相交参数区间 [t0, t1]（Liang–Barsky），无交返回 null */
const segBoxInterval = (a, b, box) => {
  let t0 = 0;
  let t1 = 1;
  const checks = [
    [a[0] - b[0], a[0] - box.minX],
    [b[0] - a[0], box.maxX - a[0]],
    [a[1] - b[1], a[1] - box.minZ],
    [b[1] - a[1], box.maxZ - a[1]],
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return t0 < t1 ? [t0, t1] : null;
};

/** 折线裁掉落在任一包围盒内的部分，返回若干段 */
const clipOutOfBoxes = (line, boxes) => {
  const pieces = [];
  let current = [];
  const pushPoint = (p) => {
    const last = current[current.length - 1];
    if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 1e-6) return;
    current.push(p);
  };
  const flush = () => {
    if (current.length >= 2) pieces.push(current);
    current = [];
  };
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    const hits = [];
    for (const box of boxes) {
      const iv = segBoxInterval(a, b, box);
      if (iv) hits.push(iv);
    }
    hits.sort((m, n) => m[0] - n[0]);
    const merged = [];
    for (const iv of hits) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    let cursor = 0;
    for (const iv of merged) {
      if (iv[0] > cursor + 1e-9) {
        pushPoint(at(cursor));
        pushPoint(at(iv[0]));
        flush();
      }
      cursor = Math.max(cursor, iv[1]);
    }
    if (cursor < 1 - 1e-9) {
      pushPoint(at(cursor));
      pushPoint(b);
    }
  }
  flush();
  return pieces;
};

let waterTrimmed = 0;
let waterTrimMeters = 0;
const trimmedWaterways = [];
for (const line of waterways) {
  const before = lineLen(line);
  let after = 0;
  for (const piece of clipOutOfBoxes(line, waterBoxes)) {
    const len = lineLen(piece);
    if (len < 40) continue; // 残段只是水坑
    trimmedWaterways.push(piece);
    after += len;
  }
  if (before - after > 1) {
    waterTrimmed += 1;
    waterTrimMeters += before - after;
  }
}
if (waterTrimmed > 0) {
  waterways.length = 0;
  waterways.push(...trimmedWaterways);
  console.log(
    `[水系] ${waterTrimmed} 条水道与模型自带河道重叠，裁掉 ${Math.round(waterTrimMeters)} 米（该处只留模型内河）`,
  );
}

/* ---------------- 2a-2. 河网收口：不留断头河 ----------------
 * 沙盘上最扎眼的水系问题不是河太宽，而是"河从街区中间凭空断掉"：
 * 一条 12m 宽的水面带在房子堆里戛然而止，既不像河也不像池。
 * 收口规则（严格按顺序）：
 *   1. 端点距其它河道 ≤45m → 直接吸到那条河上，形成 T 形交汇；
 *   2. 否则端点距护城河 ≤260m → 沿"端点→护城河最近点"方向延长，
 *      并越过轮廓 9m 伸进护城河水面，保证两片水真正连上；
 *   3. 还有悬空端的河道整条剔除——宁可少一条河，也不留断头。
 * 这一步必须在"地图水道退出模型包围盒"之后：模型内河会切断地图水道，
 * 切出来的残段正好由这里判定为断头并清掉。
 */
const outlinePts = cityOutlineLocal.map((p) => [p.x, p.z]);

/** 河道折线是 [x,z] 数组，不能复用只吃 {x,z} 的 round1 */
const roundLine = (pts) => pts.map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]);

const nearestOnPolyline = (x, z, line) => {
  let best = { x: 0, z: 0, d: Infinity };
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + t * dx;
    const pz = a[1] + t * dz;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.d) best = { x: px, z: pz, d };
  }
  return best;
};

const WATER_JOIN = 45;
const WATER_MOAT_REACH = 260;
const MOAT_EMBED = 9;
const WATER_MIN_LEN = 60;

function closeWaterNetwork(lines) {
  const geo = lines.map((line) => line.map((p) => [p[0], p[1]]));
  let snapped = 0;
  let extended = 0;
  let dropped = 0;
  const out = [];

  for (let i = 0; i < geo.length; i += 1) {
    const line = geo[i];
    if (line.length < 2) continue;
    let dangling = 0;

    for (const isHead of [true, false]) {
      const end = isHead ? line[0] : line[line.length - 1];
      // 1) 吸到最近的其它河道
      let hit = { d: Infinity, x: 0, z: 0 };
      for (let j = 0; j < geo.length; j += 1) {
        if (j === i) continue;
        const q = nearestOnPolyline(end[0], end[1], geo[j]);
        if (q.d < hit.d) hit = q;
      }
      if (hit.d <= WATER_JOIN) {
        if (hit.d > 0.4) {
          if (isHead) line.unshift([hit.x, hit.z]);
          else line.push([hit.x, hit.z]);
        }
        snapped += 1;
        continue;
      }
      // 2) 延长到护城河
      const moat = nearestOnPolyline(end[0], end[1], outlinePts);
      if (moat.d <= WATER_MOAT_REACH) {
        let dx = moat.x - end[0];
        let dz = moat.z - end[1];
        let len = Math.hypot(dx, dz);
        if (len < 0.5) {
          // 端点已经落在城墙上（补画的历史河道）：顺着河道走向伸进护城河
          const prev = isHead ? line[1] : line[line.length - 2];
          dx = end[0] - prev[0];
          dz = end[1] - prev[1];
          len = Math.hypot(dx, dz) || 1;
        }
        const reach = moat.d <= 0.5 ? MOAT_EMBED : len + MOAT_EMBED;
        const tip = [end[0] + (dx / len) * reach, end[1] + (dz / len) * reach];
        if (isHead) line.unshift(tip);
        else line.push(tip);
        extended += 1;
        continue;
      }
      dangling += 1;
    }

    if (dangling > 0 || lineLen(line) < WATER_MIN_LEN) {
      dropped += 1;
      continue;
    }
    out.push(roundLine(line));
  }

  console.log(
    `[水系] 收口：吸附交汇 ${snapped} 处，接入护城河 ${extended} 处，` +
      `剔除断头/过短河道 ${dropped} 条，保留 ${out.length} 条`,
  );
  return out;
}

/**
 * 河道折线平滑（Chaikin，保留首尾端点）。
 * OSM 的河道在高密度城区常是一串 90° 折线，12m 宽铺出来就是"楼梯形"水带。
 * 两轮圆角只改变转角形态，起终点与走向不变，河仍落在原来的位置。
 */
function smoothWater(line, iterations = 2) {
  let pts = line.map((p) => [p[0], p[1]]);
  for (let it = 0; it < iterations; it += 1) {
    if (pts.length < 3) break;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return roundLine(pts);
}

if (waterways.length > 0) {
  const closed = closeWaterNetwork(trimmedWaterways);
  waterways.length = 0;
  waterways.push(...closed.map((line) => smoothWater(line, 2)));
}

/* ---------------- 2b. 城外水道：山塘河（阊门—虎丘） ---------------- */

const OUTER_WATER_LIMIT = 5800;
const outerWaterways = [];
for (const chain of chainWays(waterWays.filter((w) => (w.tags?.name ?? '').includes('山塘河')), 60)) {
  if (chain.length < 2) continue;
  outerWaterways.push(round1(toLocalLine(chain)));
}
// 只保留寒山寺界内的部分，避免水面伸出沙盘
for (let i = outerWaterways.length - 1; i >= 0; i -= 1) {
 

  // round1 输出的是 [x, z] 数组
  const pts = outerWaterways[i].filter(
    (p) => Math.abs(p[0]) <= OUTER_WATER_LIMIT && Math.abs(p[1]) <= OUTER_WATER_LIMIT,
  );
  if (pts.length >= 2) outerWaterways[i] = pts;
  else outerWaterways.splice(i, 1);
}
console.log(`[水系] 城外山塘河 ${outerWaterways.length} 组`);

/* ---------------- 2c. 城外补建河道：上塘河（阊门—枫桥—寒山寺） ----------------
 * OSM 只给了山塘河一条城外水道，寒山寺/枫桥一带就只剩旱地。
 * 这里按真实走向补一条上塘河，并让它从留园北侧（园墙外约 30m）通过：
 * 早先这条河是画在 sceneGeometry.ts 里的运行期直线，直接穿过了留园园子
 * （园中央的水池与河连成一片），而且 build-roads 看不到它，沿河道路整段
 * 泡在水里无法避让。落到数据层后，路网避让、桥位、水面渲染共用同一条折线。
 */
const SHANGTANG_RIVER = [
  [-2092, -445], // 阊门西（接护城河）
  [-2580, -590],
  // 绕开留园的一段要缓：折点加在河道中线之外，避免水面折线在路口甩出尖角
  [-2800, -655],
  [-2950, -745],
  [-3060, -872], // 留园北：绕到园墙外，河心距园界 30m
  [-3160, -905],
  [-3300, -918],
  [-3560, -915],
  [-4100, -960],
  [-4620, -1030],
  [-5120, -1090],
  [-5393, -1135], // 枫桥
];
outerWaterways.push(SHANGTANG_RIVER);
console.log(`[水系] 含补建上塘河 共 ${outerWaterways.length} 组`);

/* ---------------- 3. 景点轮廓与坐标 ---------------- */

// way id → 景点 id（探测阶段确认）
const WAY_TO_LANDMARK = {
  468359738: 'zhuozhengyuan', // 拙政园
  420034522: 'liuyuan', // 留园
  44679452: 'wangshiyuan', // 网师园
  44679451: 'shizilin', // 狮子林
  492154541: 'canglangting', // 沧浪亭
  128898272: 'panmen', // 盘门景区（含瑞光塔+水陆城门）
  542534202: 'suzhou-museum', // 苏州博物馆
  541032070: 'shantangjie', // 七里山塘（山塘街景区面）
};

const landmarks = {};

const polygons = await loadRaw('landmark-polygons.json');
for (const el of polygons.elements ?? []) {
  const id = WAY_TO_LANDMARK[el.id];
  if (!id || !el.geometry) continue;
  let ring = el.geometry;
  if (!isClosed(ring)) ring = [...ring, ring[0]];
  const local = simplify(toLocalLine(ring), 1.0);
  // 质心（顶点均值，轮廓近似凸时足够定位标签/相机）
  const n = local.length - 1;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i += 1) {
    cx += local[i].x;
    cz += local[i].z;
  }
  landmarks[id] = {
    outline: round1(local),
    centroid: { x: Math.round((cx / n) * 10) / 10, z: Math.round((cz / n) * 10) / 10 },
  };
}

// 街道型景点：平江路、山塘街折线
const streets = await loadRaw('streets.json');
const streetWays = { 平江路: [], 山塘街: [] };
for (const el of streets.elements ?? []) {
  const name = el.tags?.name;
  if (el.type === 'way' && el.geometry && streetWays[name]) streetWays[name].push(el);
}
const streetTargets = { 平江路: 'pingjiang', 山塘街: 'shantangjie-path' };
for (const [name, ways] of Object.entries(streetWays)) {
  const streetChains = chainWays(ways, 10).map(toLocalLine).sort((a, b) => b.length - a.length);
  if (streetChains.length === 0) continue;
  const longest = simplify(streetChains[0], 1.0);
  const mid = longest[Math.floor(longest.length / 2)];
  const key = streetTargets[name];
  if (key === 'shantangjie-path') {
    if (landmarks.shantangjie) landmarks.shantangjie.path = round1(longest);
  } else {
    landmarks[key] = {
      path: round1(longest),
      centroid: { x: Math.round(mid.x * 10) / 10, z: Math.round(mid.z * 10) / 10 },
    };
  }
  console.log(`[街道] ${name}: ${ways.length} 条 way → 最长链 ${longest.length} 点`);
}

/**
 * 平江河：把精细模型内河接进主河网。
 *
 * 平江路模型自带 190m 样板段内河（街道西侧，水面 u∈[-20.5,-8.5]，中心 -14.5m），
 * 而 OSM 城内水道在该范围被模型包围盒裁掉，剩下两截又按"断头河"规则整条剔除，
 * 于是模型内河成了两端齐茬断掉的死水。
 *
 * 这里沿用模型内河的同一条中心线（平江路折线左法线偏移 14.5m），南端接干将河
 * （z≈60），北端接临顿河（x≈600）。必须在"水道退出模型包围盒 / 河网收口"
 * 之后追加：否则这一条又会被裁断或当成断头河丢弃。build-buildings 读同一份
 * waterways，沿河民居会同步退出河道，不会出现房子泡在水里。
 */
const pingjiangRiver = (() => {
  const path = landmarks.pingjiang?.path;
  if (!path || path.length < 2) return null;
  const aligned = offsetStreetRiver(path, 14.5);
  const [lastX] = aligned[aligned.length - 1];
  return roundLine([[601, aligned[0][1]], ...aligned, [lastX, 60]]);
})();
if (pingjiangRiver) {
  waterways.push(pingjiangRiver);
  console.log(
    `[水系] 补画平江河 ${pingjiangRiver.length} 点：对齐模型内河中心线（西偏 14.5m），南接干将河、北接临顿河`,
  );
}

/**
 * 山塘河对齐精细模型：
 * 模型内河西岸在街道中心线 +7.7m 处（脚本里 u=-7.7，世界方向为左法线）。
 * 这里直接用山塘街折线偏移生成绘制河道中心线，保证模型水面与绘制水面完全重合，
 * 而不是让 OSM 河道和模型河道并排出现成"两条河"。
 */
function offsetStreetRiver(line, distance) {
  const out = [];
  for (let i = 0; i < line.length; i += 1) {
    const prev = line[Math.max(0, i - 1)];
    const next = line[Math.min(line.length - 1, i + 1)];
    let tx = next[0] - prev[0];
    let tz = next[1] - prev[1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    // 左法线 (-tz, tx)：与模型 Blender 脚本里 u=+7.7 的河道完全重合
    out.push([line[i][0] - tz * distance, line[i][1] + tx * distance]);
  }
  return out;
}

if (landmarks.shantangjie?.path?.length > 1 && outerWaterways.length > 0) {
  const oldRiver = outerWaterways[0];
  const aligned = offsetStreetRiver(landmarks.shantangjie.path, 7.7);
  const moatMouth = oldRiver[oldRiver.length - 1];
  if (moatMouth) aligned.unshift([moatMouth[0], moatMouth[1]]);
  // 山塘街折线尾端伸进虎丘山体；河道不能爬坡，按山脚半径剪掉，避免"河上山"。
  const hillsRaw = JSON.parse(await readFile(new URL('../src/data/hills.json', import.meta.url), 'utf8'));
  const hillDiscs = hillsRaw.map((h) => ({ ...toLocal(h.lon, h.lat), r: h.radius * 1.02 }));
  const outsideHills = ([x, z]) => hillDiscs.every((h) => Math.hypot(x - h.x, z - h.z) > h.r);
  while (aligned.length > 2 && !outsideHills(aligned[aligned.length - 1])) aligned.pop();
  outerWaterways[0] = aligned.map(
    ([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10],
  );
  console.log(`[河道] 山塘河已对齐山塘街模型内河：${outerWaterways[0].length} 点，偏移 7.7m，阊门端接护城河`);
}

// 寒山寺（阊门外）
const hanshan = await loadRaw('hanshan.json');
for (const el of hanshan.elements ?? []) {
  if (el.type === 'way' && el.geometry && isClosed(el.geometry)) {
    const local = simplify(toLocalLine(el.geometry), 1.0);
    const n = local.length - 1;
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < n; i += 1) {
      cx += local[i].x;
      cz += local[i].z;
    }
    landmarks.hanshansi = {
      outline: round1(local),
      centroid: { x: Math.round((cx / n) * 10) / 10, z: Math.round((cz / n) * 10) / 10 },
    };
    console.log(`[景点] 寒山寺轮廓 ${local.length} 点`);
    break;
  }
}

/* ---------------- 3b. 补充景点：观前街 / 双塔 / 报恩寺·北寺塔 ---------------- */

/** 闭合环 → { outline, centroid } */
function addRingLandmark(id, el, tolerance = 1.0) {
  if (!el?.geometry) return;
  let ring = el.geometry;
  if (!isClosed(ring)) ring = [...ring, ring[0]];
  const local = simplify(toLocalLine(ring), tolerance);
  const n = local.length - 1;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i += 1) {
    cx += local[i].x;
    cz += local[i].z;
  }
  landmarks[id] = {
    outline: round1(local),
    centroid: { x: Math.round((cx / n) * 10) / 10, z: Math.round((cz / n) * 10) / 10 },
  };
  console.log(`[景点] ${id} 轮廓 ${local.length} 点`);
}

const extra = async (name) => {
  try {
    return await loadRaw(name);
  } catch {
    console.warn(`[跳过] ${name} 不存在，先运行 node scripts/fetch-extra-landmarks.mjs`);
    return null;
  }
};

// 观前街（步行街）：多条 way 串链后取最长
const guanqian = await extra('extra-guanqian.json');
if (guanqian) {
  const gqWays = (guanqian.elements ?? []).filter(
    (el) => el.type === 'way' && el.geometry && el.tags?.name === '观前街',
  );
  const chains = chainWays(gqWays, 15).map(toLocalLine).sort((a, b) => b.length - a.length);
  if (chains.length > 0) {
    const longest = simplify(chains[0], 1.0);
    const mid = longest[Math.floor(longest.length / 2)];
    landmarks.guanqianjie = {
      path: round1(longest),
      centroid: { x: Math.round(mid.x * 10) / 10, z: Math.round(mid.z * 10) / 10 },
    };
    console.log(`[街道] 观前街: ${gqWays.length} 条 way → 最长链 ${longest.length} 点`);
  }
}

// 双塔（罗汉院双塔）
const shuangta = await extra('extra-shuangta.json');
if (shuangta) {
  const site = (shuangta.elements ?? []).find((el) => el.id === 526782681);
  addRingLandmark('shuangta', site);
}

// 报恩寺 · 北寺塔
const beisita = await extra('extra-beisita.json');
if (beisita) {
  const temple = (beisita.elements ?? []).find((el) => el.id === 455890868);
  addRingLandmark('beisita', temple);
}

// 唐寅祠 + 桃花坞片区
const taohuawu = await extra('extra-taohuawu.json');
if (taohuawu) {
  // 唐寅祠：独立祠院轮廓
  const ci = (taohuawu.elements ?? []).find((el) => el.id === 529003248);
  addRingLandmark('tangyinci', ci);

  // 桃花坞片区：沿桃花坞大街取最长链作为街区骨架
  const thwWays = (taohuawu.elements ?? []).filter(
    (el) => el.type === 'way' && el.geometry && el.tags?.name === '桃花坞大街',
  );
  const chains = chainWays(thwWays, 15).map(toLocalLine).sort((a, b) => b.length - a.length);
  if (chains.length > 0) {
    const full = simplify(chains[0], 1.0);
    // 桃花坞大街全长约 1.2km，这里只保留质心两侧各 130m 的样板段
    const midIdx = Math.floor(full.length / 2);
    const seg = [full[midIdx]];
    let acc = 0;
    for (let i = midIdx + 1; i < full.length; i += 1) {
      acc += Math.hypot(full[i].x - full[i - 1].x, full[i].z - full[i - 1].z);
      if (acc > 130) break;
      seg.push(full[i]);
    }
    acc = 0;
    for (let i = midIdx; i > 0; i -= 1) {
      acc += Math.hypot(full[i].x - full[i - 1].x, full[i].z - full[i - 1].z);
      if (acc > 130) break;
      seg.unshift(full[i - 1]);
    }
    const mid = full[midIdx];
    landmarks.taohuawu = {
      path: round1(seg),
      centroid: { x: Math.round(mid.x * 10) / 10, z: Math.round(mid.z * 10) / 10 },
    };
    console.log(
      `[街道] 桃花坞大街: ${thwWays.length} 条 way → 全长 ${full.length} 点，样板段 ${seg.length} 点`,
    );
  }
}

/* ---------------- 3c. 西园寺 / 石路商圈 ---------------- */

// 西园寺（西园戒幢律寺）：寺院范围 way 736382204
const xiyuansi = await extra('extra-xiyuansi.json');
if (xiyuansi) {
  const site = (xiyuansi.elements ?? []).find((el) => el.id === 736382204);
  addRingLandmark('xiyuansi', site);
}

// 石路商圈：以石路步行街 retail 面 way 561176608 作为街区范围
const shilu = await extra('extra-shilu.json');
if (shilu) {
  const site = (shilu.elements ?? []).find((el) => el.id === 561176608);
  addRingLandmark('shilu', site);
}

/* ---------------- 4. 输出统一场景数据 ---------------- */

const sceneData = {
  meta: {
    source: 'OpenStreetMap via Overpass API',
    license: 'ODbL (© OpenStreetMap contributors)',
    origin: ORIGIN,
    unit: 'meter',
    note: '局部米制坐标：+x=东，-z=北；lonlat 为 WGS84',
  },
  cityOutline: round1(cityOutlineLocal),
  waterways,
  outerWaterways,
  landmarks,
};

await writeFile(OUT_JSON, JSON.stringify(sceneData));
console.log(`\n[输出] ${OUT_JSON.pathname}`);
console.log('景点数据:');
for (const [id, data] of Object.entries(landmarks)) {
  const kind = data.outline ? `轮廓 ${data.outline.length} 点` : `折线 ${data.path?.length ?? 0} 点`;
  console.log(`  ${id.padEnd(16)} ${kind}  centroid=(${data.centroid.x}, ${data.centroid.z})`);
}

/* ---------------- 5. 渲染轮廓参考图（SVG → PNG） ---------------- */

// 画布范围：轮廓 + 全部景点
let minX = Infinity;
let maxX = -Infinity;
let minZ = Infinity;
let maxZ = -Infinity;
const expand = (x, z) => {
  minX = Math.min(minX, x);
  maxX = Math.max(maxX, x);
  minZ = Math.min(minZ, z);
  maxZ = Math.max(maxZ, z);
};
cityOutlineLocal.forEach((p) => expand(p.x, p.z));
Object.values(landmarks).forEach((l) => expand(l.centroid.x, l.centroid.z));
const PAD = 300;
minX -= PAD;
maxX += PAD;
minZ -= PAD;
maxZ += PAD;

const W = 1600;
const scale = W / (maxX - minX);
const H = Math.round((maxZ - minZ) * scale);
// 局部坐标 → SVG 像素：x 向右，z（南为正）向下
const px = (x) => (x - minX) * scale;
const pz = (z) => (z - minZ) * scale;
const polyStr = (pts) => pts.map((p) => `${px(p[0]).toFixed(1)},${pz(p[1]).toFixed(1)}`).join(' ');
const lineStr = (pts) => pts.map((p) => `${px(p[0]).toFixed(1)},${pz(p[1]).toFixed(1)}`).join(' ');

const NAMES = {
  zhuozhengyuan: '拙政园',
  liuyuan: '留园',
  wangshiyuan: '网师园',
  shizilin: '狮子林',
  canglangting: '沧浪亭',
  panmen: '盘门',
  'suzhou-museum': '苏州博物馆',
  shantangjie: '山塘街',
  pingjiang: '平江路',
  hanshansi: '寒山寺',
  guanqianjie: '观前街',
  shuangta: '双塔',
  beisita: '报恩寺·北寺塔',
  tangyinci: '唐寅祠',
  taohuawu: '桃花坞片区',
};

const landmarkSvg = Object.entries(landmarks)
  .map(([id, l]) => {
    const shape = l.outline
      ? `<polygon points="${polyStr(l.outline)}" fill="rgba(201,168,106,0.35)" stroke="#c9a86a" stroke-width="1.5"/>`
      : `<polyline points="${lineStr(l.path)}" fill="none" stroke="#c9a86a" stroke-width="3"/>`;
    const label = `<text x="${px(l.centroid.x)}" y="${pz(l.centroid.z) - 8}" font-size="15" fill="#e8e6e0" text-anchor="middle">${NAMES[id] ?? id}</text>`;
    return shape + label;
  })
  .join('\n');

const waterSvg = waterways
  .map((seg) => `<polyline points="${lineStr(seg)}" fill="none" stroke="#3f7ea6" stroke-width="2"/>`)
  .join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#0e1420"/>
  <polygon points="${polyStr(round1(cityOutlineLocal))}" fill="rgba(138,143,122,0.25)" stroke="#c9a86a" stroke-width="3"/>
  ${waterSvg}
  ${landmarkSvg}
  <text x="24" y="40" font-size="26" fill="#e8e6e0" font-weight="bold" font-family="Microsoft YaHei,PingFang SC,sans-serif">苏州古城轮廓 · 护城河以内 ${(areaM2(enclosing[0]) / 1e6).toFixed(1)} km²</text>
  <text x="24" y="68" font-size="14" fill="#8fa3bf" font-family="Microsoft YaHei,PingFang SC,sans-serif">数据源 OpenStreetMap (ODbL) · 原点 120.621°E, 31.311°N · 1 单位 = 1 米</text>
</svg>`;

await mkdir(new URL('../public/textures/', import.meta.url), { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(OUT_PNG));
console.log(`[输出] ${OUT_PNG.pathname} (${W}×${H})`);
