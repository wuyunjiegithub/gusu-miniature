/**
 * 把 scripts/blender/measure_bounds.py 输出的 GLB 包围盒换算为场景坐标占地矩形
 * 输出 src/data/model-bounds.json，供 build-buildings.mjs 与 Outskirts 剔除背景建筑
 * 用法: blender -b --python scripts/blender/measure_bounds.py && node scripts/measure-model-bounds.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';

const scene = JSON.parse(
  await readFile(new URL('../src/data/scene-geometry.json', import.meta.url), 'utf8'),
);
const bbox = JSON.parse(await readFile(process.env.TEMP + '/glb_bbox.json', 'utf8'));

/** GLB 文件名 → 景点 id（不一致的两处） */
const FILES = { suzhou_museum: 'suzhou-museum' };

const out = {};
for (const [file, b] of Object.entries(bbox)) {
  const id = FILES[file] ?? file;
  const landmark = scene.landmarks[id];
  if (!landmark) continue;
  out[id] = [
    Math.round((landmark.centroid.x + b.x[0] - 1) * 10) / 10,
    Math.round((landmark.centroid.x + b.x[1] + 1) * 10) / 10,
    Math.round((landmark.centroid.z - b.y[1] - 1) * 10) / 10,
    Math.round((landmark.centroid.z - b.y[0] + 1) * 10) / 10,
  ];
}

await writeFile(new URL('../src/data/model-bounds.json', import.meta.url), JSON.stringify(out));
console.log(`[输出] src/data/model-bounds.json（${Object.keys(out).length} 处模型）`);
