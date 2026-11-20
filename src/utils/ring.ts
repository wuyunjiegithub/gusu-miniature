import * as THREE from 'three';
import { pointInRing } from './geo';
import type { LocalPoint2 } from '../types';

/**
 * 沿闭合轮廓向外扩展 width 米，生成环带状平面几何（护城河水面用）。
 * 通过法线方向 + 内外测试确定"外侧"，避免依赖轮廓绕向。
 */
export function buildOutlineRing(
  line: LocalPoint2[],
  width: number,
  y: number,
): THREE.BufferGeometry {
  const n = line.length;
  const normals = line.map((_, i) => {
    const prev = line[(i - 1 + n) % n];
    const next = line[(i + 1) % n];
    const dx = next[0] - prev[0];
    const dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    return [-dz / len, dx / len];
  });

  // 用首段中点判断法线是否朝外
  const mx = (line[0][0] + line[1][0]) / 2;
  const mz = (line[0][1] + line[1][1]) / 2;
  const sign = pointInRing(line, mx + normals[0][0] * width * 2, mz + normals[0][1] * width * 2) ? -1 : 1;

  const positions: number[] = [];
  /** 世界坐标 UV，供水面波纹贴图流动 */
  const uvs: number[] = [];
  const UV_SCALE = 1 / 45;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const [ix, iz] = line[i];
    const [jx, jz] = line[j];
    const ox = ix + normals[i][0] * width * sign;
    const oz = iz + normals[i][1] * width * sign;
    const px = jx + normals[j][0] * width * sign;
    const pz = jz + normals[j][1] * width * sign;

    positions.push(ix, y, iz, jx, y, jz, px, y, pz);
    positions.push(ix, y, iz, px, y, pz, ox, y, oz);
    uvs.push(
      ix * UV_SCALE, iz * UV_SCALE,
      jx * UV_SCALE, jz * UV_SCALE,
      px * UV_SCALE, pz * UV_SCALE,
      ix * UV_SCALE, iz * UV_SCALE,
      px * UV_SCALE, pz * UV_SCALE,
      ox * UV_SCALE, oz * UV_SCALE,
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}
