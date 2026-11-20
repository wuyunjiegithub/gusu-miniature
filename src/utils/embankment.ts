import * as THREE from 'three';
import type { LocalPoint2 } from '../types';

/**
 * 水乡驳岸（M1 补充）：
 * 城内运河两侧加石砌驳岸——压顶石条、临水竖面、陆侧裙墙，并按固定间距布置
 * 河埠头（入水石阶）与系船石，全部合并为一个 BufferGeometry（1 draw call）。
 *
 * 高度与 WaterSystem / bridges 保持一致：水面 2.4m、河道半宽 15m。
 */

/** 河道半宽（与 WaterSystem 的 30m 河宽一致） */
export const CANAL_HALF = 15;
/** 水面高度（与 WaterSystem / bridges 一致） */
export const CANAL_WATER_Y = 2.4;

/** 压顶顶面：高出水面 14cm，形成清晰的水岸线 */
const COPING_Y = CANAL_WATER_Y + 0.14;
/** 压顶内沿略压住水面边缘，藏住水面平面的硬边 */
const COPING_INNER = CANAL_HALF - 0.18;
/** 压顶外沿 */
const COPING_OUTER = CANAL_HALF + 1.35;
/** 临水竖面下沿（略沉入水面以下，避免露缝） */
const COPING_LIP_Y = CANAL_WATER_Y - 0.03;
/** 陆侧裙墙下沿：插入沙盘台面，避免悬空 */
const SKIRT_BOTTOM = -0.15;

/** 河埠头：每级台阶的进深与高差 */
const STEP_DEPTH = 1.05;
const STEP_DROP = 0.035;
/** 台阶体块底面（沉在水面以下，只看得到水上部分） */
const STEP_BASE_Y = CANAL_WATER_Y - 0.32;
/** 河埠头宽度（沿河方向） */
const STEP_WIDTH = 3.6;
/** 系船石高出压顶的高度 */
const MOOR_H = 0.52;
/** 河埠头平均间距 */
const LANDING_SPACING = 118;
/** 距河道折线端部的最小距离，避免台阶悬在端点外 */
const LANDING_END_MARGIN = 26;

const hash = (v: number): number => {
  const t = Math.sin(v * 12.9898 + 78.233) * 43758.5453;
  return t - Math.floor(t);
};

interface SegmentFrame {
  x: number;
  z: number;
  /** 单位切向（沿河） */
  tx: number;
  tz: number;
  /** 单位左法线 */
  nx: number;
  nz: number;
  len: number;
}

type Vec3 = [number, number, number];

/** 折线 → 分段累计长度 */
function segmentFrames(line: LocalPoint2[]): SegmentFrame[] {
  const frames: SegmentFrame[] = [];
  for (let i = 0; i < line.length - 1; i += 1) {
    const [x, z] = line[i];
    const [x2, z2] = line[i + 1];
    const dx = x2 - x;
    const dz = z2 - z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) continue;
    const tx = dx / len;
    const tz = dz / len;
    frames.push({ x, z, tx, tz, nx: -tz, nz: tx, len });
  }
  return frames;
}

/**
 * 生成驳岸几何：
 * - 压顶：沿两岸的浅色石条，压住水面边缘
 * - 临水竖面 + 陆侧裙墙：让水面与沙盘台面之间不再是一张悬空的平面
 * - 河埠头：向水里伸出的 3 级石阶
 * - 系船石：河埠头两端的小石柱
 */
export function buildEmbankmentGeometry(lines: LocalPoint2[][]): THREE.BufferGeometry {
  const positions: number[] = [];
  let segIndex = 0;

  const tri = (a: Vec3, b: Vec3, c: Vec3): void => {
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  };
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): void => {
    tri(a, b, c);
    tri(a, c, d);
  };

  for (const line of lines) {
    const frames = segmentFrames(line);
    if (!frames.length) continue;

    // ---- 两岸压顶、临水竖面、陆侧裙墙 ----
    for (const frame of frames) {
      const { x, z, tx, tz, nx, nz, len } = frame;
      // 每段做毫米级确定性错层，避免折线拐点处两段压顶共面闪烁
      const jitter = hash(segIndex * 1.73) * 0.004;
      segIndex += 1;
      const yTop = COPING_Y + jitter;

      const P = (u: number, v: number, y: number): Vec3 => [
        x + tx * u + nx * v,
        y,
        z + tz * u + nz * v,
      ];

      for (const sign of [1, -1] as const) {
        const vIn = COPING_INNER * sign;
        const vOut = COPING_OUTER * sign;
        const vLo = Math.min(vIn, vOut);
        const vHi = Math.max(vIn, vOut);

        // 压顶石条顶面
        quad(P(0, vLo, yTop), P(0, vHi, yTop), P(len, vHi, yTop), P(len, vLo, yTop));
        // 临水竖面：从压顶落到水面以下
        quad(P(0, vIn, yTop), P(0, vIn, COPING_LIP_Y), P(len, vIn, COPING_LIP_Y), P(len, vIn, yTop));
        // 陆侧裙墙：从压顶落到沙盘台面
        quad(P(0, vOut, yTop), P(0, vOut, SKIRT_BOTTOM), P(len, vOut, SKIRT_BOTTOM), P(len, vOut, yTop));
      }
    }

    // ---- 河埠头与系船石 ----
    const total = frames.reduce((sum, f) => sum + f.len, 0);
    if (total < LANDING_END_MARGIN * 2 + STEP_WIDTH * 2) continue;

    /** 根据沿河累计距离取所在分段与段内偏移 */
    const locate = (d: number): { frame: SegmentFrame; u: number } | null => {
      let acc = 0;
      for (const frame of frames) {
        if (d <= acc + frame.len) return { frame, u: d - acc };
        acc += frame.len;
      }
      return null;
    };

    let d = LANDING_END_MARGIN + hash(total * 0.017) * LANDING_SPACING;
    let siteIndex = 0;
    while (d < total - LANDING_END_MARGIN) {
      const hit = locate(d);
      if (!hit) break;
      const { frame, u } = hit;
      const { x, z, tx, tz, nx, nz } = frame;
      const sign: 1 | -1 = siteIndex % 2 === 0 ? 1 : -1;
      const seed = hash(d * 0.31 + siteIndex * 0.77);
      const width = STEP_WIDTH * (0.85 + seed * 0.3);
      const uHalf = width / 2;

      // 台阶需完整落在同一段内，避免在折线拐点处错位
      if (u < uHalf + 1 || u > frame.len - uHalf - 1) {
        d += LANDING_SPACING * (0.8 + hash(d * 0.07) * 0.4);
        continue;
      }

      const P = (uu: number, v: number, y: number): Vec3 => [
        x + tx * uu + nx * v,
        y,
        z + tz * uu + nz * v,
      ];

      /** 局部轴对齐方块：u 沿河、v 为带符号的横向偏移 */
      const box = (u0: number, u1: number, v0: number, v1: number, y0: number, y1: number): void => {
        const vLo = Math.min(v0, v1);
        const vHi = Math.max(v0, v1);
        quad(P(u0, vLo, y1), P(u0, vHi, y1), P(u1, vHi, y1), P(u1, vLo, y1));
        quad(P(u0, vLo, y0), P(u1, vLo, y0), P(u1, vHi, y0), P(u0, vHi, y0));
        quad(P(u0, vHi, y1), P(u0, vHi, y0), P(u1, vHi, y0), P(u1, vHi, y1));
        quad(P(u0, vLo, y1), P(u1, vLo, y1), P(u1, vLo, y0), P(u0, vLo, y0));
        quad(P(u1, vLo, y1), P(u1, vHi, y1), P(u1, vHi, y0), P(u1, vLo, y0));
        quad(P(u0, vLo, y1), P(u0, vLo, y0), P(u0, vHi, y0), P(u0, vHi, y1));
      };

      // 3 级入水石阶：自岸边向水面逐级降低
      // 起点内缩 4cm，避开与压顶临水竖面共面导致的深度冲突
      for (let k = 0; k < 3; k += 1) {
        const vNear = sign * (COPING_INNER - 0.04 - k * STEP_DEPTH);
        const vFar = sign * (COPING_INNER - 0.04 - (k + 1) * STEP_DEPTH);
        const topY = COPING_Y - 0.012 - k * STEP_DROP;
        box(u - uHalf, u + uHalf, vNear, vFar, STEP_BASE_Y, topY);
      }

      // 系船石：河埠头两端的小石柱
      for (const side of [-1, 1] as const) {
        const cu = u + side * (uHalf - 0.32);
        const vCenter = sign * (COPING_INNER - 0.55);
        box(
          cu - 0.17,
          cu + 0.17,
          vCenter - 0.17,
          vCenter + 0.17,
          COPING_Y - 0.03,
          COPING_Y + MOOR_H,
        );
      }

      siteIndex += 1;
      d += LANDING_SPACING * (0.8 + hash(d * 0.07) * 0.4);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}
