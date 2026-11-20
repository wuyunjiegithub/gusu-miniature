/**
 * 轨道交通：抓取苏州地铁（route=subway）与站位节点。
 * 产出 data/raw/transit.json
 * 用法: node scripts/fetch-transit.mjs
 */
import { writeFile } from 'node:fs/promises';
import { overpassQuery } from './lib/overpass.mjs';

const SOUTH = 31.247;
const NORTH = 31.375;
const WEST = 120.545;
const EAST = 120.697;
const BBOX = `${SOUTH},${WEST},${NORTH},${EAST}`;

const query = `[out:json][timeout:180];
(
  relation["route"~"^(subway|light_rail)$"](${BBOX});
  node["railway"="station"]["station"~"^(subway|light_rail)$"](${BBOX});
);
out geom;`;

const json = await overpassQuery(query, { retries: 3, timeoutMs: 240_000 });
await writeFile(new URL('../data/raw/transit.json', import.meta.url), JSON.stringify(json));
console.log(`[save] transit.json (${json.elements?.length ?? 0} elements)`);
