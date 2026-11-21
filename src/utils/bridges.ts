import * as THREE from 'three';
import type { RoadsData } from '../hooks/useRoads';
import { roadSurfaceY } from '../data/outerCity';
import { waterLevelAt as waterLevelOf } from './waterField';

/**
 * 跨水桥（M1 补充）：
 * 道路与水面相交处如果没有桥，路面就直接没进水里——沙盘上很扎眼。
 * 这里沿每条道路找出"入水—出水"的连续区段，逐段生成石桥：
 * 拱起桥面 + 两侧石栏板 + 桥墩 + 引坡，全部桥合并进单个 BufferGeometry。
 * 覆盖城内 30m 河道、120m 护城河与山塘河三种水面。
 */


const DECK_THICK = 0.55;
/** 引坡长度：从桥身两端下到路面 */
const RAMP_LEN = 9;
const RAIL_H = 0.62;
const RAIL_T = 0.34;
const PIER_BASE_Y = 0.6;
/** 桥墩间距：长桥按这个间距加密，120m 的护城河桥不会只有三个墩 */
const PIER_SPACING = 17;

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
  /** 桥顶 / 桥身两端的高度 */
  crownY: number;
  edgeY: number;
  /**
   * 平桥：水面远低于路面（城外的山塘河、上塘河），桥面压到路面下 2cm，
   * 由路面本身充当桥面（车道线连续），桥体只露出栏板与桥墩。
   */
  flat?: boolean;
  /** 该处水面标高：桥墩要下到河床，不能悬在水面上方 */
  waterY?: number;
  /** 是否为同一条主干道（桥面材质/标线颜色跟着路走） */
  major?: boolean;
  /**
   * 桥心处路面标线的纵向坐标（与 Roads 的 aRoad.y 同口径）。
   * 拱桥桥面要自己画车道线，虚线的相位必须接着两端路面，
   * 否则每次过桥虚线都会错一格——看起来像"桥把标线打断了"。
   */
  vStart?: number;
}

/**
 * 该点所在的水面标高（不在水面返回 null）。
 * 走 src/utils/waterField.ts 的网格索引：单次查询只测几条候选线段，
 * 不再对 270 段水道逐条开方——那是首屏卡顿的最大来源。
 */
const waterLevelAt = (x: number, z: number): number | null => waterLevelOf(x, z);

/**
 * 扫描道路 × 水面：把每条路上连续入水的区段找出来，各建一座桥。
 * 顺河而行的长区段（>210m）不是过河，交给岸线处理，不建桥。
 */
export function computeBridgeSites(roads: RoadsData): BridgeSite[] {
  const sites: BridgeSite[] = [];
  /**
   * 最大跨度：护城河宽 120m，斜跨时沿路长度可到 280m（城南南门一带最明显，
   * 超过 210m 就被误判为"顺河而行"，结果整段路面直接铺在水上、没有桥）。
   * 放宽到 460m；真正顺河而行的长段（>460m）由 build-roads 的推离/裁断处理。
   */
  const MAX_SPAN = 460;
  const STEP = 4;

  for (const kind of ['major', 'minor'] as const) {
    // 桥面宽度必须跟 Roads.tsx 的实际路宽（26m / 11m）对齐：
    // 窄一半的桥会被路面本身盖住，看上去就是"路直接压过水面"
    const halfWidth = kind === 'major' ? 13.4 : 5.8;
    // 城内基准路面高度；实际高度还要按半径过渡到城外（留园、山塘一带低 2m）
    const innerY = kind === 'major' ? 1.3 : 1.2;

    for (const line of roads[kind]) {
      if (line.length < 2) continue;
      // 沿折线等距采样，记录每个采样点的水面标高与"沿路里程"
      const samples: Array<{ x: number; z: number; water: number | null; along: number }> = [];
      let along = 0;
      const pushSample = (x: number, z: number) => {
        samples.push({ x, z, water: waterLevelAt(x, z), along });
      };
      for (let i = 0; i < line.length - 1; i += 1) {
        const a = line[i];
        const b = line[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const steps = Math.max(1, Math.ceil(len / STEP));
        for (let s = 0; s < steps; s += 1) {
          const t = s / steps;
          pushSample(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
          along += len / steps;
        }
      }
      pushSample(line[line.length - 1][0], line[line.length - 1][1]);
      // 与 ribbon.ts 相同的世界方向相位：同一条路跨 OSM way 拆分后虚线仍然连续
      const dirX = line[line.length - 1][0] - line[0][0];
      const dirZ = line[line.length - 1][1] - line[0][1];
      const dirLen = Math.hypot(dirX, dirZ);
      const phase = dirLen > 0.01 ? (line[0][0] * dirX + line[0][1] * dirZ) / dirLen : 0;

      let i = 0;
      while (i < samples.length) {
        if (samples[i].water === null) {
          i += 1;
          continue;
        }
        let j = i;
        let waterY = samples[i].water as number;
        while (j + 1 < samples.length && samples[j + 1].water !== null) {
          j += 1;
          waterY = Math.max(waterY, samples[j].water as number);
        }
        const start = samples[i];
        const end = samples[j];
        const span = Math.hypot(end.x - start.x, end.z - start.z);
        // 过短是岸边毛刺；过长是顺河而行，都不建桥
        if (span >= 5 && span <= MAX_SPAN) {
          const mid = Math.round((i + j) / 2);
          const x = (start.x + end.x) / 2;
          const z = (start.z + end.z) / 2;
          // 桥轴取桥心处的路向，而不是"入水—出水"两点的弦：
          // 弯道斜切时弦向会把桥面拧着压在路面上，看起来像桥斜着横在路上
          const a = samples[Math.max(i, mid - 3)];
          const b = samples[Math.min(j, mid + 3)];
          const angle =
            Math.hypot(b.x - a.x, b.z - a.z) > 1
              ? Math.atan2(b.z - a.z, b.x - a.x)
              : Math.atan2(end.z - start.z, end.x - start.x);
          // 同一处路口主支路都过河时只留一座：按"新桥心是否落在已有桥面范围内"判断。
          // 不能按 34m 半径一刀切——两条平行街隔 30m 各过一条河时，会被误删一座桥。
          const covered = sites.some((s) => {
            const dx = x - s.x;
            const dz = z - s.z;
            const c = Math.cos(s.angle);
            const sn = Math.sin(s.angle);
            const u = dx * c + dz * sn;
            const v = -dx * sn + dz * c;
            return Math.abs(u) <= s.deckHalf && Math.abs(v) <= s.halfWidth + 2;
          });
          if (!covered) {
            // 桥面必须与两岸路面接顺，否则会"浮"在路面上、引坡斜插进邻近街道：
            //   · 城内河道水面（2.4m）比路面（1.3m）高，桥面只能抬到水上（净空 1.15m），
            //     这是石拱桥的正常形态，桥面用石色；
            //   · 城外山塘河/上塘河水面（-1.3m）远低于路面，此时若仍按"水面 + 1.15"
            //     抬桥，桥面会比路面高半米多，俯视就是一条浅色带横盖马路。
            //     改成"平桥"：桥面压到路面下 2cm，让路面（含车道线）直接铺在桥上，
            //     桥只露出栏板、腹板与桥墩——这才是沙盘里"路从桥上过"的正确读法。
            //   · 城外低水位不承担通航，净空压到 0.45m；否则上塘河这种 26m 宽的河
            //     会被抬成 1.5m 高的石堤，桥面顺着河铺几十米，像一道坝。
            const roadY = roadSurfaceY(x, z, innerY);
            const clearance = waterY < 0 ? 0.45 : 1.15;
            const flat = waterY + clearance <= roadY + 0.02;
            const edgeY = flat ? roadY - 0.02 : waterY + clearance;
            const camber = flat ? 0 : Math.min(1.8, 0.35 + span * 0.008);
            sites.push({
              x,
              z,
              angle,
              halfWidth,
              roadY,
              deckHalf: span / 2 + 2.4,
              crownY: edgeY + camber,
              edgeY,
              flat,
              waterY,
              major: kind === 'major',
              vStart: phase + samples[mid].along,
            });
          }
        }
        i = j + 1;
      }
    }
  }

  return sites;
}

/**
 * 把所有桥合并为两组几何体：
 *   · deck  —— 桥面顶面（平桥与路面同色，被路面覆盖；拱桥露在外面）
 *   · stone —— 桥底、腹板、栏板、立柱、桥墩，共用石作材质
 * 局部坐标：u 沿桥长轴、v 横向、y 竖向，再按路口方向转到世界坐标。
 */
export function buildBridgeGeometry(sites: BridgeSite[]): {
  /** 平桥桥面（压到路面下，与沥青同色，通常被路面盖住，只露桥缘） */
  flatDeck: THREE.BufferGeometry;
  /** 拱桥桥面（城内河道，水面高于路面，桥面本身是石作） */
  archDeck: THREE.BufferGeometry;
  stone: THREE.BufferGeometry;
} {
  const positions: number[] = [];
  const flatDeckPositions: number[] = [];
  const archDeckPositions: number[] = [];
  /** 拱桥桥面的车道线坐标（与路面同口径，虚线相位接着两端路面） */
  const archRoadUV: number[] = [];

  for (const site of sites) {
    const cos = Math.cos(site.angle);
    const sin = Math.sin(site.angle);
    const hw = site.halfWidth;
    // 平桥桥面与路面齐平，不需要引坡；拱桥按高差拉长引坡，坡比不超过 12%
    const rampLen = site.flat ? 0 : Math.max(RAMP_LEN, (site.edgeY - site.roadY) * 7);
    const rampEnd = site.deckHalf + rampLen;
    const CROWN_Y = site.crownY;
    const EDGE_Y = site.edgeY;

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
      const t = Math.min(1, (abs - site.deckHalf) / rampLen);
      return EDGE_Y + (site.roadY + 0.05 - EDGE_Y) * t;
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
      us.push(-(site.deckHalf + rampLen * (1 - i / rampSteps)));
    }
    const deckSteps = Math.max(8, Math.ceil(site.deckHalf / 6));
    for (let i = 1; i <= deckSteps; i += 1) {
      us.push(-site.deckHalf + (2 * site.deckHalf * i) / deckSteps);
    }
    for (let i = 1; i <= rampSteps; i += 1) {
      us.push(site.deckHalf + (rampLen * i) / rampSteps);
    }

    for (let i = 0; i < us.length - 1; i += 1) {
      const u0 = us[i];
      const u1 = us[i + 1];
      const t0 = topY(u0);
      const t1 = topY(u1);

      // 桥面 / 桥底 / 两侧腹板
      const deckTarget = site.flat ? flatDeckPositions : archDeckPositions;
      const deckQuad = (
        a: [number, number, number],
        b: [number, number, number],
        c: [number, number, number],
        d: [number, number, number],
      ) => {
        deckTarget.push(...a, ...b, ...c, ...a, ...c, ...d);
      };
      deckQuad(P(u0, -hw, t0), P(u0, hw, t0), P(u1, hw, t1), P(u1, -hw, t1));
      if (!site.flat) {
        // 桥面也是车道：横向 u 从 0（左缘）到 1（右缘），纵向 v 接着路面的里程，
        // 这样桥面与两端路面的边线、虚线在同一条直线上，不会在桥头断开
        const vy = site.vStart ?? 0;
        // 第三个分量是路口遮罩：桥面自身不与路面重叠，恒为 1
        archRoadUV.push(
          0, vy + u0, 1, 1, vy + u0, 1, 1, vy + u1, 1,
          0, vy + u0, 1, 1, vy + u1, 1, 0, vy + u1, 1,
        );
      }
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

    // 桥墩：按跨径加密，长桥不再是"三根柱子架百米"；
    // 墩脚要下到河床（水面下 1.2m），否则平桥的墩只剩十几厘米高、像悬空
    const pierBase = Math.min(PIER_BASE_Y, (site.waterY ?? 0) - 1.2);
    const pierCount = Math.max(2, Math.ceil((2 * site.deckHalf) / PIER_SPACING));
    for (let k = 0; k <= pierCount; k += 1) {
      const u = -site.deckHalf + (2 * site.deckHalf * k) / pierCount;
      const yTop = topY(u) - DECK_THICK + 0.05;
      box(u, 0, pierBase, 2.6, 2 * hw - 0.9, yTop - pierBase);
    }
  }

  const toGeometry = (verts: number[], uv?: number[]): THREE.BufferGeometry => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    if (uv && uv.length > 0) geo.setAttribute('aRoad', new THREE.Float32BufferAttribute(uv, 3));
    geo.computeVertexNormals();
    return geo;
  };
  return {
    flatDeck: toGeometry(flatDeckPositions),
    archDeck: toGeometry(archDeckPositions, archRoadUV),
    stone: toGeometry(positions),
  };
}
