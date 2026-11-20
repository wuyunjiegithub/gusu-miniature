/**
 * 补抓单个道路分块（用于大分块超时）：拆成 2×2 子块合并后落盘
 * 用法: node scripts/fetch-road-tile.mjs <row> <col>
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { overpassQuery } from './lib/overpass.mjs';

const SOUTH = 31.2868;
const NORTH = 31.3345;
const WEST = 120.5979;
const EAST = 120.6447;
const ROWS = 3;
const COLS = 3;

const row = Number(process.argv[2]);
const col = Number(process.argv[3]);
if (!Number.isInteger(row) || !Number.isInteger(col)) {
  throw new Error('用法: node scripts/fetch-road-tile.mjs <row> <col>');
}

const dLat = (NORTH - SOUTH) / ROWS;
const dLon = (EAST - WEST) / COLS;
const s0 = SOUTH + row * dLat;
const w0 = WEST + col * dLon;

const elements = new Map();
for (let subR = 0; subR < 2; subR += 1) {
  for (let subC = 0; subC < 2; subC += 1) {
    const s = (s0 + (dLat / 2) * subR).toFixed(5);
    const w = (w0 + (dLon / 2) * subC).toFixed(5);
    const n = (s0 + (dLat / 2) * (subR + 1)).toFixed(5);
    const e = (w0 + (dLon / 2) * (subC + 1)).toFixed(5);
    console.log(`[fetch] 子块 ${subR}-${subC} ${s},${w},${n},${e}`);
    const json = await overpassQuery(
      `[out:json][timeout:120];way["highway"](${s},${w},${n},${e});out geom;`,
      { retries: 4, timeoutMs: 180_000 },
    );
    for (const el of json.elements ?? []) {
      if (el.type === 'way' && el.geometry) elements.set(el.id, el);
    }
    console.log(`[ok] 累计 ${elements.size} 条`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

await mkdir(new URL('../data/raw/', import.meta.url), { recursive: true });
await writeFile(
  new URL(`../data/raw/roads-${row}-${col}.json`, import.meta.url),
  JSON.stringify({ elements: [...elements.values()] }),
);
console.log(`[save] roads-${row}-${col}.json (${elements.size} ways)`);
