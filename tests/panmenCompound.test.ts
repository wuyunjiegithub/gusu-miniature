import { describe, it, expect, vi } from 'vitest';

/** 用最小真实轮廓替身隔离 sceneGeometry，专测布局纯函数 */
const OUTLINE: Array<[number, number]> = [
  [-1000, 2100], [-520, 2100], [-520, 2392], [-1000, 2392],
];
// vi.mock 会被提升到文件顶部，工厂内不能引用顶层变量，故内联同样的字面量
vi.mock('../src/data/sceneGeometry', () => ({
  sceneGeometry: {
    landmarks: { panmen: { outline: [[-1000, 2100], [-520, 2100], [-520, 2392], [-1000, 2392]] } },
  },
}));

import {
  pointInRing,
  distToRing,
  buildPanmenCompound,
} from '../src/data/panmenCompound';

describe('pointInRing 环内判定', () => {
  it('矩形环内外判定正确', () => {
    expect(pointInRing(OUTLINE, -800, 2250)).toBe(true);
    expect(pointInRing(OUTLINE, -400, 2250)).toBe(false);
    expect(pointInRing(OUTLINE, -800, 2000)).toBe(false);
  });
});

describe('distToRing 边界距离', () => {
  it('内部点到最近边的距离正确', () => {
    expect(distToRing(OUTLINE, -800, 2250)).toBeCloseTo(142, 0);
    expect(distToRing(OUTLINE, -520, 2250)).toBeCloseTo(0, 0);
  });
});

describe('buildPanmenCompound 盘门腹地布局', () => {
  const layout = buildPanmenCompound();

  it('生成水池、院落与点景树', () => {
    expect(layout.ponds.length).toBeGreaterThanOrEqual(2);
    expect(layout.houses.length).toBeGreaterThan(20);
    expect(layout.trees.length).toBeGreaterThan(20);
  });

  it('院落全部在轮廓内且不压门洞水道/瑞光塔', () => {
    for (const h of layout.houses) {
      expect(pointInRing(OUTLINE, h.x, h.z)).toBe(true);
      const gate = Math.abs(h.x + 777) < 9 && h.z > 2230 && h.z < 2470;
      const tower = Math.hypot(h.x + 722, h.z - 2400) < 16;
      expect(gate || tower).toBe(false);
    }
  });

  it('院落之间不重叠', () => {
    for (let i = 0; i < layout.houses.length; i++) {
      for (let j = i + 1; j < layout.houses.length; j++) {
        const a = layout.houses[i];
        const b = layout.houses[j];
        const overlapX = Math.abs(a.x - b.x) < (a.w + b.w) / 2;
        const overlapZ = Math.abs(a.z - b.z) < (a.d + b.d) / 2;
        expect(overlapX && overlapZ).toBe(false);
      }
    }
  });

  it('布局可复现（同输入同输出）', () => {
    const again = buildPanmenCompound();
    expect(again).toEqual(layout);
  });
});
