import type { LocalPoint2 } from '../types';

/** 与 Roads.tsx 一致的路面半宽（米） */
export const ROAD_HALF = { major: 13, minor: 5.5 } as const;

export interface RoadLines {
  major: LocalPoint2[][];
  minor: LocalPoint2[][];
}

interface Seg {
  a: LocalPoint2;
  b: LocalPoint2;
  half: number;
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

/**
 * 把景区石台轮廓从马路上"削回来"：
 *
 * 粗景点轮廓来自 OSM polygon，与路网是两套独立数据；有些轮廓顶点会伸进
 * 相邻路面（拙政园东侧/南侧最明显，侵入 5~11m）。石台拉伸后盖住路面，
 * 既压路又让路面标线在石台边缘闪烁。
 *
 * 处理方式：对轮廓上落在任一路面半宽内的顶点，沿该路段的法线退到路缘外
 * 再加 0.5m 余量；随后在相邻顶点间按步长重采样，让被削掉的尖角两侧平滑
 * 过渡。只处理"侵入路面"的顶点，正常边界不动。
 *
 * 输出的轮廓点数可能变化（顶点被推出后重新采样），但保持首尾不重复的闭合环。
 */
export function trimOutlineFromRoads(
  outline: LocalPoint2[],
  roads: RoadLines,
  options: { margin?: number; sampleStep?: number } = {},
): LocalPoint2[] {
  const margin = options.margin ?? 0.5;
  const sampleStep = options.sampleStep ?? 4;
  if (outline.length < 3) return outline;

  // 道路段 + 网格索引
  const segs: Seg[] = [];
  const grid = new Map<string, number[]>();
  const key = (cx: number, cz: number) => `${cx},${cz}`;
  for (const kind of ['major', 'minor'] as const) {
    for (const line of roads[kind]) {
      for (let i = 0; i < line.length - 1; i += 1) {
        const seg: Seg = { a: line[i], b: line[i + 1], half: ROAD_HALF[kind] };
        const id = segs.length;
        segs.push(seg);
        const pad = seg.half + margin + 4;
        const x0 = Math.floor((Math.min(seg.a[0], seg.b[0]) - pad) / CELL);
        const x1 = Math.floor((Math.max(seg.a[0], seg.b[0]) + pad) / CELL);
        const z0 = Math.floor((Math.min(seg.a[1], seg.b[1]) - pad) / CELL);
        const z1 = Math.floor((Math.max(seg.a[1], seg.b[1]) + pad) / CELL);
        for (let cx = x0; cx <= x1; cx += 1) {
          for (let cz = z0; cz <= z1; cz += 1) {
            const k = key(cx, cz);
            const arr = grid.get(k) ?? [];
            arr.push(id);
            grid.set(k, arr);
          }
        }
      }
    }
  }
  if (!segs.length) return outline;

  // 计算点到最近路面"侵入深度"（>0 表示压路）
  const roadDepth = (x: number, z: number): { depth: number; seg: Seg } => {
    let worst = -Infinity;
    let seg = segs[0];
    for (let cx = Math.floor((x - 40) / CELL); cx <= Math.floor((x + 40) / CELL); cx += 1) {
      for (let cz = Math.floor((z - 40) / CELL); cz <= Math.floor((z + 40) / CELL); cz += 1) {
        for (const id of grid.get(key(cx, cz)) ?? []) {
          const s = segs[id];
          const depth = s.half + margin - distToSeg(x, z, s.a, s.b);
          // 只在段的中段（非端点延长区）判定，避免路口端点把石台角误削
          if (depth > worst) {
            worst = depth;
            seg = s;
          }
        }
      }
    }
    return { depth: worst, seg };
  };

  /**
   * 把点迭代推离所有路面：
   * 单次退让可能把顶点从一条路推到相邻路上（路口处尤其常见），
   * 所以反复找"侵入最深"的那条路，沿该路法线推出，直到不再压路。
   */
  const relax = (x: number, z: number): LocalPoint2 => {
    // 两条路夹角很小的楔形区，推离一条会落进另一条而震荡；
    // 记录侵入最浅的那个位置，最终取它，保证不会越推越糟。
    let bestX = x;
    let bestZ = z;
    let bestDepth = roadDepth(x, z).depth;
    for (let iter = 0; iter < 24; iter += 1) {
      const { depth, seg } = roadDepth(x, z);
      if (depth < bestDepth) {
        bestDepth = depth;
        bestX = x;
        bestZ = z;
      }
      if (depth <= 0) break;
      const dx = seg.b[0] - seg.a[0];
      const dz = seg.b[1] - seg.a[1];
      const len = Math.hypot(dx, dz) || 1;
      let t = ((x - seg.a[0]) * dx + (z - seg.a[1]) * dz) / (len * len);
      t = Math.max(0, Math.min(1, t));
      const px = seg.a[0] + t * dx;
      const pz = seg.a[1] + t * dz;
      let nx = x - px;
      let nz = z - pz;
      const nl = Math.hypot(nx, nz);
      if (nl < 1e-4) {
        // 点恰好落在道路中心线上：用段法线（保持一侧一致）
        nx = dz / len;
        nz = -dx / len;
      } else {
        nx /= nl;
        nz /= nl;
      }
      const target = seg.half + margin + 0.2;
      x = px + nx * target;
      z = pz + nz * target;
    }
    return bestDepth < roadDepth(x, z).depth ? [bestX, bestZ] : [x, z];
  };

  // 1) 顶点退让：落在路面内的顶点迭代退到路缘外
  const moved: LocalPoint2[] = outline.map(([x, z]) => relax(x, z));

  // 2) 边重采样：长边按步长插入中间点，若中间点压路则同样退让，
  //    这样被削掉的尖角两侧会顺着路缘平滑过渡，而不是留下一条跨越路面的直线。
  const refined: LocalPoint2[] = [];
  const n = moved.length;
  for (let i = 0; i < n; i += 1) {
    const a = moved[i];
    const b = moved[(i + 1) % n];
    refined.push(a);
    const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.floor(dist / sampleStep);
    for (let s = 1; s < steps; s += 1) {
      const t = s / steps;
      const x = a[0] + (b[0] - a[0]) * t;
      const z = a[1] + (b[1] - a[1]) * t;
      refined.push(relax(x, z));
    }
  }

  // 去掉退让后可能产生的重复点（相邻 < 0.2m）
  const out: LocalPoint2[] = [];
  for (const p of refined) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.2) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.2) out.pop();
  }
  return out;
}
