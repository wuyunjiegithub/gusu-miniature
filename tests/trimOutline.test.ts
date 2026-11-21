import { describe, expect, it } from 'vitest';
import { ROAD_HALF, trimOutlineFromRoads, type RoadLines } from '../src/utils/trimOutline';

const distToSeg = (x: number, z: number, a: [number, number], b: [number, number]): number => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
};

describe('trimOutlineFromRoads', () => {
  const roads: RoadLines = {
    // 一条竖直主干道在 x=100，半宽 13；一条水平支路在 z=100，半宽 5.5
    major: [[[100, -200], [100, 200]]],
    minor: [[[-200, 100], [200, 100]]],
  };

  it('把伸进主干道的顶点退到路缘外，且不改变远离道路的顶点', () => {
    const outline: [number, number][] = [
      [0, 0],
      [106, 50], // 侵入主干道（距 6 < 13）
      [0, 100],
    ];
    const out = trimOutlineFromRoads(outline, roads);
    // 退让后应存在 x >= 100 + 13 + 0.4 的点（被推离主干道）
    expect(out.some(([x, z]) => z > 40 && z < 60 && x >= 100 + ROAD_HALF.major + 0.4)).toBe(true);
    // 远离道路的点原样保留
    expect(out.some(([x, z]) => x === 0 && z === 0)).toBe(true);
  });

  it('把伸进支路的顶点退到支路路缘外', () => {
    const outline: [number, number][] = [
      [-50, 0],
      [0, 103], // 侵入支路（距 3 < 5.5）
      [50, 0],
    ];
    const out = trimOutlineFromRoads(outline, roads);
    expect(out.some(([x, z]) => Math.abs(x) < 5 && z >= 100 + ROAD_HALF.minor + 0.4)).toBe(true);
  });

  it('边界侵入主干道的景区轮廓，裁剪后所有点都退到路缘外', () => {
    // 景区主体在道路左侧，只有右边界伸进主干道（拙政园的真实情形）
    const outline: [number, number][] = [
      [40, -20],
      [104, -20],
      [104, 20],
      [40, 20],
    ];
    const out = trimOutlineFromRoads(outline, roads, { sampleStep: 3 });
    for (const [x, z] of out) {
      expect(distToSeg(x, z, [100, -200], [100, 200])).toBeGreaterThanOrEqual(ROAD_HALF.major + 0.3);
    }
  });

  it('闭合环保持首尾不重复', () => {
    const outline: [number, number][] = [
      [0, 0],
      [106, 50],
      [0, 100],
      [0, 0],
    ];
    const out = trimOutlineFromRoads(outline, roads);
    const a = out[0];
    const b = out[out.length - 1];
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(0.2);
  });

  it('空路网时原样返回', () => {
    const outline: [number, number][] = [[0, 0], [1, 0], [1, 1]];
    expect(trimOutlineFromRoads(outline, { major: [], minor: [] })).toEqual(outline);
  });
});
