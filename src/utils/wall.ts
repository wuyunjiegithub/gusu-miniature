import * as THREE from 'three';
import type { LocalPoint2 } from '../types';

/**
 * 沿折线生成城墙几何（内外墙面 + 墙顶）。
 * 墙基下沉到 waterY 以下，避免与水面之间出现缝隙。
 * closed=false 时按开放折线处理（用于城门之间的墙段）。
 */
export function buildWallGeometry(
  line: LocalPoint2[],
  thickness: number,
  height: number,
  baseY: number,
  closed = true,
): THREE.BufferGeometry {
  const half = thickness / 2;
  const positions: number[] = [];
  const n = line.length;

  // 每个顶点的平均法线（用于内外侧偏移）
  const normals: Array<[number, number]> = line.map((_, i) => {
    const prev = line[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = line[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    return [-dz / len, dx / len];
  });

  const inner = line.map(([x, z], i) => [x + normals[i][0] * half, z + normals[i][1] * half]);
  const outer = line.map(([x, z], i) => [x - normals[i][0] * half, z - normals[i][1] * half]);

  const topY = baseY + height;

  const quad = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
  ) => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    positions.push(ax, ay, az, cx, cy, cz, dx, dy, dz);
  };

  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i += 1) {
    const j = (i + 1) % n;
    const [ix, iz] = inner[i];
    const [jx, jz] = inner[j];
    const [ox, oz] = outer[i];
    const [px, pz] = outer[j];

    // 内墙面
    quad(ix, baseY, iz, jx, baseY, jz, jx, topY, jz, ix, topY, iz);
    // 外墙面：必须反向绕序，否则法线指向墙内，从城外看整面墙被背面剔除，
    // 只剩墙顶和垛口悬在水面上（盘门正面"悬空"就是这个原因）
    quad(px, baseY, pz, ox, baseY, oz, ox, topY, oz, px, topY, pz);
    // 墙顶
    quad(ix, topY, iz, jx, topY, jz, px, topY, pz, ox, topY, oz);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * 按累计里程切掉若干区间（城门洞口），返回保留的开放折线。
 * cuts 为 [start, end] 里程对，可跨 0 点；内部自动处理闭合回绕。
 */
export function splitClosedLine(
  line: LocalPoint2[],
  cuts: Array<[number, number]>,
): LocalPoint2[][] {
  const n = line.length;
  const cum: number[] = [0];
  for (let i = 1; i <= n; i += 1) {
    const a = line[i - 1];
    const b = line[i % n];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[n];

  const pointAt = (s: number): LocalPoint2 => {
    const t = ((s % total) + total) % total;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid + 1] < t) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.min(lo, n - 1);
    const segLen = cum[i + 1] - cum[i] || 1;
    const f = (t - cum[i]) / segLen;
    const a = line[i];
    const b = line[(i + 1) % n];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };

  // 归一化切区间，得到保留区间
  const blocked = cuts
    .map(([a, b]) => {
      const start = ((a % total) + total) % total;
      const end = ((b % total) + total) % total;
      return start <= end ? [[start, end] as [number, number]] : ([[start, total], [0, end]] as Array<[number, number]>);
    })
    .flat()
    .sort((p, q) => p[0] - q[0]);

  const keep: Array<[number, number]> = [];
  let cursor = 0;
  for (const [a, b] of blocked) {
    if (a > cursor) keep.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < total) keep.push([cursor, total]);

  // 生成折线：端点插值 + 中间原始顶点
  return keep.map(([a, b]) => {
    const pts: LocalPoint2[] = [pointAt(a)];
    for (let i = 1; i <= n; i += 1) {
      if (cum[i] > a && cum[i] < b) pts.push(line[i % n]);
    }
    pts.push(pointAt(b));
    return pts;
  }).filter((pts) => pts.length >= 2);
}

/**
 * 取闭合轮廓上里程 [s0, s1] 之间的折线（两端插值，中间保留原始顶点）。
 * 与 splitClosedLine 互补：CityWall 用它切掉城门洞口，城门段用它取出洞口那一段。
 */
export function arcBetween(line: LocalPoint2[], s0: number, s1: number): LocalPoint2[] {
  const n = line.length;
  const cum: number[] = [0];
  for (let i = 1; i <= n; i += 1) {
    const a = line[i - 1];
    const b = line[i % n];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[n];
  const pointAt = (s: number): LocalPoint2 => {
    const t = Math.max(0, Math.min(total, s));
    let i = 0;
    while (i < n - 1 && cum[i + 1] < t) i += 1;
    const segLen = cum[i + 1] - cum[i] || 1;
    const f = (t - cum[i]) / segLen;
    const a = line[i];
    const b = line[(i + 1) % n];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };
  const out: LocalPoint2[] = [pointAt(s0)];
  for (let i = 1; i < n; i += 1) {
    if (cum[i] > s0 && cum[i] < s1) out.push(line[i]);
  }
  out.push(pointAt(s1));
  return out;
}
