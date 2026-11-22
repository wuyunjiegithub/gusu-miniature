﻿import { useMemo } from 'react';
import * as THREE from 'three';
import { useRoads } from '../hooks/useRoads';
import { useSandTable } from '../store/useSandTable';
import { buildRibbons } from '../utils/ribbon';
import { roadSurfaceY } from '../data/outerCity';
import { clipLinesToRadius } from '../utils/clip';
import { WORLD_LIMIT } from '../constants/geo';
import type { LocalPoint2 } from '../types';

/** 道路面高（米）：抬高以避免远视距下的深度冲突 */
const MINOR_ROAD_Y = 1.2;
/** 主干道再抬高 0.18m：与支路在路口重叠时由深度缓冲稳定分出前后，避免共面闪烁 */
const MAJOR_ROAD_Y = 1.38;
const MAJOR_WIDTH = 26;
const MINOR_WIDTH = 11;
/** 高架引桥长度（米）：桥面从地面抬到净高、末端再落回地面 */
const OVERPASS_RAMP = 55;
/** 桥墩间距与截面宽度（米） */
const PIER_SPACING = 22;
const PIER_WIDTH_MAJOR = 5.2;
const PIER_WIDTH_MINOR = 3.4;

interface ElevatedLine {
  line: LocalPoint2[];
  h: number;
  /** 两组端头标高：0 = 引桥落地，>0 = 与相邻高架 way 对接的接缝高程 */
  endH?: [number, number];
}

/**
 * 高架纵断面：两端高度 h0 / h1（0 = 引桥落地），中段升到桥面净高 peak。
 * OSM 把一条连续高架拆成多段 bridge way，若每段都按"两端落地"起坡，
 * 整条高架会在 way 交界处反复下凹回地面；相邻段焊接后把接缝高度传进来，
 * 桥面就能连续通过。
 */
function elevatedProfile(
  along: number,
  total: number,
  peak: number,
  h0: number,
  h1: number,
): number {
  const ramp = Math.min(OVERPASS_RAMP, Math.max(total / 2, 1));
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const s0 = smooth(Math.min(1, along / ramp));
  const s1 = smooth(Math.min(1, (total - along) / ramp));
  return Math.min(h0 + (peak - h0) * s0, h1 + (peak - h1) * s1);
}

/**
 * 路面标线着色器：车道线、虚实线全部按断面 UV 在片元里画，
 * 不新增任何几何；路网 1300km，用几何画标线会多出几十万三角形。
 */
const ROAD_VERTEX_PARS = /* glsl */ `
attribute vec3 aRoad;
varying vec3 vRoad;
`;

const ROAD_VERTEX_BODY = /* glsl */ `
  vRoad = aRoad;
`;

const ROAD_FRAGMENT_PARS = /* glsl */ `
varying vec3 vRoad;
uniform float uMarkFade;
uniform vec3 uMarkColor;
`;

const ROAD_FRAGMENT_BODY = /* glsl */ `
{
  float u = vRoad.x;
  float v = vRoad.y;
  // 路口遮罩：另一条同高路面压上来时，两套标线共面会一起闪，这里直接淡掉
  float junction = vRoad.z;
  // 横断面一像素的归一化宽度：细线边缘随它加宽，等价于解析抗锯齿。
  // 上限必须小：以前放到 0.16，远处一条边线被摊成 4m 宽的渐变，
  // 不透明度被稀释到几乎看不见，于是"要拉近才看得到标线"。
  float aaU = clamp(fwidth(u) * 1.6, 0.0025, 0.05);
  // 一像素跨过多少米路面：只用来轻微降对比，不再让标线整体消失
  float metersPerPx = fwidth(v);
  float far = smoothstep(0.5, 2.2, metersPerPx);
  float mask = uMarkFade * junction * mix(1.0, 0.62, far);
  // 中心虚线是高频图案：远处按像素跨度淡出，避免摩尔纹与闪动
  float dashFade = 1.0 - smoothstep(0.45, 1.6, metersPerPx);

  if (mask > 0.001) {
    // 两侧车道边线（实线）
    float edge = 1.0 - smoothstep(0.016, 0.016 + aaU, abs(u - 0.055));
    edge = max(edge, 1.0 - smoothstep(0.016, 0.016 + aaU, abs(u - 0.945)));
    // 中心虚线：8m 周期，约 3m 实 / 5m 空（12m 在老城密路网里显得过于稀疏）
    float d = fract(v / 8.0);
    float dashMask = smoothstep(0.04, 0.10, d) * (1.0 - smoothstep(0.40, 0.46, d));
    float center = 1.0 - smoothstep(0.011, 0.011 + aaU, abs(u - 0.5));
    float mark = max(edge, center * dashMask * dashFade);
    diffuseColor.rgb = mix(diffuseColor.rgb, uMarkColor, clamp(mark, 0.0, 1.0) * mask);
  }
}
`;

/** 道路标线材质：在标准材质上注入标线绘制。桥面也复用同一套，保证过桥不丢标线 */
export function createRoadMaterial(baseColor: string, roughness: number, marking: string) {
  const mat = new THREE.MeshStandardMaterial({
    color: baseColor,
    roughness,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
  const uniforms = {
    uMarkFade: { value: 1 },
    uMarkColor: { value: new THREE.Color(marking) },
  };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMarkFade = uniforms.uMarkFade;
    shader.uniforms.uMarkColor = uniforms.uMarkColor;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ROAD_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${ROAD_VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ROAD_FRAGMENT_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${ROAD_FRAGMENT_BODY}`);
  };
  mat.customProgramCacheKey = () => 'road-marking';
  return mat;
}

/**
 * 标线遮罩：顶点到"任意同高路面中心线"的最近距离。
 * 带状面顶点距自身中心线恰好半宽（half），所以 minDist < half 就说明这里
 * 被另一条同高路面压住了（路口、并线、短接），标线在此淡出，
 * 避免两套标线共面叠加、俯视下一明一暗地闪。
 */
function buildMarkMask(lines: LocalPoint2[][], half: number): (x: number, z: number) => number {
  const CELL = 16;
  const cellKey = (ix: number, iz: number) => ix * 100000 + iz;
  const segs: { ax: number; az: number; bx: number; bz: number }[] = [];
  const grid = new Map<number, number[]>();

  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i += 1) {
      const [ax, az] = line[i];
      const [bx, bz] = line[i + 1];
      if (Math.hypot(bx - ax, bz - az) < 0.4) continue;
      const id = segs.push({ ax, az, bx, bz }) - 1;
      const x0 = Math.floor(Math.min(ax, bx) / CELL);
      const x1 = Math.floor(Math.max(ax, bx) / CELL);
      const z0 = Math.floor(Math.min(az, bz) / CELL);
      const z1 = Math.floor(Math.max(az, bz) / CELL);
      for (let ix = x0; ix <= x1; ix += 1)
        for (let iz = z0; iz <= z1; iz += 1) {
          const k = cellKey(ix, iz);
          let bucket = grid.get(k);
          if (!bucket) grid.set(k, (bucket = []));
          bucket.push(id);
        }
    }
  }

  const lo = half - 0.6;
  const hi = half + 1.2;
  return (x, z) => {
    const ix0 = Math.floor((x - hi) / CELL);
    const ix1 = Math.floor((x + hi) / CELL);
    const iz0 = Math.floor((z - hi) / CELL);
    const iz1 = Math.floor((z + hi) / CELL);
    let best = Infinity;
    for (let ix = ix0; ix <= ix1; ix += 1) {
      for (let iz = iz0; iz <= iz1; iz += 1) {
        const bucket = grid.get(cellKey(ix, iz));
        if (!bucket) continue;
        for (const id of bucket) {
          const s = segs[id];
          const dx = s.bx - s.ax;
          const dz = s.bz - s.az;
          const l2 = dx * dx + dz * dz;
          let t = l2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(x - s.ax - t * dx, z - s.az - t * dz);
          if (d < best) {
            best = d;
            if (best <= lo) return 0;
          }
        }
      }
    }
    if (best >= hi) return 1;
    const k = (best - lo) / (hi - lo);
    return k * k * (3 - 2 * k);
  };
}

/** 重叠路面分层步长与层数：同宽道路相交必须靠确定层高分开，否则远看就是闪烁 */
const LAYER_STEP = 0.02;
/** 兜底上限：正常着色不会用满，超过说明冲突图异常 */
const MAX_LAYERS = 8;
/** 主干整体再抬 3cm：城外路面高度会收敛到同一值，靠它保持主/支分离 */
const MAJOR_LIFT = 0.03;
/** 窄路汇入宽路：末尾 FLARE_LEN 米把路幅平滑放大成喇叭口 */
const FLARE_LEN = 34;
const FLARE_GAIN = 0.5;

interface EndInfo {
  /** 端点是否已压在别的路上 */
  attached: boolean;
  /** 汇入宽路时的渐扩长度（米），0 表示不扩 */
  flare: number;
  /** 喇叭口末端的目标半宽：端对端焊接取对方半宽，T 接只放大 1.5 倍 */
  target: number;
}

interface RoadJoin {
  /** 焊接/收头之后的折线（渲染与标线遮罩都必须用这一份） */
  major: LocalPoint2[][];
  minor: LocalPoint2[][];
  capMajor: (li: number, atStart: boolean, x: number, z: number) => boolean;
  capMinor: (li: number, atStart: boolean, x: number, z: number) => boolean;
  halfMajor: (li: number, index: number, along: number, total: number) => number;
  halfMinor: (li: number, index: number, along: number, total: number) => number;
  liftMajor: (li: number) => number;
  liftMinor: (li: number) => number;
}

/** 两条 2D 线段的最近距离平方（Ericson《Real-Time Collision Detection》标准解法） */
function segSegDist2(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): number {
  const d1x = bx - ax;
  const d1z = bz - az;
  const d2x = dx - cx;
  const d2z = dz - cz;
  const rx = ax - cx;
  const rz = az - cz;
  const a = d1x * d1x + d1z * d1z;
  const e = d2x * d2x + d2z * d2z;
  const f = d2x * rx + d2z * rz;
  let s = 0;
  let t = 0;
  if (a <= 1e-9) {
    t = e <= 1e-9 ? 0 : Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1x * rx + d1z * rz;
    if (e <= 1e-9) {
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = d1x * d2x + d1z * d2z;
      const denom = a * e - b * b;
      s = denom !== 0 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  const px = ax + d1x * s - (cx + d2x * t);
  const pz = az + d1z * s - (cz + d2z * t);
  return px * px + pz * pz;
}

/**
 * 同宽折线之间的重叠检测 → Welsh–Powell 着色。
 * 两条路中心线距离小于两者半宽之和时，它们的带状面一定重叠；
 * 给重叠的一对分配不同层号，层高 = 层号 × LAYER_STEP，深度缓冲才能稳定分前后。
 *
 * 旧实现沿线段每 10m 打点近似，短的重叠段会漏检，漏检的两条线就可能落在同一层、
 * 在远处一明一暗地闪；这里改成线段对线段的精确最短距离，再按冲突度降序上色，
 * 把需要的层数压到接近最优（旧顺序贪心经常顶到上限后强行同层）。
 */
function colorLayers(lines: LocalPoint2[][], half: number): number[] {
  /** 两条带面可能重叠的最远中心线距离（留 2m 余量给喇叭口） */
  const reach = half * 2 + 2;
  /** 双向各扩一半：距离 ≤ reach 的两段必然落进同一格 */
  const expand = reach / 2;
  const CELL = Math.max(24, half * 1.5);
  const key = (ix: number, iz: number) => ix * 100000 + iz;

  type Seg = { ax: number; az: number; bx: number; bz: number; li: number };
  const segs: Seg[] = [];
  const grid = new Map<number, number[]>();

  lines.forEach((line, li) => {
    for (let i = 0; i < line.length - 1; i += 1) {
      const [ax, az] = line[i];
      const [bx, bz] = line[i + 1];
      if (Math.hypot(bx - ax, bz - az) < 0.4) continue;
      const id = segs.push({ ax, az, bx, bz, li }) - 1;
      const x0 = Math.floor((Math.min(ax, bx) - expand) / CELL);
      const x1 = Math.floor((Math.max(ax, bx) + expand) / CELL);
      const z0 = Math.floor((Math.min(az, bz) - expand) / CELL);
      const z1 = Math.floor((Math.max(az, bz) + expand) / CELL);
      for (let ix = x0; ix <= x1; ix += 1)
        for (let iz = z0; iz <= z1; iz += 1) {
          const k = key(ix, iz);
          let bucket = grid.get(k);
          if (!bucket) grid.set(k, (bucket = []));
          bucket.push(id);
        }
    }
  });

  const conflict: Set<number>[] = lines.map(() => new Set<number>());
  const limit2 = reach * reach;
  /** 同一段对多条查询段只判定一次 */
  const stamp = new Int32Array(segs.length).fill(-1);
  for (let id = 0; id < segs.length; id += 1) {
    const s = segs[id];
    const x0 = Math.floor(Math.min(s.ax, s.bx) / CELL);
    const x1 = Math.floor(Math.max(s.ax, s.bx) / CELL);
    const z0 = Math.floor(Math.min(s.az, s.bz) / CELL);
    const z1 = Math.floor(Math.max(s.az, s.bz) / CELL);
    for (let ix = x0; ix <= x1; ix += 1)
      for (let iz = z0; iz <= z1; iz += 1) {
        const bucket = grid.get(key(ix, iz));
        if (!bucket) continue;
        for (let bi = 0; bi < bucket.length; bi += 1) {
          const oid = bucket[bi];
          if (oid === id || stamp[oid] === id) continue;
          stamp[oid] = id;
          const o = segs[oid];
          if (o.li === s.li) continue;
          if (segSegDist2(s.ax, s.az, s.bx, s.bz, o.ax, o.az, o.bx, o.bz) <= limit2) {
            conflict[s.li].add(o.li);
            conflict[o.li].add(s.li);
          }
        }
      }
  }

  // DSATUR：每次挑"已用邻居色最多"的线先上色，比按固定顺序贪心省层。
  // 饱和度增量维护，避免每步都为所有点重建集合（1776 条线的平方级扫描已经够慢）。
  const adj = conflict.map((s) => [...s]);
  const layers = new Array<number>(lines.length).fill(-1);
  const sat: Set<number>[] = lines.map(() => new Set<number>());
  const deg = adj.map((a) => a.length);
  const used = new Set<number>();
  let remaining = lines.length;
  while (remaining > 0) {
    let pick = -1;
    let bestSat = -1;
    let bestDeg = -1;
    for (let v = 0; v < lines.length; v += 1) {
      if (layers[v] >= 0) continue;
      const s = sat[v].size;
      if (s > bestSat || (s === bestSat && deg[v] > bestDeg)) {
        pick = v;
        bestSat = s;
        bestDeg = deg[v];
      }
    }
    used.clear();
    for (const other of adj[pick]) if (layers[other] >= 0) used.add(layers[other]);
    let c = 0;
    while (used.has(c)) c += 1;
    layers[pick] = Math.min(c, MAX_LAYERS - 1);
    for (const other of adj[pick]) if (layers[other] < 0) sat[other].add(layers[pick]);
    remaining -= 1;
  }
  return layers;
}

/** 折线总长（米） */
function polylineLength(line: LocalPoint2[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i += 1)
    total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return total;
}

/** 末端点 + 指向道路内部的单位方向（跳过 <0.6m 的微段，避免方向抖动） */
function polylineEnd(line: LocalPoint2[], atStart: boolean) {
  const n = line.length;
  if (n < 2) return null;
  const iEnd = atStart ? 0 : n - 1;
  const p = line[iEnd];
  for (let j = iEnd + (atStart ? 1 : -1); j >= 0 && j < n; j += atStart ? 1 : -1) {
    const dx = line[j][0] - p[0];
    const dz = line[j][1] - p[1];
    const l = Math.hypot(dx, dz);
    if (l > 0.6) return { p, dir: [dx / l, dz / l] as [number, number] };
  }
  return null;
}

/**
 * 折线圆角拟合：OSM 把弯道画成几段直线，11~26m 宽的路面经过这些拐点时会
 * 出现硬折角、内侧挤成楔形缺口、外侧被 miter 甩出尖刺（截图里支路汇入前
 * 那一拐最明显）。这里只对转角超过 ROUND_TURN 的顶点做二次贝塞尔圆角：
 * 圆弧两端沿相邻直线段切入，与原折线 G1 连续；转角很小的密集点原样保留，
 * 不改变直路与圆滑曲线的现状。半径取两侧段长的一半（上限 14m），
 * 因此密集采样的曲线几乎不动，只有真正的折角被"拟合"成弯。
 */
const ROUND_TURN = (22 * Math.PI) / 180;
function roundCorners(line: LocalPoint2[], steps = 5, maxRadius = 14): LocalPoint2[] {
  const n = line.length;
  if (n < 3) return line;
  const out: LocalPoint2[] = [line[0]];
  for (let i = 1; i < n - 1; i += 1) {
    const a = line[i - 1];
    const v = line[i];
    const b = line[i + 1];
    const l1 = Math.hypot(v[0] - a[0], v[1] - a[1]);
    const l2 = Math.hypot(b[0] - v[0], b[1] - v[1]);
    if (l1 < 0.3 || l2 < 0.3) {
      out.push(v);
      continue;
    }
    const u1x = (v[0] - a[0]) / l1;
    const u1z = (v[1] - a[1]) / l1;
    const u2x = (b[0] - v[0]) / l2;
    const u2z = (b[1] - v[1]) / l2;
    const turn = Math.acos(Math.max(-1, Math.min(1, u1x * u2x + u1z * u2z)));
    if (turn < ROUND_TURN) {
      out.push(v);
      continue;
    }
    const rr = Math.min(l1 * 0.48, l2 * 0.48, maxRadius);
    const p0: LocalPoint2 = [v[0] - u1x * rr, v[1] - u1z * rr];
    const p2: LocalPoint2 = [v[0] + u2x * rr, v[1] + u2z * rr];
    out.push(p0);
    for (let k = 1; k < steps; k += 1) {
      const t = k / steps;
      const mt = 1 - t;
      out.push([
        mt * mt * p0[0] + 2 * mt * t * v[0] + t * t * p2[0],
        mt * mt * p0[1] + 2 * mt * t * v[1] + t * t * p2[1],
      ]);
    }
    out.push(p2);
  }
  out.push(line[n - 1]);
  return out;
}

/** 从末端沿道路退 dist 米，返回切点 p 与剩下的点（含紧邻切点的内点） */
function cutPolylineEnd(line: LocalPoint2[], atStart: boolean, dist: number) {
  const n = line.length;
  // 2 点直线也要能切：OSM 里大量连接支路只有首尾两点。
  if (n < 2) return null;
  let i = atStart ? 0 : n - 1;
  let acc = 0;
  for (;;) {
    const j = i + (atStart ? 1 : -1);
    if (j < 0 || j >= n) return null;
    const a = line[i];
    const b = line[j];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d > 1e-6 && acc + d >= dist) {
      const t = (dist - acc) / d;
      const p: LocalPoint2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const keep = atStart ? line.slice(j) : line.slice(0, i);
      // 只有两个端点的短 way（OSM 里大量连接支路就是这种）也必须能焊：
      // 以前这里要求 keep ≥ 2 点，2 点线直接返回 null，于是这些支路的方端头
      // 永远接不上，路口就留一个方头台阶/内角缺口。
      if (keep.length < 1) return null;
      return { p, keep };
    }
    acc += d;
    i = j;
  }
}

/**
 * 端头补口时把折角抹圆。
 * 补缺口/并排收口是沿"指向对方"的方向直接追加一个端点，若该方向与道路
 * 入端方向不一致，中心线就在原端头处拐一个硬角；在喇叭口宽度（半宽可到
 * 8m 以上）下，内缘会折出一个可见的三角缺口，外缘甩出尖刺，边线随之
 * 扭成浅色楔形。这里把端头最后 leg 米换成一段以原端头为控制点的二次
 * 贝塞尔，出入方向都保持切向连续，边线自然过渡。
 */
function extendRounded(
  line: LocalPoint2[],
  atStart: boolean,
  p2: LocalPoint2,
  leg: number,
): LocalPoint2[] {
  const cut = cutPolylineEnd(line, atStart, Math.min(leg, polylineLength(line) * 0.45));
  if (!cut) return atStart ? [p2, ...line] : [...line, p2];
  const p0 = atStart ? line[0] : line[line.length - 1];
  const STEPS = 6;
  const curve: LocalPoint2[] = [cut.p];
  for (let i = 1; i <= STEPS; i += 1) {
    const t = i / STEPS;
    const mt = 1 - t;
    curve.push([
      mt * mt * cut.p[0] + 2 * mt * t * p0[0] + t * t * p2[0],
      mt * mt * cut.p[1] + 2 * mt * t * p0[1] + t * t * p2[1],
    ]);
  }
  return atStart ? [...curve].reverse().concat(cut.keep) : cut.keep.concat(curve);
}

/**
 * 道路衔接处理。
 *   1. 端对端接头（两条 way 在同一点相接）：两侧末端各退 L 米，用同一条
 *      二次贝塞尔过渡，两条路的中心线在弯道里完全重合 —— 俯视不会再有
 *      "两个矩形交叉成十字"的台阶和缺口；
 *   2. 末端已经越过另一条路外缘（数据里常见 5~10m 的"出头"）：把末端收回
 *      对方路面内，路头不会从另一条路外侧戳出一块；
 *   3. 只有真正的断头才做圆头；
 *   4. 窄路汇入宽路做喇叭口，端对端焊接时宽度直接过渡到对方半宽；
 *   5. 重叠路面按冲突图分层（确定性 DSATUR）。
 */
function buildRoadJoin(majorLines: LocalPoint2[][], minorLines: LocalPoint2[][]): RoadJoin {
  const CELL = 24;
  type Seg = { ax: number; az: number; bx: number; bz: number; half: number; owner: number };

  /** 为一批折线建线段网格；返回"端点附近最近的一条别的路"查询函数 */
  const makeIndex = (majorArr: LocalPoint2[][], minorArr: LocalPoint2[][]) => {
    const segs: Seg[] = [];
    const grid = new Map<number, number[]>();
    const key = (ix: number, iz: number) => ix * 100000 + iz;
    const add = (lines: LocalPoint2[][], offset: number, half: number) => {
      lines.forEach((line, li) => {
        const owner = offset + li;
        for (let i = 0; i < line.length - 1; i += 1) {
          const [ax, az] = line[i];
          const [bx, bz] = line[i + 1];
          if (Math.hypot(bx - ax, bz - az) < 0.4) continue;
          const id = segs.push({ ax, az, bx, bz, half, owner }) - 1;
          for (let ix = Math.floor(Math.min(ax, bx) / CELL); ix <= Math.floor(Math.max(ax, bx) / CELL); ix += 1)
            for (let iz = Math.floor(Math.min(az, bz) / CELL); iz <= Math.floor(Math.max(az, bz) / CELL); iz += 1) {
              const k = key(ix, iz);
              let bucket = grid.get(k);
              if (!bucket) grid.set(k, (bucket = []));
              bucket.push(id);
            }
        }
      });
    };
    add(majorArr, 0, MAJOR_WIDTH / 2);
    add(minorArr, majorArr.length, MINOR_WIDTH / 2);

    return (owner: number, x: number, z: number, skip?: Set<number>) => {
      // 搜索半径要覆盖"宽路半宽 + 一定余量"：以前固定 16m，26m 宽的主干道
      // 端头只要冲出对方路面 3m 以上就再也查不到对方路，收头/补口全部失效，
      // 端头于是被安上半圆端帽，俯视就是一个戳出路口的大圆头。
      const reach = 30;
      let best: {
        d: number;
        half: number;
        qx: number;
        qz: number;
        owner: number;
        tx: number;
        tz: number;
      } | null = null;
      for (let ix = Math.floor((x - reach) / CELL); ix <= Math.floor((x + reach) / CELL); ix += 1) {
        for (let iz = Math.floor((z - reach) / CELL); iz <= Math.floor((z + reach) / CELL); iz += 1) {
          const bucket = grid.get(key(ix, iz));
          if (!bucket) continue;
          for (const id of bucket) {
            const s = segs[id];
            if (s.owner === owner || skip?.has(s.owner)) continue;
            const dx = s.bx - s.ax;
            const dz = s.bz - s.az;
            const l2 = dx * dx + dz * dz;
            let t = l2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = s.ax + t * dx;
            const qz = s.az + t * dz;
            const d = Math.hypot(x - qx, z - qz);
            if (!best || d < best.d) {
              const len = Math.sqrt(l2) || 1;
              best = { d, half: s.half, qx, qz, owner: s.owner, tx: dx / len, tz: dz / len };
            }
          }
        }
      }
      return best;
    };
  };

  const totalOf = polylineLength;

  /** 末端点 + 指向道路内部的单位方向 */
  const endInfoOf = polylineEnd;

  /** 从末端沿道路退 dist 米 */
  const cutEnd = cutPolylineEnd;

  /** 从末端沿道路向内 dist 米的点（按里程线性插值） */
  const pointAlong = (line: LocalPoint2[], atStart: boolean, dist: number): LocalPoint2 | null => {
    const n = line.length;
    let acc = 0;
    for (let k = 1; k < n; k += 1) {
      const a = atStart ? line[k - 1] : line[n - k];
      const b = atStart ? line[k] : line[n - k - 1];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (acc + seg >= dist) {
        const t = seg > 1e-6 ? (dist - acc) / seg : 0;
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
      acc += seg;
    }
    return null;
  };

  type EndRec = {
    kind: 'major' | 'minor';
    li: number;
    atStart: boolean;
    p: LocalPoint2;
    dir: [number, number];
    half: number;
    key: string;
  };
  const ends: EndRec[] = [];
  const collect = (kind: 'major' | 'minor', lines: LocalPoint2[][]) => {
    const half = (kind === 'major' ? MAJOR_WIDTH : MINOR_WIDTH) / 2;
    lines.forEach((line, li) => {
      for (const atStart of [true, false]) {
        const info = endInfoOf(line, atStart);
        if (!info) continue;
        ends.push({ kind, li, atStart, p: info.p, dir: info.dir, half, key: `${kind}:${li}:${atStart ? 1 : 0}` });
      }
    });
  };
  collect('major', majorLines);
  collect('minor', minorLines);

  // 端对端配对：两端距离 ≤8m、朝向相反（两端的"驶入方向"夹角即弯道转角 ≤75°）
  const byKey = new Map(ends.map((e) => [e.key, e]));
  const partner = new Map<string, EndRec>();
  for (const a of ends) {
    let best: EndRec | null = null;
    let bestD = Infinity;
    for (const b of ends) {
      if (b === a || (b.kind === a.kind && b.li === a.li)) continue;
      const d = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]);
      if (d > 8 || d >= bestD) continue;
      // dir 指向各自道路内部；两端面对面时方向应相反
      if (a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] > -0.5) continue;
      const tx = -a.dir[0];
      const tz = -a.dir[1];
      const turn = (Math.acos(Math.max(-1, Math.min(1, tx * b.dir[0] + tz * b.dir[1]))) * 180) / Math.PI;
      if (turn > 75) continue;
      best = b;
      bestD = d;
    }
    if (best) partner.set(a.key, best);
  }
  const pairs: Array<[EndRec, EndRec]> = [];
  for (const [k, b] of partner) {
    if (partner.get(b.key)?.key === k) {
      const a = byKey.get(k);
      if (a) pairs.push([a, b]);
    }
  }

  /** 焊接结果：每条线整条替换（一条线最多参与一个接头，避免两端互吃） */
  const weldedMajor: Array<LocalPoint2[] | null> = majorLines.map(() => null);
  const weldedMinor: Array<LocalPoint2[] | null> = minorLines.map(() => null);
  const weldedKeys = new Set<string>();
  const linesOf = (kind: 'major' | 'minor') => (kind === 'major' ? majorLines : minorLines);
  const slotsOf = (kind: 'major' | 'minor') => (kind === 'major' ? weldedMajor : weldedMinor);
  const bez = (t: number, p0: LocalPoint2, c: LocalPoint2, p1: LocalPoint2): LocalPoint2 => {
    const mt = 1 - t;
    return [
      mt * mt * p0[0] + 2 * mt * t * c[0] + t * t * p1[0],
      mt * mt * p0[1] + 2 * mt * t * c[1] + t * t * p1[1],
    ];
  };

  const weldPair = (a: EndRec, b: EndRec) => {
    const slotsA = slotsOf(a.kind);
    const slotsB = slotsOf(b.kind);
    if (slotsA[a.li] || slotsB[b.li]) return false;
    const lineA = linesOf(a.kind)[a.li];
    const lineB = linesOf(b.kind)[b.li];
    const cutA = cutEnd(lineA, a.atStart, Math.min(a.half * 2.2, 22, totalOf(lineA) * 0.45));
    const cutB = cutEnd(lineB, b.atStart, Math.min(b.half * 2.2, 22, totalOf(lineB) * 0.45));
    if (!cutA || !cutB) return false;
    // 控制点取两条切线（沿各自道路向内）的交点：这样贝塞尔在 cutA / cutB 两端
    // 都与原道路同切（G1），拐角是一条真正的圆顺弧。
    // 以前控制点取两个端点的中点，90° 弯时弧线整体缩在拐角内侧，两端切向各偏
    // 几十度，焊口处会折出尖角/台阶——就是截图里支路汇入主路前的硬边。
    const da: [number, number] = [-a.dir[0], -a.dir[1]];
    const db: [number, number] = [-b.dir[0], -b.dir[1]];
    const ex = cutB.p[0] - cutA.p[0];
    const ez = cutB.p[1] - cutA.p[1];
    const den = da[0] * db[1] - da[1] * db[0];
    let control: LocalPoint2 = [(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2];
    const span0 = Math.hypot(ex, ez);
    if (Math.abs(den) > 0.08) {
      const t = (ex * db[1] - ez * db[0]) / den;
      // 近平行时交点在很远的地方，圆弧会鼓成一个大包，退回中点
      if (t > 0 && t < span0 * 1.2 + 2) {
        control = [cutA.p[0] + da[0] * t, cutA.p[1] + da[1] * t];
      }
    }
    const span = Math.hypot(cutB.p[0] - cutA.p[0], cutB.p[1] - cutA.p[1]);
    const steps = Math.max(6, Math.ceil(span / 2.5));
    const mid = Math.floor(steps / 2);
    const curve: LocalPoint2[] = [];
    for (let i = 0; i <= steps; i += 1) curve.push(bez(i / steps, cutA.p, control, cutB.p));
    const first = curve.slice(0, mid + 1);
    const second = curve.slice(mid);
    slotsA[a.li] = a.atStart ? [...first].reverse().concat(cutA.keep) : cutA.keep.concat(first);
    slotsB[b.li] = b.atStart ? second.concat(cutB.keep) : cutB.keep.concat([...second].reverse());
    weldedKeys.add(a.key);
    weldedKeys.add(b.key);
    return true;
  };

  /**
   * 尖角（>75° 转角、环路口）焊接：把两条路并成"一条"折线，而不是各留一半圆弧。
   * 各留一半时，两条带状面在拐点处各有一个垂直于自身走向的平端头：外角露出
   * 一块三角地面，内角两层路面叠出一个尖喙——就是俯视截图里支路拐弯处被咬掉
   * 一块、还戳出一个亮尖的缺陷。并成单条折线后，带状面在拐点自己用 miter +
   * 圆弧拟合出连续外缘，外角被补齐、内角不再重叠。
   */
  const mergeSharpPair = (a: EndRec, b: EndRec) => {
    const slotsA = slotsOf(a.kind);
    const slotsB = slotsOf(b.kind);
    if (slotsA[a.li] || slotsB[b.li]) return false;
    const lineA = linesOf(a.kind)[a.li];
    const lineB = linesOf(b.kind)[b.li];
    const cutA = cutEnd(lineA, a.atStart, Math.min(a.half * 2.2, 22, totalOf(lineA) * 0.45));
    const cutB = cutEnd(lineB, b.atStart, Math.min(b.half * 2.2, 22, totalOf(lineB) * 0.45));
    if (!cutA || !cutB) return false;
    const da: [number, number] = [-a.dir[0], -a.dir[1]];
    const db: [number, number] = [-b.dir[0], -b.dir[1]];
    const ex = cutB.p[0] - cutA.p[0];
    const ez = cutB.p[1] - cutA.p[1];
    const den = da[0] * db[1] - da[1] * db[0];
    let control: LocalPoint2 = [(cutA.p[0] + cutB.p[0]) / 2, (cutA.p[1] + cutB.p[1]) / 2];
    const span0 = Math.hypot(ex, ez);
    if (Math.abs(den) > 0.08) {
      const t = (ex * db[1] - ez * db[0]) / den;
      if (t > 0 && t < span0 * 1.2 + 2) {
        control = [cutA.p[0] + da[0] * t, cutA.p[1] + da[1] * t];
      }
    }
    const span = Math.hypot(ex, ez);
    // 采样密一点：11~26m 宽的路面在 90° 转角半径只有 ~8m，2.5m 一段时
    // 外缘会看成几段直线；1.2m 一段后外缘与边线都是连续弧。
    const steps = Math.max(10, Math.ceil(span / 1.2));
    const curve: LocalPoint2[] = [];
    for (let i = 0; i <= steps; i += 1) curve.push(bez(i / steps, cutA.p, control, cutB.p));
    // 统一成"从 A 远端 → cutA → 圆弧 → cutB → B 远端"
    const aOut = a.atStart ? [...cutA.keep].reverse() : cutA.keep;
    const bOn = b.atStart ? cutB.keep : [...cutB.keep].reverse();
    slotsA[a.li] = [...aOut, ...curve, ...bOn];
    slotsB[b.li] = [];
    // 拐点已并入中心线内部，不再是端点；不要把拐点的 key 记进 weldedKeys，
    // 否则会与合并后那条线"远端"的 key（同一条线的另一侧）撞号，远端会被
    // 误判成已焊接而跳过收头/补口。
    return true;
  };

  for (const [a, b] of pairs) weldPair(a, b);

  /**
   * 尖角收口：环路口、V 形转角这类 >75° 的端对端接头，平滑焊接条件会整体跳过，
   * 两条路的平面端头之间就留下一个楔形缺口（俯视能看到地面）。
   * 只在"该节点恰好只有这两个自由端头、且没有第三条路从中间穿过"时才补，
   * 否则是 T 形路口，硬接会把路口拉歪。
   */
  const ownerOf = (e: EndRec) => (e.kind === 'major' ? 0 : majorLines.length) + e.li;
  const freeEnds = ends.filter((e) => !weldedKeys.has(e.key));
  const nearCount = new Map<string, number>();
  for (let i = 0; i < freeEnds.length; i += 1) {
    for (let j = i + 1; j < freeEnds.length; j += 1) {
      const a = freeEnds[i];
      const b = freeEnds[j];
      if (a.kind === b.kind && a.li === b.li) continue;
      if (Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]) > 12) continue;
      nearCount.set(a.key, (nearCount.get(a.key) ?? 0) + 1);
      nearCount.set(b.key, (nearCount.get(b.key) ?? 0) + 1);
    }
  }

  const nearestPre = makeIndex(majorLines, minorLines);
  const sharpUsed = new Set<string>();
  let sharpCount = 0;
  for (const a of freeEnds) {
    if (nearCount.get(a.key) !== 1 || sharpUsed.has(a.key)) continue;
    let best: EndRec | null = null;
    let bestD = Infinity;
    for (const b of freeEnds) {
      if (b === a || b.kind !== a.kind || b.li === a.li) continue;
      const d = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]);
      if (d > 8 || d >= bestD) continue;
      const dot = a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1];
      if (dot > 0.97) continue; // 完全同向并排：交给下面的"并排端头"处理
      best = b;
      bestD = d;
    }
    if (!best || nearCount.get(best.key) !== 1) continue;
    const mx = (a.p[0] + best.p[0]) / 2;
    const mz = (a.p[1] + best.p[1]) / 2;
    const third = nearestPre(-1, mx, mz, new Set([ownerOf(a), ownerOf(best)]));
    if (third && third.d < Math.max(a.half, best.half) + 2) continue;
    if (!mergeSharpPair(a, best)) continue;
    sharpUsed.add(a.key);
    sharpUsed.add(best.key);
    sharpCount += 1;
  }

  let nextMajor = majorLines.map((line, li) => weldedMajor[li] ?? line);
  let nextMinor = minorLines.map((line, li) => weldedMinor[li] ?? line);
  if (import.meta.env?.DEV) console.info(`[road-join] 端对端焊接 ${weldedKeys.size / 2} 处（尖角 ${sharpCount}）`);

  // 收头：焊接会挪动中心线，所以按焊接后的几何重建索引。
  // 一个末端只要"自己或横断面的两个角"越过了对方路面外缘，就沿道路退回去，
  // 直到整条端边落在对方路面内 —— 俯视不会再出现从路口外侧戳出的小三角。
  let nearestW = makeIndex(nextMajor, nextMinor);

  // 并排断头：两条路在同一处收口、方向接近平行（环路收口、双幅路端头），
  // 两个平端头之间会露出一道缝。让两端朝彼此各补一小段，重叠 3m 后缝被盖住。
  const extendedKeys = new Set<string>();
  const currentOf = (kind: 'major' | 'minor') => (kind === 'major' ? nextMajor : nextMinor);
  for (const a of freeEnds) {
    if (weldedKeys.has(a.key) || extendedKeys.has(a.key) || nearCount.get(a.key) !== 1) continue;
    let best: EndRec | null = null;
    let bestD = Infinity;
    for (const b of freeEnds) {
      if (b === a || b.kind !== a.kind || b.li === a.li) continue;
      if (weldedKeys.has(b.key) || extendedKeys.has(b.key)) continue;
      const d = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]);
      if (d <= 0.5 || d > 12 || d >= bestD) continue;
      if (a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] <= 0.5) continue;
      best = b;
      bestD = d;
    }
    if (!best) continue;
    const pairsBoth = [[a, best], [best, a]] as const;
    const steps: Array<[EndRec, LocalPoint2]> = [];
    for (const [from, to] of pairsBoth) {
      const dx = to.p[0] - from.p[0];
      const dz = to.p[1] - from.p[1];
      const l = Math.hypot(dx, dz) || 1;
      const line = currentOf(from.kind)[from.li];
      const step = Math.min(bestD / 2 + 1.5, totalOf(line) * 0.45);
      if (step <= 0.4) continue;
      steps.push([from, [from.p[0] + (dx / l) * step, from.p[1] + (dz / l) * step]]);
    }
    if (steps.length < 2) continue;
    for (const [from, p2] of steps) {
      const lines = currentOf(from.kind);
      const line = lines[from.li];
      lines[from.li] = extendRounded(line, from.atStart, p2, 10);
      extendedKeys.add(from.key);
    }
  }

  // 补缺口：相当多 way 在路口前 2~8m 就断了，旧逻辑分不清"差一点"和"冲过头"，
  // 一律按出头往回裁，反而把缺口越裁越大。分两种情况补：
  //   - 目标在道路正前方 → 沿自身延长线补进对方路面；
  //   - 目标在侧前方且端头离对方外缘只有 0~6.5m（斜向 T 接的平端头）→ 朝最近点补进去。
  for (const kind of ['major', 'minor'] as const) {
    const lines = kind === 'major' ? nextMajor : nextMinor;
    const offset = kind === 'major' ? 0 : majorLines.length;
    for (let li = 0; li < lines.length; li += 1) {
      for (const atStart of [true, false]) {
        const key = `${kind}:${li}:${atStart ? 1 : 0}`;
        if (weldedKeys.has(key) || extendedKeys.has(key)) continue;
        const line = lines[li];
        const info = endInfoOf(line, atStart);
        if (!info) continue;
        const hit = nearestW(offset + li, info.p[0], info.p[1]);
        if (!hit) continue;
        const outX = -info.dir[0];
        const outZ = -info.dir[1];
        const axial = (hit.qx - info.p[0]) * outX + (hit.qz - info.p[1]) * outZ;
        const gap = hit.d - hit.half;
        // 窄路汇入宽路会做喇叭口，末端半宽可达 1.5 倍（≈8m）。
        // 这种端头必须补到宽路中心线附近，否则扩出来的两侧会从宽路外边缘戳出去；
        // 等宽路对接没有扩口，浅补 2~4m 即可，补太深会在对方路面里留下一截舌头。
        const deep = hit.half > (kind === 'major' ? MAJOR_WIDTH : MINOR_WIDTH) / 2 + 1;
        let ex = outX;
        let ez = outZ;
        let step = 0;
        // 只要端头在对方路缘外 20m 内、且大致朝前，就补到对方路面里。
        // 很多支路在 OSM 里就停在主干路边缘几米外，旧逻辑按 6.5m 限距补不到，
        // 端头于是被安上圆帽——俯视就是"路断在半空、露出一个浅色圆头"。
        // axial 必须为正：end 的朝向要指向对方路面。贴边的**并行**支路（axial≈0）
        // 一旦也补进来，会沿横向甩出一个 90° 的弯钩，俯视就是路缘上鼓起一个圆瘤。
        if (gap > 0.05 && gap <= 20 && axial > 0.15) {
          const dx = hit.qx - info.p[0];
          const dz = hit.qz - info.p[1];
          const l = Math.hypot(dx, dz);
          if (l > 1e-3) {
            ex = dx / l;
            ez = dz / l;
            // 12m 上限会把 15~20m 的缺口只补掉一半：端头停在路缘外 4~8m，
            // 既不算断头（旧附着判定）也接不上，俯视就是一条悬空的平齐断口。
            // 补到对方中心线再越过 4m，端面整体被对方路面盖住；喇叭口也才会
            // 真正落在宽路内，不会从宽路外缘戳出去。
            const reach = deep ? Math.min(hit.d + 1.5, 22) : Math.min(gap + 4, 24);
            step = Math.min(reach, totalOf(line) * 0.45);
          }
        }
        if (step <= 0.5) continue;
        const p2: LocalPoint2 = [info.p[0] + ex * step, info.p[1] + ez * step];
        lines[li] = extendRounded(line, atStart, p2, 16);
        extendedKeys.add(key);
      }
    }
  }

  // 补口/顺接都改了几何，收头必须按最新几何查：否则收头看到的是补口之前的
  // 旧线段，端头明明已经补进对方路面，收头却按旧位置判断，该裁的不裁、
  // 该收的收不回来。
  nearestW = makeIndex(nextMajor, nextMinor);

  for (const kind of ['major', 'minor'] as const) {
    const lines = kind === 'major' ? nextMajor : nextMinor;
    const offset = kind === 'major' ? 0 : majorLines.length;
    for (let li = 0; li < lines.length; li += 1) {
      for (const atStart of [true, false]) {
        const endKey = `${kind}:${li}:${atStart ? 1 : 0}`;
        if (weldedKeys.has(endKey) || extendedKeys.has(endKey)) continue;
        let trimmed = 0;
        for (let pass = 0; pass < 4; pass += 1) {
          const line = lines[li];
          const info = endInfoOf(line, atStart);
          if (!info) break;
          const hit = nearestW(offset + li, info.p[0], info.p[1]);
          if (!hit) break;
          // 末端已经从"对方路面内部"穿到外缘之外：这是 OSM 连接支路/画过头的
          // 短接头，会在主路边缘戳出一个方头。判断必须同时满足：
          //   · 端头落在对方路面之外（d > 半宽）；
          //   · 沿道路内侧一段（按冲出深度自适应）的点落在对方路面之内。
          // 只看端头会把"还差几米才接上"的正常端头也往回裁，裁出露地三角。
          if (hit.d <= hit.half + 0.4) break;
          // 端头已经穿到对方外缘之外：向内探的点要足够深才能落回对方路面里。
          // 固定 4m 只够发现"刚好穿出一点点"的情况；冲出 7m 的大端头探不到，
          // 于是被当成正常断头加了端帽——俯视就是主干道头上顶个大圆包。
          const probe = Math.min(28, Math.max(4, hit.d - hit.half + 4));
          const inX = info.p[0] + info.dir[0] * probe;
          const inZ = info.p[1] + info.dir[1] * probe;
          const inHit = nearestW(offset + li, inX, inZ);
          if (!inHit || inHit.owner !== hit.owner || inHit.d >= inHit.half - 0.6) break;
          // 端头沿道路方向退出多少米，取决于它与对方路缘的夹角：
          // 近乎垂直穿出时 1m 路程换 1m 横向距离，斜穿时要按法向分量放大。
          const alongT = Math.abs(info.dir[0] * hit.tx + info.dir[1] * hit.tz);
          const normalComp = Math.max(0.3, Math.sqrt(Math.max(0, 1 - alongT * alongT)));
          const need = (hit.d - (hit.half - 1.5)) / normalComp;
          const step = Math.min(need, 12, 18 - trimmed, totalOf(line) * 0.45);
          if (step <= 0.5) break;
          const cut = cutEnd(line, atStart, step);
          if (!cut) break;
          lines[li] = atStart ? [cut.p, ...cut.keep] : [...cut.keep, cut.p];
          trimmed += step;
        }
      }
    }
  }
  /**
   * 越界尾巴：端头已经压在路口路面上，但端头横断面比对方路面还宽，或者端头
   * 前面还带一小段回勾（OSM 里 人民路@平齐路 这种：中心线在路口内绕一个弯再
   * 结束），26m 宽的带状面就会从对方路面另一侧甩出一个圆舌/圆瘤——俯视看
   * 像路口上长了一个带白边的大包。
   *
   * 判据：端头"接上"了对方路（路面重叠），但 d + 自己半宽 > 对方半宽，说明
   * 端面有部分露在对方路面之外。沿道路向内找与**同一条对方路**中心线最近的点：
   * 只要这段尾巴确实跨进了对方路面（存在 d < 对方半宽的点），且最近点比端头
   * 更深入，就把尾巴切到最近点。端头停在对方中心线上，整个端面被对方路面盖住。
   */
  for (const kind of ['major', 'minor'] as const) {
    const lines = kind === 'major' ? nextMajor : nextMinor;
    const offset = kind === 'major' ? 0 : majorLines.length;
    const ownHalf = (kind === 'major' ? MAJOR_WIDTH : MINOR_WIDTH) / 2;
    for (let li = 0; li < lines.length; li += 1) {
      for (const atStart of [true, false]) {
        const endKey = `${kind}:${li}:${atStart ? 1 : 0}`;
        if (weldedKeys.has(endKey)) continue;
        const line = lines[li];
        if (line.length < 3) continue;
        const info = endInfoOf(line, atStart);
        if (!info) continue;
        const hit = nearestW(offset + li, info.p[0], info.p[1]);
        if (!hit) continue;
        if (hit.d > hit.half + ownHalf - 1.5) continue;
        if (hit.d + ownHalf - hit.half <= 2) continue;
        // 只看端头附近：再远就不是"这条尾巴"了
        const total = totalOf(line);
        const maxCut = Math.min(ownHalf * 2.5 + 12, total * 0.45);
        if (maxCut <= 3) continue;
        let bestD = hit.d;
        let bestCut = 0;
        // 按 2m 步长沿道路采样：OSM 里常有 100m 级的稀疏长直段，只查顶点会
        // 整段跳过，"最贴近对方中心线"的跨路点就落在两个顶点之间查不到。
        for (let s = 2; s <= maxCut; s += 2) {
          const q = pointAlong(line, atStart, s);
          if (!q) break;
          const w = nearestW(offset + li, q[0], q[1]);
          if (!w || w.owner !== hit.owner) continue;
          if (w.d < bestD) {
            bestD = w.d;
            bestCut = s;
          }
        }
        // 尾巴必须真的跨进对方路面，且最近点比端头更深（否则是正常搭接）
        if (bestD >= hit.half - 0.3) continue;
        if (bestCut < 2 || bestD + 2 >= hit.d) continue;
        const cut = cutEnd(line, atStart, bestCut);
        if (!cut) continue;
        const kept = atStart ? [cut.p, ...cut.keep] : [...cut.keep, cut.p];
        if (totalOf(kept) < 8) continue;
        lines[li] = kept;
      }
    }
  }

  /**
   * 跨断口顺接：OSM 常把同一条直路在路口切成两段，两段端头隔着路口面对面。
   * 它们往往不是"互选"焊点（各自的最佳对象可能是路口另一侧的路），于是中间
   * 留一道亮缝/接缝台阶——俯视截图里路口中央的小方块与两侧亮缝就是它。
   * 这里把所有"面对面且几乎共线"的端头成对顺接：两端各越过中点 2m 相互叠压，
   * 缺口被两层路面盖住。只叠接不并线，不动其它接头，也不影响端头圆角。
   */
  {
    type Seam = {
      key: string;
      li: number;
      atStart: boolean;
      p: LocalPoint2;
      dir: [number, number];
    };
    const SEAM_MAX = 26;
    const deslant = (kind: 'major' | 'minor', lines: LocalPoint2[][]) => {
      const ends: Seam[] = [];
      lines.forEach((line, li) => {
        for (const atStart of [true, false]) {
          const key = `${kind}:${li}:${atStart ? 1 : 0}`;
          if (weldedKeys.has(key)) continue;
          const info = endInfoOf(line, atStart);
          if (!info) continue;
          ends.push({ key, li, atStart, p: info.p, dir: info.dir });
        }
      });
      const used = new Set<string>();
      const seams: Array<[Seam, Seam]> = [];
      for (let i = 0; i < ends.length; i += 1) {
        const a = ends[i];
        if (used.has(a.key)) continue;
        let best: Seam | null = null;
        let bestD = Infinity;
        for (let j = 0; j < ends.length; j += 1) {
          const b = ends[j];
          if (b.li === a.li || used.has(b.key)) continue;
          const dx = b.p[0] - a.p[0];
          const dz = b.p[1] - a.p[1];
          const dist = Math.hypot(dx, dz);
          if (dist < 1.5 || dist > SEAM_MAX || dist >= bestD) continue;
          // 内向相对：两段沿同一轴线朝彼此延伸
          if (a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] > -0.85) continue;
          const ax = -a.dir[0];
          const az = -a.dir[1];
          const along = dx * ax + dz * az;
          if (along < dist * 0.7) continue;
          // 横向偏移太大的不是同一条路（例如并排的双向车道）
          if (Math.abs(dx * az - dz * ax) > 6) continue;
          best = b;
          bestD = dist;
        }
        if (!best) continue;
        used.add(a.key);
        used.add(best.key);
        seams.push([a, best]);
      }
      for (const [a, b] of seams) {
        const dx = b.p[0] - a.p[0];
        const dz = b.p[1] - a.p[1];
        const l = Math.hypot(dx, dz) || 1;
        const ux = dx / l;
        const uz = dz / l;
        const reach = l / 2 + 2;
        lines[a.li] = extendRounded(
          lines[a.li],
          a.atStart,
          [a.p[0] + ux * reach, a.p[1] + uz * reach],
          14,
        );
        lines[b.li] = extendRounded(
          lines[b.li],
          b.atStart,
          [b.p[0] - ux * reach, b.p[1] - uz * reach],
          14,
        );
      }
    };
    deslant('major', nextMajor);
    deslant('minor', nextMinor);
  }

  nextMajor = kindSafe(nextMajor);
  nextMinor = kindSafe(nextMinor);

  // 越界尾巴裁剪、跨断口顺接都改了几何；附着判定必须按最终几何重建索引，
  // 否则用的是已经被剪掉的旧线段，真正的悬空端头会被误判成"已接上"，
  // 于是既不补口也不补圆头，留下平齐断口。
  nearestW = makeIndex(nextMajor, nextMinor);

  const endsOf = (kind: 'major' | 'minor', lines: LocalPoint2[][], offset: number, ownHalf: number): EndInfo[][] =>
    lines.map((line, li) => {
      const blank: EndInfo = { attached: false, flare: 0, target: ownHalf };
      if (line.length < 2) return [blank, blank];
      const total = totalOf(line);
      return [0, line.length - 1].map((idx) => {
        const p = line[idx];
        const atStart = idx === 0;
        const prev = line[idx === 0 ? 1 : line.length - 2];
        const hit = nearestW(offset + li, p[0], p[1]);
        // "接上"= 端头本身压在对方路面上（或离路缘 ≤2m）。
        // 旧规则用 hit.half + ownHalf - 1.5 兜底，26m 宽的主干道路缘外 11m
        // 仍算接上：端头既不平齐收进对方路面，也不补圆头，就是一条悬空断口。
        let attached = !!hit && hit.d <= hit.half + 2;
        if (!attached && hit) {
          // 中心点还在路缘外，但端头横断面已经搭在对方路面上（斜向 T 接、
          // 宽路在街角对接）：两片路面叠住了，补圆头会从对方路面里鼓出一个
          // 浅色圆包（旧版路口大圆瘤）。任一角点压进对方路面即视为接上。
          const ox = p[0] - prev[0];
          const oz = p[1] - prev[1];
          const ol = Math.hypot(ox, oz) || 1;
          const nx = -oz / ol;
          const nz = ox / ol;
          for (const k of [-1, -0.5, 0.5, 1]) {
            const c = nearestW(offset + li, p[0] + nx * ownHalf * k, p[1] + nz * ownHalf * k);
            if (c && c.d < c.half - 0.2) {
              attached = true;
              break;
            }
          }
        }
        const welded = weldedKeys.has(`${kind}:${li}:${atStart ? 1 : 0}`);
        // 只有"窄汇入宽"才扩口；端对端焊接则直接把宽度过渡到对方半宽。
        // toward > 1 要求端头确实朝宽路里伸，贴边并行的支路不能算汇入（否则会鼓一个包）。
        const ox = p[0] - prev[0];
        const oz = p[1] - prev[1];
        const ol = Math.hypot(ox, oz) || 1;
        const toward = hit ? ((hit.qx - p[0]) * ox + (hit.qz - p[1]) * oz) / ol : 0;
        const wider = attached && !!hit && hit.half > ownHalf + 1 && toward > 1;
        const flare = welded || wider ? Math.min(FLARE_LEN, total * 0.45) : 0;
        const target = welded && hit ? Math.max(ownHalf, hit.half) : wider && hit ? ownHalf * (1 + FLARE_GAIN) : ownHalf;
        return { attached, flare, target };
      });
    });

  // 附着判定先算出来：短断头删除也要用它，否则会按半宽兜底的旧口径
  // 把悬空碎段误判成"已连接"而保留下来。
  let endsMajor = endsOf('major', nextMajor, 0, MAJOR_WIDTH / 2);
  let endsMinor = endsOf('minor', nextMinor, majorLines.length, MINOR_WIDTH / 2);

  // 短断头支路（<15m、只有一端搭在别的路上）在俯视图里就是挂在路边的一个黑疙瘩，
  // 既不构成通行连接也读不出含义，直接不渲染；两端都搭在别的路上的短连接件保留。
  // 另外，两端都悬空、长度不足 45m 的孤立碎段（OSM 数据碎片）整段删除：
  // 否则两端各补一个圆头，就是一块浮在空中的"药丸"。
  for (const kind of ['major', 'minor'] as const) {
    const lines = kind === 'major' ? nextMajor : nextMinor;
    const ends = kind === 'major' ? endsMajor : endsMinor;
    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li];
      const e = ends[li];
      if (line.length < 2 || !e) continue;
      const total = totalOf(line);
      const aAtt = e[0].attached;
      const bAtt = e[1].attached;
      if (total < 15 && !(aAtt && bAtt)) lines[li] = [];
      else if (total < 45 && !aAtt && !bAtt) lines[li] = [];
    }
  }

  // 碎段删掉后重新判定：端头原来可能只"搭在"一条即将被删掉的碎段上，
  // 沿用旧结果会让它既没有圆头也没有连接，留下悬空平口。索引也要重建，
  // 否则删掉的碎段仍留在网格里参与最近路查询。
  nearestW = makeIndex(nextMajor, nextMinor);
  endsMajor = endsOf('major', nextMajor, 0, MAJOR_WIDTH / 2);
  endsMinor = endsOf('minor', nextMinor, majorLines.length, MINOR_WIDTH / 2);

  // 汇入口端部拟合：只动有喇叭口的端头，其余路形保持原样
  const fitMajor = smoothFlaredEnds(nextMajor, endsMajor);
  const fitMinor = smoothFlaredEnds(nextMinor, endsMinor);

  const capOf = (ends: EndInfo[][]) => (li: number, atStart: boolean) =>
    !(ends[li]?.[atStart ? 0 : 1]?.attached ?? false);

  /** 喇叭口按 smoothstep 渐变加宽：路口是渐变漏斗，不是硬切口 */
  const halfOf =
    (ends: EndInfo[][], baseHalf: number) =>
    (li: number, _index: number, along: number, total: number) => {
      const s = ends[li]?.[0];
      const e = ends[li]?.[1];
      let k = 0;
      let target = baseHalf;
      if (s && s.flare > 0) {
        const kk = 1 - along / s.flare;
        if (kk > k) {
          k = kk;
          target = s.target;
        }
      }
      if (e && e.flare > 0) {
        const kk = 1 - (total - along) / e.flare;
        if (kk > k) {
          k = kk;
          target = e.target;
        }
      }
      if (k <= 0) return baseHalf;
      const t = Math.min(1, k);
      const smooth = t * t * (3 - 2 * t);
      return baseHalf + (target - baseHalf) * smooth;
    };

  const layersMajor = colorLayers(fitMajor, MAJOR_WIDTH / 2);
  const layersMinor = colorLayers(fitMinor, MINOR_WIDTH / 2);

  return {
    major: fitMajor,
    minor: fitMinor,
    capMajor: capOf(endsMajor),
    capMinor: capOf(endsMinor),
    halfMajor: halfOf(endsMajor, MAJOR_WIDTH / 2),
    halfMinor: halfOf(endsMinor, MINOR_WIDTH / 2),
    liftMajor: (li) => MAJOR_LIFT - layersMajor[li] * LAYER_STEP,
    liftMinor: (li) => -layersMinor[li] * LAYER_STEP,
  };
}

/** 焊接后可能有连续重复点（切点恰好落在原顶点上），顺手压掉 */
function kindSafe(lines: LocalPoint2[][]): LocalPoint2[][] {
  return lines.map((line) => {
    const out: LocalPoint2[] = [];
    for (const p of line) {
      const last = out[out.length - 1];
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.05) continue;
      out.push(p);
    }
    return out;
  });
}

/**
 * 喇叭口区间的端部拟合。
 * 汇入口前 34m 里，OSM 折线的硬折角会在加宽后放大成明显的折边：
 * 俯视看，支路接近主路时边线突然拐一下，内外缘之间还夹着露地的楔形。
 * 这里把端头前 flare 米重采样到 4m，并做两遍带衰减的拉普拉斯平滑：
 * 端头点固定（保持与主路的搭接），接缝处权重为 0（不影响其余路形），
 * 中间部分逐渐抹圆，边线成为连续曲线。
 */
const FLARE_STEP = 4;

function smoothFlaredEnds(lines: LocalPoint2[][], ends: EndInfo[][]): LocalPoint2[][] {
  return kindSafe(
    lines.map((raw, li) => {
      let line = raw;
      for (const atStart of [true, false]) {
        const info = ends[li]?.[atStart ? 0 : 1];
        if (!info || info.flare <= 0.5) continue;
        const next = smoothEnd(line, atStart, info.flare + 2);
        if (next) line = next;
      }
      return line;
    }),
  );
}

function smoothEnd(line: LocalPoint2[], atStart: boolean, len: number): LocalPoint2[] | null {
  const total = polylineLength(line);
  const L = Math.min(len, total * 0.55);
  // 统一按"从端头往内"的顺序处理，结束后再翻回去
  const pts = atStart ? line : [...line].reverse();
  if (pts.length < 3) return null;
  const acc = [0];
  for (let i = 1; i < pts.length; i += 1) {
    acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  if (acc[acc.length - 1] <= L + 0.5) return null;
  let i = 0;
  while (i < pts.length - 2 && acc[i + 1] < L) i += 1;
  const seg = acc[i + 1] - acc[i];
  const t = seg > 1e-6 ? Math.min(1, (L - acc[i]) / seg) : 0;
  const seam: LocalPoint2 = [
    pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
    pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t,
  ];
  // 端头段：端头 → 接缝
  const tail: LocalPoint2[] = [...pts.slice(0, i + 1), seam];
  const resampled: LocalPoint2[] = [tail[0]];
  for (let k = 1; k < tail.length; k += 1) {
    const d = Math.hypot(tail[k][0] - tail[k - 1][0], tail[k][1] - tail[k - 1][1]);
    const n = Math.max(1, Math.round(d / FLARE_STEP));
    for (let j = 1; j <= n; j += 1) {
      const tt = j / n;
      resampled.push([
        tail[k - 1][0] + (tail[k][0] - tail[k - 1][0]) * tt,
        tail[k - 1][1] + (tail[k][1] - tail[k - 1][1]) * tt,
      ]);
    }
  }
  const n = resampled.length;
  const fade = Math.max(2, Math.round(n * 0.45));
  for (let pass = 0; pass < 2; pass += 1) {
    for (let k = 1; k < n - 1; k += 1) {
      // 接缝附近不动，越靠端头平滑权重越大；端头点本身固定
      const u = Math.min(1, (n - 1 - k) / fade);
      const w = u * u * (3 - 2 * u) * 0.7;
      const ax = (resampled[k - 1][0] + resampled[k + 1][0]) / 2;
      const az = (resampled[k - 1][1] + resampled[k + 1][1]) / 2;
      resampled[k] = [
        resampled[k][0] + (ax - resampled[k][0]) * w,
        resampled[k][1] + (az - resampled[k][1]) * w,
      ];
    }
  }
  const keep = pts.slice(i + 1);
  const merged = resampled.concat(keep);
  return atStart ? merged : merged.reverse();
}

/**
 * 高架折线加密。
 * OSM 的 bridge way 常有 1~2km 的超长直段（个别段甚至只有两个点），
 * 桥面高度只在折线顶点上取样、段内由 GPU 线性插值，而桥墩按真实纵断面取高。
 * 长段里两者能差出好几米，墩顶于是从桥面中间穿出来（俯视是一排菱形灰块）。
 * 加密到 ≤10m 之后，桥面与纵断面的偏差只剩几厘米。
 */
const ELEVATED_SEG = 10;
function densifyLine(line: LocalPoint2[], step = ELEVATED_SEG): LocalPoint2[] {
  const out: LocalPoint2[] = [line[0]];
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1];
    const b = line[i];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.ceil(d / step));
    for (let j = 1; j <= k; j += 1) {
      const t = j / k;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

interface ElevatedJoin {
  lines: LocalPoint2[][];
  /** 每条折线两端的设计标高：0 = 引桥落地，>0 = 与相邻高架 way 对接的桥面高程 */
  endH: Array<[number, number]>;
}

/**
 * 高架 way 拼接。
 * OSM 把一条连续高架拆成多段独立 bridge way，逐段渲染会露出两类"断口"：
 *   · 每段两端都按引桥落回地面 → 整条高架在每个 way 交界处下凹再抬起；
 *   · 两段端面各自平切，转角处露出地面楔形缺口（俯视就是 V 形豁口/错位台阶）。
 * 这里把端头相对、净高相近的相邻段焊成连续桥面：两端各退一段，
 * 用二次贝塞尔接上（与地面道路同一套做法），并把接缝标高记到 endH 里。
 */
function joinElevatedWays(batch: ElevatedLine[], half: number): ElevatedJoin {
  const lines = batch.map((e) => e.line.slice());
  const endH: Array<[number, number]> = batch.map(() => [0, 0]);
  if (batch.length < 2) return { lines: lines.map((line) => densifyLine(line)), endH };

  type End = { li: number; atStart: boolean; p: LocalPoint2; dir: [number, number]; h: number };
  const ends: End[] = [];
  batch.forEach((b, li) => {
    ([true, false] as const).forEach((atStart) => {
      const info = polylineEnd(b.line, atStart);
      if (info) ends.push({ li, atStart, p: info.p, dir: info.dir, h: b.h });
    });
  });

  const cand: Array<{ a: End; b: End; d: number }> = [];
  for (let i = 0; i < ends.length; i += 1) {
    for (let j = i + 1; j < ends.length; j += 1) {
      const a = ends[i];
      const b = ends[j];
      if (a.li === b.li) continue;
      const d = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]);
      if (d > 12) continue;
      const dot = a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1];
      // 两端"驶入方向"基本相反才是首尾相接。地面道路只焊转角 ≤75° 的接头，
      // 但高架桥面是悬空的：转角处不焊，两片方形端面之间会直接漏出下面的地面，
      // 所以这里放宽到 ~100°（dot < 0.2）；同向平行的双幅路仍然是 dot≈+1，被排除。
      if (dot > 0.2) continue;
      if (Math.abs(a.h - b.h) > 4) continue;
      cand.push({ a, b, d });
    }
  }
  cand.sort((x, y) => x.d - y.d);

  const keyOf = (e: End) => `${e.li}:${e.atStart ? 1 : 0}`;
  const used = new Set<string>();
  for (const { a, b } of cand) {
    if (used.has(keyOf(a)) || used.has(keyOf(b))) continue;
    const lineA = lines[a.li];
    const lineB = lines[b.li];
    const cutA = cutPolylineEnd(lineA, a.atStart, Math.min(half * 2.2, 22, polylineLength(lineA) * 0.45));
    const cutB = cutPolylineEnd(lineB, b.atStart, Math.min(half * 2.2, 22, polylineLength(lineB) * 0.45));
    if (!cutA || !cutB) continue;
    used.add(keyOf(a));
    used.add(keyOf(b));

    const cx = (a.p[0] + b.p[0]) / 2;
    const cz = (a.p[1] + b.p[1]) / 2;
    const span = Math.hypot(cutB.p[0] - cutA.p[0], cutB.p[1] - cutA.p[1]);
    const steps = Math.max(6, Math.ceil(span / 2.5));
    const mid = Math.floor(steps / 2);
    const curve: LocalPoint2[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const mt = 1 - t;
      curve.push([
        mt * mt * cutA.p[0] + 2 * mt * t * cx + t * t * cutB.p[0],
        mt * mt * cutA.p[1] + 2 * mt * t * cz + t * t * cutB.p[1],
      ]);
    }
    const first = curve.slice(0, mid + 1);
    const second = curve.slice(mid);
    lines[a.li] = a.atStart ? first.slice().reverse().concat(cutA.keep) : cutA.keep.concat(first);
    lines[b.li] = b.atStart ? second.concat(cutB.keep) : cutB.keep.concat(second.slice().reverse());

    // 接缝标高取较低者：两段 way 的 OSM 净高偶尔不一致，取低才不会凭空抬高桥面
    const seam = Math.min(a.h, b.h);
    if (a.atStart) endH[a.li][0] = seam;
    else endH[a.li][1] = seam;
    if (b.atStart) endH[b.li][0] = seam;
    else endH[b.li][1] = seam;
  }

  return { lines: kindSafe(lines).map((line) => densifyLine(line)), endH };
}

/**
 * 道路（M1）：OSM highway 折线 → 带状面，主干/支路各合并为一个 mesh（2 draw call）。
 * 路网裁到 5.8km（寒山寺为界），路面高度按半径从城内基准平滑降到外围地面。
 * 车道虚实线由着色器绘制；冬季路面保持干净的深色沥青，不做积雪覆盖。
 */
/* 注意：`overpass` 段仍然保留在 major/minor 里（QA 与桥梁索引要用），
   但地面渲染时按 index 剔除，改由下面的高架几何单独绘制。 */
export function Roads() {
  const data = useRoads();
  const season = useSandTable((state) => state.season);
  const winter = season === 'winter';

  const overpassKey = useMemo(
    () => new Set((data?.overpass ?? []).map((o) => `${o.kind}:${o.index}`)),
    [data],
  );

  const majorLines = useMemo(
    () =>
      data
        ? clipLinesToRadius(
            data.major.filter((_, i) => !overpassKey.has(`major:${i}`)),
            WORLD_LIMIT,
          ).map((line) => roundCorners(line))
        : null,
    [data, overpassKey],
  );
  const minorLines = useMemo(
    () =>
      data
        ? clipLinesToRadius(
            data.minor.filter((_, i) => !overpassKey.has(`minor:${i}`)),
            WORLD_LIMIT,
          ).map((line) => roundCorners(line))
        : null,
    [data, overpassKey],
  );

  const elevated = useMemo(() => {
    const groups: { major: ElevatedLine[]; minor: ElevatedLine[] } = { major: [], minor: [] };
    for (const o of data?.overpass ?? []) {
      const line = data?.[o.kind]?.[o.index];
      if (line && line.length >= 2) groups[o.kind].push({ line, h: o.h });
    }
    // 先把同净高的相邻 way 焊成连续桥面，再交给渲染
    const major = joinElevatedWays(groups.major, MAJOR_WIDTH / 2);
    const minor = joinElevatedWays(groups.minor, MINOR_WIDTH / 2);
    const wrap = (list: ElevatedLine[], joined: ElevatedJoin): ElevatedLine[] =>
      list.map((e, i) => ({ h: e.h, line: joined.lines[i], endH: joined.endH[i] }));
    return { major: wrap(groups.major, major), minor: wrap(groups.minor, minor) };
  }, [data]);

  /**
   * 高架桥面分层。
   * OSM 的双幅高架（如 major:24 / major:26）是两条中心线只隔 9~16m 的平行 way，
   * 而桥面宽 26m —— 两片桥面在整段中间完全共面，且都按同一个净高抬升，
   * 深度缓冲只能逐像素随机取胜，下层桥面的标线从上层桥面里透出来，
   * 远看就是"桥上线条疯狂闪烁"。与地面一样按冲突图确定性错开层高即可。
   */
  const elevatedLayers = useMemo(() => {
    const major = elevated.major.map((e) => e.line);
    const minor = elevated.minor.map((e) => e.line);
    return {
      major: colorLayers(major, MAJOR_WIDTH / 2),
      minor: colorLayers(minor, MINOR_WIDTH / 2),
    };
  }, [elevated]);

  const join = useMemo(
    () => (majorLines && minorLines ? buildRoadJoin(majorLines, minorLines) : null),
    [majorLines, minorLines],
  );
  const majorGeo = useMemo(
    () =>
      join
        ? buildRibbons(join.major, MAJOR_WIDTH, (x, z) => roadSurfaceY(x, z, MAJOR_ROAD_Y), {
            roadUV: true,
            markMask: buildMarkMask(join.major, MAJOR_WIDTH / 2),
            endCaps: join.capMajor,
            lineLift: join.liftMajor,
            halfAt: join.halfMajor,
          })
        : null,
    [join],
  );
  const minorGeo = useMemo(
    () =>
      join
        ? buildRibbons(join.minor, MINOR_WIDTH, (x, z) => roadSurfaceY(x, z, MINOR_ROAD_Y), {
            roadUV: true,
            markMask: buildMarkMask(join.minor, MINOR_WIDTH / 2),
            endCaps: join.capMinor,
            lineLift: join.liftMinor,
            halfAt: join.halfMinor,
          })
        : null,
    [join],
  );

  const overpassMajorGeo = useMemo(
    () =>
      elevated.major.length === 0
        ? null
        : buildRibbons(
            elevated.major.map((e) => e.line),
            MAJOR_WIDTH,
            MAJOR_ROAD_Y,
            {
              roadUV: true,
              // 与地面一致的确定性层高：双幅桥面必须错开，同层就是共面闪烁
              lineLift: (li) => MAJOR_LIFT - elevatedLayers.major[li] * LAYER_STEP,
              heightAtVertex: (li, line, i, along, total) => {
                const e = elevated.major[li];
                const [h0, h1] = e.endH ?? [0, 0];
                return (
                  roadSurfaceY(line[i][0], line[i][1], MAJOR_ROAD_Y) +
                  elevatedProfile(along, total, Math.max(e.h, h0, h1), h0, h1)
                );
              },
            },
          ),
    [elevated, elevatedLayers],
  );
  const overpassMinorGeo = useMemo(
    () =>
      elevated.minor.length === 0
        ? null
        : buildRibbons(
            elevated.minor.map((e) => e.line),
            MINOR_WIDTH,
            MINOR_ROAD_Y,
            {
              roadUV: true,
              lineLift: (li) => -elevatedLayers.minor[li] * LAYER_STEP,
              heightAtVertex: (li, line, i, along, total) => {
                const e = elevated.minor[li];
                const [h0, h1] = e.endH ?? [0, 0];
                return (
                  roadSurfaceY(line[i][0], line[i][1], MINOR_ROAD_Y) +
                  elevatedProfile(along, total, Math.max(e.h, h0, h1), h0, h1)
                );
              },
            },
          ),
    [elevated, elevatedLayers],
  );

  /** 桥墩：高架段每 22m 一根，从地面顶到桥面底，让"立起来"这件事一眼可见 */
  const pierMesh = useMemo(() => {
    const specs: Array<{ x: number; z: number; ground: number; height: number; width: number }> = [];
    const collect = (list: ElevatedLine[], baseY: number, width: number) => {
      for (const { line, h, endH } of list) {
        const n = line.length;
        if (n < 2) continue;
        const along: number[] = [0];
        for (let i = 1; i < n; i += 1) {
          along.push(
            along[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]),
          );
        }
        const total = along[n - 1];
        if (total < 12) continue;
        const peak = Math.max(h, endH?.[0] ?? 0, endH?.[1] ?? 0);
        const [h0, h1] = endH ?? [0, 0];
        /** 桥面顶点高度：与 buildRibbons 的 heightAtVertex 完全一致 */
        const deckH = (k: number) => elevatedProfile(along[k], total, peak, h0, h1);
        for (let d = PIER_SPACING / 2; d < total; d += PIER_SPACING) {
          let i = 0;
          while (i < n - 2 && along[i + 1] < d) i += 1;
          const seg = along[i + 1] - along[i];
          const t = seg > 0 ? (d - along[i]) / seg : 0;
          const x = line[i][0] + (line[i + 1][0] - line[i][0]) * t;
          const z = line[i][1] + (line[i + 1][1] - line[i][1]) * t;
          const ground = roadSurfaceY(x, z, baseY);
          // 桥面在段内是线性插值，墩顶必须按同一条插值线再压 0.9m，
          // 否则纵断面的曲率会让墩顶从桥面里冒出来
          const top = deckH(i) + (deckH(i + 1) - deckH(i)) * t;
          const height = top - 0.9;
          if (height > 1.4) specs.push({ x, z, ground, height, width });
        }
      }
    };
    collect(elevated.major, MAJOR_ROAD_Y, PIER_WIDTH_MAJOR);
    collect(elevated.minor, MINOR_ROAD_Y, PIER_WIDTH_MINOR);
    if (specs.length === 0) return null;
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: '#9d9a92', roughness: 0.92 }),
      specs.length,
    );
    const m = new THREE.Matrix4();
    specs.forEach((s, i) => {
      m.makeScale(s.width, s.height, s.width);
      m.setPosition(s.x, s.ground + s.height / 2, s.z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }, [elevated]);

  // 路面材质不再用 polygonOffset：偏移量随视线斜率变化，远看（几乎平视）时
  // 会把 2cm 的真实层高差整个抵消掉，重叠路面又会互相穿透。分层已在几何里做。
  const minorMat = useMemo(
    () => createRoadMaterial(winter ? '#4b4f53' : '#474a4e', winter ? 0.95 : 0.82, '#e2ddcd'),
    [winter],
  );
  const majorMat = useMemo(
    () => createRoadMaterial(winter ? '#43474b' : '#3c3f43', winter ? 0.93 : 0.8, '#efe9d6'),
    [winter],
  );

  if (!data) return null;

  return (
    <group>
      {minorGeo && (
        <mesh geometry={minorGeo} receiveShadow material={minorMat} />
      )}
      {majorGeo && (
        <mesh geometry={majorGeo} receiveShadow material={majorMat} />
      )}
      {overpassMinorGeo && (
        <mesh geometry={overpassMinorGeo} castShadow receiveShadow material={minorMat} />
      )}
      {overpassMajorGeo && (
        <mesh geometry={overpassMajorGeo} castShadow receiveShadow material={majorMat} />
      )}
      {pierMesh && <primitive object={pierMesh} />}
    </group>
  );
}
