import * as THREE from 'three';
import type { LocalPoint2 } from '../types';
import type { RoadsData } from '../hooks/useRoads';
import { sceneGeometry } from '../data/sceneGeometry';

/**
 * 城内桥梁（M1 补充）：
 * 道路与 30m 宽城内河道交叉处原本没有桥，路面直接没入水面。
 * 这里按道路走向生成石桥：拱起桥面 + 两侧石栏板 + 桥墩 + 引坡，
 * 全部桥合并进单个 BufferGeometry（1 draw call）。
 */

/** 与 WaterSystem 的水面参数保持一致 */
const CANAL_HALF = 15;
const WATER_Y = 2.4;

/** 桥面中心 / 桥身两端高度（均高于水面） */
const CROWN_Y = WATER_Y + 1.35;
const EDGE_Y = WATER_Y + 1.05;
const DECK_THICK = 0.55;
/** 引坡长度：从桥身两端下到路面 */
const RAMP_LEN = 9;
const RAIL_H = 0.62;
const RAIL_T = 0.34;
const PIER_BASE_Y = 0.6;

export interface BridgeSite {
  x: number;
  z: number;
  /** 桥长轴方向（沿道路），弧度 */
  angle: number;
  /** 桥面半宽 */
  halfWidth: number;
  /** 引道端部路面高度 */
  roadY: number;
  /** 跨水桥身半长 */
  deckHalf: number;
}

function pointInPolygon(p: LocalPoint2, ring: LocalPoint2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if ((zi > p[1]) !== (zj > p[1]) && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** 点到闭合轮廓的最小距离 */
function distanceToRing(p: LocalPoint2, ring: LocalPoint2[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[j];
    const b = ring[i];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len2 = dx * dx + dz * dz || 1;
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t)));
  }
  return best;
}

/**
 * 扫描道路 × 河道交点，筛掉顺河段、城墙附近与重复点位。
 * 主干道优先：先去重主干道交点，支路交点若离已有桥不足 46m 则忽略。
 */
export function computeBridgeSites(roads: RoadsData): BridgeSite[] {
  const { waterways, cityOutline } = sceneGeometry;
  const sites: BridgeSite[] = [];

  for (const kind of ['major', 'minor'] as const) {
    const halfWidth = kind === 'major' ? 6.4 : 4.2;
    const roadY = kind === 'major' ? 1.3 : 1.2;

    for (const line of roads[kind]) {
      for (let i = 0; i < line.length - 1; i += 1) {
        const a = line[i];
        const b = line[i + 1];
        const rx = b[0] - a[0];
        const rz = b[1] - a[1];
        if (Math.hypot(rx, rz) < 8) continue;

        for (const water of waterways) {
          for (let j = 0; j < water.length - 1; j += 1) {
            const c = water[j];
            const d = water[j + 1];
            const sx = d[0] - c[0];
            const sz = d[1] - c[1];
            if (Math.hypot(sx, sz) < 4) continue;

            const den = rx * sz - rz * sx;
            if (Math.abs(den) < 1e-6) continue;
            const t = ((c[0] - a[0]) * sz - (c[1] - a[1]) * sx) / den;
            const u = ((c[0] - a[0]) * rz - (c[1] - a[1]) * rx) / den;
            if (t < 0 || t > 1 || u < 0 || u > 1) continue;

            // 与河道的夹角：太小说明道路顺河而行，不需要桥
            const raw = Math.abs(Math.atan2(rz, rx) - Math.atan2(sz, sx));
            const cross = Math.min(raw, Math.PI - raw);
            if (cross < 0.7) continue;

            const x = a[0] + rx * t;
            const z = a[1] + rz * t;
            const p: LocalPoint2 = [x, z];

            // 只在城内、且离城墙足够远（桥身 + 引坡不会插进墙体/护城河）
            if (!pointInPolygon(p, cityOutline)) continue;
            if (distanceToRing(p, cityOutline) < 42) continue;
            if (sites.some((s) => Math.hypot(s.x - x, s.z - z) < 46)) continue;

            // 斜交时水面在道路方向上的投影更宽，桥身相应加长
            const sin = Math.max(Math.sin(cross), 0.35);
            sites.push({
              x,
              z,
              angle: Math.atan2(rz, rx),
              halfWidth,
              roadY,
              deckHalf: Math.min(26, CANAL_HALF / sin + 1.6),
            });
          }
        }
      }
    }
  }

  return sites;
}

/**
 * 把所有桥合并为单个几何体（石作材质共用一个 draw call）。
 * 局部坐标：u 沿桥长轴、v 横向、y 竖向，再按路口方向转到世界坐标。
 */
export function buildBridgeGeometry(sites: BridgeSite[]): THREE.BufferGeometry {
  const positions: number[] = [];

  for (const site of sites) {
    const cos = Math.cos(site.angle);
    const sin = Math.sin(site.angle);
    const hw = site.halfWidth;
    const rampEnd = site.deckHalf + RAMP_LEN;

    const P = (u: number, v: number, y: number): [number, number, number] => [
      site.x + u * cos - v * sin,
      y,
      site.z + u * sin + v * cos,
    ];

    /** 桥面顶部高度：跨水段二次拱起，引坡段线性下到路面 */
    const topY = (u: number): number => {
      const abs = Math.abs(u);
      if (abs <= site.deckHalf) {
        const t = abs / site.deckHalf;
        return CROWN_Y - (CROWN_Y - EDGE_Y) * t * t;
      }
      const t = Math.min(1, (abs - site.deckHalf) / RAMP_LEN);
      return EDGE_Y + (site.roadY + 0.16 - EDGE_Y) * t;
    };

    const tri = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => {
      positions.push(...a, ...b, ...c);
    };
    const quad = (
      a: [number, number, number],
      b: [number, number, number],
      c: [number, number, number],
      d: [number, number, number],
    ) => {
      tri(a, b, c);
      tri(a, c, d);
    };

    /** 局部坐标轴对齐方块（用于桥墩、栏板立柱） */
    const box = (cu: number, cv: number, y0: number, su: number, sv: number, sy: number) => {
      const u0 = cu - su / 2;
      const u1 = cu + su / 2;
      const v0 = cv - sv / 2;
      const v1 = cv + sv / 2;
      const y1 = y0 + sy;
      quad(P(u0, v0, y1), P(u0, v1, y1), P(u1, v1, y1), P(u1, v0, y1));
      quad(P(u0, v0, y0), P(u1, v0, y0), P(u1, v1, y0), P(u0, v1, y0));
      quad(P(u0, v1, y1), P(u0, v1, y0), P(u1, v1, y0), P(u1, v1, y1));
      quad(P(u0, v0, y1), P(u1, v0, y1), P(u1, v0, y0), P(u0, v0, y0));
      quad(P(u1, v0, y1), P(u1, v1, y1), P(u1, v1, y0), P(u1, v0, y0));
      quad(P(u0, v0, y1), P(u0, v0, y0), P(u0, v1, y0), P(u0, v1, y1));
    };

    // ---- 纵向采样：跨水段 8 段做拱形，两端各 3 段引坡
    const us: number[] = [];
    const rampSteps = 3;
    for (let i = 0; i <= rampSteps; i += 1) {
      us.push(-(site.deckHalf + RAMP_LEN * (1 - i / rampSteps)));
    }
    const deckSteps = 8;
    for (let i = 1; i <= deckSteps; i += 1) {
      us.push(-site.deckHalf + (2 * site.deckHalf * i) / deckSteps);
    }
    for (let i = 1; i <= rampSteps; i += 1) {
      us.push(site.deckHalf + (RAMP_LEN * i) / rampSteps);
    }

    for (let i = 0; i < us.length - 1; i += 1) {
      const u0 = us[i];
      const u1 = us[i + 1];
      const t0 = topY(u0);
      const t1 = topY(u1);

      // 桥面 / 桥底 / 两侧腹板
      quad(P(u0, -hw, t0), P(u0, hw, t0), P(u1, hw, t1), P(u1, -hw, t1));
      quad(
        P(u0, -hw, t0 - DECK_THICK),
        P(u1, -hw, t1 - DECK_THICK),
        P(u1, hw, t1 - DECK_THICK),
        P(u0, hw, t0 - DECK_THICK),
      );
      quad(P(u0, hw, t0), P(u0, hw, t0 - DECK_THICK), P(u1, hw, t1 - DECK_THICK), P(u1, hw, t1));
      quad(P(u0, -hw, t0), P(u1, -hw, t1), P(u1, -hw, t1 - DECK_THICK), P(u0, -hw, t0 - DECK_THICK));

      // 两侧石栏板（实心矮墙）
      for (const sign of [-1, 1] as const) {
        const vIn = sign * (hw - RAIL_T);
        const vOut = sign * hw;
        const vlo = Math.min(vIn, vOut);
        const vhi = Math.max(vIn, vOut);
        quad(
          P(u0, vlo, t0 + RAIL_H),
          P(u0, vhi, t0 + RAIL_H),
          P(u1, vhi, t1 + RAIL_H),
          P(u1, vlo, t1 + RAIL_H),
        );
        if (sign > 0) {
          quad(
            P(u0, vOut, t0),
            P(u1, vOut, t1),
            P(u1, vOut, t1 + RAIL_H),
            P(u0, vOut, t0 + RAIL_H),
          );
        } else {
          quad(
            P(u0, vOut, t0),
            P(u0, vOut, t0 + RAIL_H),
            P(u1, vOut, t1 + RAIL_H),
            P(u1, vOut, t1),
          );
        }
        // 内侧面板（近距离观看时不透空）
        if (sign > 0) {
          quad(
            P(u0, vIn, t0),
            P(u0, vIn, t0 + RAIL_H),
            P(u1, vIn, t1 + RAIL_H),
            P(u1, vIn, t1),
          );
        } else {
          quad(
            P(u0, vIn, t0),
            P(u1, vIn, t1),
            P(u1, vIn, t1 + RAIL_H),
            P(u0, vIn, t0 + RAIL_H),
          );
        }
      }
    }

    // 栏板端头封口
    for (const end of [-1, 1] as const) {
      const u = end * rampEnd;
      const y = topY(u);
      for (const sign of [-1, 1] as const) {
        const vIn = sign * (hw - RAIL_T);
        const vOut = sign * hw;
        const vlo = Math.min(vIn, vOut);
        const vhi = Math.max(vIn, vOut);
        if (end > 0) {
          quad(P(u, vlo, y), P(u, vlo, y + RAIL_H), P(u, vhi, y + RAIL_H), P(u, vhi, y));
        } else {
          quad(P(u, vlo, y), P(u, vhi, y + RAIL_H), P(u, vlo, y + RAIL_H), P(u, vhi, y));
        }
      }
    }

    // 栏板立柱：每 4m 一根，顶端略高出栏板
    for (let u = -rampEnd + 1.6; u <= rampEnd - 1.6; u += 4) {
      const y = topY(u);
      for (const sign of [-1, 1] as const) {
        box(u, sign * (hw - RAIL_T / 2), y, 0.34, RAIL_T, RAIL_H + 0.32);
      }
    }

    // 桥墩：两端桥台 + 中央桥墩，落到水面以下
    for (const u of [-(site.deckHalf - 1.4), 0, site.deckHalf - 1.4]) {
      const yTop = topY(u) - DECK_THICK + 0.05;
      box(u, 0, PIER_BASE_Y, 2.6, 2 * hw - 0.9, yTop - PIER_BASE_Y);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}
