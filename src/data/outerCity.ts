import { sceneGeometry } from './sceneGeometry';
import modelBounds from './model-bounds.json';
import { HILLS } from './hills';
import { inAnyPark } from './outerParks';
import { lonLatToVector3, pointInRing } from '../utils/geo';
import type { LocalPoint2 } from '../types';

/** 外围陆地基准面（与 Hills 基础高度一致） */
export const OUTER_GROUND_Y = -2;
export const OUTER_ROAD_WIDTH = 30;
export const OUTER_RING_INNER = 3000;
/** 外环止于寒山寺一带（寒山寺在 -5.45km，取 5.8km 留出余量），再远的城市肌理不做 */
export const OUTER_RING_OUTER = 5800;

/** 城外道路面高：贴在外围地面上方，留足深度缓冲余量避免远视距下与地面穿模 */
export const OUTER_ROAD_Y = OUTER_GROUND_Y + 0.32;
/** 高差过渡：护城河外侧起步，2km 内降到外围地面（沙盘台边缘约 2.95km） */
const ROAD_RAMP_START = 2950;
const ROAD_RAMP_END = 4950;

/**
 * 道路/轨道面高：城内沿用抬高的路面高度，出城后平滑降到外围地面高度。
 * 用线段中点求值，避免一段带面跨越两个高度层。
 */
export function roadSurfaceY(x: number, z: number, innerY: number): number {
  const r = Math.hypot(x, z);
  if (r <= ROAD_RAMP_START) return innerY;
  if (r >= ROAD_RAMP_END) return OUTER_ROAD_Y;
  const t = (r - ROAD_RAMP_START) / (ROAD_RAMP_END - ROAD_RAMP_START);
  const smooth = t * t * (3 - 2 * t);
  return innerY + (OUTER_ROAD_Y - innerY) * smooth;
}

const GRID_STEP = 110;
/**
 * 建筑上限给足，保证 3–5.8km 全环带都能铺满：
 * 上限若小于总候选数，网格从西南角开始扫，会在扫到一半时截断，
 * 造成东、北侧城外一片空白。
 */
const BLOCK_CAP = 26000;
const TOWER_CAP = 90;

/** 现代高层幕墙：冷灰蓝玻璃，与古城暖白粉墙拉开时代差 */
export const TOWER_COLORS = ['#9fb2c1', '#aebecb', '#8fa4b4', '#b7c4ce', '#93a7b7'];

const hash = (i: number): number => {
  const v = Math.sin(i * 78.233 + 11.7) * 43758.5453;
  return v - Math.floor(v);
};

export interface OuterBlock {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  roofH: number;
  rot: number;
}

export interface OuterTower {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  rot: number;
}

export interface OuterCity {
  blocks: OuterBlock[];
  towers: OuterTower[];
}

export interface RoadLines {
  major: LocalPoint2[][];
  minor: LocalPoint2[][];
}

/** 道路栅格索引边长（米）：把主干道按 20m 采样后落格，用于快速避让 */
const ROAD_CELL = 20;

/** 道路格键：整数编码，避免在十万级查询里反复拼字符串 */
const roadCellKey = (cx: number, cz: number): number => (cx + 1024) * 4096 + (cz + 1024);

function buildRoadCells(lines: LocalPoint2[][]): Set<number> {
  const cells = new Set<number>();
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i += 1) {
      const [x0, z0] = line[i];
      const [x1, z1] = line[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      const steps = Math.max(1, Math.ceil(len / ROAD_CELL));
      for (let s = 0; s <= steps; s += 1) {
        const t = s / steps;
        const x = x0 + (x1 - x0) * t;
        const z = z0 + (z1 - z0) * t;
        cells.add(roadCellKey(Math.round(x / ROAD_CELL), Math.round(z / ROAD_CELL)));
      }
    }
  }
  return cells;
}

function roadNear(cells: Set<number>, x: number, z: number, rings: number): boolean {
  const cx = Math.round(x / ROAD_CELL);
  const cz = Math.round(z / ROAD_CELL);
  for (let i = -rings; i <= rings; i += 1) {
    for (let j = -rings; j <= rings; j += 1) {
      if (cells.has(roadCellKey(cx + i, cz + j))) return true;
    }
  }
  return false;
}

function hillSpots(): { x: number; z: number; r: number }[] {
  return HILLS.map((hill) => {
    const v = lonLatToVector3(hill.lon, hill.lat, 0);
    return { x: v.x, z: v.z, r: hill.radius };
  });
}

/* ---------------- 路网避让：按真实矩形四角判定 ----------------
 * 早期只判中心点是否贴近道路格，宽 26m 的建筑转个角就能压到马路上。
 * 这里建一份线段索引，直接算"矩形四角 + 中心"到路中心线的距离。
 */
const HALF_MAJOR = 13;
const HALF_MINOR = 5.5;
const SEG_CELL = 80;

interface SegRef {
  a: LocalPoint2;
  b: LocalPoint2;
  half: number;
}

/** 网格键：cx/cz 都在 ±512 格内，用整数键代替模板字符串，省掉每次查询的字符串分配 */
const segKey = (cx: number, cz: number): number => (cx + 512) * 1024 + (cz + 512);

function buildSegIndex(roads: RoadLines): Map<number, SegRef[]> {
  const index = new Map<number, SegRef[]>();
  const add = (line: LocalPoint2[], half: number) => {
    for (let i = 0; i < line.length - 1; i += 1) {
      const a = line[i];
      const b = line[i + 1];
      const ref = { a, b, half };
      const minX = Math.floor(Math.min(a[0], b[0]) / SEG_CELL);
      const maxX = Math.floor(Math.max(a[0], b[0]) / SEG_CELL);
      const minZ = Math.floor(Math.min(a[1], b[1]) / SEG_CELL);
      const maxZ = Math.floor(Math.max(a[1], b[1]) / SEG_CELL);
      for (let cx = minX; cx <= maxX; cx += 1) {
        for (let cz = minZ; cz <= maxZ; cz += 1) {
          const key = segKey(cx, cz);
          const arr = index.get(key);
          if (arr) arr.push(ref);
          else index.set(key, [ref]);
        }
      }
    }
  };
  roads.major.forEach((line) => add(line, HALF_MAJOR));
  roads.minor.forEach((line) => add(line, HALF_MINOR));
  return index;
}

/**
 * 该点是否落在某条路面上（含 margin 退距）。
 * 只做平方距离比较、不开方，也不为每次比较新建对象——这个函数在城外
 * 一万多个地块 × 5 个角点的循环里被调用，任何一点分配都会拖慢首屏。
 */
function hitsRoad(index: Map<number, SegRef[]>, x: number, z: number, margin: number): boolean {
  const cx = Math.floor(x / SEG_CELL);
  const cz = Math.floor(z / SEG_CELL);
  for (let i = -1; i <= 1; i += 1) {
    for (let j = -1; j <= 1; j += 1) {
      const arr = index.get(segKey(cx + i, cz + j));
      if (!arr) continue;
      for (let k = 0; k < arr.length; k += 1) {
        const seg = arr[k];
        const ax = seg.a[0];
        const az = seg.a[1];
        const dx = seg.b[0] - ax;
        const dz = seg.b[1] - az;
        const len2 = dx * dx + dz * dz;
        let t = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + t * dx;
        const pz = az + t * dz;
        const lim = seg.half + margin;
        if ((x - px) * (x - px) + (z - pz) * (z - pz) < lim * lim) return true;
      }
    }
  }
  return false;
}

/** 矩形（含朝向）是否压到车道：四角 + 中心都要退到路面边线外 1m */
function boxHitsRoad(
  index: Map<number, SegRef[]>,
  x: number,
  z: number,
  w: number,
  d: number,
  rot: number,
): boolean {
  const ca = Math.cos(rot);
  const sa = Math.sin(rot);
  const hw = w / 2;
  const hd = d / 2;
  if (hitsRoad(index, x, z, 1)) return true;
  if (hitsRoad(index, x + hw * ca + hd * sa, z - hw * sa + hd * ca, 1)) return true;
  if (hitsRoad(index, x - hw * ca + hd * sa, z + hw * sa + hd * ca, 1)) return true;
  if (hitsRoad(index, x + hw * ca - hd * sa, z - hw * sa - hd * ca, 1)) return true;
  if (hitsRoad(index, x - hw * ca - hd * sa, z + hw * sa - hd * ca, 1)) return true;
  return false;
}

const cache = new WeakMap<RoadLines, OuterCity>();

/**
 * 城外 3–5.8km 的城市蔓延：真实 OSM 路网之外的空地铺满带坡顶的民居，
 * 主干道旁点缀少量高层。建筑自动避开真实道路、山体与精细模型，
 * 夜里再由 NightLights 沿同一份路网布灯。
 */
export function buildOuterCity(roads: RoadLines): OuterCity {
  const hit = cache.get(roads);
  if (hit) return hit;

  const hills = hillSpots();
  const modelRects = Object.values(modelBounds) as [number, number, number, number][];
  const majorCells = buildRoadCells(roads.major);
  const segIndex = buildSegIndex(roads);

  const blocks: OuterBlock[] = [];
  let seed = 1;
  for (let gx = -OUTER_RING_OUTER; gx <= OUTER_RING_OUTER && blocks.length < BLOCK_CAP; gx += GRID_STEP) {
    for (let gz = -OUTER_RING_OUTER; gz <= OUTER_RING_OUTER && blocks.length < BLOCK_CAP; gz += GRID_STEP) {
      const radius = Math.hypot(gx, gz);
      if (radius < OUTER_RING_INNER || radius > OUTER_RING_OUTER) continue;
      seed += 1;
      if (hash(seed) > 0.96) continue;

      // 每个 110m 格位放 3~5 栋真实尺度的民居，把街坊填满
      const count = 3 + Math.floor(hash(seed + 21) * 3);
      for (let k = 0; k < count && blocks.length < BLOCK_CAP; k += 1) {
        const x = gx + (hash(seed + 31 + k * 7) - 0.5) * 74;
        const z = gz + (hash(seed + 47 + k * 11) - 0.5) * 74;
        if (pointInRing(sceneGeometry.cityOutline, x, z)) continue;
        if (hills.some((h) => Math.hypot(x - h.x, z - h.z) < h.r)) continue;
        // 公园范围里留空：草坪上不长房子
        if (inAnyPark(x, z, 30)) continue;
        if (modelRects.some(([x0, x1, z0, z1]) => x >= x0 - 40 && x <= x1 + 40 && z >= z0 - 40 && z <= z1 + 40)) {
          continue;
        }

        // 主干道两旁的街坊更高（8~22m），形成有起伏的城市天际线
        const nearMajor = roadNear(majorCells, x, z, 2);
        const h = nearMajor ? 9 + hash(seed + 13 + k) * 13 : 6.5 + hash(seed + 13 + k) * 8;
        const w = 12 + hash(seed + 7 + k) * 14;
        const d = 9 + hash(seed + 11 + k) * 9;
        const rot = (hash(seed + 17 + k) > 0.72 ? Math.PI / 2 : 0) + (hash(seed + 19 + k) - 0.5) * 0.12;
        // 真实矩形不得压到车道（含四角）
        if (boxHitsRoad(segIndex, x, z, w, d, rot)) continue;

        blocks.push({
          x,
          z,
          w,
          d,
          h,
          roofH: Math.min(5, Math.max(2, 1.4 + h * 0.2)),
          rot,
        });
      }
    }
  }

  /** 少量高层：贴着真实主干道布置，形成几处可辨认的城市节点 */
  const towers: OuterTower[] = [];
  let towerSeed = 7000;
  for (let gx = -OUTER_RING_OUTER; gx <= OUTER_RING_OUTER && towers.length < TOWER_CAP; gx += 260) {
    for (let gz = -OUTER_RING_OUTER; gz <= OUTER_RING_OUTER && towers.length < TOWER_CAP; gz += 260) {
      const radius = Math.hypot(gx, gz);
      if (radius < 3600 || radius > OUTER_RING_OUTER) continue;
      towerSeed += 1;
      if (hash(towerSeed) > 0.45) continue;
      const x = gx + (hash(towerSeed + 3) - 0.5) * 120;
      const z = gz + (hash(towerSeed + 5) - 0.5) * 120;
      if (!roadNear(majorCells, x, z, 3)) continue;
      if (hills.some((h) => Math.hypot(x - h.x, z - h.z) < h.r)) continue;
      if (inAnyPark(x, z, 30)) continue;
      if (modelRects.some(([x0, x1, z0, z1]) => x >= x0 - 40 && x <= x1 + 40 && z >= z0 - 40 && z <= z1 + 40)) {
        continue;
      }
      const w = 16 + hash(towerSeed + 7) * 10;
      const d = 16 + hash(towerSeed + 11) * 10;
      const rot = Math.atan2(z, x) + Math.PI / 2;
      if (boxHitsRoad(segIndex, x, z, w, d, rot)) continue;
      towers.push({
        x,
        z,
        w,
        d,
        h: 26 + hash(towerSeed + 13) * 26,
        rot,
      });
    }
  }

  const result: OuterCity = { blocks, towers };
  cache.set(roads, result);
  return result;
}
