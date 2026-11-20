/**
 * 补充景点抓取：观前街、双塔（罗汉院）、北寺塔（报恩寺）
 * 产出 data/raw/extra-*.json，供 build-scene-data.mjs 合并进 scene-geometry.json
 * 用法: node scripts/fetch-extra-landmarks.mjs
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { overpassQuery } from './lib/overpass.mjs';

const RAW_DIR = new URL('../data/raw/', import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const exists = async (file) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

const fetchTo = async (name, query) => {
  const file = new URL(name, RAW_DIR);
  if (await exists(file)) {
    console.log(`[skip] ${name} 已存在`);
    return;
  }
  const json = await overpassQuery(query);
  await mkdir(RAW_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(json));
  console.log(`[save] ${name} (${json.elements?.length ?? 0} elements)`);
  await sleep(3000);
};

/** 观前街（步行街段） */
await fetchTo(
  'extra-guanqian.json',
  '[out:json][timeout:30];way["highway"]["name"="观前街"](31.3050,120.6100,31.3200,120.6350);out geom tags;',
);

/** 双塔（罗汉院双塔）+ 定慧寺巷一带院墙 */
await fetchTo(
  'extra-shuangta.json',
  '[out:json][timeout:30];(nwr["name"~"双塔|罗汉院"](31.3000,120.6100,31.3150,120.6350);way["barrier"="wall"](31.3040,120.6180,31.3120,120.6300););out geom tags;',
);

/** 北寺塔（报恩寺） */
await fetchTo(
  'extra-beisita.json',
  '[out:json][timeout:30];(nwr["name"~"北寺塔|报恩寺"](31.3080,120.6050,31.3250,120.6350);way["barrier"="wall"](31.3120,120.6140,31.3220,120.6260););out geom tags;',
);

console.log('\n抓取完成。下一步: node scripts/build-scene-data.mjs');
