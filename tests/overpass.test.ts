import { describe, expect, it } from 'vitest';
import {
  assembleRings,
  ringAreaM2,
  ringContains,
  ringCentroid,
} from '../scripts/lib/overpass.mjs';

/** Overpass out geom 里的一个 way member（带 geometry） */
const way = (id: number, geometry: { lat: number; lon: number }[], role = 'outer') => ({
  type: 'way',
  ref: id,
  role,
  geometry,
});

describe('ringAreaM2 球面近似面积', () => {
  it('1°×1° 的矩形环面积接近平面估算（赤道附近略收缩）', () => {
    const ring = [
      { lat: 31, lon: 120 },
      { lat: 31, lon: 121 },
      { lat: 32, lon: 121 },
      { lat: 32, lon: 120 },
      { lat: 31, lon: 120 },
    ];
    const area = ringAreaM2(ring);
    const latM = 111_320;
    const lonM = 111_320 * Math.cos((31.5 * Math.PI) / 180);
    expect(area).toBeGreaterThan(latM * lonM * 0.95);
    expect(area).toBeLessThan(latM * lonM * 1.05);
  });

  it('退化环（所有点重合）面积为 0', () => {
    const ring = Array.from({ length: 5 }, () => ({ lat: 31, lon: 120 }));
    expect(ringAreaM2(ring)).toBe(0);
  });
});

describe('ringContains 射线法', () => {
  const square = [
    { lon: 0, lat: 0 },
    { lon: 10, lat: 0 },
    { lon: 10, lat: 10 },
    { lon: 0, lat: 10 },
    { lon: 0, lat: 0 },
  ];
  it('内外点判定正确', () => {
    expect(ringContains(square, 5, 5)).toBe(true);
    expect(ringContains(square, 15, 5)).toBe(false);
  });
});

describe('ringCentroid 环质心', () => {
  it('正方形质心在中心，且忽略闭合末点的重复计权', () => {
    const square = [
      { lon: 0, lat: 0 },
      { lon: 10, lat: 0 },
      { lon: 10, lat: 10 },
      { lon: 0, lat: 10 },
      { lon: 0, lat: 10 }, // 闭合末点（重复）
    ];
    const c = ringCentroid(square);
    expect(c.lon).toBeCloseTo(5, 6);
    expect(c.lat).toBeCloseTo(5, 6);
  });
});

describe('assembleRings 组装闭合环', () => {
  it('两段首尾相接的 outer way 拼成一个闭合环', () => {
    const members = [
      way(1, [
        { lon: 0, lat: 0 },
        { lon: 5, lat: 0 },
      ]),
      way(2, [
        { lon: 5, lat: 0 },
        { lon: 5, lat: 5 },
        { lon: 0, lat: 0 },
      ]),
    ];
    const rings = assembleRings(members);
    expect(rings.length).toBe(1);
    expect(rings[0][0]).toEqual({ lon: 0, lat: 0 });
    expect(rings[0].at(-1)).toEqual({ lon: 0, lat: 0 });
  });

  it('反向段自动翻向拼接', () => {
    const members = [
      way(1, [
        { lon: 0, lat: 0 },
        { lon: 5, lat: 0 },
      ]),
      // 这段起点是 (0,0)、终点是 (5,5)，需要翻向接到 (5,0)
      way(2, [
        { lon: 0, lat: 0 },
        { lon: 5, lat: 5 },
        { lon: 5, lat: 0 },
      ]),
    ];
    const rings = assembleRings(members);
    expect(rings.length).toBe(1);
    // 翻向后拼成 (0,0)→(5,0)→(5,5)→(0,0)，闭合环首尾同为 (0,0)
    expect(rings[0][0]).toEqual({ lon: 0, lat: 0 });
    expect(rings[0].at(-1)).toEqual({ lon: 0, lat: 0 });
    expect(rings[0]).toContainEqual({ lon: 5, lat: 5 });
  });

  it('过滤非 outer 成员与未闭合链', () => {
    const members = [
      way(1, [
        { lon: 0, lat: 0 },
        { lon: 5, lat: 0 },
      ], 'inner'), // role 不对
      way(2, [
        { lon: 0, lat: 0 },
        { lon: 5, lat: 0 },
      ]), // 未闭合
    ];
    expect(assembleRings(members).length).toBe(0);
  });
});
