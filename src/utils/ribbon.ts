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
  /**
   * 逐顶点高度：用于高架/立交桥面的引桥上下坡。
   * 传入折线在入参数组里的序号、去重后的折线、顶点序号、沿路里程与该线总长。
   */
  heightAtVertex?: (
    lineIndex: number,
    line: LocalPoint2[],
    index: number,
    along: number,
    total: number,
  ) => number;
  /**
   * 端口圆头：给真正断头的端口补一个半圆，让收口是圆顺的。
   * 传函数时按（折线下标、是否起点、端点坐标）逐端判断——
   * 接在别的路上的端头绝不能补圆头，否则半圆会从路口外侧鼓出一个"肉瘤"，
   * 俯视就是路口上一块圆形/方形凸起。
   */
  endCaps?: boolean | ((lineIndex: number, atStart: boolean, x: number, z: number) => boolean);
  /**
   * 逐线高度层：重叠路面必须靠确定性的层高分开，
   * 不能各线自己随机抖动——两条同宽路面恰好落在同一高度就会闪烁。
   */
  lineLift?: (lineIndex: number) => number;
  /**
   * 逐顶点半宽：窄路汇入宽路时，端部要把路幅平滑放大成"喇叭口"，
   * 否则 11m 支路直接怼在 26m 主干上，边缘是硬的直角台阶。
   */
  halfAt?: (lineIndex: number, index: number, along: number, total: number) => number;
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

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    // 去重：连续重复点会让 miter 方向退化
    const line: LocalPoint2[] = [];
    for (const p of rawLine) {
      const last = line[line.length - 1];
      if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 0.05) line.push(p);
    }
    if (line.length < 2) continue;

    const n = line.length;
    // 每条带面一个整体高度偏移：优先用调用方给的确定性层高（重叠路面靠它分前后），
    // 没给才退回低差异序列。随机抖动会让两条线偶然落到同一高度，远看就是闪烁。
    const lift = options.lineLift
      ? options.lineLift(lineIndex)
      : 0.004 + ((strip * 0.6180339887) % 1) * 0.026;
    strip += 1;

    const left: Array<[number, number, number]> = [];
    const right: Array<[number, number, number]> = [];
    /** 沿路累计里程（米）：标线相位与高架引桥坡度都用它 */
    const along: number[] = [0];
    for (let i = 1; i < n; i += 1) {
      along.push(
        along[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]),
      );
    }
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
      // miter 长度 = half / cos(半转角)。钳制在 1.43 倍（cos≥0.7）：
      // 更尖的转角不再向外甩长刺，宁可让外缘略短一点，也不在路口出现针尖
      const cos = Math.max(0.7, mx * n1[0] + mz * n1[1]);
      const h = options.halfAt ? options.halfAt(lineIndex, i, along[i], along[n - 1]) : half;
      const scale = h / cos;

      const baseY = options.heightAtVertex
        ? options.heightAtVertex(lineIndex, line, i, along[i], along[n - 1])
        : typeof y === 'number'
          ? y
          : y(x, z);
      const vy = baseY + lift;
      left.push([x + mx * scale, vy, z + mz * scale]);
      right.push([x - mx * scale, vy, z - mz * scale]);
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

    const caps = options.endCaps;
    const capStart =
      caps === true || (typeof caps === 'function' && caps(lineIndex, true, line[0][0], line[0][1]));
    const capEnd =
      caps === true ||
      (typeof caps === 'function' && caps(lineIndex, false, line[n - 1][0], line[n - 1][1]));
    if (capStart || capEnd) {
      const CAP_SEG = 12;
      /** 三角形按"法线朝上"补绕序，避免端头出现背光黑面 */
      const pushCapTriangle = (
        cx: number, cy: number, cz: number,
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
      ) => {
        const ux = ax - cx;
        const uy = ay - cy;
        const uz = az - cz;
        const wx = bx - cx;
        const wy = by - cy;
        const wz = bz - cz;
        const ny = uz * wx - ux * wz;
        if (ny >= 0) positions.push(cx, cy, cz, ax, ay, az, bx, by, bz);
        else positions.push(cx, cy, cz, bx, by, bz, ax, ay, az);
        uvs.push(0.5, 0.5, 0.5, 0.5, 0.5, 0.5);
        if (options.roadUV) {
          // 端头不放标线：遮罩写 0，着色器直接跳过
          roadUVs.push(0.5, 0, 0, 0.5, 0, 0, 0.5, 0, 0);
        }
      };
      const capAt = (px: number, pz: number, py: number, tx: number, tz: number, out: number, h: number) => {
        // 左法线 (-tz, tx)；out = ±1 表示朝起点外侧( -1 )还是终点外侧( +1 )
        const nx = -tz;
        const nz = tx;
        const ox = tx * out;
        const oz = tz * out;
        const pts: Array<[number, number]> = [];
        for (let k = 0; k <= CAP_SEG; k += 1) {
          const ang = (Math.PI * k) / CAP_SEG;
          const c = Math.cos(ang) * h;
          const s = Math.sin(ang) * h;
          pts.push([px + nx * c + ox * s, pz + nz * c + oz * s]);
        }
        for (let k = 0; k < CAP_SEG; k += 1) {
          const a = pts[k];
          const b = pts[k + 1];
          pushCapTriangle(px, py, pz, a[0], py, a[1], b[0], py, b[1]);
        }
      };
      if (capStart) {
        const t0x = line[1][0] - line[0][0];
        const t0z = line[1][1] - line[0][1];
        const l0 = Math.hypot(t0x, t0z) || 1;
        const h0 = options.halfAt ? options.halfAt(lineIndex, 0, 0, along[n - 1]) : half;
        capAt(line[0][0], line[0][1], left[0][1], t0x / l0, t0z / l0, -1, h0);
      }

      if (capEnd) {
        const t1x = line[n - 1][0] - line[n - 2][0];
        const t1z = line[n - 1][1] - line[n - 2][1];
        const l1 = Math.hypot(t1x, t1z) || 1;
        const h1 = options.halfAt
          ? options.halfAt(lineIndex, n - 1, along[n - 1], along[n - 1])
          : half;
        capAt(line[n - 1][0], line[n - 1][1], left[n - 1][1], t1x / l1, t1z / l1, 1, h1);
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
