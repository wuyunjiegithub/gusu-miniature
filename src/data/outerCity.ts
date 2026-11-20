import { sceneGeometry } from './sceneGeometry';
import modelBounds from './model-bounds.json';
import { HILLS } from './hills';
import { lonLatToVector3, pointInRing } from '../utils/geo';
import type { LocalPoint2 } from '../types';

/** 外围陆地基准面（与 Hills 基础高度一致） */
export const OUTER_GROUND_Y = -2;
export const OUTER_ROAD_WIDTH = 30;
export const OUTER_RING_INNER = 3000;
/** 外环止于寒山寺一带（寒山寺在 -5.45km，取 5.8km 留出余量），再远的城市肌理不做 */
export const OUTER_RING_OUTER = 5800;

/** 城外道路面高：贴在外围地面上方，避免整条路悬空 */
export const OUTER_ROAD_Y = OUTER_GROUND_Y + 0.08;
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

export const TOWER_COLORS = ['#b7b5ae', '#a8acb0', '#c3bfb5', '#9ea5ac', '#b0a89b'];

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

function buildRoadCells(lines: LocalPoint2[][]): Set<string> {
  const cells = new Set<string>();
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
        cells.add(`${Math.round(x / ROAD_CELL)},${Math.round(z / ROAD_CELL)}`);
      }
    }
  }
  return cells;
}

function roadNear(cells: Set<string>, x: number, z: number, rings: number): boolean {
  const cx = Math.round(x / ROAD_CELL);
  const cz = Math.round(z / ROAD_CELL);
  for (let i = -rings; i <= rings; i += 1) {
    for (let j = -rings; j <= rings; j += 1) {
      if (cells.has(`${cx + i},${cz + j}`)) return true;
    }
  }
  return false;
}

function hillSpots(): { x: number; z: number; r: number }[] {
  return HILLS.map((hill) => {
    const v = lonLatToVector3(hill.lon, hill.lat, 0);
    return { x: v.x, z: v.z, r: hill.radius * 0.9 };
  });
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
  const allCells = buildRoadCells([...roads.major, ...roads.minor]);

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
        // 避让真实街巷（含城外 residential）与主干道
        if (roadNear(allCells, x, z, 1)) continue;
        if (hills.some((h) => Math.hypot(x - h.x, z - h.z) < h.r)) continue;
        if (modelRects.some(([x0, x1, z0, z1]) => x >= x0 - 40 && x <= x1 + 40 && z >= z0 - 40 && z <= z1 + 40)) {
          continue;
        }

        // 主干道两旁的街坊更高（8~22m），形成有起伏的城市天际线
        const nearMajor = roadNear(majorCells, x, z, 2);
        const h = nearMajor ? 9 + hash(seed + 13 + k) * 13 : 6.5 + hash(seed + 13 + k) * 8;
        blocks.push({
          x,
          z,
          w: 12 + hash(seed + 7 + k) * 14,
          d: 9 + hash(seed + 11 + k) * 9,
          h,
          roofH: Math.min(5, Math.max(2, 1.4 + h * 0.2)),
          rot: (hash(seed + 17 + k) > 0.72 ? Math.PI / 2 : 0) + (hash(seed + 19 + k) - 0.5) * 0.12,
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
      if (roadNear(allCells, x, z, 1)) continue;
      if (hills.some((h) => Math.hypot(x - h.x, z - h.z) < h.r)) continue;
      if (modelRects.some(([x0, x1, z0, z1]) => x >= x0 - 40 && x <= x1 + 40 && z >= z0 - 40 && z <= z1 + 40)) {
        continue;
      }
      towers.push({
        x,
        z,
        w: 16 + hash(towerSeed + 7) * 10,
        d: 16 + hash(towerSeed + 11) * 10,
        h: 26 + hash(towerSeed + 13) * 26,
        rot: Math.atan2(z, x) + Math.PI / 2,
      });
    }
  }

  const result: OuterCity = { blocks, towers };
  cache.set(roads, result);
  return result;
}
