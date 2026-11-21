import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sceneGeometry } from '../data/sceneGeometry';
import { useSandTable } from '../store/useSandTable';
import { useBuildings, type BuildingsData } from '../hooks/useBuildings';
import { useRoads, type RoadsData } from '../hooks/useRoads';
import { SEASON_LOOKS } from '../constants/seasons';
import { pointInRing, lonLatToVector3 } from '../utils/geo';
import { WORLD_LIMIT } from '../constants/geo';
import { HILLS } from '../data/hills';
import { buildOuterCity } from '../data/outerCity';
import type { LocalPoint2 } from '../types';

const TRUNK_COLORS = ['#6b5642', '#5f4c3b', '#75604a'];

/** 行道树距路缘的距离：近处被建筑占位时退到更外侧 */
const STREET_OFFSETS = [2.4, 5.4];
/** 行道树数量上限（干/冠各一个 InstancedMesh，控制远景三角形数） */
const MAX_STREET_TREES = 9000;
/** 城外行道树上限 */
const MAX_OUTER_TREES = 5200;
/** 城外空地散生林（绿化带）上限 */
const MAX_SCATTER_TREES = 8000;
/**
 * 城外空地散生林：3–5.8km 的城郊此前只剩屋顶与马路，大片空地是裸地。
 * 这里按 68m 网格撒点补绿化带，避开道路、河湖、山体、园林与民居，
 * 成组出现（一格 1–2 棵）更像林地而不是行道树。
 */
const SCATTER_STEP = 68;

function scatterOuterWoods(roadIndex: RoadIndex, grids: (FootprintGrid | null)[]): TreeTransform[] {
  const trees: TreeTransform[] = [];
  let seed = 910000;

  for (let gx = -WORLD_LIMIT; gx <= WORLD_LIMIT; gx += SCATTER_STEP) {
    for (let gz = -WORLD_LIMIT; gz <= WORLD_LIMIT; gz += SCATTER_STEP) {
      if (trees.length >= MAX_SCATTER_TREES) return trees;
      seed += 1;
      const x = gx + (hash(seed) - 0.5) * SCATTER_STEP * 0.85;
      const z = gz + (hash(seed + 17) - 0.5) * SCATTER_STEP * 0.85;
      const r = Math.hypot(x, z);
      if (r < 2600 || r > WORLD_LIMIT - 70) continue;
      if (hash(seed + 3) > 0.34) continue;
      if (pointInRing(sceneGeometry.cityOutline, x, z)) continue;
      if (distanceToSegments(WALL_SEGMENTS, x, z) < MOAT_OUTER + 8) continue;
      if (distanceToSegments(OUTER_WATER_SEGMENTS, x, z) < 26) continue;
      if (HILL_FOOTPRINTS.some((h) => Math.hypot(x - h.x, z - h.z) < h.r * 1.06)) continue;
      if (insideLandmark(x, z, 10)) continue;
      if (onAnyRoad(x, z, roadIndex, 1.5)) continue;
      if (anyBlocked(grids, x, z, 4)) continue;

      const n = hash(seed + 91) > 0.62 ? 2 : 1;
      for (let k = 0; k < n; k += 1) {
        const tx = x + (hash(seed + 11 + k) - 0.5) * 26;
        const tz = z + (hash(seed + 23 + k) - 0.5) * 26;
        if (onAnyRoad(tx, tz, roadIndex, 1.5)) continue;
        trees.push({
          x: tx,
          z: tz,
          y: OUTER_TREE_Y,
          trunkH: 5.4 + hash(seed + 31 + k) * 3.4,
          crownR: 3.6 + hash(seed + 37 + k) * 2.8,
          lean: (hash(seed + 41 + k) - 0.5) * 0.1,
        });
      }
    }
  }
  return trees;
}


/** 建筑占位网格边长，用于快速判断树点是否落在房子里 */
const GRID_CELL = 24;
/** 河道中心线外多少米内不放行道树（河宽 30m + 驳岸压顶） */
const WATER_MARGIN = 19;
/** 城墙中心线两侧多少米内不放树：墙厚 8m，留出墙外散水后不穿模 */
const WALL_CLEARANCE = 13;
/**
 * 护城河外岸：河面从城墙外 4.6m 起铺 120m，再加 3.2m 石驳岸。
 * sceneGeometry.waterways 里有一条折线与城墙轮廓完全重合（即护城河），
 * 若按城内 30m 河道的 19m 退让去种树，树会整排站在河心里。
 */
const MOAT_OUTER = 132;
/** 城外地面高度 */
const OUTER_TREE_Y = -2;

/** 盘门水门水道 x（与 WaterSystem.PANMEN_GATE.x、sceneGeometry.trimPanmenGate 一致） */
const PANMEN_GATE_X = -777;

const hash = (i: number): number => {
  const v = Math.sin(i * 91.17 + 47.3) * 43758.5453;
  return v - Math.floor(v);
};

/**
 * 冬日枯枝：主干上部伸出的几根细枝，枝梢用顶点色偏白，
 * 表现"树枝上压着白雪"；不再生成额外积雪几何，控制三角形数量。
 */
function createBranchGeometry(): THREE.BufferGeometry {
  const wood = new THREE.Color('#5b493a');
  const snow = new THREE.Color('#e9eff4');
  const parts: THREE.BufferGeometry[] = [];
  const count = 5;

  for (let i = 0; i < count; i += 1) {
    const len = 0.9 + (i % 2) * 0.22;
    // 3 段开口圆柱：每根枝只有 6 个三角形
    const geo = new THREE.CylinderGeometry(0.03, 0.07, len, 3, 1, true).translate(0, len / 2, 0);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let v = 0; v < pos.count; v += 1) {
      const t = Math.max(0, Math.min(1, pos.getY(v) / len));
      c.copy(wood).lerp(snow, 0.1 + t * 0.85);
      colors[v * 3] = c.r;
      colors[v * 3 + 1] = c.g;
      colors[v * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.rotateZ(0.5 + (i % 3) * 0.18);
    geo.rotateY((i / count) * Math.PI * 2 + 0.4);
    parts.push(geo);
  }

  return mergeGeometries(parts);
}

interface TreeTransform {
  x: number;
  z: number;
  /** 树根高度：城内台面 0，城外基准面 -2 */
  y: number;
  trunkH: number;
  crownR: number;
  lean: number;
}

type Rect = [number, number, number, number];

interface FootprintGrid {
  map: Map<string, Rect[]>;
}

/** 旋转矩形建筑的轴对齐包围盒 */
function footprintRect([x, z, w, d, rot]: number[]): Rect {
  const c = Math.abs(Math.cos(rot));
  const s = Math.abs(Math.sin(rot));
  const hx = (c * w + s * d) / 2;
  const hz = (s * w + c * d) / 2;
  return [x - hx, x + hx, z - hz, z + hz];
}

/** 把建筑按网格分桶，供行道树避让（城内坡顶/平顶 + 城外民居一起入桶） */
function buildFootprintGrid(data: BuildingsData): FootprintGrid {
  const map = new Map<string, Rect[]>();
  const push = (rec: number[]): void => {
    const rect = footprintRect(rec);
    const [x0, x1, z0, z1] = rect;
    for (let cx = Math.floor(x0 / GRID_CELL); cx <= Math.floor(x1 / GRID_CELL); cx += 1) {
      for (let cz = Math.floor(z0 / GRID_CELL); cz <= Math.floor(z1 / GRID_CELL); cz += 1) {
        const key = `${cx},${cz}`;
        const list = map.get(key);
        if (list) list.push(rect);
        else map.set(key, [rect]);
      }
    }
  };
  for (const rec of data.pitched) push(rec);
  for (const rec of data.flat) push(rec);
  for (const rec of data.outer) push(rec);
  return { map };
}

/** 程序化城外街区（Outskirts 那 2.6 万栋）也要入桶，否则散生林会从屋顶长出来 */
function buildOuterBlockGrid(roads: RoadsData): FootprintGrid {
  const map = new Map<string, Rect[]>();
  for (const block of buildOuterCity(roads).blocks) {
    const rect = footprintRect([block.x, block.z, block.w, block.d, block.rot]);
    const [x0, x1, z0, z1] = rect;
    for (let cx = Math.floor(x0 / GRID_CELL); cx <= Math.floor(x1 / GRID_CELL); cx += 1) {
      for (let cz = Math.floor(z0 / GRID_CELL); cz <= Math.floor(z1 / GRID_CELL); cz += 1) {
        const key = `${cx},${cz}`;
        const list = map.get(key);
        if (list) list.push(rect);
        else map.set(key, [rect]);
      }
    }
  }
  return { map };
}

/** 树点是否压到建筑（含 margin 余量） */
function blocked(grid: FootprintGrid, x: number, z: number, margin: number): boolean {
  const list = grid.map.get(`${Math.floor(x / GRID_CELL)},${Math.floor(z / GRID_CELL)}`);
  if (!list) return false;
  for (const [x0, x1, z0, z1] of list) {
    if (x > x0 - margin && x < x1 + margin && z > z0 - margin && z < z1 + margin) return true;
  }
  return false;
}

/** 多张占位网格（真实建筑 + 程序化城外街区）任一命中即算压到房子 */
function anyBlocked(grids: (FootprintGrid | null)[], x: number, z: number, margin: number): boolean {
  for (const grid of grids) {
    if (grid && blocked(grid, x, z, margin)) return true;
  }
  return false;
}

interface WaterSegment {
  x1: number;
  z1: number;
  dx: number;
  dz: number;
  l2: number;
}

/** 河道折线预展开成线段，避免逐点判断时反复遍历折线 */
const WATER_SEGMENTS: WaterSegment[] = sceneGeometry.waterways.flatMap((line) =>
  line.slice(0, -1).map(([x1, z1], i) => {
    const [x2, z2] = line[i + 1];
    const dx = x2 - x1;
    const dz = z2 - z1;
    return { x1, z1, dx, dz, l2: dx * dx + dz * dz };
  }),
);

/** 城外水道（山塘河）单独一套线段：城外种树不能种进河里 */
const OUTER_WATER_SEGMENTS: WaterSegment[] = (sceneGeometry.outerWaterways ?? []).flatMap((line) =>
  line.slice(0, -1).map(([x1, z1], i) => {
    const [x2, z2] = line[i + 1];
    const dx = x2 - x1;
    const dz = z2 - z1;
    return { x1, z1, dx, dz, l2: dx * dx + dz * dz };
  }),
);

/** 城墙轮廓线段：树点离墙太近就会与墙体、垛口交叠 */
const WALL_SEGMENTS: WaterSegment[] = sceneGeometry.cityOutline.flatMap(([x1, z1], i, arr) => {
  const [x2, z2] = arr[(i + 1) % arr.length];
  const dx = x2 - x1;
  const dz = z2 - z1;
  return [{ x1, z1, dx, dz, l2: dx * dx + dz * dz }];
});

function distanceToSegments(segments: WaterSegment[], x: number, z: number): number {
  let best = Infinity;
  for (const seg of segments) {
    const t = seg.l2 > 0 ? Math.min(1, Math.max(0, ((x - seg.x1) * seg.dx + (z - seg.z1) * seg.dz) / seg.l2)) : 0;
    const px = seg.x1 + seg.dx * t - x;
    const pz = seg.z1 + seg.dz * t - z;
    const d = px * px + pz * pz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/**
 * 车行道路面索引：树干绝不能站在路面上。
 * 每条折线段带真实半宽（主 13m / 次 5.5m，与 Roads.tsx 的 MAJOR_WIDTH/MINOR_WIDTH 一致），
 * 用网格加速查询，避免逐树遍历上万条路段。
 */
interface RoadSegment extends WaterSegment {
  half: number;
}
interface RoadIndex {
  segs: RoadSegment[];
  grid: Map<string, number[]>;
}
const ROAD_CELL = 60;
const roadKey = (cx: number, cz: number) => `${cx},${cz}`;

function buildRoadIndex(roads: RoadsData): RoadIndex {
  const segs: RoadSegment[] = [];
  const grid = new Map<string, number[]>();
  for (const [kind, half] of [['major', 13], ['minor', 5.5]] as const) {
    for (const line of roads[kind]) {
      for (let i = 0; i < line.length - 1; i += 1) {
        const [x1, z1] = line[i];
        const [x2, z2] = line[i + 1];
        const dx = x2 - x1;
        const dz = z2 - z1;
        const seg: RoadSegment = { x1, z1, dx, dz, l2: dx * dx + dz * dz, half };
        const id = segs.length;
        segs.push(seg);
        for (let cx = Math.floor(Math.min(x1, x2) / ROAD_CELL); cx <= Math.floor(Math.max(x1, x2) / ROAD_CELL); cx += 1) {
          for (let cz = Math.floor(Math.min(z1, z2) / ROAD_CELL); cz <= Math.floor(Math.max(z1, z2) / ROAD_CELL); cz += 1) {
            const k = roadKey(cx, cz);
            let arr = grid.get(k);
            if (!arr) grid.set(k, (arr = []));
            arr.push(id);
          }
        }
      }
    }
  }
  return { segs, grid };
}

/** 点是否压在任意一条车行道路面上。margin = 树干半径外的额外缓冲（默认 1m）。 */
function onAnyRoad(x: number, z: number, index: RoadIndex, margin = 1): boolean {
  const cx = Math.floor(x / ROAD_CELL);
  const cz = Math.floor(z / ROAD_CELL);
  // 3×3 邻域格边长 180m，远大于最大路面半宽 13m，不会漏判
  for (let ix = cx - 1; ix <= cx + 1; ix += 1) {
    for (let iz = cz - 1; iz <= cz + 1; iz += 1) {
      const arr = index.grid.get(roadKey(ix, iz));
      if (!arr) continue;
      for (const id of arr) {
        const seg = index.segs[id];
        const t = seg.l2 > 0 ? Math.min(1, Math.max(0, ((x - seg.x1) * seg.dx + (z - seg.z1) * seg.dz) / seg.l2)) : 0;
        const px = seg.x1 + seg.dx * t - x;
        const pz = seg.z1 + seg.dz * t - z;
        const limit = seg.half + margin;
        if (px * px + pz * pz < limit * limit) return true;
      }
    }
  }
  return false;
}

/** 山体在场景中的平面位置与占地半径（山上不种行道树，否则树会埋进山里） */
const HILL_FOOTPRINTS = HILLS.map((hill) => {
  const v = lonLatToVector3(hill.lon, hill.lat, 0);
  return { x: v.x, z: v.z, r: hill.radius };
});

/** 树点是否落在河道（含驳岸）范围内 */
function nearWater(x: number, z: number, margin: number): boolean {
  for (const seg of WATER_SEGMENTS) {
    const t = seg.l2 > 0 ? Math.min(1, Math.max(0, ((x - seg.x1) * seg.dx + (z - seg.z1) * seg.dz) / seg.l2)) : 0;
    const px = seg.x1 + seg.dx * t - x;
    const pz = seg.z1 + seg.dz * t - z;
    if (px * px + pz * pz < margin * margin) return true;
  }
  return false;
}

/** 景点轮廓（含包围盒预筛）：景点内部布局由各自 GLB 表达，行道树不得插入 */
interface LandmarkRing {
  ring: LocalPoint2[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const LANDMARK_RINGS: LandmarkRing[] = Object.values(sceneGeometry.landmarks).flatMap((lm) => {
  const ring = lm.outline;
  if (!ring || ring.length < 3) return [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of ring) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return [{ ring, minX, maxX, minZ, maxZ }];
});

/** 树点是否落在任一景点轮廓内（pad > 0 时为轮廓外扩的余量，避免树冠探进园内） */
function insideLandmark(x: number, z: number, pad = 0): boolean {
  if (ringHit(x, z)) return true;
  if (pad <= 0) return false;
  return ringHit(x + pad, z) || ringHit(x - pad, z) || ringHit(x, z + pad) || ringHit(x, z - pad);
}

function ringHit(x: number, z: number): boolean {
  for (const r of LANDMARK_RINGS) {
    if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) continue;
    if (pointInRing(r.ring, x, z)) return true;
  }
  return false;
}

/** 判断一条水道折线是否就是护城河本身（与城墙轮廓逐点重合） */
function isMoatLine(line: LocalPoint2[]): boolean {
  return line.every(([x, z]) => distanceToSegments(WALL_SEGMENTS, x, z) < 12);
}

/** 盘门水门水道：x=-766 的南北向短线，两端 z 都在 2200~2500 之间 */
function isPanmenGateLine(line: LocalPoint2[]): boolean {
  if (line.length !== 2) return false;
  const [a, b] = line;
  return (
    Math.abs(a[0] - PANMEN_GATE_X) < 4 &&
    Math.abs(b[0] - PANMEN_GATE_X) < 4 &&
    a[1] > 2000 &&
    b[1] > 2000
  );
}

/** 河道两侧行道树：沿折线每 30m 取点，落在驳岸压顶之外 */
function alongWaterways(roadIndex: RoadIndex): TreeTransform[] {
  const trees: TreeTransform[] = [];
  let seed = 0;
  for (const line of sceneGeometry.waterways) {
    const moat = isMoatLine(line);
    // 盘门水门水道：两侧是城墙/水门/景区，不种行道树，否则南端会种进护城河水面
    if (isPanmenGateLine(line)) continue;
    for (let i = 0; i < line.length - 1; i += 1) {
      const [x1, z1] = line[i];
      const [x2, z2] = line[i + 1];
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len = Math.hypot(dx, dz);
      if (len < 25) continue;
      const steps = Math.floor(len / 30);
      for (let s = 0; s < steps; s += 1) {
        const t = (s + 0.5) / steps;
        const nx = -dz / len;
        const nz = dx / len;
        for (const side of [-1, 1]) {
          seed += 1;
          // 护城河：退到石驳岸外侧，且只种城外那一侧（内侧是城墙）
          const offset = moat ? MOAT_OUTER + 2 + hash(seed) * 4 : WATER_MARGIN + 0.6 + hash(seed) * 3;
          const x = x1 + dx * t + nx * offset * side;
          const z = z1 + dz * t + nz * offset * side;
          if (moat && pointInRing(sceneGeometry.cityOutline, x, z)) continue;
          if (insideLandmark(x, z, 4)) continue;
          if (distanceToSegments(WALL_SEGMENTS, x, z) < WALL_CLEARANCE) continue;
          // 河岸树也不能站到沿河/跨河的马路路面上
          if (onAnyRoad(x, z, roadIndex, 1.2)) continue;
          trees.push({
            x,
            z,
            // 护城河外岸在城外基准面上，城内河道两岸在台面上
            y: moat ? OUTER_TREE_Y : 0,
            trunkH: 6.5 + hash(seed + 3) * 2.4,
            crownR: 4.8 + hash(seed + 5) * 2.6,
            lean: (hash(seed + 7) - 0.5) * 0.12,
          });
        }
      }
    }
  }
  return trees;
}

/**
 * 街巷行道树：沿主/次干道两侧种植，遇建筑让位、遇河道避让。
 * 这是"江南绿城"观感的关键——城内原本几乎没有植被。
 */
function alongStreets(roads: RoadsData, grid: FootprintGrid, roadIndex: RoadIndex): TreeTransform[] {
  const trees: TreeTransform[] = [];
  const nets: { lines: LocalPoint2[][]; half: number; spacing: number }[] = [
    { lines: roads.minor, half: 5.5, spacing: 22 },
    { lines: roads.major, half: 13, spacing: 30 },
  ];
  let seed = 0;

  for (const net of nets) {
    for (const line of net.lines) {
      for (let i = 0; i < line.length - 1; i += 1) {
        const [x1, z1] = line[i];
        const [x2, z2] = line[i + 1];
        const dx = x2 - x1;
        const dz = z2 - z1;
        const len = Math.hypot(dx, dz);
        if (len < 18) continue;
        const nx = -dz / len;
        const nz = dx / len;
        const steps = Math.max(1, Math.floor(len / net.spacing));
        for (let s = 0; s < steps; s += 1) {
          const t = (s + 0.5) / steps;
          const bx = x1 + dx * t;
          const bz = z1 + dz * t;
          for (const side of [-1, 1] as const) {
            seed += 1;
            for (const extra of STREET_OFFSETS) {
              const x = bx + nx * (net.half + extra) * side;
              const z = bz + nz * (net.half + extra) * side;
              if (!pointInRing(sceneGeometry.cityOutline, x, z)) continue;
              if (blocked(grid, x, z, 1.4)) continue;
              if (nearWater(x, z, WATER_MARGIN)) continue;
              if (insideLandmark(x, z, 5)) continue;
              if (distanceToSegments(WALL_SEGMENTS, x, z) < WALL_CLEARANCE) continue;
              // A 路的树不能落到交叉的 B 路路面上：按全路网真实半宽判定
              if (onAnyRoad(x, z, roadIndex, 1.2)) continue;
              trees.push({
                x,
                z,
                y: 0,
                trunkH: 5.2 + hash(seed + 3) * 1.8,
                crownR: 3.2 + hash(seed + 5) * 1.9,
                lean: (hash(seed + 7) - 0.5) * 0.1,
              });
              break;
            }
            if (trees.length >= MAX_STREET_TREES) return trees;
          }
        }
      }
    }
  }
  return trees;
}

/**
 * 城外形道树：沿 OSM 主次干道在城外一侧补种，
 * 让 3–5.8km 的城郊不只是屋顶与马路，而是有连续的林荫；
 * 河里、园林里、山体上都不种，避免穿模。
 */
function alongOuterRoads(roads: RoadsData, grids: (FootprintGrid | null)[], roadIndex: RoadIndex): TreeTransform[] {
  const trees: TreeTransform[] = [];
  const nets = [
    { lines: roads.major, half: 13, spacing: 50, offsets: [18, 25] },
    { lines: roads.minor, half: 5.5, spacing: 64, offsets: [11, 16] },
  ];
  let seed = 480000;

  for (const net of nets) {
    for (const line of net.lines) {
      for (let i = 0; i < line.length - 1; i += 1) {
        const [x1, z1] = line[i];
        const [x2, z2] = line[i + 1];
        const dx = x2 - x1;
        const dz = z2 - z1;
        const len = Math.hypot(dx, dz);
        if (len < 24) continue;
        const mx = (x1 + x2) / 2;
        const mz = (z1 + z2) / 2;
        const r = Math.hypot(mx, mz);
        if (r < 2500 || r > WORLD_LIMIT - 60) continue;
        if (pointInRing(sceneGeometry.cityOutline, mx, mz)) continue;
        if (HILL_FOOTPRINTS.some((h) => Math.hypot(mx - h.x, mz - h.z) < h.r * 1.02)) continue;

        const nx = -dz / len;
        const nz = dx / len;
        const steps = Math.max(1, Math.floor(len / net.spacing));
        for (let s = 0; s < steps; s += 1) {
          const t = (s + 0.5) / steps;
          const bx = x1 + dx * t;
          const bz = z1 + dz * t;
          for (const side of [-1, 1] as const) {
            seed += 1;
            if (hash(seed) > 0.58) continue;
            for (const extra of net.offsets) {
              const x = bx + nx * (net.half + extra) * side;
              const z = bz + nz * (net.half + extra) * side;
              if (Math.hypot(x, z) > WORLD_LIMIT - 40) break;
              if (pointInRing(sceneGeometry.cityOutline, x, z)) continue;
              // 城外一侧的点一律在城墙外，这里顺带挡掉护城河水面与石驳岸
              if (distanceToSegments(WALL_SEGMENTS, x, z) < MOAT_OUTER) continue;
              if (distanceToSegments(OUTER_WATER_SEGMENTS, x, z) < 22) continue;
              if (insideLandmark(x, z, 8)) continue;
              // 不落到任何一条马路（含交叉路）上：按真实半宽判定，
              // 旧实现用固定 9m，小于主干道半宽 13m，导致树长进路面。
              if (onAnyRoad(x, z, roadIndex, 1.5)) continue;
              // 城外民居同样要避让，否则树干会从屋顶里长出来
              if (anyBlocked(grids, x, z, 2.2)) continue;
              trees.push({
                x,
                z,
                y: OUTER_TREE_Y,
                trunkH: 6 + hash(seed + 3) * 3,
                crownR: 4 + hash(seed + 5) * 2.4,
                lean: (hash(seed + 7) - 0.5) * 0.1,
              });
              break;
            }
            if (trees.length >= MAX_OUTER_TREES) return trees;
          }
        }
      }
    }
  }
  return trees;
}

/**
 * 树木：河道行道树 + 街巷行道树 + 城外形道树。
 * 园林内部的树由各园林 GLB 自带的低矮点缀树表达，这里不再叠加，
 * 否则城市尺度的大树冠会把厅堂楼阁整片遮住。
 * 干/冠/冬日枯枝各一个 InstancedMesh，颜色按季节取色；
 * 冬季落叶后只剩枝干，枝梢带雪。
 */
export function Trees() {
  const trunkRef = useRef<THREE.InstancedMesh>(null);
  const crownRef = useRef<THREE.InstancedMesh>(null);
  const branchRef = useRef<THREE.InstancedMesh>(null);
  const season = useSandTable((state) => state.season);
  const look = SEASON_LOOKS[season];
  const buildings = useBuildings();
  const roads = useRoads();

  const trees = useMemo(() => {
    const roadIndex = roads ? buildRoadIndex(roads) : null;
    const grid = buildings ? buildFootprintGrid(buildings) : null;
    const blockGrid = roads ? buildOuterBlockGrid(roads) : null;
    const grids = [grid, blockGrid];
    // 四类树统一用带真实半宽的路面索引避让：树干只在路两侧，不在路面上。
    const waterside = roadIndex ? alongWaterways(roadIndex) : [];
    const streets = roads && grid && roadIndex ? alongStreets(roads, grid, roadIndex) : [];
    const outer = roads && roadIndex ? alongOuterRoads(roads, grids, roadIndex) : [];
    const woods = roadIndex ? scatterOuterWoods(roadIndex, grids) : [];
    const all = [...waterside, ...streets, ...outer, ...woods];
    return all.filter((t) => {
      // 兜底：任何生成函数漏掉的护城河水面树一律剔除。
      // 护城河是城墙线外 4.6~124.6m 的环带（再加 3.2m 驳岸），
      // 城外(cityOutline 之外)且离城墙线在 MOAT_OUTER+4 以内即落在河面里。
      if (t.y <= -0.5 && !pointInRing(sceneGeometry.cityOutline, t.x, t.z)
        && distanceToSegments(WALL_SEGMENTS, t.x, t.z) < MOAT_OUTER + 4) return false;
      // 兜底：任何树都不得压在车行道路面上（含树干半径缓冲）
      if (roadIndex && onAnyRoad(t.x, t.z, roadIndex, 1.2)) return false;
      return true;
    });
  }, [buildings, roads]);

  // QA 探针：把最终树位暴露给 window，便于客观校验「树上路/树进水」为零。
  // 仅 DEV 生效，生产构建无任何开销。
  useLayoutEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__treePositions = trees.map((t) => ({
        x: t.x, z: t.z, y: t.y,
      }));
    }
  }, [trees]);

  /**
   * 园林绿地已改由 Landmarks 的石台承担（台面铺草色）：
   * 之前这里再叠一张 2.5m 高的草皮，会把园林模型自带的水面与铺地全盖住，
   * 远看只剩"房子 + 草地"。
   */
  const trunkGeo = useMemo(
    () => new THREE.CylinderGeometry(0.2, 0.28, 1, 5).translate(0, 0.5, 0),
    [],
  );
  const crownGeo = useMemo(() => new THREE.IcosahedronGeometry(1, 0), []);
  const branchGeo = useMemo(createBranchGeometry, []);
  const [trunkMat, crownMat, branchMat] = useMemo(
    () => [
      new THREE.MeshStandardMaterial({ roughness: 1 }),
      new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }),
    ],
    [],
  );

  useLayoutEffect(() => {
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const trunkMesh = trunkRef.current;
    const crownMesh = crownRef.current;
    const branchMesh = branchRef.current;

    trees.forEach((tree, i) => {
      dummy.position.set(tree.x, tree.y, tree.z);
      dummy.rotation.set(tree.lean, hash(i + 31) * Math.PI * 2, 0);
      dummy.scale.set(1, tree.trunkH, 1);
      dummy.updateMatrix();
      trunkMesh?.setMatrixAt(i, dummy.matrix);
      if (trunkMesh) trunkMesh.setColorAt(i, color.set(TRUNK_COLORS[i % TRUNK_COLORS.length]));

      // 冬季绝大多数树落叶：隐藏树冠，改显带雪枯枝；仅少数常绿保留树冠
      const bare = season === 'winter' && hash(i * 5.3 + 2.1) >= look.evergreen;
      if (bare) {
        dummy.scale.set(0, 0, 0);
        dummy.updateMatrix();
        crownMesh?.setMatrixAt(i, dummy.matrix);

        const s = tree.crownR * 0.72;
        dummy.position.set(tree.x, tree.y + tree.trunkH * 0.55, tree.z);
        dummy.rotation.set(tree.lean, hash(i + 77) * Math.PI * 2, 0);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        branchMesh?.setMatrixAt(i, dummy.matrix);
        return;
      }

      // 非冬季不显示枯枝
      dummy.scale.set(0, 0, 0);
      dummy.updateMatrix();
      branchMesh?.setMatrixAt(i, dummy.matrix);

      dummy.position.set(tree.x, tree.y + tree.trunkH + tree.crownR * 0.72, tree.z);
      dummy.rotation.set(tree.lean, hash(i + 77) * Math.PI * 2, 0);
      dummy.scale.set(tree.crownR, tree.crownR * 0.85, tree.crownR);
      dummy.updateMatrix();
      crownMesh?.setMatrixAt(i, dummy.matrix);
      if (crownMesh) {
        const blossomColor =
          look.blossom && hash(i * 3.7 + 5.1) < look.blossom.ratio ? look.blossom.color : null;
        const crownColor =
          blossomColor ?? look.crowns[Math.floor(hash(i + 41) * look.crowns.length)];
        crownMesh.setColorAt(i, color.set(crownColor));
      }
    });

    if (trunkMesh) {
      trunkMesh.instanceMatrix.needsUpdate = true;
      if (trunkMesh.instanceColor) trunkMesh.instanceColor.needsUpdate = true;
    }
    if (crownMesh) {
      crownMesh.instanceMatrix.needsUpdate = true;
      if (crownMesh.instanceColor) crownMesh.instanceColor.needsUpdate = true;
    }
    if (branchMesh) branchMesh.instanceMatrix.needsUpdate = true;
  }, [trees, season, look]);

  if (trees.length === 0) return null;

  return (
    <group>
      <instancedMesh
        ref={trunkRef}
        args={[trunkGeo, trunkMat, trees.length]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={crownRef}
        args={[crownGeo, crownMat, trees.length]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={branchRef}
        args={[branchGeo, branchMat, trees.length]}
        frustumCulled={false}
        visible={season === 'winter'}
      />
    </group>
  );
}
