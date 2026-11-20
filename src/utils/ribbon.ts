import * as THREE from 'three';
import type { LocalPoint2 } from '../types';

/** 高度可为常数，或按世界坐标求值（用于城内→城外的高差过渡） */
export type HeightAt = number | ((x: number, z: number) => number);

export interface RibbonOptions {
  /**
   * 额外写入道路专用 UV（横断面 0..1、纵向累计米数），
   * 供路面着色器程序化绘制车道线——不再生成任何标线几何。
   */
  roadUV?: boolean;
}

/**
 * 折线 → 平铺带状几何（合并为单个 BufferGeometry，一次 draw call）。
 * 用于道路、环城河等线状要素在三维中的面状呈现。
 *
 * 每段带状面会在基准高度上做毫米级确定性错层：折线拐点、路口、不同道路
 * 重叠处原本完全共面，深度值相同会随视角抖动（z-fighting 闪烁），
 * 错开后由深度缓冲稳定分出前后。
 */
export function buildRibbons(
  lines: LocalPoint2[][],
  width: number,
  y: HeightAt,
  options: RibbonOptions = {},
): THREE.BufferGeometry {
  const half = width / 2;
  const positions: number[] = [];
  /** 世界坐标 UV（约 45m 一个循环），供水面法线/波纹贴图流动 */
  const uvs: number[] = [];
  /** 道路专用 UV：u = 横断面 0..1，v = 沿路里程（米） */
  const roadUVs: number[] = [];
  const UV_SCALE = 1 / 45;
  let seg = 0;

  for (const line of lines) {
    let along = 0;
    for (let i = 0; i < line.length - 1; i += 1) {
      const [x1, z1] = line[i];
      const [x2, z2] = line[i + 1];
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;
      // 左法线
      const nx = (-dz / len) * half;
      const nz = (dx / len) * half;

      const ax = x1 + nx;
      const az = z1 + nz;
      const bx = x1 - nx;
      const bz = z1 - nz;
      const cx = x2 + nx;
      const cz = z2 + nz;
      const dx2 = x2 - nx;
      const dz2 = z2 - nz;

      // 黄金分割低差异序列：让任意两条重叠带面几乎不可能落在同一深度层
      const baseY = typeof y === 'number' ? y : y((x1 + x2) / 2, (z1 + z2) / 2);
      const segY = baseY + ((seg * 0.6180339887) % 1) * 0.012;
      seg += 1;

      positions.push(ax, segY, az, bx, segY, bz, cx, segY, cz);
      positions.push(bx, segY, bz, dx2, segY, dz2, cx, segY, cz);
      uvs.push(
        ax * UV_SCALE, az * UV_SCALE,
        bx * UV_SCALE, bz * UV_SCALE,
        cx * UV_SCALE, cz * UV_SCALE,
        bx * UV_SCALE, bz * UV_SCALE,
        dx2 * UV_SCALE, dz2 * UV_SCALE,
        cx * UV_SCALE, cz * UV_SCALE,
      );
      if (options.roadUV) {
        const v0 = along;
        const v1 = along + len;
        roadUVs.push(0, v0, 1, v0, 0, v1, 1, v0, 1, v1, 0, v1);
      }
      along += len;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (options.roadUV) {
    geo.setAttribute('aRoad', new THREE.Float32BufferAttribute(roadUVs, 2));
  }
  geo.computeVertexNormals();
  return geo;
}
