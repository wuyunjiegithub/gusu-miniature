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

/** 射线法：局部米制坐标点是否在闭合环内 */
export function pointInRing(ring: LocalPoint2[], x: number, z: number): boolean {
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
