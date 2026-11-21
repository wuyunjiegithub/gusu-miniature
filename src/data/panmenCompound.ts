import { sceneGeometry } from './sceneGeometry';

/**
 * 盘门景区腹地的程序化填充布局（纯数据，不依赖 three/DOM，可单测）。
 *
 * 背景：盘门三景（城墙/水陆门/瑞光塔/吴门桥）由 Panmen.tsx 程序化重建，
 * 但景区 outline 覆盖的城内腹地（约 460m×340m）被建筑生成器整体避让、
 * 又不铺石台，于是一整块青石板空地。这里在轮廓内生成苏式院落 + 水池，
 * 把腹地填满，与四周白墙黛瓦肌理衔接。
 *
 * 约束（全部在布局阶段保证，渲染端只消费结果，不做判定）：
 * - 院落/水池中心必须在景区 outline 内，且离轮廓边界 >= 各自半径 + 余量；
 * - 避让水门水道（x=-777，z 2240~2458.5，宽 9）；
 * - 避让景区内支水道（x≈-690，z 2299~2340）；
 * - 避让瑞光塔（塔心 -722,2400，半径 14）；
 * - 院落之间不互相重叠。
 */

export interface PondSpec {
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  /** 石岸宽度 */
  bank: number;
}

export interface HouseSpec {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  roofH: number;
  /** 绕 Y 轴朝向（弧度），沿街区肌理 */
  rot: number;
  /** 调色板索引 */
  tint: number;
}

export interface TreeSpec {
  x: number;
  z: number;
  h: number;
  tint: number;
}

export interface PanmenCompoundLayout {
  ponds: PondSpec[];
  houses: HouseSpec[];
  trees: TreeSpec[];
}

type Point2 = [number, number];

/** 射线法：点是否在环内 */
export function pointInRing(ring: Point2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
    const [xi, zi] = ring[i];
    const [xk, zk] = ring[k];
    if (zi > z !== zk > z && x < ((xk - xi) * (z - zi)) / (zk - zi) + xi) inside = !inside;
  }
  return inside;
}

/** 点到环边界的最短距离 */
export function distToRing(ring: Point2[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
    const px = x - (a[0] + t * dx);
    const pz = z - (a[1] + t * dz);
    const d = px * px + pz * pz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** 点到线段距离（用于水道避让） */
function distToSeg(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
  return Math.hypot(x - (ax + t * dx), z - (az + t * dz));
}

/** 确定性伪随机（布局可复现） */
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** 水门水道（WaterSystem 的 PANMEN_GATE）：x=-777, z 2240~2458.5 */
const GATE = { x: -777, z0: 2240, z1: 2458.5, half: 4.5 };
/** 景区内支水道（scene-geometry waterway#3）：x≈-691, z 2299~2340 */
const BRANCH = { x: -691, z0: 2285, z1: 2350, half: 5 };
/** 瑞光塔 */
const PAGODA = { x: -722, z: 2400, r: 16 };

/** 某点是否落在需避让的水域/塔内（含 padding） */
function blocked(x: number, z: number, pad: number): boolean {
  if (Math.abs(x - GATE.x) < GATE.half + pad && z > GATE.z0 - pad && z < GATE.z1 + pad) return true;
  if (Math.abs(x - BRANCH.x) < BRANCH.half + pad && z > BRANCH.z0 - pad && z < BRANCH.z1 + pad) return true;
  if (Math.hypot(x - PAGODA.x, z - PAGODA.z) < PAGODA.r + pad) return true;
  return false;
}

/**
 * 生成布局。候选池中心是经验选点（都在景区东西两半的开阔处），
 * 但每个都经轮廓/边界/水域约束校验，不合格自动丢弃，不会穿模。
 */
export function buildPanmenCompound(): PanmenCompoundLayout {
  const outline = (sceneGeometry.landmarks.panmen?.outline ?? []) as Point2[];
  if (outline.length < 3) return { ponds: [], houses: [], trees: [] };

  // ---- 候选水池（椭圆）：先放池，房子再绕开 ----
  const pondCandidates: Array<[number, number, number, number]> = [
    // 西半区（水道以西）
    [-872, 2240, 30, 24],
    [-905, 2325, 22, 17],
    [-860, 2145, 20, 15],
    // 东半区（水道以东，避开塔与支水道：支水道 x≈-691/z2299~2340 纵切）
    [-650, 2180, 26, 18],
    [-700, 2220, 18, 14],
  ];
  const ponds: PondSpec[] = [];
  for (const [cx, cz, rx, rz] of pondCandidates) {
    const r = Math.max(rx, rz);
    if (!pointInRing(outline, cx, cz)) continue;
    if (distToRing(outline, cx, cz) < r + 4) continue;
    if (blocked(cx, cz, r + 3)) continue;
    // 椭圆四极也要在水域之外
    if (
      blocked(cx + rx, cz, 3) || blocked(cx - rx, cz, 3) ||
      blocked(cx, cz + rz, 3) || blocked(cx, cz - rz, 3)
    ) continue;
    ponds.push({ cx, cz, rx, rz, bank: 2.6 });
  }

  // ---- 院落：网格采样 + 抖动，逐个校验 ----
  const houses: HouseSpec[] = [];
  const STEP = 26;
  const MARGIN = 9;
  let seed = 1;
  for (let z = 2110; z <= 2385; z += STEP) {
    for (let x = -975; x <= -530; x += STEP) {
      const jx = x + (hash(seed++) - 0.5) * 9;
      const jz = z + (hash(seed++) - 0.5) * 9;
      const w = 12 + hash(seed++) * 7;
      const d = 9 + hash(seed++) * 5;
      const r = Math.max(w, d) / 2;
      if (!pointInRing(outline, jx, jz)) continue;
      if (distToRing(outline, jx, jz) < r + MARGIN) continue;
      if (blocked(jx, jz, r + 3)) continue;
      // 与水池保持距离
      let onPond = false;
      for (const p of ponds) {
        const nx = (jx - p.cx) / (p.rx + p.bank + r + 4);
        const nz = (jz - p.cz) / (p.rz + p.bank + r + 4);
        if (nx * nx + nz * nz < 1) { onPond = true; break; }
      }
      if (onPond) continue;
      // 与已有院落保持距离（避免重叠）
      let overlap = false;
      for (const h of houses) {
        if (Math.abs(jx - h.x) < (w + h.w) / 2 + 3 && Math.abs(jz - h.z) < (d + h.d) / 2 + 3) {
          overlap = true;
          break;
        }
      }
      if (overlap) continue;
      const h = 4.5 + hash(seed++) * 2.2;
      houses.push({
        x: jx,
        z: jz,
        w,
        d,
        h,
        // 坡顶要有明显起伏，俯视才看得到黛瓦：脊高取墙高的 0.55~0.8
        roofH: h * (0.55 + hash(seed++) * 0.25),
        rot: (hash(seed++) - 0.5) * 0.24,
        tint: Math.floor(hash(seed++) * 5),
      });
    }
  }

  // ---- 点景树：院落间隙与水池边，避开房、池、水道、塔 ----
  const trees: TreeSpec[] = [];
  let tseed = 9000;
  for (let z = 2110; z <= 2385; z += 18) {
    for (let x = -970; x <= -535; x += 18) {
      const tx = x + (hash(tseed++) - 0.5) * 12;
      const tz = z + (hash(tseed++) - 0.5) * 12;
      if (!pointInRing(outline, tx, tz)) continue;
      if (distToRing(outline, tx, tz) < 6) continue;
      if (blocked(tx, tz, 4)) continue;
      // 离房太近不种（种在院落空地/墙边）
      let nearHouse = false;
      for (const h of houses) {
        if (Math.abs(tx - h.x) < h.w / 2 + 3 && Math.abs(tz - h.z) < h.d / 2 + 3) { nearHouse = true; break; }
      }
      if (nearHouse) continue;
      // 离水池太近不种（水面不种树）
      let inPond = false;
      for (const p of ponds) {
        const nx = (tx - p.cx) / (p.rx + p.bank + 2);
        const nz = (tz - p.cz) / (p.rz + p.bank + 2);
        if (nx * nx + nz * nz < 1) { inPond = true; break; }
      }
      if (inPond) continue;
      trees.push({ x: tx, z: tz, h: 6 + hash(tseed++) * 4, tint: Math.floor(hash(tseed++) * 4) });
    }
  }

  return { ponds, houses, trees };
}

/** 布局单例（与场景生命周期一致，模块加载时算一次） */
export const PANMEN_COMPOUND = buildPanmenCompound();
