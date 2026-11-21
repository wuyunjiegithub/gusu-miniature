import * as THREE from 'three';
import { CITY_ORIGIN } from '../constants/geo';
import type { LocalPoint2 } from '../types';

const METERS_PER_DEGREE_LAT = 111_320;
const METERS_PER_DEGREE_LON_ORIGIN = METERS_PER_DEGREE_LAT * Math.cos((CITY_ORIGIN.lat * Math.PI) / 180);

export interface LocalPoint {
  x: number;
  z: number;
}

const metersPerDegreeLon = (lat: number): number =>
  METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);

/**
 * 经纬度 → 场景局部坐标（米），简单等比缩放。
 * +x = 东，-z = 北（three.js 惯例）
 */
export function lonLatToLocal(lon: number, lat: number): LocalPoint {
  return {
    x: (lon - CITY_ORIGIN.lon) * metersPerDegreeLon(CITY_ORIGIN.lat),
    z: -(lat - CITY_ORIGIN.lat) * METERS_PER_DEGREE_LAT,
  };
}

/**
 * 地图坐标（WGS84 经纬度）→ 三维位置（米）。
 * +x = 东，-z = 北，+y = 高度（默认贴地 0，可按需传入）。
 */
export function lonLatToVector3(lon: number, lat: number, y = 0): THREE.Vector3 {
  const local = lonLatToLocal(lon, lat);
  return new THREE.Vector3(local.x, y, local.z);
}

/**
 * 局部米制平面坐标 [x, z] → 三维位置。
 * 用于把 scene-geometry.json 中的二维轮廓/质心坐标直接投放到场景。
 */
export function localToVector3(point: LocalPoint2, y = 0): THREE.Vector3 {
  return new THREE.Vector3(point[0], y, point[1]);
}

/** 三维位置 → 地图坐标（反算，便于拾取结果回写经纬度） */
export function vector3ToLonLat(position: THREE.Vector3): { lon: number; lat: number } {
  return {
    lon: CITY_ORIGIN.lon + position.x / METERS_PER_DEGREE_LON_ORIGIN,
    lat: CITY_ORIGIN.lat - position.z / METERS_PER_DEGREE_LAT,
  };
}

/**
 * 环内判定索引：按 z 分桶存边，查询时只测该桶里的几条边。
 *
 * 射线法本身要遍历整条环。护城河轮廓 100 个点、树木/地铁采样点有几十万个，
 * 直接遍历等于上千万次比较，首屏会卡住近两秒。分桶后每条边只落进它覆盖的
 * 那几个 z 区间，单次查询从 100 次降到 1~3 次，结果与遍历法完全一致。
 */
interface RingIndex {
  ring: LocalPoint2[];
  /** bins[i] 存"可能跨过该 z 区间"的边起点下标 */
  bins: number[][];
  minZ: number;
  binH: number;
}

const RING_BINS = 96;
/** 环点数少于这个值时分桶没有意义，直接遍历更快 */
const RING_INDEX_MIN = 12;
const ringIndexCache = new WeakMap<LocalPoint2[], RingIndex>();

const getRingIndex = (ring: LocalPoint2[]): RingIndex => {
  const cached = ringIndexCache.get(ring);
  if (cached) return cached;

  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [, z] of ring) {
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const span = maxZ - minZ;
  const binH = span > 0 ? span / RING_BINS : 1;
  const bins: number[][] = Array.from({ length: RING_BINS }, () => []);

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const zi = ring[i][1];
    const zj = ring[j][1];
    if (zj === zi) continue; // 水平边不参与射线相交
    const lo = Math.min(zi, zj);
    const hi = Math.max(zi, zj);
    let b0 = Math.floor((lo - minZ) / binH);
    let b1 = Math.floor((hi - minZ) / binH);
    if (b0 < 0) b0 = 0;
    if (b1 > RING_BINS - 1) b1 = RING_BINS - 1;
    for (let b = b0; b <= b1; b += 1) bins[b].push(j);
  }

  const index: RingIndex = { ring, bins, minZ, binH };
  ringIndexCache.set(ring, index);
  return index;
};

/** 射线法：局部米制坐标点是否在闭合环内 */
export function pointInRing(ring: LocalPoint2[], x: number, z: number): boolean {
  if (ring.length >= RING_INDEX_MIN) {
    const index = getRingIndex(ring);
    const bin = Math.floor((z - index.minZ) / index.binH);
    if (bin < 0 || bin >= RING_BINS) return false;
    // 边按起点下标 j 存放，终点是 j+1；两者相差 1 时 z 区间与桶完全一致
    const edgesBin = index.bins[bin];
    let inside = false;
    for (let k = 0; k < edgesBin.length; k += 1) {
      const j = edgesBin[k];
      const i = j + 1 === ring.length ? 0 : j + 1;
      const [xj, zj] = ring[j];
      const [xi, zi] = ring[i];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
