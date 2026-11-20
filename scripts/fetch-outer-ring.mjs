/**
 * 城外 2~3km 真实建筑补齐：在现有 3×3 瓦片之外，补抓四圈条带
 * 输出 data/raw/buildings-ring-{n,s,e,w}.json
 * 用法: node scripts/fetch-outer-ring.mjs
 */
import { writeFile } from 'node:fs/promises';
import { overpassQuery } from './lib/overpass.mjs';

// 现有数据覆盖 lon 120.5969~120.6454、lat 31.2861~31.3343；目标半径 3km
const RING = [
  ['n', [31.3343, 120.5895, 31.3383, 120.6525]],
  ['s', [31.2837, 120.5895, 31.2861, 120.6525]],
  ['w', [31.2861, 120.5895, 31.3343, 120.5969]],
  ['e', [31.2861, 120.6454, 31.3343, 120.6525]],
];

for (const [name, bbox] of RING) {
  const query = `[out:json][timeout:90];way["building"](${bbox.join(',')});out geom tags;`;
  try {
    const json = await overpassQuery(query);
    await writeFile(new URL(`../data/raw/buildings-ring-${name}.json`, import.meta.url), JSON.stringify(json));
    console.log(`[save] buildings-ring-${name}.json (${json.elements?.length ?? 0})`);
  } catch (error) {
    console.error(`[fail] ${name}: ${error.message}`);
  }
}
