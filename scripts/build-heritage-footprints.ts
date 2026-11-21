/**
 * 生成文保院落占地（src/data/heritage-footprints.json）。
 *
 * OSM 的文物 POI 质心常常落在街边甚至路面上，直接按半径画圆就会出现
 * "宅第造在马路上"。这里用 heritageFootprint 的求解器把每处院落挪到
 * 街区内部、缩到放得下，并把结果固化下来：
 *   - 运行时（Heritage.tsx / 标签 / 相机）读这份 JSON，不必等路网加载；
 *   - 建筑生成（scripts/build-buildings.mjs）也读这份 JSON 剔除民居，
 *     保证院落搬过去的地方本来就是空的。
 *
 * 用法：npx vite-node scripts/build-heritage-footprints.ts
 */
import { readFile, writeFile } from 'node:fs/promises';
import { HERITAGE_LANDMARKS } from '../src/data/heritage';
import { getHeritageModelSpec } from '../src/data/heritageModels';
import { sceneGeometry } from '../src/data/sceneGeometry';
import { resolveFootprints, toBlocked } from '../src/utils/heritageFootprint';
import modelBounds from '../src/data/model-bounds.json';

const roads = JSON.parse(
  await readFile(new URL('../public/data/roads.json', import.meta.url), 'utf8'),
) as { major: [number, number][][]; minor: [number, number][][] };

const sites = HERITAGE_LANDMARKS.map((item) => {
  const centroid = sceneGeometry.landmarks[item.id]?.centroid ?? { x: 0, z: 0 };
  return {
    id: item.id,
    center: [centroid.x, centroid.z] as [number, number],
    radius: getHeritageModelSpec(item.id, item.kind).radius ?? 20,
  };
});

const footprints = resolveFootprints(sites, roads, toBlocked(modelBounds as Record<string, number[]>), {
  buffer: 2,
  gap: 3,
  minRadius: 6,
  maxShift: 40,
});

const out: Record<string, { x: number; z: number; r: number; hidden?: true }> = {};
for (const site of sites) {
  const fp = footprints.get(site.id);
  if (!fp) continue;
  out[site.id] = {
    x: Math.round(fp.center[0] * 10) / 10,
    z: Math.round(fp.center[1] * 10) / 10,
    r: Math.round(fp.radius * 10) / 10,
    ...(fp.hidden ? { hidden: true as const } : {}),
  };
}

const file = new URL('../src/data/heritage-footprints.json', import.meta.url);
await writeFile(
  file,
  `${JSON.stringify(
    {
      meta: {
        note: '文保院落占地：由 OSM 质心按路网避让求解，勿手改；重新生成用 npx vite-node scripts/build-heritage-footprints.ts',
        unit: 'meter',
        buffer: 2,
      },
      sites: out,
    },
    null,
    2,
  )}\n`,
);
const moved = sites.filter((s) => {
  const fp = out[s.id];
  return fp && !fp.hidden && Math.hypot(fp.x - s.center[0], fp.z - s.center[1]) > 1;
}).length;
console.log(
  `[文保足迹] ${Object.keys(out).length} 处，搬离原址 ${moved} 处，已被精细模型覆盖 ${Object.values(out).filter((s) => s.hidden).length} 处`,
);
