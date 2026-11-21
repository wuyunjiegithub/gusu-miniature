import type { LocalPoint2 } from '../types';
import { sceneGeometry } from '../data/sceneGeometry';
import { outerWaterHalf } from '../constants/geo';
import { pointInRing } from './geo';

/**
 * 水域场（water field）：全场景唯一的水面判定入口。
 *
 * 为什么要有这个模块：
 * 桥位扫描、路灯避让、地铁剪断、树木避让过去各自实现了一份
 * "点到所有水道折线取最小距离"，而水道折线共 200 多段、护城河轮廓 100 段。
 * 道路按 4m 采样有 30 多万个点，每个点再乘 270 段 = 8000 多万次开方，
 * 首屏主线程会因此卡住 5 秒以上。
 *
 * 这里把所有水域线段一次性装进 64m 的均匀网格，查询退化为"取当前格子里的
 * 几条候选段"，并把距离比较改成平方比较（不 sqrt）。同一套判定给所有调用方复用。
 */

/** 与 WaterSystem 的水面参数保持一致 */
export const CANAL_HALF = 15;
export const CANAL_Y = 2.4;
export const MOAT_INNER = 4.6;
export const MOAT_OUTER = MOAT_INNER + 120;
export const MOAT_Y = 1.4;
export const SHANTANG_Y = -1.3;
/** 护城河内岸判定比几何内岸再收 0.6m，避免岸边石头被算成水面 */
const MOAT_INNER_TOL = 0.6;

/** 查询时允许的最大外扩量（决定网格插入半径） */
const MAX_MARGIN = 8;
const CELL = 64;

type Kind = 0 | 1 | 2; // 0 城内河道 / 1 山塘河 / 2 护城河

interface WaterSeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  kind: Kind;
  half: number;
}

const cityRing = sceneGeometry.cityOutline;

const segs: WaterSeg[] = [];
const pushLine = (line: LocalPoint2[], kind: Kind, half: number) => {
  for (let i = 0; i < line.length - 1; i += 1) {
    segs.push({ ax: line[i][0], az: line[i][1], bx: line[i + 1][0], bz: line[i + 1][1], kind, half });
  }
};

// 顺序即优先级：河道 > 城外水道 > 护城河（与旧实现一致）
for (const line of sceneGeometry.waterways ?? []) pushLine(line, 0, CANAL_HALF);
(sceneGeometry.outerWaterways ?? []).forEach((line, i) => pushLine(line, 1, outerWaterHalf(i)));
pushLine([...cityRing, cityRing[0]], 2, 0);

/** 每种水域的插入半径：查询时用不到的格子不必装 */
const reachOf = (seg: WaterSeg): number =>
  seg.kind === 2 ? MOAT_OUTER + MAX_MARGIN : seg.half + MAX_MARGIN;

const grid = new Map<number, WaterSeg[]>();
const cellKey = (ix: number, iz: number): number => ix * 8192 + iz;

const insert = (seg: WaterSeg) => {
  const reach = reachOf(seg);
  const x0 = Math.floor((Math.min(seg.ax, seg.bx) - reach) / CELL);
  const x1 = Math.floor((Math.max(seg.ax, seg.bx) + reach) / CELL);
  const z0 = Math.floor((Math.min(seg.az, seg.bz) - reach) / CELL);
  const z1 = Math.floor((Math.max(seg.az, seg.bz) + reach) / CELL);
  for (let ix = x0; ix <= x1; ix += 1) {
    for (let iz = z0; iz <= z1; iz += 1) {
      const key = cellKey(ix, iz);
      const bucket = grid.get(key);
      if (bucket) bucket.push(seg);
      else grid.set(key, [seg]);
    }
  }
};
for (const seg of segs) insert(seg);

/** 点到线段的距离平方（不开方，避免 hypot 的开销） */
const distSqToSeg = (x: number, z: number, seg: WaterSeg): number => {
  const dx = seg.bx - seg.ax;
  const dz = seg.bz - seg.az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((x - seg.ax) * dx + (z - seg.az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = seg.ax + t * dx;
  const pz = seg.az + t * dz;
  return (x - px) * (x - px) + (z - pz) * (z - pz);
};

/**
 * 该点所在的水面标高；不在任何水面上返回 null。
 * margin > 0 时把水面边界外扩，用于"离水太近也不许放东西"的场合。
 */
export function waterLevelAt(x: number, z: number, margin = 0): number | null {
  const m = margin > MAX_MARGIN ? MAX_MARGIN : margin < 0 ? 0 : margin;
  const bucket = grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!bucket) return null;

  const canalR2 = (CANAL_HALF + m) * (CANAL_HALF + m);
  const moatInner = MOAT_INNER - MOAT_INNER_TOL - m;
  const moatOuter = MOAT_OUTER + m;

  // 护城河要"到轮廓的最短距离"，不能拿任意一条在带的边就判成水：
  // 盘门那种内凹处，一条边在环带里、另一条边离得更近，取最小值才不会误判。
  let moatMin2 = Infinity;

  for (let i = 0; i < bucket.length; i += 1) {
    const seg = bucket[i];
    const d2 = distSqToSeg(x, z, seg);
    if (seg.kind === 0) {
      if (d2 < canalR2) return CANAL_Y;
    } else if (seg.kind === 1) {
      const r = seg.half + m;
      if (d2 < r * r) return SHANTANG_Y;
    } else if (d2 < moatMin2) {
      moatMin2 = d2;
    }
  }

  if (
    moatMin2 >= moatInner * moatInner &&
    moatMin2 < moatOuter * moatOuter &&
    !pointInRing(cityRing, x, z)
  ) {
    return MOAT_Y;
  }
  return null;
}

/** 是否落在水面上（含外扩 margin） */
export function inWater(x: number, z: number, margin = 0): boolean {
  return waterLevelAt(x, z, margin) !== null;
}

/** 到最近水域边界的距离（米），只用于诊断 */
export function distanceToWater(x: number, z: number): number {
  const bucket = grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!bucket) return Infinity;
  let best = Infinity;
  for (let i = 0; i < bucket.length; i += 1) {
    const seg = bucket[i];
    const d2 = distSqToSeg(x, z, seg);
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}
