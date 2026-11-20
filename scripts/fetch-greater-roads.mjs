/**
 * 城外真实路网补齐：在古城 3×3 瓦片之外，抓取约 14km × 14km 范围的
 * 高速/快速路/主干道/次干道/支路（不含 residential，控制数据量）。
 * 产出 data/raw/greater-roads-<row>-<col>.json
 * 用法: node scripts/fetch-greater-roads.mjs
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { overpassQuery } from './lib/overpass.mjs';

const RAW_DIR = new URL('../data/raw/', import.meta.url);
/** 以古城为中心、半径约 7km 的外扩范围 */
const SOUTH = 31.247;
const NORTH = 31.375;
const WEST = 120.545;
const EAST = 120.697;
const ROWS = 3;
const COLS = 3;
const CLASSES = '^(motorway|trunk|primary|secondary|tertiary)(_link)?$';

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
    const name = `greater-roads-${r}-${c}.json`;
    const file = new URL(name, RAW_DIR);
    if (await exists(file)) {
      console.log(`[skip] ${name}`);
      continue;
    }
    const s = (SOUTH + r * dLat).toFixed(5);
    const w = (WEST + c * dLon).toFixed(5);
    const n = (SOUTH + (r + 1) * dLat).toFixed(5);
    const e = (WEST + (c + 1) * dLon).toFixed(5);
    console.log(`[fetch] ${name} ${s},${w},${n},${e}`);
    const json = await overpassQuery(
      `[out:json][timeout:180];way["highway"~"${CLASSES}"](${s},${w},${n},${e});out geom;`,
      { retries: 3, timeoutMs: 240_000 },
    );
    await writeFile(file, JSON.stringify(json));
    const bytes = JSON.stringify(json).length;
    console.log(`[save] ${name} (${json.elements?.length ?? 0} ways, ${(bytes / 1024 / 1024).toFixed(1)}MB)`);
    await sleep(3000);
  }
}

console.log('\n抓取完成。下一步: node scripts/build-roads.mjs');
