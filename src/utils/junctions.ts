import type { LocalPoint2 } from '../types';

export interface Junction {
  x: number;
  z: number;
  /** 各条道路在此处的走向（单位切向，已按 π 折叠去重） */
  dirs: Array<[number, number]>;
}

/** 角度折叠到 [0, π)，用来合并同一条路的上行/下行方向 */
function foldAngle(ax: number, az: number): number {
  let a = Math.atan2(az, ax);
  if (a < 0) a += Math.PI;
  if (a >= Math.PI) a -= Math.PI;
  return a;
}

function vertexKey(x: number, z: number): string {
  return `${Math.round(x)},${Math.round(z)}`;
}

interface Accum {
  x: number;
  z: number;
  lines: Set<number>;
  angles: number[];
}

/**
 * 路网交叉口：OSM 折线在路口共用同一节点，按顶点坐标聚类即可精确找回，
 * 不需要做 O(n²) 的线段求交。只统计至少两条路经过的节点。
 */
export function findJunctions(
  lines: LocalPoint2[][],
  options: { maxRadius: number; minRadius?: number; limit?: number } = { maxRadius: 2700 },
): Junction[] {
  const { maxRadius, minRadius = 0, limit = 240 } = options;
  const map = new Map<string, Accum>();

  lines.forEach((line, li) => {
    for (let i = 0; i < line.length; i += 1) {
      const [x, z] = line[i];
      const r = Math.hypot(x, z);
      if (r < minRadius || r > maxRadius) continue;
      const prev = line[Math.max(0, i - 1)];
      const next = line[Math.min(line.length - 1, i + 1)];
      const dx = next[0] - prev[0];
      const dz = next[1] - prev[1];
      if (Math.hypot(dx, dz) < 1e-3) continue;

      const key = vertexKey(x, z);
      let acc = map.get(key);
      if (!acc) {
        acc = { x, z, lines: new Set<number>(), angles: [] };
        map.set(key, acc);
      }
      acc.lines.add(li);
      acc.angles.push(foldAngle(dx, dz));
    }
  });

  const junctions: Junction[] = [];
  for (const acc of map.values()) {
    if (acc.lines.size < 2) continue;
    // 方向去重：同一条路的上行/下行折叠后相同，夹角小于 12° 视为同一条
    const dirs: Array<[number, number]> = [];
    for (const angle of acc.angles) {
      const dup = dirs.some(([ax, az]) => {
        const da = Math.abs(foldAngle(ax, az) - angle);
        return Math.min(da, Math.PI - da) < 0.21;
      });
      if (!dup) dirs.push([Math.cos(angle), Math.sin(angle)]);
    }
    if (dirs.length < 2) continue;
    junctions.push({ x: acc.x, z: acc.z, dirs });
    if (junctions.length >= limit) break;
  }

  return junctions;
}

export interface CrosswalkOptions {
  /** 路面总宽（米） */
  roadWidth: number;
  /** 斑马线到路口的距离（米） */
  setback: number;
  /**
   * 过街方向可用半宽（米）。返回 0 表示这里不铺。
   * 路口节点会把相交的每一条路的走向都收进来，若照着支路走向铺 22m 宽的条纹带，
   * 条纹会整条甩到路缘之外的地面上——必须按实际路面量出可铺宽度。
   */
  widthAt?: (x: number, z: number, nx: number, nz: number, dx: number, dz: number) => number;
  /**
   * 路口节点的切线来自前后顶点连线，弯道上会与铺设点的真实路向差十几甚至几十度，
   * 条纹就会斜着铺。这里把过街带中心吸附到实际路面中心线，并返回该处真实单位路向，
   * 保证条纹长边与脚下道路严格正交。
   */
  snap?: (
    x: number,
    z: number,
    dx: number,
    dz: number,
  ) => { x: number; z: number; ux: number; uz: number } | null;
}

/**
 * 斑马线几何：每条进口道画一条过街带。
 * 白色粗实线顺着车行方向（与路缘平行），沿过街方向按 0.45m 实 / 0.6m 空排满路面。
 */
export function buildCrosswalkGeometry(
  junctions: Junction[],
  y: number,
  options: CrosswalkOptions = { roadWidth: 24, setback: 15 },
): Float32Array {
  const { roadWidth, setback, widthAt, snap } = options;
  const half = roadWidth / 2;
  const positions: number[] = [];
  /** 条纹宽（沿过街方向量）与间距 */
  const BAR_W = 0.45;
  const BAR_GAP = 0.6;
  const PITCH = BAR_W + BAR_GAP;
  /** 人行横道沿车行方向的深度（半深），国标不小于 3m */
  const DEPTH_HALF = 3.3;

  const quad = (
    ax: number, az: number,
    bx: number, bz: number,
    cx: number, cz: number,
    dx: number, dz: number,
  ) => {
    positions.push(ax, y, az, bx, y, bz, cx, y, cz);
    positions.push(ax, y, az, cx, y, cz, dx, y, dz);
  };

  for (const junction of junctions) {
    for (const [dx, dz] of junction.dirs) {
      // 路口两侧各画一条（进口道 + 出口道）
      for (const sign of [1, -1]) {
        const cx = junction.x + dx * setback * sign;
        const cz = junction.z + dz * setback * sign;
        // 优先用铺设点的真实路向定向：弯道节点切线会让条纹斜铺
        const local = snap?.(cx, cz, dx, dz) ?? null;
        // 吸附不到"同向道路"说明这条进口道在这里并不存在，铺出来会是一条悬空斜带
        if (snap && !local) continue;
        const ox = local ? local.x : cx;
        const oz = local ? local.z : cz;
        const dirX = local ? local.ux : dx;
        const dirZ = local ? local.uz : dz;
        const nx = -dirZ;
        const nz = dirX;
        const bandHalf = widthAt ? Math.min(half, widthAt(ox, oz, nx, nz, dirX, dirZ)) : half;
        if (bandHalf < 3) continue;
        // 条纹沿过街方向横向排布，覆盖实际路面宽度
        const bars = Math.max(1, Math.floor((bandHalf * 2) / PITCH));
        const start = -((bars - 1) * PITCH) / 2;

        for (let k = 0; k < bars; k += 1) {
          const off = start + k * PITCH;
          // 长边沿车行方向 ±DEPTH_HALF（与路缘平行），宽 BAR_W
          const ax = ox - dirX * DEPTH_HALF + nx * (off - BAR_W / 2);
          const az = oz - dirZ * DEPTH_HALF + nz * (off - BAR_W / 2);
          const bx = ox - dirX * DEPTH_HALF + nx * (off + BAR_W / 2);
          const bz = oz - dirZ * DEPTH_HALF + nz * (off + BAR_W / 2);
          const cxp = ox + dirX * DEPTH_HALF + nx * (off + BAR_W / 2);
          const czp = oz + dirZ * DEPTH_HALF + nz * (off + BAR_W / 2);
          const dxp = ox + dirX * DEPTH_HALF + nx * (off - BAR_W / 2);
          const dzp = oz + dirZ * DEPTH_HALF + nz * (off - BAR_W / 2);
          quad(ax, az, bx, bz, cxp, czp, dxp, dzp);
        }
      }
    }
  }

  return new Float32Array(positions);
}
