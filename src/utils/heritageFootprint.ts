import type { LocalPoint2 } from '../types';
import { ROAD_HALF, type RoadLines } from './trimOutline';

/**
 * 文保占地求解。
 *
 * 文保落点来自 OSM 的 POI 质心，与路网是两套数据；直接按 spec 半径画一个
 * 圆形院落，就会出现"宅第造在马路上""宅院整个盖住拙政园"这类问题
 * （见用户截图：潘世恩宅、观前街）。
 *
 * 这里不靠手改坐标，而是按几何求解一个"能放下并且不压路"的院落：
 *   1. 质心落在已有精细 GLB 景点范围内（如张士诚碑在拙政园园内）→ 不再重复建模；
 *   2. 在质心周围小范围搜索，取"可用半径最大且偏移最小"的位置；
 *   3. 可用半径 = 到最近路缘的净距 - 缓冲；
 *   4. 相邻文保院落互相重叠时按公共边界等分收缩。
 *
 * 纯函数，可单测；调用方传入 roads（运行时加载）与 blocked（精细模型包围盒）。
 */

export interface FootprintSite {
  id: string;
  center: LocalPoint2;
  /** 期望半宽（米） */
  radius: number;
}

export interface Footprint {
  center: LocalPoint2;
  radius: number;
  /** 已被更精细的模型表现，本层不再建模 */
  hidden: boolean;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const CELL = 60;

const distToSeg = (x: number, z: number, a: LocalPoint2, b: LocalPoint2): number => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
};

interface Seg {
  a: LocalPoint2;
  b: LocalPoint2;
  half: number;
}

/** 路网转成带网格索引的线段表（一次构建，多次查询） */
export function buildRoadIndex(roads: RoadLines): {
  clearance: (x: number, z: number) => number;
} {
  const segs: Seg[] = [];
  const grid = new Map<string, number[]>();
  for (const kind of ['major', 'minor'] as const) {
    const half = ROAD_HALF[kind];
    for (const line of roads[kind]) {
      for (let i = 0; i < line.length - 1; i += 1) {
        const seg: Seg = { a: line[i], b: line[i + 1], half };
        const id = segs.length;
        segs.push(seg);
        const pad = half + 40;
        const x0 = Math.floor((Math.min(seg.a[0], seg.b[0]) - pad) / CELL);
        const x1 = Math.floor((Math.max(seg.a[0], seg.b[0]) + pad) / CELL);
        const z0 = Math.floor((Math.min(seg.a[1], seg.b[1]) - pad) / CELL);
        const z1 = Math.floor((Math.max(seg.a[1], seg.b[1]) + pad) / CELL);
        for (let cx = x0; cx <= x1; cx += 1) {
          for (let cz = z0; cz <= z1; cz += 1) {
            const k = `${cx},${cz}`;
            const arr = grid.get(k) ?? [];
            arr.push(id);
            grid.set(k, arr);
          }
        }
      }
    }
  }

  if (!segs.length) return { clearance: () => Number.POSITIVE_INFINITY };

  /** 到最近路缘的净距（米）。>0 表示这个点不在任何路面上 */
  const clearance = (x: number, z: number): number => {
    let best = Number.POSITIVE_INFINITY;
    for (let cx = Math.floor((x - 60) / CELL); cx <= Math.floor((x + 60) / CELL); cx += 1) {
      for (let cz = Math.floor((z - 60) / CELL); cz <= Math.floor((z + 60) / CELL); cz += 1) {
        for (const id of grid.get(`${cx},${cz}`) ?? []) {
          const s = segs[id];
          const d = distToSeg(x, z, s.a, s.b) - s.half;
          if (d < best) best = d;
          if (best <= 0) return best;
        }
      }
    }
    return best;
  };

  return { clearance };
}

export interface ResolveOptions {
  /** 院落边界到路缘的缓冲（米） */
  buffer?: number;
  /** 允许的最大平移量（米） */
  maxShift?: number;
  /** 相邻院落之间的最小间隙（米） */
  gap?: number;
  /** 院落最小半宽（再小就不像一处宅第了） */
  minRadius?: number;
}

/**
 * 求解每处文保的院落中心与半径。
 * 返回 Map，键为 site.id；hidden 表示不建模。
 */
export function resolveFootprints(
  sites: FootprintSite[],
  roads: RoadLines | null,
  blocked: Record<string, Bounds> = {},
  options: ResolveOptions = {},
): Map<string, Footprint> {
  const buffer = options.buffer ?? 2;
  const maxShift = options.maxShift ?? 40;
  const gap = options.gap ?? 2;
  const minRadius = options.minRadius ?? 6;
  const index = roads ? buildRoadIndex(roads) : null;
  const out = new Map<string, Footprint>();

  const inBlocked = (x: number, z: number): string | null => {
    for (const [id, b] of Object.entries(blocked)) {
      if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) return id;
    }
    return null;
  };

  for (const site of sites) {
    const [cx, cz] = site.center;
    // 已有精细模型完整表现了这个院落：不再叠一层程序化建筑
    if (inBlocked(cx, cz)) {
      out.set(site.id, { center: [cx, cz], radius: 0, hidden: true });
      continue;
    }

    const fitAt = (x: number, z: number): number => {
      if (!index) return site.radius;
      return Math.min(site.radius, index.clearance(x, z) - buffer);
    };

    let best = { x: cx, z: cz, radius: fitAt(cx, cz), score: 0 };
    best.score = best.radius;

    // 原址放得下就不用挪；OSM 的 POI 质心常常落在街边（甚至路面上），
    // 这时把院落挪进街区内部，比在原地缩成一团更接近实际情况。
    if (best.radius < site.radius - 0.5) {
      const rings = [3, 6, 9, 12, 15, 18, 21, 25, maxShift].filter((d) => d <= maxShift);
      outer: for (const d of rings) {
        for (let k = 0; k < 36; k += 1) {
          const a = (k / 36) * Math.PI * 2;
          const x = cx + Math.cos(a) * d;
          const z = cz + Math.sin(a) * d;
          const fit = fitAt(x, z);
          // 半径优先，其次尽量少挪（挪 1m 折 0.35m 半径）
          const score = fit - d * 0.35;
          if (score > best.score) best = { x, z, radius: fit, score };
          if (best.radius >= site.radius - 0.5 && d <= 12) break outer;
        }
      }
    }

    out.set(site.id, {
      center: [best.x, best.z],
      radius: Math.max(4, Math.min(site.radius, best.radius)),
      hidden: false,
    });
  }

  // 相邻院落互相压住时，收到公共边
  const list = sites.filter((s) => !out.get(s.id)?.hidden);
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = out.get(list[i].id);
      const b = out.get(list[j].id);
      if (!a || !b) continue;
      const d = Math.hypot(b.center[0] - a.center[0], b.center[1] - a.center[1]);
      if (d >= a.radius + b.radius + gap) continue;
      const half = Math.max(4, (d - gap) / 2);
      a.radius = Math.min(a.radius, half);
      b.radius = Math.min(b.radius, half);
    }
  }

  return out;
}

/** 由 model-bounds.json 的 [minX,maxX,minZ,maxZ] 生成 blocked 记录 */
export function toBlocked(bounds: Record<string, number[]>): Record<string, Bounds> {
  const out: Record<string, Bounds> = {};
  for (const [id, b] of Object.entries(bounds)) {
    out[id] = { minX: b[0], maxX: b[1], minZ: b[2], maxZ: b[3] };
  }
  return out;
}
