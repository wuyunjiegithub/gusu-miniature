/**
 * 抓取 OSM 道路（M1）：3×3 分块，断点续传
 * 产出 data/raw/roads-<row>-<col>.json
 * 用法: node scripts/fetch-roads.mjs
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { overpassQuery } from './lib/overpass.mjs';

const RAW_DIR = new URL('../data/raw/', import.meta.url);
const SOUTH = 31.2868;
const NORTH = 31.3345;
const WEST = 120.5979;
const EAST = 120.6447;
const ROWS = 3;
const COLS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = async (f) => {
  try {
    await access(f);
    return true;
  } catch {
    return false;
  }
};

await mkdir(RAW_DIR, { recursive: true });

const dLat = (NORTH - SOUTH) / ROWS;
const dLon = (EAST - WEST) / COLS;

for (let r = 0; r < ROWS; r += 1) {
  for (let c = 0; c < COLS; c += 1) {
    const name = `roads-${r}-${c}.json`;
    const file = new URL(name, RAW_DIR);
    if (await exists(file)) {
      console.log(`[skip] ${name}`);
      continue;
    }
    const s = (SOUTH + r * dLat).toFixed(5);
    const w = (WEST + c * dLon).toFixed(5);
    const n = (SOUTH + (r + 1) * dLat).toFixed(5);
    const e = (WEST + (c + 1) * dLon).toFixed(5);

    console.log(`[fetch] ${name}`);
    const json = await overpassQuery(
      `[out:json][timeout:180];way["highway"](${s},${w},${n},${e});out geom;`,
      { retries: 3, timeoutMs: 240_000 },
    );
    await writeFile(file, JSON.stringify(json));
    console.log(`[save] ${name} (${json.elements?.length ?? 0} ways)`);
    await sleep(3000);
  }
}

console.log('\n抓取完成。下一步: node scripts/build-roads.mjs');
