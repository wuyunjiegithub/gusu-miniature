import { describe, expect, it } from 'vitest';
import {
  createRoadClearance,
  fitLandmarkPlacement,
  fitScaleToRoads,
  getRoadClearance,
  silhouetteProfile,
  type RoadClearance,
  type SilhouettePoint,
} from '../src/utils/roadClearance';
import type { LocalPoint2 } from '../src/types';

const roads = {
  major: [[[-500, 0], [500, 0]]] as LocalPoint2[][],
  minor: [[[0, -500], [0, 500]]] as LocalPoint2[][],
};

describe('createRoadClearance', () => {
  it('主路半宽 13m：路缘外为正、路面上为负', () => {
    const c = createRoadClearance(roads);
    // 主路沿 x 轴；次路沿 z 轴半宽 5.5，取主路约束占优的采样点
    expect(c(200, 20)).toBeCloseTo(7, 5);
    expect(c(200, 13)).toBeCloseTo(0, 5);
    expect(c(200, 10)).toBeCloseTo(-3, 5);
    expect(c(200, 0)).toBeCloseTo(-13, 5);
  });

  it('取最近的路：靠近次路时按次路半宽算', () => {
    const c = createRoadClearance(roads);
    expect(c(8, 300)).toBeCloseTo(2.5, 5);
    expect(c(3, 300)).toBeCloseTo(-2.5, 5);
    expect(c(0, 300)).toBeCloseTo(-5.5, 5);
  });

  it('同一份路网复用索引', () => {
    expect(getRoadClearance(roads)).toBe(getRoadClearance(roads));
  });
});

describe('silhouetteProfile', () => {
  it('每个方向取最外点，忽略原点附近的点', () => {
    const points: LocalPoint2[] = [
      [0, 0],
      [10, 0],
      [30, 0],
      [0, 20],
      [-40, 0],
    ];
    const profile = silhouetteProfile(points, 360);
    const find = (dx: number, dz: number) =>
      profile.find((p) => Math.abs(p.dir[0] - dx) < 0.02 && Math.abs(p.dir[1] - dz) < 0.02);
    expect(find(1, 0)?.radius).toBeCloseTo(30, 5);
    expect(find(-1, 0)?.radius).toBeCloseTo(40, 5);
    expect(find(0, 1)?.radius).toBeCloseTo(20, 5);
  });
});

describe('fitScaleToRoads', () => {
  it('包络点会压路时等比缩小到刚好退让', () => {
    const profile: SilhouettePoint[] = [{ dir: [1, 0], radius: 100 }];
    // 路缘在 x = 80，要求 1m 余量 → x*scale <= 79
    const clearance: RoadClearance = (x) => 80 - x;
    const scale = fitScaleToRoads(profile, [0, 0], clearance, { margin: 1, step: 0.005 });
    expect(scale).toBeGreaterThan(0.78);
    expect(scale).toBeLessThanOrEqual(0.8);
    expect(100 * scale).toBeLessThanOrEqual(79.5);
  });

  it('已经退让到位时不缩放', () => {
    const profile: SilhouettePoint[] = [{ dir: [1, 0], radius: 40 }];
    const clearance: RoadClearance = (x) => 80 - x;
    expect(fitScaleToRoads(profile, [0, 0], clearance)).toBe(1);
  });

  it('缩放不低于下限', () => {
    const profile: SilhouettePoint[] = [{ dir: [1, 0], radius: 100 }];
    const clearance: RoadClearance = () => -20;
    expect(fitScaleToRoads(profile, [0, 0], clearance, { min: 0.55 })).toBe(0.55);
  });

  it('空包络不动模型', () => {
    expect(fitScaleToRoads([], [0, 0], () => 999)).toBe(1);
  });
});

describe('fitLandmarkPlacement', () => {
  const square: LocalPoint2[] = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];

  it('平移以景点质心为基准，把模型中心对齐石台中心', () => {
    const p = fitLandmarkPlacement(square, [120, 220], [100, 100], () => 999);
    expect(p.scale).toBe(1);
    // 模型中心 (50,50) 应落到 (120,220)：offset = (120-100-50, 220-100-50)
    expect(p.offset[0]).toBeCloseTo(-30);
    expect(p.offset[1]).toBeCloseTo(70);
    const cx = 100 + p.offset[0] + 50;
    const cz = 100 + p.offset[1] + 50;
    expect(cx).toBeCloseTo(120);
    expect(cz).toBeCloseTo(220);
  });

  it('居中后仍压路才缩小', () => {
    // 路缘在 x = 140：不缩时模型右边界落在 150，压进路面 10m
    const clearance: RoadClearance = (x) => (x > 140 ? 140 - x : 999);
    const p = fitLandmarkPlacement(square, [100, 100], [100, 100], clearance, { min: 0.5 });
    expect(p.scale).toBeLessThan(1);
    const right = 100 + p.offset[0] + 100 * p.scale;
    expect(right).toBeLessThanOrEqual(140);
  });

  it('平移量不超过上限', () => {
    const p = fitLandmarkPlacement(square, [9999, 9999], [0, 0], () => 999, { maxShift: 40 });
    expect(Math.abs(p.offset[0])).toBeLessThanOrEqual(40);
    expect(Math.abs(p.offset[1])).toBeLessThanOrEqual(40);
  });
});
