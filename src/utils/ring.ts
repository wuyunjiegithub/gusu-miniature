import * as THREE from 'three';
import { pointInRing } from './geo';
import type { LocalPoint2 } from '../types';

/** 闭合轮廓各顶点处的向外单位法线（用内外测试定"外"，不依赖绕向） */
function outwardNormals(line: LocalPoint2[]): Array<[number, number]> {
  const n = line.length;
  const normals = line.map((_, i) => {
    const prev = line[(i - 1 + n) % n];
    const next = line[(i + 1) % n];
    const dx = next[0] - prev[0];
    const dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    return [-dz / len, dx / len] as [number, number];
  });

  const mx = (line[0][0] + line[1][0]) / 2;
  const mz = (line[0][1] + line[1][1]) / 2;
  const outward = !pointInRing(line, mx + normals[0][0] * 40, mz + normals[0][1] * 40);
  return outward ? normals : normals.map(([x, z]) => [-x, -z] as [number, number]);
}

/**
 * 沿闭合轮廓向外偏移，生成环带状平面几何（护城河水面用）。
 *
 * inset > 0 时水面从轮廓外 inset 米处才开始，为城墙留出一条干岸：
 * 城墙厚 8m，水面若从轮廓线（城墙中心）起铺，半堵墙就泡在水里。
 */
export function buildOutlineRing(
  line: LocalPoint2[],
  width: number,
  y: number,
  inset = 0,
): THREE.BufferGeometry {
  const n = line.length;
  const normals = outwardNormals(line);

  const positions: number[] = [];
  /** 世界坐标 UV，供水面波纹贴图流动 */
  const uvs: number[] = [];
  const UV_SCALE = 1 / 45;

  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const [ix, iz] = line[i];
    const [jx, jz] = line[j];
    const [nix, niz] = normals[i];
    const [njx, njz] = normals[j];

    const ax = ix + nix * inset;
    const az = iz + niz * inset;
    const bx = jx + njx * inset;
    const bz = jz + njz * inset;
    const cx = jx + njx * (inset + width);
    const cz = jz + njz * (inset + width);
    const dx = ix + nix * (inset + width);
    const dz = iz + niz * (inset + width);

    positions.push(ax, y, az, bx, y, bz, cx, y, cz);
    positions.push(ax, y, az, cx, y, cz, dx, y, dz);
    uvs.push(
      ax * UV_SCALE, az * UV_SCALE,
      bx * UV_SCALE, bz * UV_SCALE,
      cx * UV_SCALE, cz * UV_SCALE,
      ax * UV_SCALE, az * UV_SCALE,
      cx * UV_SCALE, cz * UV_SCALE,
      dx * UV_SCALE, dz * UV_SCALE,
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

/**
 * 护城河石驳岸：沿轮廓外 offset 米铺一条宽 width 的石带，
 * 外沿垂下一道石墙到 bottomY；靠城墙那一侧本身就是墙体，不再另加竖面。
 */
export function buildRingBank(
  line: LocalPoint2[],
  offset: number,
  width: number,
  topY: number,
  bottomY: number,
): THREE.BufferGeometry {
  const n = line.length;
  const normals = outwardNormals(line);
  const positions: number[] = [];

  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const [ix, iz] = line[i];
    const [jx, jz] = line[j];
    const [nix, niz] = normals[i];
    const [njx, njz] = normals[j];

    const ax = ix + nix * offset;
    const az = iz + niz * offset;
    const bx = jx + njx * offset;
    const bz = jz + njz * offset;
    const cx = jx + njx * (offset + width);
    const cz = jz + njz * (offset + width);
    const dx = ix + nix * (offset + width);
    const dz = iz + niz * (offset + width);

    // 顶面石带
    positions.push(ax, topY, az, bx, topY, bz, cx, topY, cz);
    positions.push(ax, topY, az, cx, topY, cz, dx, topY, dz);
    // 外沿竖面（沉到外围地面以下）
    positions.push(bx, topY, bz, cx, topY, cz, cx, bottomY, cz);
    positions.push(bx, topY, bz, cx, bottomY, cz, bx, bottomY, bz);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}
