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
console.log(`[水系] 城内线段组 ${waterways.length} 组`);

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
