import { useMemo } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { useSandTable } from '../store/useSandTable';
import { SEASON_LOOKS } from '../constants/seasons';
import { PANMEN_COMPOUND, type PondSpec, type HouseSpec, type TreeSpec } from '../data/panmenCompound';
import { CITY_GATES, PANMEN_GATE_GAP_HALF } from '../data/cityGates';
import { sceneGeometry } from '../data/sceneGeometry';
import { arcBetween, buildWallGeometry } from '../utils/wall';
import { createPitchedRoofGeometry } from '../utils/roof';
import type { LocalPoint2 } from '../types';

/**
 * 盘门三景（水陆城门 + 瑞光塔 + 吴门桥）——程序化重建版。
 *
 * 背景：panmen.glb 由 Blender 导出，但城墙/桥尺度与真实不符、且模型落在
 * 景区质心（城内）导致城墙压河道、桥悬空。这里改为按真实尺寸程序化生成，
 * 精确对齐城墙南墙与护城河。
 *
 * 真实尺度（米）：
 * - 城墙：东西向约 300m、高 8.1m、厚约 12m；含水门（宽 9.3m）+ 陆门（宽 7m）。
 * - 城楼：二层重檐歇山顶，阔 15.5m、高 11.3m、进深 8.65m。
 * - 吴门桥：单孔石拱桥，全长 66.3m、宽 4.8m、拱券净跨 16m、矢高 9m，南北走向。
 * - 瑞光塔：七级八面楼阁式砖塔，高约 43m。
 *
 * 锚点：盘门城门（水门）在城墙南墙 (-780, 2467.8)。城墙沿南墙走向（在盘门
 * 附近方向角约 172°，即 -x 偏南约 7.6°），留口两端与程序化城墙 CityWall 衔接。
 * 吴门桥在城墙南侧跨护城河，瑞光塔在城墙北侧城内。
 */

const STONE = '#9c9484';
const STONE_DARK = '#6d685c';
const WOOD = '#7c3f2c';
const TILE = '#3b424c';
const BRICK = '#b6a68b';
const BRIDGE = '#a9a294';

/** 城墙 group 定位：盘门留口的中点（cityOutline 里程 s=2757.3 处的点，
 *  与 CityWall 的留口 s ± 165 同源，城楼因此正好坐在墙线上） */
const WALL_POS: [number, number, number] = [-780, 0, 2467.8];
/** 城墙 group 的朝向：留口折线的平均走向。墙线本身沿 cityOutline 逐点生成，
 *  这个角度只用来把局部坐标摆正（水门/陆门的局部 x 定位依赖它）。 */
const WALL_ROT = 0.1333;
const WALL_BASE = -2.2;
const WALL_TOP = 7.5;
const WALL_H = WALL_TOP - WALL_BASE; // 9.7m
const WALL_HALF_T = 4; // 半厚（局部 z ±4m，总厚 8m）

/** 水门 / 陆门洞在城墙局部 x 坐标（水门东、陆门西，相距约 28m）
 *  水门局部 x=3 → 世界 x≈-777，正好压在 OSM 水门水道（waterway#11）上 */
const WATER_GATE_LX = 3;
const LAND_GATE_LX = -25;
/** 1986 年重建的城楼就在陆门城台原址上；城楼、陆门、吴门桥须在同一条轴线上。
 *  TOWER_LZ 取该处墙线的局部 z（墙线在盘门并非严格 z=0），城楼才正压城台。 */
const TOWER_LX = LAND_GATE_LX;
const TOWER_LZ = -2.4;

/** 吴门桥：与陆门同轴、沿城墙法向跨护城河（局部坐标，随城墙 group 一起旋转）。
 *  护城河在盘门处：城墙线 z≈2467.8，内岸 z≈2472.4，外岸 z≈2592.4；
 *  桥北端 z=2 顶在城墙南面（陆门洞口），南端 z=134 落在外岸外侧，全长 132m。
 *  真实吴门桥本体 66m，沙盘的护城河按 120m 宽建模，桥需相应加长才能不悬在河心。 */
const BRIDGE_LX = LAND_GATE_LX;
const BRIDGE_Z_CENTER = 68;
const BRIDGE_HALF_LEN = 66;
const BRIDGE_WIDTH = 6.8;   // 要能塞进 7m 宽的陆门洞；真实吴门桥约 4.8m

/** 瑞光塔（绝对场景坐标，城墙北侧城内） */
const PAGODA_X = -722;
const PAGODA_Z = 2400;
const PAGODA_H = 43;

/* ---------------- 城墙（带拱形门洞，局部坐标） ---------------- */

/**
 * 盘门段墙线：严格沿 cityOutline 走，端点与程序化城墙的留口（s ± 165）重合。
 * 原来用一条直墙加固定旋转角，在轮廓折角处会切进城内 18m，两端各短 30~50m，
 * 于是墙在水面上凭空截断（用户截图里的"盘门此处依旧断开"）。
 */
function gapLineWorld(): LocalPoint2[] {
  const gate = CITY_GATES.find((g) => g.name === '盘门');
  const half = PANMEN_GATE_GAP_HALF;
  const s = gate ? gate.sAlong : 2757.3;
  return arcBetween(sceneGeometry.cityOutline, s - half, s + half);
}

/** 世界坐标 → 城墙 group 的局部坐标（group 带 WALL_POS / WALL_ROT） */
function toLocalPoint([x, z]: LocalPoint2): LocalPoint2 {
  const dx = x - WALL_POS[0];
  const dz = z - WALL_POS[2];
  const c = Math.cos(WALL_ROT);
  const s = Math.sin(WALL_ROT);
  return [dx * c - dz * s, dx * s + dz * c];
}

/** 把折线按累计弧长切成 [a,b] 段（保留中间原始顶点） */
function sliceByArc(line: LocalPoint2[], a: number, b: number): LocalPoint2[] {
  const seg: number[] = [0];
  for (let i = 1; i < line.length; i += 1) {
    seg.push(seg[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  }
  const at = (s: number): LocalPoint2 => {
    const t = Math.max(0, Math.min(seg[seg.length - 1], s));
    let i = 0;
    while (i < line.length - 2 && seg[i + 1] < t) i += 1;
    const len = seg[i + 1] - seg[i] || 1;
    const f = (t - seg[i]) / len;
    return [line[i][0] + (line[i + 1][0] - line[i][0]) * f, line[i][1] + (line[i + 1][1] - line[i][1]) * f];
  };
  const out: LocalPoint2[] = [at(a)];
  for (let i = 1; i < line.length - 1; i += 1) {
    if (seg[i] > a && seg[i] < b) out.push(line[i]);
  }
  out.push(at(b));
  return out;
}

/** 墙线在某段局部 x 处的弧长（水门/陆门按原定位落在墙上） */
function arcAtX(line: LocalPoint2[], targetX: number): number {
  let s = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const x0 = line[i][0];
    const x1 = line[i + 1][0];
    const dx = x1 - x0;
    const dz = line[i + 1][1] - line[i][1];
    const len = Math.hypot(dx, dz) || 1;
    if ((x0 - targetX) * (x1 - targetX) <= 0 && dx !== 0) {
      const f = (targetX - x0) / dx;
      return s + len * f;
    }
    s += len;
  }
  return s;
}

/** 城门洞：两侧门垛 + 拱顶（沿墙线切向建，再旋转到该处的实际走向）
 *  rise < hw 时是“坦拱”（水门要 9m 宽又只能 4.6m 高，半圆拱会顶到墙顶）。 */
function pushGate(
  pos: number[],
  center: LocalPoint2,
  tangent: LocalPoint2,
  hw: number,
  spring: number,
  rise: number,
): void {
  const zN = -WALL_HALF_T;
  const zS = WALL_HALF_T;
  const nrm: LocalPoint2 = [-tangent[1], tangent[0]];
  const at = (u: number, y: number, z: number): number[] => [
    center[0] + tangent[0] * u + nrm[0] * z,
    y,
    center[1] + tangent[1] * u + nrm[1] * z,
  ];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    pos.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
  };

  // 门垛（洞口两侧，贯穿墙厚）
  for (const u of [-hw, hw]) {
    quad(at(u, 0, zN), at(u, 0, zS), at(u, spring, zS), at(u, spring, zN));
  }
  // 拱券：两个墙面各一条拱带，内侧补拱腹；拱顶以上补墙身到墙顶
  const steps = 12;
  for (let k = 0; k < steps; k += 1) {
    const t0 = -1 + (2 * k) / steps;
    const t1 = -1 + (2 * (k + 1)) / steps;
    const u0 = t0 * hw;
    const u1 = t1 * hw;
    const y0 = spring + rise * Math.sqrt(Math.max(0, 1 - t0 * t0));
    const y1 = spring + rise * Math.sqrt(Math.max(0, 1 - t1 * t1));
    for (const z of [zN, zS]) {
      quad(at(u0, y0, z), at(u1, y1, z), at(u1, WALL_TOP, z), at(u0, WALL_TOP, z));
    }
    quad(at(u0, y0, zN), at(u1, y1, zN), at(u1, y1, zS), at(u0, y0, zS));
  }
}

function wallGeometry(): THREE.BufferGeometry {
  const line = gapLineWorld().map(toLocalPoint);
  const total = (() => {
    let s = 0;
    for (let i = 0; i < line.length - 1; i += 1) s += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
    return s;
  })();

  // 门洞：[中心局部 x, 半宽, 起拱高, 拱矢高]
  // 拱顶 = 起拱高 + 拱矢高，必须明显低于墙顶（局部 y=7.5），
  // 否则水门会变成一道贯穿整面墙的豁口。水门 9.3m 宽用坦拱：
  // 1.0 + 3.6 = 4.6m 拱顶，墙顶还剩 2.9m 砌体。
  const gates: Array<[number, number, number, number]> = [
    [WATER_GATE_LX, 4.65, 1.0, 3.6],
    [LAND_GATE_LX, 3.5, 1.4, 3.2],
  ];
  const gateArcs = gates
    .map(([x, hw, spring, rise]) => ({ s: arcAtX(line, x), hw, spring, rise }))
    .sort((a, b) => a.s - b.s);

  const parts: THREE.BufferGeometry[] = [];
  let cursor = 0;
  for (const g of gateArcs) {
    if (g.s - g.hw > cursor) {
      parts.push(buildWallGeometry(sliceByArc(line, cursor, g.s - g.hw), WALL_HALF_T * 2, WALL_H, WALL_BASE, false));
    }
    cursor = g.s + g.hw;
  }
  if (cursor < total) {
    parts.push(buildWallGeometry(sliceByArc(line, cursor, total), WALL_HALF_T * 2, WALL_H, WALL_BASE, false));
  }

  const pos: number[] = [];
  for (const g of gateArcs) {
    const s = Math.min(total - 0.01, Math.max(0.01, g.s));
    const p = sliceByArc(line, s - 0.01, s + 0.01);
    const t: LocalPoint2 = [p[1][0] - p[0][0], p[1][1] - p[0][1]];
    const tl = Math.hypot(t[0], t[1]) || 1;
    pushGate(pos, [p[0][0], p[0][1]], [t[0] / tl, t[1] / tl], g.hw, g.spring, g.rise);
  }
  const gatesGeo = new THREE.BufferGeometry();
  gatesGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  gatesGeo.computeVertexNormals();

  // 属性集必须一致（position + normal）才能合并成单个 mesh
  const merged = mergeGeometries([...parts, gatesGeo], false);
  parts.forEach((g) => g.dispose());
  gatesGeo.dispose();
  if (!merged) return buildWallGeometry(line, WALL_HALF_T * 2, WALL_H, WALL_BASE, false);
  merged.computeVertexNormals();
  return merged;
}

function merlonGeometry(): THREE.BufferGeometry[] {
  const line = gapLineWorld().map(toLocalPoint);
  const geos: THREE.BufferGeometry[] = [];
  const skip = [WATER_GATE_LX, LAND_GATE_LX];
  for (let i = 0; i < line.length - 1; i += 1) {
    const [x0, z0] = line[i];
    const [x1, z1] = line[i + 1];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const steps = Math.max(1, Math.round(len / 6));
    const rot = Math.atan2(-dz, dx);
    for (let k = 0; k < steps; k += 1) {
      const f = (k + 0.5) / steps;
      const x = x0 + dx * f;
      const z = z0 + dz * f;
      if (skip.some((s) => Math.abs(x - s) < 8)) continue;
      for (const side of [-1, 1]) {
        const geo = new THREE.BoxGeometry(2.6, 1.0, 1.4);
        geo.rotateY(rot);
        // 沿墙法线挪到内外墙面
        const nx = (dz / len) * side * (WALL_HALF_T - 0.7);
        const nz = (-dx / len) * side * (WALL_HALF_T - 0.7);
        geo.translate(x + nx, WALL_TOP + 0.5, z + nz);
        geos.push(geo);
      }
    }
  }
  return geos;
}

/* ---------------- 城楼（二层重檐歇山，局部坐标，沿城墙中心） ---------------- */

function createHipRoof(w: number, d: number, h: number): THREE.BufferGeometry {
  const hw = w / 2;
  const hd = d / 2;
  const rh = Math.max(0, hw - hd * 0.72);
  const v = new Float32Array([
    // 屋面三角形统一逆时针朝外，法线朝上；否则俯视时整片屋顶被背面剔除
    -hw, 0, -hd, rh, h, 0, hw, 0, -hd,
    -hw, 0, -hd, -rh, h, 0, rh, h, 0,
    hw, 0, hd, -rh, h, 0, -hw, 0, hd,
    hw, 0, hd, rh, h, 0, -rh, h, 0,
    hw, 0, -hd, rh, h, 0, hw, 0, hd,
    -hw, 0, hd, -rh, h, 0, -hw, 0, -hd,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return geo;
}

function towerGeometries(): { wood: THREE.BufferGeometry; roof: THREE.BufferGeometry; stone: THREE.BufferGeometry } {
  const podium = new THREE.BoxGeometry(18, 1.5, 10);
  podium.translate(0, WALL_TOP + 0.75, 0);

  const lower = new THREE.BoxGeometry(15.5, 5, 8.65);
  lower.translate(0, WALL_TOP + 1.5 + 2.5, 0);

  const upper = new THREE.BoxGeometry(11.2, 3.7, 6.4);
  upper.translate(0, WALL_TOP + 1.5 + 5 + 1.85, 0);

  const r1 = createHipRoof(18, 10, 2.4);
  r1.translate(0, WALL_TOP + 1.5 + 5, 0);
  const r2 = createHipRoof(13.6, 8, 3.0);
  r2.translate(0, WALL_TOP + 1.5 + 5 + 3.7, 0);

  const wood = mergeGeometries([lower, upper], false) ?? lower;
  const roof = mergeGeometries([r1, r2], false) ?? r1;
  return { wood, roof, stone: podium };
}

/* ---------------- 吴门桥（单孔石拱桥，局部坐标，随城墙 group 旋转） ---------------- */

function bridgeGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const push = (x: number, y: number, z: number) => pos.push(x, y, z);
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    push(a[0], a[1], a[2]); push(b[0], b[1], b[2]); push(c[0], c[1], c[2]);
    push(a[0], a[1], a[2]); push(c[0], c[1], c[2]); push(d[0], d[1], d[2]);
  };

  const xW = BRIDGE_WIDTH / 2;
  const bedY = -2;          // 河床
  const waterY = 1.4;       // 护城河水面
  const deckBase = 1.7;     // 桥面搭岸高度（内/外岸顶约 1.52m）
  const deckRise = 7.3;     // 桥面中央比岸高（形成缓和拱势，桥顶约 9m）
  const archHalf = 46;      // 拱洞半跨（单孔，跨 92m 主航道）
  const archTop = 8.0;      // 拱洞顶高
  const steps = 48;

  // 桥面高度：从岸边到中央平缓隆起
  const deckY = (z: number): number => {
    const t = (z - BRIDGE_Z_CENTER) / BRIDGE_HALF_LEN;
    return deckBase + deckRise * Math.max(0, 1 - t * t);
  };
  // 拱洞内缘高度：中央最高，两拱脚落到水面；超出拱跨则该段是实心桥台
  const archY = (z: number): number | null => {
    const dz = z - BRIDGE_Z_CENTER;
    if (Math.abs(dz) >= archHalf) return null;
    return waterY + (archTop - waterY) * Math.sqrt(Math.max(0, 1 - (dz / archHalf) ** 2));
  };

  for (let k = 0; k < steps; k++) {
    const z0 = BRIDGE_Z_CENTER - BRIDGE_HALF_LEN + (2 * BRIDGE_HALF_LEN * k) / steps;
    const z1 = BRIDGE_Z_CENTER - BRIDGE_HALF_LEN + (2 * BRIDGE_HALF_LEN * (k + 1)) / steps;
    const d0 = deckY(z0);
    const d1 = deckY(z1);
    const a0 = archY(z0);
    const a1 = archY(z1);

    // 桥面（横跨 x）
    quad(
      [BRIDGE_LX - xW, d0, z0], [BRIDGE_LX - xW, d1, z1],
      [BRIDGE_LX + xW, d1, z1], [BRIDGE_LX + xW, d0, z0],
    );

    // 两侧立面：拱洞段填拱顶→桥面，桥台段填河床→桥面
    for (const sx of [-1, 1]) {
      const x = BRIDGE_LX + sx * xW;
      if (a0 !== null && a1 !== null) {
        quad([x, a0, z0], [x, a1, z1], [x, d1, z1], [x, d0, z0]);
      } else {
        quad([x, bedY, z0], [x, bedY, z1], [x, d1, z1], [x, d0, z0]);
      }
    }

    // 拱腹（拱洞内表面，横跨 x）：只在拱洞段生成
    if (a0 !== null && a1 !== null) {
      quad(
        [BRIDGE_LX - xW, a0, z0], [BRIDGE_LX - xW, a1, z1],
        [BRIDGE_LX + xW, a1, z1], [BRIDGE_LX + xW, a0, z0],
      );
    }
  }

  // 桥面两端封口
  for (const z of [BRIDGE_Z_CENTER - BRIDGE_HALF_LEN, BRIDGE_Z_CENTER + BRIDGE_HALF_LEN]) {
    const d = deckY(z);
    quad([BRIDGE_LX - xW, bedY, z], [BRIDGE_LX - xW, d, z], [BRIDGE_LX + xW, d, z], [BRIDGE_LX + xW, bedY, z]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/* ---------------- 瑞光塔（七级八面） ---------------- */

function pagodaGeometry(): THREE.BufferGeometry {
  const body: THREE.BufferGeometry[] = [];
  const roof: THREE.BufferGeometry[] = [];

  const platform = new THREE.CylinderGeometry(6.5, 6.2, 1.6, 8);
  platform.translate(0, 0.8, 0);
  body.push(platform);

  const n = 7;
  let y = 1.6;
  let r = 6.0;
  const tierH = (PAGODA_H - 1.6 - 3.0) / n;
  for (let i = 0; i < n; i++) {
    const r0 = r * (1 - 0.07 * i);
    const r1 = r * (1 - 0.07 * (i + 1));
    const wall = new THREE.CylinderGeometry(r1, r0, tierH, 8);
    wall.translate(0, y + tierH / 2, 0);
    body.push(wall);
    const eave = new THREE.CylinderGeometry(r1 * 1.5, r1 * 1.15, 0.6, 8);
    eave.translate(0, y + tierH, 0);
    roof.push(eave);
    y += tierH;
  }
  const spire = new THREE.CylinderGeometry(0.9, 1.2, 3.0, 8);
  spire.translate(0, y + 1.5, 0);
  roof.push(spire);

  return mergeGeometries([...body, ...roof], false)!;
}

/* ---------------- 景区腹地：水池 + 苏式院落 ---------------- */

/** 城内水面标高（与 WaterSystem 的 CANAL_Y 一致）；池水铺在青石板台面 y=0 之上 */
const POND_Y = 2.4;
/** 石岸顶标高（略高于水面，压住硬边） */
const POND_BANK_Y = 2.52;

/** 椭圆水池：水面盘 + 环形石岸（都建在 y=0 台面上） */
function pondGeometries(pond: PondSpec): { water: THREE.BufferGeometry; bank: THREE.BufferGeometry } {
  const segs = 28;
  const { cx, cz, rx, rz, bank } = pond;

  // 水面：圆盘（Shape 取 (x,-z)，rotateX 后法线朝上）
  const waterShape = new THREE.Shape();
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const x = cx + Math.cos(a) * rx;
    const z = cz + Math.sin(a) * rz;
    if (i === 0) waterShape.moveTo(x, -z);
    else waterShape.lineTo(x, -z);
  }
  const water = new THREE.ShapeGeometry(waterShape);
  water.rotateX(-Math.PI / 2);
  water.translate(0, POND_Y, 0);

  // 石岸：外椭圆 - 内椭圆 的环形带
  const outer = new THREE.Shape();
  const inner = new THREE.Path();
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const co = Math.cos(a);
    const si = Math.sin(a);
    const ox = cx + co * (rx + bank);
    const oz = cz + si * (rz + bank);
    const ix = cx + co * rx;
    const iz = cz + si * rz;
    if (i === 0) {
      outer.moveTo(ox, -oz);
      inner.moveTo(ix, -iz);
    } else {
      outer.lineTo(ox, -oz);
      inner.lineTo(ix, -iz);
    }
  }
  outer.holes.push(inner);
  const bankGeo = new THREE.ExtrudeGeometry(outer, { depth: POND_BANK_Y, bevelEnabled: false });
  bankGeo.rotateX(-Math.PI / 2); // 挤出方向 +Z → 世界 +Y，岸从 y=0 升到 POND_BANK_Y
  return { water, bank: bankGeo };
}

/** 院落：白墙立方体 + 单位坡顶（按 spec 缩放/旋转），按材质分桶合并 */
function houseGeometries(houses: HouseSpec[]): {
  walls: THREE.BufferGeometry[];
  roofs: THREE.BufferGeometry[];
} {
  const walls: THREE.BufferGeometry[] = [];
  const roofs: THREE.BufferGeometry[] = [];
  const unitRoof = createPitchedRoofGeometry();
  for (const h of houses) {
    const wall = new THREE.BoxGeometry(h.w, h.h, h.d);
    wall.rotateY(h.rot); // 先绕自身中心转，再平移，避免绕原件原点甩出
    wall.translate(h.x, h.h / 2, h.z);
    walls.push(wall);

    const roof = unitRoof.clone();
    // 单位屋顶底 1×1、脊高 1；四坡外挑 8%，底边抬到墙顶之上避免 z-fighting
    roof.scale(h.w * 1.1, h.roofH, h.d * 1.1);
    roof.translate(0, h.h + 0.05, 0);
    roof.rotateY(h.rot);
    roof.translate(h.x, 0, h.z);
    roofs.push(roof);
  }
  return { walls, roofs };
}

/** 点景树：按 tint 分 4 组（树干 + 双层圆锥树冠），冬季只留树干与少量常绿 */
function treeGeometries(trees: TreeSpec[]): { trunks: THREE.BufferGeometry; crowns: THREE.BufferGeometry[][] } {
  const trunks: THREE.BufferGeometry[] = [];
  const crowns: THREE.BufferGeometry[][] = [[], [], [], []];
  for (const t of trees) {
    const trunk = new THREE.CylinderGeometry(0.35, 0.5, t.h * 0.45, 5);
    trunk.translate(t.x, t.h * 0.225, t.z);
    trunks.push(trunk);
    const c1 = new THREE.ConeGeometry(t.h * 0.22, t.h * 0.5, 6);
    c1.translate(t.x, t.h * 0.55, t.z);
    const c2 = new THREE.ConeGeometry(t.h * 0.17, t.h * 0.42, 6);
    c2.translate(t.x, t.h * 0.82, t.z);
    crowns[t.tint % 4].push(c1, c2);
  }
  return {
    trunks: mergeGeometries(trunks, false) ?? new THREE.BufferGeometry(),
    crowns: crowns.map((group) => mergeGeometries(group, false) ?? undefined).filter(Boolean) as THREE.BufferGeometry[],
  };
}

/* ---------------- 渲染 ---------------- */

export function Panmen() {
  const season = useSandTable((state) => state.season);
  const winter = season === 'winter';

  const wall = useMemo(wallGeometry, []);
  const merlons = useMemo(() => mergeGeometries(merlonGeometry(), false) ?? undefined, []);
  const tower = useMemo(towerGeometries, []);
  const bridge = useMemo(bridgeGeometry, []);
  const pagoda = useMemo(pagodaGeometry, []);

  // 景区腹地：水池 + 院落（按材质合并，几个 draw call）
  const compound = useMemo(() => {
    const ponds = PANMEN_COMPOUND.ponds.map(pondGeometries);
    const waterGeo = mergeGeometries(ponds.map((p) => p.water), false);
    const bankGeo = mergeGeometries(ponds.map((p) => p.bank), false);
    const houseGeo = houseGeometries(PANMEN_COMPOUND.houses);
    const treeGeo = treeGeometries(PANMEN_COMPOUND.trees);
    return {
      water: waterGeo ?? undefined,
      bank: bankGeo ?? undefined,
      houseWalls: mergeGeometries(houseGeo.walls, false) ?? undefined,
      houseRoofs: mergeGeometries(houseGeo.roofs, false) ?? undefined,
      treeTrunks: treeGeo.trunks,
      treeCrowns: treeGeo.crowns,
    };
  }, []);

  const look = SEASON_LOOKS[season];
  const stoneColor = winter ? '#eef2f5' : STONE;
  const stoneDark = winter ? '#e2e8ec' : STONE_DARK;
  const woodColor = winter ? '#8e5f52' : WOOD;
  const tileColor = winter ? '#eef2f6' : TILE;
  const brickColor = winter ? '#d9d5cc' : BRICK;
  const bridgeColor = winter ? '#e2e2dc' : BRIDGE;

  return (
    <group>
      {/* 景区腹地：白墙黛瓦院落填满原空地，4 片水池点缀东西两半 */}
      {compound.houseWalls && (
        <mesh name="panmen-compound-walls" geometry={compound.houseWalls} castShadow receiveShadow>
          <meshStandardMaterial color={winter ? '#b9bfc4' : '#efe9dc'} roughness={0.92} flatShading />
        </mesh>
      )}
      {compound.houseRoofs && (
        <mesh name="panmen-compound-roofs" geometry={compound.houseRoofs} castShadow receiveShadow>
          <meshStandardMaterial
            color={winter ? '#eef2f6' : '#525b67'}
            roughness={0.9}
            flatShading
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      {compound.bank && (
        <mesh name="panmen-pond-banks" geometry={compound.bank} castShadow receiveShadow>
          <meshStandardMaterial color={winter ? '#e2e8ec' : '#9c9484'} roughness={0.95} flatShading />
        </mesh>
      )}
      {compound.water && (
        <mesh name="panmen-ponds" geometry={compound.water} receiveShadow>
          <meshStandardMaterial
            color={look.water}
            roughness={winter ? 0.55 : 0.18}
            metalness={winter ? 0 : 0.1}
            transparent={!winter}
            opacity={winter ? 1 : 0.92}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      {/* 点景树：院内与池畔绿化，冬季大部分落叶 */}
      {compound.treeTrunks && compound.treeTrunks.attributes.position?.count > 0 && (
        <mesh name="panmen-trees-trunk" geometry={compound.treeTrunks} castShadow>
          <meshStandardMaterial color={winter ? '#6b6156' : '#6b5440'} roughness={0.95} flatShading />
        </mesh>
      )}
      {compound.treeCrowns.map((geo, i) =>
        winter ? null : (
          <mesh key={`pcrown-${i}`} name={`panmen-trees-crown-${i}`} geometry={geo} castShadow>
            <meshStandardMaterial color={look.crowns[i % look.crowns.length]} roughness={0.9} flatShading />
          </mesh>
        ),
      )}

      {/* 城墙 + 垛口 + 城楼：沿南墙走向定位并旋转 */}
      <group position={WALL_POS} rotation={[0, WALL_ROT, 0]}>
        <mesh name="panmen-wall" geometry={wall} castShadow receiveShadow>
          <meshStandardMaterial color={stoneColor} roughness={0.95} flatShading />
        </mesh>
        {merlons && (
          <mesh name="panmen-merlons" geometry={merlons} castShadow receiveShadow>
            <meshStandardMaterial color={stoneDark} roughness={0.95} flatShading />
          </mesh>
        )}
        <group position={[TOWER_LX, 0, TOWER_LZ]}>
          <mesh name="panmen-tower-podium" geometry={tower.stone} castShadow receiveShadow>
            <meshStandardMaterial color={stoneDark} roughness={0.95} flatShading />
          </mesh>
          <mesh name="panmen-tower-body" geometry={tower.wood} castShadow>
            <meshStandardMaterial color={woodColor} roughness={0.85} flatShading />
          </mesh>
          <mesh name="panmen-tower-roof" geometry={tower.roof} castShadow>
            <meshStandardMaterial color={tileColor} roughness={0.88} flatShading />
          </mesh>
        </group>

        {/* 吴门桥：与陆门同轴，沿城墙法向跨护城河（几何为局部坐标，随 group 旋转） */}
        <mesh name="panmen-bridge" geometry={bridge} castShadow receiveShadow>
          <meshStandardMaterial color={bridgeColor} roughness={0.94} flatShading />
        </mesh>
      </group>

      {/* 瑞光塔 */}
      <group position={[PAGODA_X, 0, PAGODA_Z]}>
        <mesh name="panmen-pagoda" geometry={pagoda} castShadow receiveShadow>
          <meshStandardMaterial color={brickColor} roughness={0.9} flatShading />
        </mesh>
      </group>
    </group>
  );
}
