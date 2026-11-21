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
  /**
   * 标线遮罩：给每个顶点返回 0..1，0 表示这里要把标线完全淡掉。
   * 用于路口——另一条同高路面压上来时，两套标线共面会一起闪。
   */
  markMask?: (x: number, z: number) => number;
}

const UV_SCALE = 1 / 45;

/**
 * 折线 → 平铺带状几何（合并为单个 BufferGeometry，一次 draw call）。
 * 用于道路、环城河等线状要素在三维中的面状呈现。
 *
 * 每个顶点用相邻两段法线的角平分线（miter）偏移，路口处左右两条路面
 * 真正接在一起；早期实现按段各自偏移，急转弯处会甩出三角形尖刺、留缺口。
 * 每条带面整体做一个毫米级错层，避免与其它重叠路面共面闪烁。
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
  let strip = 0;

  for (const rawLine of lines) {
    // 去重：连续重复点会让 miter 方向退化
    const line: LocalPoint2[] = [];
    for (const p of rawLine) {
      const last = line[line.length - 1];
      if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 0.05) line.push(p);
    }
    if (line.length < 2) continue;

    const n = line.length;
    // 每条带面一个整体高度偏移（黄金分割低差异序列），与其它路面错开。
    // 路口两条同高路面必然重叠：错层按 0.004~0.03m 分布，深度缓冲才能稳定分前后，
    // 不再出现毫米级同面互相抢占导致的"路面一闪一闪"。
    const lift = 0.004 + ((strip * 0.6180339887) % 1) * 0.026;
    strip += 1;

    const left: Array<[number, number, number]> = [];
    const right: Array<[number, number, number]> = [];
    const along: number[] = [0];
    // 车道线相位用"整条线的走向"做世界坐标投影，而不是每条带面从 0 重新开始。
    // OSM 常把一条路在路口切成多段；从 0 重新开始会让每段都从头画虚线，
    // 路口两侧出现半截虚线/忽闪的观感。用同一走向的全局相位即可跨段连续。
    const dirX = line[n - 1][0] - line[0][0];
    const dirZ = line[n - 1][1] - line[0][1];
    const dirLen = Math.hypot(dirX, dirZ);
    const phase = dirLen > 0.01
      ? (line[0][0] * dirX + line[0][1] * dirZ) / dirLen
      : 0;

    for (let i = 0; i < n; i += 1) {
      const [x, z] = line[i];
      const prev = line[Math.max(0, i - 1)];
      const next = line[Math.min(n - 1, i + 1)];

      // 前后两段的单位法线（左侧）
      const segN = (a: LocalPoint2, b: LocalPoint2): [number, number] => {
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const len = Math.hypot(dx, dz) || 1;
        return [-dz / len, dx / len];
      };
      const n1 = i === 0 ? segN(line[0], line[1]) : segN(prev, line[i]);
      const n2 = i === n - 1 ? n1 : segN(line[i], next);

      // 角平分线法线：两段法线等长单位化后相加
      let mx = n1[0] + n2[0];
      let mz = n1[1] + n2[1];
      const mlen = Math.hypot(mx, mz);
      if (mlen < 1e-6) {
        // 180° 折返（数据错误）：退回前一段的法线
        mx = n1[0];
        mz = n1[1];
      } else {
        mx /= mlen;
        mz /= mlen;
      }
      // miter 长度 = half / cos(半转角)，限制 2.4 倍避免锐角甩出长刺
      const cos = Math.max(0.42, mx * n1[0] + mz * n1[1]);
      const scale = half / cos;

      const baseY = typeof y === 'number' ? y : y(x, z);
      const vy = baseY + lift;
      left.push([x + mx * scale, vy, z + mz * scale]);
      right.push([x - mx * scale, vy, z - mz * scale]);

      if (i > 0) {
        const d = Math.hypot(x - line[i - 1][0], z - line[i - 1][1]);
        along.push(along[along.length - 1] + d);
      }
    }

    for (let i = 0; i < n - 1; i += 1) {
      const l0 = left[i];
      const l1 = left[i + 1];
      const r0 = right[i];
      const r1 = right[i + 1];
      // 绕序：法线朝上
      positions.push(...l0, ...l1, ...r0);
      positions.push(...r0, ...l1, ...r1);
      uvs.push(
        l0[0] * UV_SCALE, l0[2] * UV_SCALE,
        l1[0] * UV_SCALE, l1[2] * UV_SCALE,
        r0[0] * UV_SCALE, r0[2] * UV_SCALE,
        r0[0] * UV_SCALE, r0[2] * UV_SCALE,
        l1[0] * UV_SCALE, l1[2] * UV_SCALE,
        r1[0] * UV_SCALE, r1[2] * UV_SCALE,
      );
      if (options.roadUV) {
        const v0 = phase + along[i];
        const v1 = phase + along[i + 1];
        const m0 = options.markMask
          ? options.markMask(left[i][0], left[i][2])
          : 1;
        const m1 = options.markMask
          ? options.markMask(left[i + 1][0], left[i + 1][2])
          : 1;
        const m2 = options.markMask
          ? options.markMask(right[i][0], right[i][2])
          : 1;
        const m3 = options.markMask
          ? options.markMask(right[i + 1][0], right[i + 1][2])
          : 1;
        roadUVs.push(
          0, v0, m0, 0, v1, m1, 1, v0, m2,
          1, v0, m2, 0, v1, m1, 1, v1, m3,
        );
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (options.roadUV) {
    geo.setAttribute('aRoad', new THREE.Float32BufferAttribute(roadUVs, 3));
  }
  geo.computeVertexNormals();
  return geo;
}
