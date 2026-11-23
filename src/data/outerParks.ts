import { HILLS } from './hills';
import { sceneGeometry } from './sceneGeometry';
import modelBounds from './model-bounds.json';
import { WORLD_LIMIT } from '../constants/geo';
import { lonLatToVector3, pointInRing } from '../utils/geo';
import { inWater } from '../utils/waterField';
import type { LocalPoint2 } from '../types';

/**
 * 城外草地公园：3.3–5.5km 的城市蔓延里留出的成片草坪。
 *
 * 城外地块按 110m 网格铺满民居，若只在 Trees 里画草坪会长在房子底下，
 * 所以这里把公园位置固化下来，由 buildOuterCity 跳过园内地块、Trees 铺草并点树。
 * 全部避开水道、山体、园林与精细模型；位置按固定种子生成，刷新不会漂移。
 */
export interface OuterPark {
  x: number;
  z: number;
  /** 长轴 / 短轴半径（米） */
  rx: number;
  rz: number;
  rot: number;
}

const GRID = 900;

const hash = (i: number): number => {
  const v = Math.sin(i * 91.17 + 47.3) * 43758.5453;
  return v - Math.floor(v);
};

const HILL_FOOTPRINTS = HILLS.map((hill) => {
  const v = lonLatToVector3(hill.lon, hill.lat, 0);
  return { x: v.x, z: v.z, r: hill.radius };
});

const LANDMARK_RINGS = Object.values(sceneGeometry.landmarks).flatMap((lm) => {
  const ring: LocalPoint2[] | undefined = lm.outline;
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

const MODEL_RECTS = Object.values(modelBounds) as [number, number, number, number][];

function ringHit(x: number, z: number): boolean {
  for (const r of LANDMARK_RINGS) {
    if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) continue;
    if (pointInRing(r.ring, x, z)) return true;
  }
  return false;
}

function buildParks(): OuterPark[] {
  const parks: OuterPark[] = [];
  let seed = 730000;

  for (let gx = -WORLD_LIMIT; gx <= WORLD_LIMIT; gx += GRID) {
    for (let gz = -WORLD_LIMIT; gz <= WORLD_LIMIT; gz += GRID) {
      seed += 1;
      if (hash(seed) > 0.5) continue;
      const x = gx + (hash(seed + 3) - 0.5) * GRID * 0.5;
      const z = gz + (hash(seed + 5) - 0.5) * GRID * 0.5;
      // 园子要落在城外民居带上，避开护城河与沙盘边缘
      if (Math.hypot(x, z) < 3300 || Math.hypot(x, z) > WORLD_LIMIT - 320) continue;
      if (pointInRing(sceneGeometry.cityOutline, x, z)) continue;

      const rx = 110 + hash(seed + 7) * 110;
      const rz = rx * (0.58 + hash(seed + 9) * 0.22);
      const reach = Math.max(rx, rz);
      if (HILL_FOOTPRINTS.some((h) => Math.hypot(x - h.x, z - h.z) < h.r * 1.06 + reach + 30)) continue;
      if (MODEL_RECTS.some(([x0, x1, z0, z1]) => x > x0 - reach && x < x1 + reach && z > z0 - reach && z < z1 + reach)) {
        continue;
      }

      // 椭圆边界 12 点 + 中心：进水或压到园林就换下一个候选
      let blocked = false;
      for (let k = 0; k < 13 && !blocked; k += 1) {
        const a = (k / 12) * Math.PI * 2;
        const px = k === 0 ? x : x + Math.cos(a) * rx;
        const pz = k === 0 ? z : z + Math.sin(a) * rz;
        blocked = inWater(px, pz, 6) || ringHit(px, pz);
      }
      if (blocked) continue;

      parks.push({ x, z, rx, rz, rot: hash(seed + 11) * Math.PI });
    }
  }
  return parks;
}

export const OUTER_PARKS = buildParks();

/** 预计算三角函数与包围盒，供逐栋民居/乔木的快速剔除 */
const PARK_ZONES = OUTER_PARKS.map((park) => {
  const reach = Math.max(park.rx, park.rz);
  return {
    park,
    c: Math.cos(park.rot),
    s: Math.sin(park.rot),
    minX: park.x - reach,
    maxX: park.x + reach,
    minZ: park.z - reach,
    maxZ: park.z + reach,
  };
});

/** 判断点是否落在公园椭圆内（pad 为正时外扩），与草坪的 Y 轴旋转保持一致 */
export function inAnyPark(x: number, z: number, pad = 0): boolean {
  for (const zone of PARK_ZONES) {
    if (x < zone.minX - pad || x > zone.maxX + pad || z < zone.minZ - pad || z > zone.maxZ + pad) continue;
    const { park } = zone;
    const dx = x - park.x;
    const dz = z - park.z;
    const lx = zone.c * dx - zone.s * dz;
    const lz = zone.s * dx + zone.c * dz;
    const ax = park.rx + pad;
    const az = park.rz + pad;
    if ((lx * lx) / (ax * ax) + (lz * lz) / (az * az) <= 1) return true;
  }
  return false;
}

