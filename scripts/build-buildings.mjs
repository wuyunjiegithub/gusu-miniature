/**
 * 建筑数据处理（M1）：OSM footprint → 定向包围盒 → 风格化屋顶群实例数据
 * 输入 data/raw/buildings-*.json，输出 public/data/buildings.json
 *
 * 每个建筑压缩为一个实例参数：[x, z, w, d, rot, h, roofH]
 *   (x,z) 定向包围盒中心；(w,d) 宽深；rot 绕 Y 轴弧度；h 墙体高；roofH 屋顶高
 * 坡顶（民居）与平顶（较高建筑）分为两组，运行时各一个 InstancedMesh。
 * 用法: node scripts/build-buildings.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ORIGIN = { lon: 120.621, lat: 31.311 }; // 与 src/constants/geo.ts 一致
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);

const toLocal = (lon, lat) => ({
  x: (lon - ORIGIN.lon) * M_PER_DEG_LON,
  z: -(lat - ORIGIN.lat) * M_PER_DEG_LAT,
});

const area = (pts) => {
  let s = 0;
  for (let i = 0; i < pts.length - 1; i += 1) s += pts[i].x * pts[i + 1].z - pts[i + 1].x * pts[i].z;
  return Math.abs(s / 2);
};

const pointInRing = (ring, x, z) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};

/** 点到景点轮廓边界的最短距离（米） */
const distToRing = (ring, x, z) => {
  let best = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[(i + 1) % ring.length];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - x1) * dx + (z - z1) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - (x1 + t * dx), z - (z1 + t * dz)));
  }
  return best;
};

/** 最小面积定向包围盒（遍历边方向，旋转卡壳近似） */
function orientedBox(pts) {
  let best = null;
  const n = pts.length - 1;
  for (let i = 0; i < n; i += 1) {
    const dx = pts[i + 1].x - pts[i].x;
    const dz = pts[i + 1].z - pts[i].z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uz = dz / len;
    const vx = -uz;
    const vz = ux;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let k = 0; k < n; k += 1) {
      const pu = pts[k].x * ux + pts[k].z * uz;
      const pv = pts[k].x * vx + pts[k].z * vz;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv;
      if (pv > maxV) maxV = pv;
    }
    const w = maxU - minU;
    const d = maxV - minV;
    if (!best || w * d < best.w * best.d) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = {
        w,
        d,
        x: cu * ux + cv * vx,
        z: cu * uz + cv * vz,
        // three.js: rotY 角度 a 将局部 +x 映射到 (cos a, -sin a)
        rot: Math.atan2(-uz, ux),
      };
    }
  }
  return best;
}

const parseHeight = (tags) => {
  const h = Number.parseFloat(tags.height);
  if (Number.isFinite(h) && h > 2 && h < 120) return h;
  const levels = Number.parseFloat(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0 && levels < 40) return levels * 3.2;
  const type = tags.building ?? 'yes';
  const defaults = {
    apartments: 18,
    commercial: 14,
    hotel: 20,
    school: 12,
    hospital: 20,
    office: 20,
    industrial: 9,
    retail: 10,
    church: 12,
    temple: 10,
    museum: 10,
    garage: 3.2,
    garage_boxes: 3.2,
    shed: 2.8,
    roof: 3,
    yes: 7.2,
    residential: 7.2,
    house: 6.5,
    terrace: 7,
  };
  return defaults[type] ?? 7.2;
};

/* ---------------- 读取 ---------------- */

const sceneGeo = JSON.parse(
  await readFile(new URL('../src/data/scene-geometry.json', import.meta.url), 'utf8'),
);
const cityRing = sceneGeo.cityOutline;
const landmarkRings = Object.values(sceneGeo.landmarks)
  .map((l) => l.outline)
  .filter(Boolean);

/* ---------------- 运行时注入地标的占地轮廓（文保 / 城外补建） ----------------
 * 古城内 31 处文保 + 城外补建地标的轮廓是在 sceneGeometry.ts 运行时注入的，
 * 静态 scene-geometry.json 里没有它们。若建筑生成只看静态 landmarks，就会把
 * 民居铺到文保脚下——精细建筑群被普通白模淹没，看起来"只是标了个名字"。
 * 这里从同一份 TS 数据源解析经纬度/占地半径，补出圆形剔除环，与运行时一致。
 * 单一数据源仍是 TS 文件，改坐标只需改那里。
 */
const parseRingFromTs = async (file, radiusOf) => {
  const text = await readFile(new URL(`../src/data/${file}`, import.meta.url), 'utf8');
  const out = [];
  // 逐对象块解析：{ id:'..', ..., lon: .., lat: .. }（字段顺序稳定，块内取 id/lon/lat/kind）
  const blocks = text.split(/\n\s*\{/).slice(1);
  for (const block of blocks) {
    const id = block.match(/\bid:\s*'([^']+)'/)?.[1];
    const lon = Number(block.match(/\blon:\s*(-?[\d.]+)/)?.[1]);
    const lat = Number(block.match(/\blat:\s*(-?[\d.]+)/)?.[1]);
    if (!id || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const radius = radiusOf(block);
    if (!radius || radius <= 0) continue;
    const c = toLocal(lon, lat);
    const sides = 12;
    const ring = Array.from({ length: sides }, (_, i) => {
      const a = (i / sides) * Math.PI * 2;
      return [
        Math.round((c.x + Math.cos(a) * radius) * 10) / 10,
        Math.round((c.z + Math.sin(a) * radius) * 10) / 10,
      ];
    });
    out.push(ring);
  }
  return out;
};

/**
 * 文保院落：位置与半宽以 heritage-footprints.json 为准（按路网避让求解）。
 * 直接用 OSM 质心会出现"宅第造在马路上"；求解后院落已搬进街区内部，
 * 这里必须按同一份数据剔除民居，否则院墙又会压在别人房子上。
 */
const heritageFootprints = JSON.parse(
  await readFile(new URL('../src/data/heritage-footprints.json', import.meta.url), 'utf8'),
).sites;
const heritageRings = [];
for (const fp of Object.values(heritageFootprints)) {
  if (fp.hidden || !(fp.r > 0)) continue;
  const radius = fp.r + 1.5;
  const sides = 12;
  const ring = Array.from({ length: sides }, (_, i) => {
    const a = (i / sides) * Math.PI * 2;
    return [
      Math.round((fp.x + Math.cos(a) * radius) * 10) / 10,
      Math.round((fp.z + Math.sin(a) * radius) * 10) / 10,
    ];
  });
  heritageRings.push(ring);
}
const extraRings = await parseRingFromTs('extraLandmarks.ts', (block) => {
  // 补建地标用 spec.padRadius；无 spec 的默认 14（与 sceneGeometry.ts 一致）
  const pr = Number(block.match(/\bpadRadius:\s*(-?[\d.]+)/)?.[1]);
  return Number.isFinite(pr) && pr > 0 ? pr : 14;
});
landmarkRings.push(...heritageRings, ...extraRings);
console.log(`[剔除] 运行期地标占地环：文保 ${heritageRings.length} + 补建 ${extraRings.length}`);

/** 路网与山体：建筑不得压在车行道上，也不得长在山体里 */
const roadsData = JSON.parse(
  await readFile(new URL('../public/data/roads.json', import.meta.url), 'utf8'),
);
const HILLS = JSON.parse(await readFile(new URL('../src/data/hills.json', import.meta.url), 'utf8'));

const hillCircles = HILLS.map((hill) => ({
  x: (hill.lon - ORIGIN.lon) * M_PER_DEG_LON,
  z: -(hill.lat - ORIGIN.lat) * M_PER_DEG_LAT,
  r: hill.radius * 0.96,
}));
const inHill = (x, z) => hillCircles.some((h) => Math.hypot(x - h.x, z - h.z) < h.r);

/** 车行道走廊半宽：与 Roads.tsx 的 MAJOR_WIDTH / MINOR_WIDTH 对应 */
const ROAD_HALF = { major: 13, minor: 5.5 };

const ROAD_GRID = 60;
const roadGrid = new Map();
const roadKey = (cx, cz) => `${cx},${cz}`;
const roadSegments = [];
for (const kind of ['major', 'minor']) {
  for (const line of roadsData[kind]) {
    for (let i = 0; i < line.length - 1; i += 1) {
      const a = line[i];
      const b = line[i + 1];
      const seg = { a, b, half: ROAD_HALF[kind] };
      const id = roadSegments.length;
      roadSegments.push(seg);
      for (let cx = Math.floor(Math.min(a[0], b[0]) / ROAD_GRID); cx <= Math.floor(Math.max(a[0], b[0]) / ROAD_GRID); cx += 1) {
        for (let cz = Math.floor(Math.min(a[1], b[1]) / ROAD_GRID); cz <= Math.floor(Math.max(a[1], b[1]) / ROAD_GRID); cz += 1) {
          const k = roadKey(cx, cz);
          let arr = roadGrid.get(k);
          if (!arr) roadGrid.set(k, (arr = []));
          arr.push(id);
        }
      }
    }
  }
}

/** 该点被任一条车道"吃掉"的深度（米）；<=0 表示不在路面上 */
const roadIntrusion = (x, z, radius = 40) => {
  let worst = -Infinity;
  for (let cx = Math.floor((x - radius) / ROAD_GRID); cx <= Math.floor((x + radius) / ROAD_GRID); cx += 1) {
    for (let cz = Math.floor((z - radius) / ROAD_GRID); cz <= Math.floor((z + radius) / ROAD_GRID); cz += 1) {
      const arr = roadGrid.get(roadKey(cx, cz));
      if (!arr) continue;
      for (const id of arr) {
        const seg = roadSegments[id];
        const d = distToSeg(x, z, seg.a, seg.b);
        // 用真实路面半宽 + 0.3m 安全边距：建筑不得压到渲染路面（旧值 0.55
        // 只挡内圈，导致上千栋建筑边角伸进路面，视觉上就是「房子长在马路上」）。
        // 0.3m 边距消除浮点贴边导致的「侵入 0.0m」误报。
        const depth = seg.half + 0.3 - d;
        if (depth > worst) worst = depth;
      }
    }
  }
  return worst;
};

const distToSeg = (x, z, a, b) => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
};

/** 采样点到最近车行道中心线的距离 / 路面半宽 / 走向（无路时返回 null） */
const nearestRoad = (x, z, radius = 40) => {
  let best = null;
  for (let cx = Math.floor((x - radius) / ROAD_GRID); cx <= Math.floor((x + radius) / ROAD_GRID); cx += 1) {
    for (let cz = Math.floor((z - radius) / ROAD_GRID); cz <= Math.floor((z + radius) / ROAD_GRID); cz += 1) {
      const arr = roadGrid.get(roadKey(cx, cz));
      if (!arr) continue;
      for (const id of arr) {
        const seg = roadSegments[id];
        const d = distToSeg(x, z, seg.a, seg.b);
        if (!best || d < best.dist) {
          // three.js 实例 rot 的约定：局部 +x → 世界 (cos rot, -sin rot)
          best = { dist: d, half: seg.half, angle: Math.atan2(-(seg.b[1] - seg.a[1]), seg.b[0] - seg.a[0]) };
        }
      }
    }
  }
  return best;
};

/** 定向矩形是否压在车行道中间（采样点进入路面内圈一半即判为压路）
 *  OSM 的路中心线与建筑红线本来就有几米误差，只挡"明显把房子摆在路中间"的情况。
 */
const boxOnRoad = (box) => {
  const { x, z, w, d, rot } = box;
  const ca = Math.cos(rot);
  const sa = Math.sin(rot);
  const nx = Math.max(2, Math.min(6, Math.ceil(w / 4)));
  const nz = Math.max(2, Math.min(6, Math.ceil(d / 4)));
  for (let iu = 0; iu <= nx; iu += 1) {
    for (let iv = 0; iv <= nz; iv += 1) {
      // 取 1.04 倍：留出体块边缘余量，避免"大盒子端部 1m 压到路面上"的漏检
      const lx = (iu / nx - 0.5) * w * 1.04;
      const lz = (iv / nz - 0.5) * d * 1.04;
      const px = x + lx * ca + lz * sa;
      const pz = z - lx * sa + lz * ca;
      if (roadIntrusion(px, pz, 40) > 0) return true;
    }
  }
  return false;
};


/** 点是否落在景点范围内（buffer 为轮廓外缓冲距离） */
const inLandmark = (x, z, buffer = 0) =>
  landmarkRings.some((ring) => pointInRing(ring, x, z) || distToRing(ring, x, z) <= buffer);

/** 精细 GLB 的实际占地矩形（src/data/model-bounds.json，由模型包围盒换算） */
let modelBounds = {};
try {
  modelBounds = JSON.parse(
    await readFile(new URL('../src/data/model-bounds.json', import.meta.url), 'utf8'),
  );
} catch {
  // 尚未生成模型包围盒时退化为仅按轮廓剔除
}
const inModelBounds = (pts) =>
  Object.values(modelBounds).some(([x0, x1, z0, z1]) =>
    pts.some(([x, z]) => x >= x0 && x <= x1 && z >= z0 && z <= z1),
  );

/** 定向包围盒是否触碰景点范围（9 点采样，含 4m 缓冲，兜住屋顶/底座出挑） */
const boxHitsLandmark = (box) => {
  const { x, z, w, d, rot } = box;
  const ca = Math.cos(rot);
  const sa = Math.sin(rot);
  const samples = [
    [0, 0],
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [-w / 2, d / 2],
    [w / 2, d / 2],
    [0, -d / 2],
    [0, d / 2],
    [-w / 2, 0],
    [w / 2, 0],
  ].map(([u, v]) => [x + u * ca + v * sa, z - u * sa + v * ca]);
  return inLandmark(x, z, 4) || inModelBounds(samples);
};

const wayById = new Map();
for (let r = 0; r < 3; r += 1) {
  for (let c = 0; c < 3; c += 1) {
    const text = await readFile(
      new URL(`../data/raw/buildings-${r}-${c}.json`, import.meta.url),
      'utf8',
    );
    for (const el of JSON.parse(text).elements ?? []) {
      if (el.type === 'way' && el.geometry?.length >= 4) wayById.set(el.id, el);
    }
  }
}
// 城外 2~3km 条带（scripts/fetch-outer-ring.mjs 产出，缺失时跳过）
for (const strip of ['n', 's', 'e', 'w']) {
  try {
    const text = await readFile(
      new URL(`../data/raw/buildings-ring-${strip}.json`, import.meta.url),
      'utf8',
    );
    for (const el of JSON.parse(text).elements ?? []) {
      if (el.type === 'way' && el.geometry?.length >= 4) wayById.set(el.id, el);
    }
  } catch {
    // 条带数据未抓取时忽略
  }
}
console.log(`[原始] ${wayById.size} 个建筑轮廓`);

/* ---------------- 处理 ---------------- */

const pitched = [];
const flat = [];
const outer = [];
let skippedOutside = 0;
let skippedSmall = 0;
let skippedLandmark = 0;
let skippedSample = 0;
let skippedWater = 0;

/**
 * 街道样板段走廊（与 scripts/blender/pingjiang.py、guanqianjie.py 建的模样板范围一致）：
 * 走廊内的背景建筑会被剔除，避免与精细模型互相穿插。
 */
const SAMPLE_CORRIDORS = [
  {
    radius: 30,
    path: [
      [849.3, -402.5],
      [870.4, -319.5],
      [881.5, -263.8],
      [889.2, -221.5],
    ],
  },
  {
    radius: 34,
    path: [
      [23.9, -260.6],
      [50.3, -265.5],
      [112.6, -275.2],
      [202.0, -286.3],
    ],
  },
  {
    radius: 28,
    path: [
      [-1102.2, -1197.9],
      [-1168.4, -1189.9],
      [-1184.2, -1190.7],
      [-1195.7, -1181.6],
      [-1315.5, -1148.2],
    ],
  },
  {
    // 山塘街样板段（自阊门外 40m 起 200m，避开环城河；与 shantangjie.py 一致）
    radius: 32,
    path: [
      [-2073.9, -846.3],
      [-2124.9, -907.9],
      [-2181.0, -965.0],
      [-2208.8, -993.7],
    ],
  },
];

/** 点到折线的最短距离（米） */
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

// 确定性扰动
const jitter = (seed) => {
  const v = Math.sin(seed * 12.9898) * 43758.5453;
  return v - Math.floor(v);
};

/* ---------------- 水域避让 ----------------
 * 城内河道宽 30m、护城河向外 120m：建筑（含城外真实轮廓）不得落在水面上。
 * 用建筑定向矩形的 9 点采样判断，给水面留 1.5m 岸线缓冲。
 */
const WATER_CANAL_HALF = 15;
/** 护城河：内岸从轮廓外扩 4.6m 起算，水面宽 120m，外岸在 124.6m 处 */
const WATER_MOAT_INNER = 4.6;
const WATER_MOAT_WIDTH = 120;
const WATER_MOAT_FAR = WATER_MOAT_INNER + WATER_MOAT_WIDTH;
const WATER_MARGIN = 1.5;
const cityRingClosed = [...cityRing, cityRing[0]];

const boxHitsWater = (box) => {
  const { x, z, w, d, rot } = box;
  const ca = Math.cos(rot);
  const sa = Math.sin(rot);
  const halfDiag = Math.hypot(w, d) / 2;

  // 粗筛：离水面足够远就不必逐点采样（超长条建筑除外，见下面的细分采样）
  const nearCanal = (sceneGeo.waterways ?? []).some(
    (line) => distToPolyline(x, z, line) < WATER_CANAL_HALF + WATER_MARGIN + halfDiag,
  );
  // 城外水道：山塘河 8m 宽（与精细模型内河一致），上塘河等仍按 26m 宽
  const outerLines = sceneGeo.outerWaterways ?? [];
  const outerHalf = (i) => (i === 0 ? 4 : 13);
  const nearOuter = outerLines.some(
    (line, i) => distToPolyline(x, z, line) < outerHalf(i) + WATER_MARGIN + halfDiag,
  );
  const outside = !pointInRing(cityRing, x, z);
  const nearMoat =
    outside && distToPolyline(x, z, cityRingClosed) < WATER_MOAT_FAR + halfDiag;
  if (!nearCanal && !nearOuter && !nearMoat) return false;

  // 沿长边细分采样，避免长条建筑跨过河道却漏检
  const nx = Math.max(2, Math.min(24, Math.ceil(w / 8)));
  const nz = Math.max(2, Math.min(6, Math.ceil(d / 8)));
  for (let iu = 0; iu <= nx; iu += 1) {
    const lx = (iu / nx - 0.5) * w;
    for (let iv = 0; iv <= nz; iv += 1) {
      const lz = (iv / nz - 0.5) * d;
      const wx = x + lx * ca + lz * sa;
      const wz = z - lx * sa + lz * ca;
      if (nearCanal) {
        for (const line of sceneGeo.waterways ?? []) {
          if (distToPolyline(wx, wz, line) < WATER_CANAL_HALF + WATER_MARGIN) return true;
        }
      }
      if (nearOuter) {
        for (let i = 0; i < outerLines.length; i += 1) {
          if (distToPolyline(wx, wz, outerLines[i]) < outerHalf(i) + WATER_MARGIN) return true;
        }
      }
      if (
        nearMoat &&
        !pointInRing(cityRing, wx, wz) &&
        distToPolyline(wx, wz, cityRingClosed) < WATER_MOAT_FAR + WATER_MARGIN
      ) {
        return true;
      }
    }
  }
  return false;
};

/* 艺术化比例参数：城内以 1~4 层为主，最高 6 层（20m）；城外白模封顶 */
const ART_CITY_SCALE = 1.15;
const ART_CITY_MAX_H = 20;
const ART_OUTER_MAX_H = 20;

/**
 * 轮廓 → 一个或多个体块。
 * OSM 里的院落、厂区、长条形沿街建筑常是凹多边形，直接取最小外接矩形会把
 * 一整片街区压成一个 400m 长的大板，横穿好几条马路。这里对"外接矩形明显大于
 * 自身轮廓"的footprint 做切块：外接矩形按 ≤26m 分格，只保留落在轮廓内的格子，
 * L 形、回字形院落就还原成几段小体量，既不会压路，也不再是航母大板。
 */
const MAX_BOX_SIDE = 42;
const SPLIT_CELL = 26;

function splitBox(box, ring) {
  const { w, d } = box;
  const footprint = Math.max(area(ring), 1);
  const fit = (w * d) / footprint;
  if (w <= MAX_BOX_SIDE && d <= MAX_BOX_SIDE && fit <= 1.4) return [box];
  const ring2d = ring.map((p) => [p.x, p.z]);

  const nx = Math.max(1, Math.min(18, Math.ceil(w / SPLIT_CELL)));
  const nz = Math.max(1, Math.min(18, Math.ceil(d / SPLIT_CELL)));
  const cw = w / nx;
  const cd = d / nz;
  const ca = Math.cos(box.rot);
  const sa = Math.sin(box.rot);
  const out = [];

  for (let ix = 0; ix < nx; ix += 1) {
    for (let iz = 0; iz < nz; iz += 1) {
      const lx = -w / 2 + cw * (ix + 0.5);
      const lz = -d / 2 + cd * (iz + 0.5);
      const wx = box.x + lx * ca + lz * sa;
      const wz = box.z - lx * sa + lz * ca;

      let inside = pointInRing(ring2d, wx, wz) ? 1 : 0;
      for (const [sx, sz] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const px = wx + ((sx * cw) / 2) * ca + ((sz * cd) / 2) * sa;
        const pz = wz - ((sx * cw) / 2) * sa + ((sz * cd) / 2) * ca;
        if (pointInRing(ring2d, px, pz)) inside += 1;
      }
      if (inside >= 2) out.push({ x: wx, z: wz, w: cw, d: cd, rot: box.rot });
    }
  }
  if (out.length > 0) return out;

  // 退化轮廓（自交、含内院、点序错乱）时 pointInRing 判不出内部：
  // 退而按"沿墙"生成一圈薄体量，至少还原出这栋楼的走向，而不是压成一块大板。
  const th = Math.min(14, Math.max(7, Math.sqrt(Math.max(area(ring), 1)) / 6));
  const bars = [];
  for (let i = 0; i < ring.length - 1 && bars.length < 12; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 6) continue;
    bars.push({
      x: (a.x + b.x) / 2,
      z: (a.z + b.z) / 2,
      w: len + th * 0.5,
      d: th,
      rot: Math.atan2(-dz, dx),
    });
  }
  return bars.length > 0 ? bars : [box];
}

let skippedHill = 0;
let skippedRoad = 0;

for (const [id, way] of wayById) {
  const pts = way.geometry.map((p) => toLocal(p.lon, p.lat));
  if (Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) > 1) {
    pts.push(pts[0]); // 补闭合
  }
  const box = orientedBox(pts);
  if (!box) continue;
  if (box.w < 2.5 || box.d < 2.5 || box.w * box.d < 12) {
    skippedSmall += 1;
    continue;
  }
  // 景点范围（含 4m 缓冲）优先剔除，城内外的背景建筑都不允许压到精细 GLB
  if (boxHitsLandmark(box)) {
    skippedLandmark += 1;
    continue;
  }
  // 街道样板段走廊：剔除与精细 GLB 样板段穿模的背景建筑（城内外都剔除）
  if (SAMPLE_CORRIDORS.some((c) => distToPolyline(box.x, box.z, c.path) <= c.radius)) {
    skippedSample += 1;
    continue;
  }
  // 山体占地：建筑不上山
  if (inHill(box.x, box.z)) {
    skippedHill += 1;
    continue;
  }

  const boxes = splitBox(box, pts);
  const isOutside = !pointInRing(cityRing, box.x, box.z);
  const baseH = parseHeight(way.tags ?? {});

  for (const piece of boxes) {
    // 河道 / 护城河水面：建筑不得落水
    if (boxHitsWater(piece)) {
      skippedWater += 1;
      continue;
    }
    // 拆件后仍要剔除：原 box 中心可能在占地环外，但某块 split piece 落进文保/
    // 补建地标的轮廓里（小占地环如胥门 12m 尤其容易）。这里逐块再判一次。
    if (inLandmark(piece.x, piece.z, 4)) {
      skippedLandmark += 1;
      continue;
    }
    // 车行道：建筑不得压到路面上
    if (boxOnRoad(piece)) {
      skippedRoad += 1;
      continue;
    }
    if (inHill(piece.x, piece.z)) {
      skippedHill += 1;
      continue;
    }

    // 长边作为 x 轴，保证坡顶屋脊沿长向
    let { x, z, w, d, rot } = piece;
    if (d > w) {
      [w, d] = [d, w];
      rot += Math.PI / 2;
    }

    if (isOutside) {
      skippedOutside += 1;
      const hOuter = Math.min(ART_OUTER_MAX_H, Math.max(3, baseH));
      const roofHOuter = hOuter <= 12 ? Math.min(5, Math.max(2, 1.2 + hOuter * 0.18)) : 0;
      outer.push([
        Math.round(x * 10) / 10,
        Math.round(z * 10) / 10,
        Math.round(w * 10) / 10,
        Math.round(d * 10) / 10,
        Math.round(rot * 1000) / 1000,
        Math.round(hOuter * 10) / 10,
        Math.round(roofHOuter * 10) / 10,
      ]);
      continue;
    }

    // 城内建筑控制在 6 层以内：民居 1~2 层，其余 3~6 层
    const h =
      baseH <= 12
        ? Math.min(11.5, Math.max(7.0, baseH * 1.35 * (0.94 + jitter(id) * 0.12)))
        : Math.min(
            ART_CITY_MAX_H,
            Math.max(11.5, baseH * ART_CITY_SCALE * (0.94 + jitter(id) * 0.12)),
          );
    const isPitched = h <= 15.5;
    const roofH = isPitched ? Math.min(7, Math.max(2.4, 1.6 + h * 0.2)) : 0.8;

    const rec = [
      Math.round(x * 10) / 10,
      Math.round(z * 10) / 10,
      Math.round(w * 10) / 10,
      Math.round(d * 10) / 10,
      Math.round(rot * 1000) / 1000,
      Math.round(h * 10) / 10,
      Math.round(roofH * 10) / 10,
    ];
    if (isPitched) pitched.push(rec);
    else flat.push(rec);
  }
}

console.log(
  `[过滤] 城外 ${skippedOutside} · 过小 ${skippedSmall} · 景点内 ${skippedLandmark} · 样板段 ${skippedSample} · 水面 ${skippedWater} · 山体 ${skippedHill} · 压路 ${skippedRoad} · 城内 ${pitched.length + flat.length}（坡顶 ${pitched.length} / 平顶 ${flat.length}）· 城外白模 ${outer.length}`,
);

/* ---------------- 程序化补白 ----------------
 * OSM 在苏州古城的建筑轮廓只覆盖约 1/5，公开全球数据集（Microsoft / Google / Overture）均不含中国大陆，
 * 因此对 OSM 未测绘的街区按“邻近街道走向 + 传统民居尺度”生成背景民居，补齐城市肌理。
 */

const roads = JSON.parse(
  await readFile(new URL('../public/data/roads.json', import.meta.url), 'utf8'),
);

const CELL = 6;
const PAD = 80;
let gMinX = Infinity;
let gMaxX = -Infinity;
let gMinZ = Infinity;
let gMaxZ = -Infinity;
for (const [x, z] of cityRing) {
  if (x < gMinX) gMinX = x;
  if (x > gMaxX) gMaxX = x;
  if (z < gMinZ) gMinZ = z;
  if (z > gMaxZ) gMaxZ = z;
}
gMinX -= PAD;
gMinZ -= PAD;
gMaxX += PAD;
gMaxZ += PAD;

const GW = Math.ceil((gMaxX - gMinX) / CELL);
const GH = Math.ceil((gMaxZ - gMinZ) / CELL);
const blocked = new Uint8Array(GW * GH);

const markDisc = (x, z, rad) => {
  const c0 = Math.max(0, Math.floor((x - rad - gMinX) / CELL));
  const c1 = Math.min(GW - 1, Math.floor((x + rad - gMinX) / CELL));
  const r0 = Math.max(0, Math.floor((z - rad - gMinZ) / CELL));
  const r1 = Math.min(GH - 1, Math.floor((z + rad - gMinZ) / CELL));
  const rr = rad * rad;
  for (let r = r0; r <= r1; r += 1) {
    const dz = gMinZ + (r + 0.5) * CELL - z;
    for (let c = c0; c <= c1; c += 1) {
      const dx = gMinX + (c + 0.5) * CELL - x;
      if (dx * dx + dz * dz <= rr) blocked[r * GW + c] = 1;
    }
  }
};

const markLine = (pts, rad) => {
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [x1, z1] = pts[i];
    const [x2, z2] = pts[i + 1];
    const len = Math.hypot(x2 - x1, z2 - z1);
    const steps = Math.max(1, Math.ceil(len / (CELL * 0.6)));
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      markDisc(x1 + (x2 - x1) * t, z1 + (z2 - z1) * t, rad);
    }
  }
};

/** 定向矩形占位（rot 为 three.js rotY，局部 +x → 世界 (cos a, -sin a)） */
const markRect = (x, z, w, d, rot, pad) => {
  const hw = w / 2 + pad;
  const hd = d / 2 + pad;
  const ca = Math.cos(rot);
  const sa = Math.sin(rot);
  const rad = Math.hypot(hw, hd);
  const c0 = Math.max(0, Math.floor((x - rad - gMinX) / CELL));
  const c1 = Math.min(GW - 1, Math.floor((x + rad - gMinX) / CELL));
  const r0 = Math.max(0, Math.floor((z - rad - gMinZ) / CELL));
  const r1 = Math.min(GH - 1, Math.floor((z + rad - gMinZ) / CELL));
  for (let r = r0; r <= r1; r += 1) {
    const wz = gMinZ + (r + 0.5) * CELL - z;
    for (let c = c0; c <= c1; c += 1) {
      const wx = gMinX + (c + 0.5) * CELL - x;
      const u = wx * ca - wz * sa;
      const v = wx * sa + wz * ca;
      if (Math.abs(u) <= hw && Math.abs(v) <= hd) blocked[r * GW + c] = 1;
    }
  }
};

const isFree = (x, z) => {
  const c = Math.floor((x - gMinX) / CELL);
  const r = Math.floor((z - gMinZ) / CELL);
  if (c < 0 || c >= GW || r < 0 || r >= GH) return false;
  return blocked[r * GW + c] === 0;
};

// 占位：已测绘建筑
for (const rec of [...pitched, ...flat]) markRect(rec[0], rec[1], rec[2], rec[3], rec[4], 2);
// 占位：道路
for (const line of roads.major) markLine(line, 13 + 1.5);
for (const line of roads.minor) markLine(line, 5.5 + 1.5);
// 占位：城内河道
for (const line of sceneGeo.waterways ?? []) markLine(line, 17);
// 占位：护城河（沿古城轮廓内退）
markLine(cityRing, 70);
// 占位：景点范围
for (const ring of landmarkRings) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const c0 = Math.max(0, Math.floor((minX - gMinX) / CELL));
  const c1 = Math.min(GW - 1, Math.floor((maxX - gMinX) / CELL));
  const r0 = Math.max(0, Math.floor((minZ - gMinZ) / CELL));
  const r1 = Math.min(GH - 1, Math.floor((maxZ - gMinZ) / CELL));
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      if (pointInRing(ring, gMinX + (c + 0.5) * CELL, gMinZ + (r + 0.5) * CELL)) {
        blocked[r * GW + c] = 1;
      }
    }
  }
  // 轮廓外 10m 缓冲：避免补白民居压到景点模型的底座/院墙
  markLine([...ring, ring[0]], 10);
}
// 占位：街道样板段走廊（让位给 pingjiang / guanqianjie 精细 GLB，补白也不再生成）
for (const corridor of SAMPLE_CORRIDORS) markLine(corridor.path, corridor.radius);
// 占位：精细模型实际占地矩形（由 GLB 包围盒换算，兜住底板/院墙/树木）
for (const [x0, x1, z0, z1] of Object.values(modelBounds)) {
  markRect((x0 + x1) / 2, (z0 + z1) / 2, x1 - x0, z1 - z0, 0, 3);
}

// 主朝向：以已测绘建筑 rot 的圆均值确定街区格网方向
let sumSin = 0;
let sumCos = 0;
for (const rec of [...pitched, ...flat]) {
  sumSin += Math.sin(2 * rec[4]);
  sumCos += Math.cos(2 * rec[4]);
}
const streetAngle = 0.5 * Math.atan2(sumSin, sumCos);

const rnd = (seed) => {
  const v = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return v - Math.floor(v);
};

const U = 22;
const V = 16;
const ux = Math.cos(streetAngle);
const uz = -Math.sin(streetAngle);
const vx = Math.sin(streetAngle);
const vz = Math.cos(streetAngle);

const iSpan = Math.ceil((gMaxX - gMinX + gMaxZ - gMinZ) / U) + 4;
const jSpan = Math.ceil((gMaxX - gMinX + gMaxZ - gMinZ) / V) + 4;

let infill = 0;
const INFILL_CAP = 16000;

for (let i = -iSpan; i <= iSpan && infill < INFILL_CAP; i += 1) {
  for (let j = -jSpan; j <= jSpan && infill < INFILL_CAP; j += 1) {
    const seed = i * 131 + j * 977 + 17;
    const r1 = rnd(seed);
    const r2 = rnd(seed + 3);
    const r3 = rnd(seed + 11);

    // 格位内轻微抖动，避免过于机械
    const px = i * U * ux + j * V * vx + (r1 - 0.5) * 3;
    const pz = i * U * uz + j * V * vz + (r2 - 0.5) * 3;

    if (px < gMinX || px > gMaxX || pz < gMinZ || pz > gMaxZ) continue;
    if (!pointInRing(cityRing, px, pz)) continue;
    if (inHill(px, pz)) continue;

    const w = 12 + r3 * 6;
    const d = 8 + r2 * 4;
    // 朝向：贴着最近的街巷走，而不是全城套一个格网角，
    // 否则会出现"房子斜着切过马路"的怪相
    const near = nearestRoad(px, pz, 80);
    const rot = (near ? near.angle : streetAngle) + (r1 - 0.5) * 0.05;

    // 四角 + 四边中点 + 中心必须全部空闲（6m 格网下避免跨进景点缓冲）
    const ca = Math.cos(rot);
    const sa = Math.sin(rot);
    let ok = true;
    for (const [lx, lz] of [
      [-w / 2, -d / 2],
      [w / 2, -d / 2],
      [-w / 2, d / 2],
      [w / 2, d / 2],
      [0, -d / 2],
      [0, d / 2],
      [-w / 2, 0],
      [w / 2, 0],
      [0, 0],
    ]) {
      const wx = px + lx * ca + lz * sa;
      const wz = pz - lx * sa + lz * ca;
      if (!isFree(wx, wz)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    // 格网只有 17m 河道缓冲，贴水边的民居仍可能探进水面，再校验一次实际矩形
    if (boxHitsWater({ x: px, z: pz, w, d, rot })) continue;
    // 格网是 6m 粗略占位，最终再按真实矩形核一次路面
    if (boxOnRoad({ x: px, z: pz, w, d, rot })) continue;

    const h = 8.2 + r1 * 3.6;
    const roofH = Math.min(6.4, Math.max(2.4, 1.4 + h * 0.22));
    pitched.push([
      Math.round(px * 10) / 10,
      Math.round(pz * 10) / 10,
      Math.round(w * 10) / 10,
      Math.round(d * 10) / 10,
      Math.round(rot * 1000) / 1000,
      Math.round(h * 10) / 10,
      Math.round(roofH * 10) / 10,
    ]);
    markRect(px, pz, w, d, rot, 3);
    infill += 1;
  }
}

console.log(`[补白] 生成 ${infill} 栋背景民居（格网朝向 ${((streetAngle * 180) / Math.PI).toFixed(1)}°）`);

const out = {
  meta: {
    source: 'OpenStreetMap building footprints (ODbL) + procedural infill',
    origin: ORIGIN,
    unit: 'meter',
    fields: ['x', 'z', 'w', 'd', 'rot', 'h', 'roofH'],
  },
  pitched,
  flat,
  outer,
};

await mkdir(new URL('../public/data/', import.meta.url), { recursive: true });
const outFile = new URL('../public/data/buildings.json', import.meta.url);
await writeFile(outFile, JSON.stringify(out));
console.log(`[输出] ${outFile.pathname}`);
