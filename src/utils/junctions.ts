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
}

/**
 * 斑马线几何：每条进口道画一条横跨路面的条纹带。
 * 条纹长边沿过街方向（横跨路面），沿行车方向按 0.55m 实 / 0.55m 空排布。
 */
export function buildCrosswalkGeometry(
  junctions: Junction[],
  y: number,
  options: CrosswalkOptions = { roadWidth: 24, setback: 15 },
): Float32Array {
  const { roadWidth, setback } = options;
  const half = roadWidth / 2;
  const positions: number[] = [];
  const BAR_W = 0.55;
  const BAR_GAP = 0.55;
  const BARS = 6;

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
        const nx = -dz;
        const nz = dx;
        const center = ((BARS - 1) * (BAR_W + BAR_GAP)) / 2;

        for (let k = 0; k < BARS; k += 1) {
          const off = k * (BAR_W + BAR_GAP) - center;
          // 沿行车方向 ±BAR_W/2，沿过街方向 ±half
          const ax = cx + dx * (off - BAR_W / 2) - nx * half;
          const az = cz + dz * (off - BAR_W / 2) - nz * half;
          const bx = cx + dx * (off - BAR_W / 2) + nx * half;
          const bz = cz + dz * (off - BAR_W / 2) + nz * half;
          const cxp = cx + dx * (off + BAR_W / 2) + nx * half;
          const czp = cz + dz * (off + BAR_W / 2) + nz * half;
          const dxp = cx + dx * (off + BAR_W / 2) - nx * half;
          const dzp = cz + dz * (off + BAR_W / 2) - nz * half;
          quad(ax, az, bx, bz, cxp, czp, dxp, dzp);
        }
      }
    }
  }

  return new Float32Array(positions);
}
