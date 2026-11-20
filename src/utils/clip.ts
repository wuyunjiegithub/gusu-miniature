import type { LocalPoint2 } from '../types';

/** 折线是否整体落在半径内（快速判断，避免逐段裁剪） */
function allInside(line: LocalPoint2[], radius: number): boolean {
  for (const [x, z] of line) {
    if (x * x + z * z > radius * radius) return false;
  }
  return true;
}

/**
 * 把折线裁到以原点为圆心、radius 为半径的圆内。
 * 圆外点丢弃，跨越边界的线段在交点处插值补齐，
 * 这样贴边的一段路不会整段消失，也不会伸到圆盘外面悬空。
 */
export function clipLineToRadius(line: LocalPoint2[], radius: number): LocalPoint2[] {
  if (line.length < 2) return line;
  if (allInside(line, radius)) return line;

  const r2 = radius * radius;
  const out: LocalPoint2[] = [];

  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    const da = a[0] * a[0] + a[1] * a[1] <= r2;
    const db = b[0] * b[0] + b[1] * b[1] <= r2;

    if (da && db) {
      if (out.length === 0) out.push(a);
      out.push(b);
      continue;
    }
    if (!da && !db) continue;

    // 线段与圆的交点：解 |a + t(b-a)|² = r²
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const A = dx * dx + dz * dz;
    const B = 2 * (a[0] * dx + a[1] * dz);
    const C = a[0] * a[0] + a[1] * a[1] - r2;
    const disc = B * B - 4 * A * C;
    if (disc <= 0 || A < 1e-6) continue;
    const sq = Math.sqrt(disc);
    const t1 = (-B - sq) / (2 * A);
    const t2 = (-B + sq) / (2 * A);
    const t = da ? Math.max(t1, t2) : Math.min(t1, t2);
    if (t < 0 || t > 1) continue;
    const p: LocalPoint2 = [a[0] + dx * t, a[1] + dz * t];

    if (da) {
      if (out.length === 0) out.push(a);
      out.push(p);
    } else {
      out.push(p);
      out.push(b);
    }
  }

  return out;
}

/** 批量裁剪，并丢弃裁剪后不足两点的碎片 */
export function clipLinesToRadius(lines: LocalPoint2[][], radius: number): LocalPoint2[][] {
  const result: LocalPoint2[][] = [];
  for (const line of lines) {
    const clipped = clipLineToRadius(line, radius);
    if (clipped.length >= 2) result.push(clipped);
  }
  return result;
}
