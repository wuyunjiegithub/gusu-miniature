import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { resolveFootprints, buildRoadIndex, toBlocked } from '../src/utils/heritageFootprint';
import { HERITAGE_FOOTPRINTS } from '../src/data/heritageFootprints';
import { HERITAGE_LANDMARKS } from '../src/data/heritage';
import { HERITAGE_MODELS } from '../src/data/heritageModels';
import { sceneGeometry } from '../src/data/sceneGeometry';
import modelBounds from '../src/data/model-bounds.json';

const roads = JSON.parse(fs.readFileSync('public/data/roads.json', 'utf8')) as {
  major: [number, number][][];
  minor: [number, number][][];
};
const index = buildRoadIndex(roads);

describe('resolveFootprints', () => {
  it('质心落在马路上时把院落挪开，且半宽不超过可用空间', () => {
    // 一条东西向主干道（半宽 13m），院落在路中心
    const site = { id: 'a', center: [0, 0] as [number, number], radius: 18 };
    const fp = resolveFootprints([site], roads, {}, { buffer: 2 })!;
    const a = fp.get('a')!;
    expect(a.hidden).toBe(false);
    expect(index.clearance(a.center[0], a.center[1])).toBeGreaterThan(a.radius);
  });

  it('已被精细模型覆盖的院落标记为 hidden', () => {
    const site = { id: 'b', center: [355, -1720] as [number, number], radius: 20 };
    const fp = resolveFootprints([site], roads, toBlocked(modelBounds as Record<string, number[]>));
    expect(fp.get('b')?.hidden).toBe(true);
  });

  it('相邻院落互相收缩，不再重叠', () => {
    const sites = [
      { id: 'c', center: [400, -1900] as [number, number], radius: 14 },
      { id: 'd', center: [408, -1900] as [number, number], radius: 14 },
    ];
    const fp = resolveFootprints(sites, roads, {});
    const c = fp.get('c')!;
    const d = fp.get('d')!;
    const dist = Math.hypot(c.center[0] - d.center[0], c.center[1] - d.center[1]);
    expect(c.radius + d.radius).toBeLessThanOrEqual(dist + 0.01);
  });

  it('求解结果与固化的 heritage-footprints.json 一致', () => {
    const sites = HERITAGE_LANDMARKS.map((item) => {
      const centroid = sceneGeometry.landmarks[item.id]?.centroid ?? { x: 0, z: 0 };
      return {
        id: item.id,
        center: [centroid.x, centroid.z] as [number, number],
        radius: HERITAGE_MODELS[item.id]?.radius ?? 20,
      };
    });
    const fp = resolveFootprints(sites, roads, toBlocked(modelBounds as Record<string, number[]>), {
      buffer: 2,
      gap: 3,
      minRadius: 6,
      maxShift: 40,
    });
    for (const site of sites) {
      const want = HERITAGE_FOOTPRINTS[site.id];
      const got = fp.get(site.id)!;
      expect(want, site.id).toBeTruthy();
      if (got.hidden) {
        expect(want.hidden, site.id).toBe(true);
        continue;
      }
      expect(Math.abs(want.x - got.center[0]), `${site.id} x`).toBeLessThan(0.2);
      expect(Math.abs(want.z - got.center[1]), `${site.id} z`).toBeLessThan(0.2);
      expect(Math.abs(want.r - got.radius), `${site.id} r`).toBeLessThan(0.2);
    }
  });

  it('每一处文保院落都不压路（回归：宅第造在马路上）', () => {
    const offenders: string[] = [];
    for (const h of HERITAGE_LANDMARKS) {
      const fp = HERITAGE_FOOTPRINTS[h.id];
      if (!fp || fp.hidden) continue;
      if (index.clearance(fp.x, fp.z) <= fp.r) offenders.push(`${h.name}(${h.id})`);
    }
    expect(offenders).toEqual([]);
  });

  it('文保院落与民居实例不重叠（建筑数据按同一份足迹剔除）', () => {
    const data = JSON.parse(fs.readFileSync('public/data/buildings.json', 'utf8')) as {
      pitched?: number[][];
      flat?: number[][];
    };
    const all = [...(data.pitched ?? []), ...(data.flat ?? [])];
    const offenders: string[] = [];
    for (const h of HERITAGE_LANDMARKS) {
      const fp = HERITAGE_FOOTPRINTS[h.id];
      if (!fp || fp.hidden) continue;
      const hit = all.some((b) => Math.hypot(b[0] - fp.x, b[1] - fp.z) < fp.r);
      if (hit) offenders.push(h.id);
    }
    expect(offenders).toEqual([]);
  });
});
