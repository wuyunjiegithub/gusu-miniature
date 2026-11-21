import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  lonLatToLocal,
  lonLatToVector3,
  vector3ToLonLat,
  localToVector3,
  pointInRing,
} from '../src/utils/geo';
import { CITY_ORIGIN } from '../src/constants/geo';
import type { LocalPoint2 } from '../src/types';

describe('坐标转换（lonLatToLocal / vector3ToLonLat）', () => {
  it('原点映射到 (0,0)', () => {
    const p = lonLatToLocal(CITY_ORIGIN.lon, CITY_ORIGIN.lat);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(0, 6);
  });

  it('纬度 +1° → z 减少约 111320m（北为负 z）', () => {
    const p = lonLatToLocal(CITY_ORIGIN.lon, CITY_ORIGIN.lat + 1);
    expect(p.z).toBeCloseTo(-111320, 0);
    expect(p.x).toBeCloseTo(0, 6);
  });

  it('经度 +1° → x 增加（东为正 x），量级随纬度收敛', () => {
    const p = lonLatToLocal(CITY_ORIGIN.lon + 1, CITY_ORIGIN.lat);
    expect(p.x).toBeGreaterThan(90_000);
    expect(p.x).toBeLessThan(100_000);
    expect(p.z).toBeCloseTo(0, 6);
  });

  it('经纬度 → 局部 → 经纬度 往返一致', () => {
    const lon = CITY_ORIGIN.lon + 0.01;
    const lat = CITY_ORIGIN.lat - 0.008;
    const back = vector3ToLonLat(lonLatToVector3(lon, lat));
    expect(back.lon).toBeCloseTo(lon, 9);
    expect(back.lat).toBeCloseTo(lat, 9);
  });

  it('localToVector3 直接把 [x,z] 放到 x/z 分量', () => {
    const v = localToVector3([123, -456], 10);
    expect(v).toBeInstanceOf(THREE.Vector3);
    expect(v.x).toBe(123);
    expect(v.y).toBe(10);
    expect(v.z).toBe(-456);
  });
});

describe('pointInRing 环内判定', () => {
  const square: LocalPoint2[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];

  it('内部点返回 true，外部点返回 false', () => {
    expect(pointInRing(square, 5, 5)).toBe(true);
    expect(pointInRing(square, 15, 5)).toBe(false);
    expect(pointInRing(square, -1, 5)).toBe(false);
  });

  it('边界附近稳定（略微内缩/外扩）', () => {
    expect(pointInRing(square, 0.5, 5)).toBe(true);
    expect(pointInRing(square, 9.5, 5)).toBe(true);
  });

  it('大环（≥12 点）走分桶索引，结果与朴素一致', () => {
    // 构造 16 边正多边形（闭合），中心在原点
    const big: LocalPoint2[] = [];
    const N = 16;
    for (let i = 0; i <= N; i += 1) {
      const a = (i / N) * Math.PI * 2;
      big.push([Math.cos(a) * 100, Math.sin(a) * 100]);
    }
    expect(pointInRing(big, 0, 0)).toBe(true);
    expect(pointInRing(big, 200, 0)).toBe(false);
    expect(pointInRing(big, 99, 0)).toBe(true);
  });
});
