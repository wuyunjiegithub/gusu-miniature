import type { LocalPoint2 } from '../types';
import { ROAD_HALF, type RoadLines } from './trimOutline';

/**
 * 路网净距查询。
 *
 * `trimOutlineFromRoads` 只能把"画出来的轮廓"从马路上削回来；精细 GLB 模型
 * 是按真实尺寸建的，它自己的外墙/院墙边界由建模脚本决定，与 OSM 轮廓无关。
 * 于是出现"画的区域退了，模型外墙仍在马路上"的情况（拙政园最典型）。
 *
 * 这里给出一个可在任意点查询"距最近路缘还有多少米"的函数：
 * 正值 = 在路缘外（安全），0 = 正好压路缘，负值 = 压进路面。
 * 调用方据此把模型等比缩到能放下为止，而不是继续改 OSM 轮廓。
 */
export interface RoadClearance {
  /** 距最近路缘的净距（米）；负值表示压路深度 */
  (x: number, z: number): number;
}

interface Seg {
  a: LocalPoint2;
  b: LocalPoint2;
  half: number;
}

const CELL = 80;
/** 查询半径：超出这个距离的段不可能更近，用于剪枝 */
const REACH = 160;

const distToSeg = (x: number, z: number, a: LocalPoint2, b: LocalPoint2): number => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
};

export function createRoadClearance(roads: RoadLines): RoadClearance {
  const segs: Seg[] = [];
  const grid = new Map<string, number[]>();
  const key = (cx: number, cz: number) => `${cx},${cz}`;

  for (const kind of ['major', 'minor'] as const) {
    for (const line of roads[kind]) {
      for (let i = 0; i < line.length - 1; i += 1) {
        const seg: Seg = { a: line[i], b: line[i + 1], half: ROAD_HALF[kind] };
        const id = segs.length;
        segs.push(seg);
        const pad = seg.half + 4;
        const x0 = Math.floor((Math.min(seg.a[0], seg.b[0]) - pad) / CELL);
        const x1 = Math.floor((Math.max(seg.a[0], seg.b[0]) + pad) / CELL);
        const z0 = Math.floor((Math.min(seg.a[1], seg.b[1]) - pad) / CELL);
        const z1 = Math.floor((Math.max(seg.a[1], seg.b[1]) + pad) / CELL);
        for (let cx = x0; cx <= x1; cx += 1) {
          for (let cz = z0; cz <= z1; cz += 1) {
            const k = key(cx, cz);
            const arr = grid.get(k);
            if (arr) arr.push(id);
            else grid.set(k, [id]);
          }
        }
      }
    }
  }

  return (x: number, z: number): number => {
    let best = Infinity;
    const r = Math.ceil(REACH / CELL);
    const cx0 = Math.floor(x / CELL);
    const cz0 = Math.floor(z / CELL);
    for (let cx = cx0 - r; cx <= cx0 + r; cx += 1) {
      for (let cz = cz0 - r; cz <= cz0 + r; cz += 1) {
        const ids = grid.get(key(cx, cz));
        if (!ids) continue;
        for (const id of ids) {
          const s = segs[id];
          const d = distToSeg(x, z, s.a, s.b) - s.half;
          if (d < best) best = d;
        }
      }
    }
    return best === Infinity ? REACH : best;
  };
}

/** 同一份路网只建一次索引（16 个精细模型共用） */
const clearanceCache = new WeakMap<RoadLines, RoadClearance>();

export function getRoadClearance(roads: RoadLines): RoadClearance {
  const hit = clearanceCache.get(roads);
  if (hit) return hit;
  const fn = createRoadClearance(roads);
  clearanceCache.set(roads, fn);
  return fn;
}

export interface SilhouettePoint {
  /** 单位方向（xz 平面） */
  dir: LocalPoint2;
  /** 该方向上离模型原点最远的水平半径 */
  radius: number;
}

/**
 * 把模型水平投影点的极坐标包络压成若干方向上的"最大半径"。
 * 只需要每个方向最外侧的点——缩小模型时，先撞上马路的必然是它们。
 *
 * 方向记为该点自身的真实角度（不是桶中心）：桶中心会让包络点绕中心偏转
 * 最多半桶，150m 半径上就是几米误差，判完仍会压进路面。
 */
export function silhouetteProfile(
  points: Iterable<LocalPoint2>,
  buckets = 72,
): SilhouettePoint[] {
  const radii = new Float32Array(buckets);
  const angles = new Float32Array(buckets);
  for (const [x, z] of points) {
    const r = Math.hypot(x, z);
    if (r < 1e-3) continue;
    let a = Math.atan2(z, x);
    if (a < 0) a += Math.PI * 2;
    const idx = Math.min(buckets - 1, Math.floor((a / (Math.PI * 2)) * buckets));
    if (r > radii[idx]) {
      radii[idx] = r;
      angles[idx] = a;
    }
  }
  const out: SilhouettePoint[] = [];
  for (let i = 0; i < buckets; i += 1) {
    if (radii[i] <= 0) continue;
    out.push({ dir: [Math.cos(angles[i]), Math.sin(angles[i])], radius: radii[i] });
  }
  return out;
}

export interface FitScaleOptions {
  /** 距离路缘的最小安全余量（米） */
  margin?: number;
  /** 缩放下限，避免为了避一条贴着园子的路把模型缩成一个点 */
  min?: number;
  /** 步长（缩放比例分辨率） */
  step?: number;
}

/**
 * 求模型可用的等比缩放系数：从 1 逐步往下试，直到包络上每个方向的最外点
 * 都退到路缘外 margin 米。只缩不放（最大 1）。
 */
export function fitScaleToRoads(
  profile: SilhouettePoint[],
  center: LocalPoint2,
  clearance: RoadClearance,
  options: FitScaleOptions = {},
): number {
  const margin = options.margin ?? 1;
  const min = options.min ?? 0.5;
  const step = options.step ?? 0.01;
  if (!profile.length) return 1;

  const probe = (scale: number): boolean => {
    for (const p of profile) {
      const x = center[0] + p.dir[0] * p.radius * scale;
      const z = center[1] + p.dir[1] * p.radius * scale;
      if (clearance(x, z) < margin) return false;
    }
    return true;
  };

  for (let s = 1; s > min; s -= step) {
    const scale = Math.max(min, Number(s.toFixed(4)));
    if (probe(scale)) return scale;
  }
  return min;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  center: LocalPoint2;
}

export function boundsOf(points: Iterable<LocalPoint2>): Bounds | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let any = false;
  for (const [x, z] of points) {
    any = true;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!any) return null;
  return { minX, maxX, minZ, maxZ, center: [(minX + maxX) / 2, (minZ + maxZ) / 2] };
}

export interface Placement {
  /** 等比缩放系数 */
  scale: number;
  /** 相对景点质心的平移（米） */
  offset: LocalPoint2;
}

export interface PlacementOptions extends FitScaleOptions {
  /** 平移上限（米），超过说明模型与石台形态差太多，不再强行居中 */
  maxShift?: number;
}

/**
 * 模型落位：等比缩放 + 平移。
 *
 * 模型通常就是照 OSM 轮廓建的，二者尺寸相当；压路的原因是整块模型相对
 * 石台偏心（模型几何中心 ≠ 多边形面积质心，拙政园偏了 30~50m），而不是
 * 模型真的比景点大。这时只缩小会让园子缩水又偏在一角。
 *
 * 所以先按"模型包围盒中心对齐石台包围盒中心"求平移，再在该位置上求
 * 不压路的最大缩放：能只平移就只平移，放不下才缩。
 */
export function fitLandmarkPlacement(
  points: LocalPoint2[],
  padCenter: LocalPoint2,
  anchor: LocalPoint2,
  clearance: RoadClearance,
  options: PlacementOptions = {},
): Placement {
  const margin = options.margin ?? 1;
  const min = options.min ?? 0.5;
  const step = options.step ?? 0.01;
  const maxShift = options.maxShift ?? 80;
  const box = boundsOf(points);
  if (!box) return { scale: 1, offset: [0, 0] };

  // 判定只用每个方向的最外点：模型缩小时先撞上马路的必然是它们，
  // 逐个顶点枚举会把这一步变成百万次查询。
  const envelope = silhouetteProfile(points).map<LocalPoint2>((p) => [
    p.dir[0] * p.radius,
    p.dir[1] * p.radius,
  ]);
  const clampShift = (v: number) => Math.max(-maxShift, Math.min(maxShift, v));

  const probe = (scale: number, ox: number, oz: number): boolean => {
    for (const [x, z] of envelope) {
      if (clearance(anchor[0] + ox + x * scale, anchor[1] + oz + z * scale) < margin) return false;
    }
    return true;
  };

  // 让模型包围盒中心落到石台包围盒中心（两者都在世界坐标，先化成相对质心的位移）
  const targetX = padCenter[0] - anchor[0];
  const targetZ = padCenter[1] - anchor[1];
  const shiftAt = (scale: number): LocalPoint2 => [
    clampShift(targetX - box.center[0] * scale),
    clampShift(targetZ - box.center[1] * scale),
  ];

  for (let s = 1; s > min; s -= step) {
    const scale = Math.max(min, Number(s.toFixed(4)));
    const [ox, oz] = shiftAt(scale);
    if (probe(scale, ox, oz)) return { scale, offset: [ox, oz] };
  }

  const scale = min;
  return { scale, offset: shiftAt(scale) };
}
