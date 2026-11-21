/**
 * OSM 数据抓取：古城水系（含外城河轮廓）+ 主要景点轮廓/坐标
 * 产出 data/raw/*.json（Overpass 原始几何，WGS84 经纬度）
 * 特性：逐查询落盘、断点续传（已存在的文件自动跳过）
 * 用法: node scripts/fetch-osm-data.mjs
 */
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
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

/** 抓取单个查询并落盘；已存在则跳过（断点续传） */
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

/** 1. 水系：按 4 块分块拉取（纪律：不整城一次拉取），供提取外城河闭合环 + 城内水系 */
await fetchTo(
  'waterways-sw.json',
  '[out:json][timeout:120];way["waterway"](31.268,120.578,31.313,120.623);out geom;',
);
await fetchTo(
  'waterways-se.json',
  '[out:json][timeout:120];way["waterway"](31.268,120.619,31.313,120.664);out geom;',
);
await fetchTo(
  'waterways-nw.json',
  '[out:json][timeout:120];way["waterway"](31.309,120.578,31.354,120.623);out geom;',
);
await fetchTo(
  'waterways-ne.json',
  '[out:json][timeout:120];way["waterway"](31.309,120.619,31.354,120.664);out geom;',
);

/** 2. 景点面状轮廓（探测阶段确认的 way id） */
await fetchTo(
  'landmark-polygons.json',
  '[out:json][timeout:40];way(id:468359738,420034522,44679452,44679451,492154541,685088107,128898272,542534202,541032070);out geom tags;',
);

/** 3. 街道型景点折线：平江路、山塘街（阊门—虎丘段） */
await fetchTo(
  'streets.json',
  '[out:json][timeout:40];(way["highway"]["name"="平江路"](31.305,120.626,31.325,120.640);way["highway"]["name"="山塘街"](31.308,120.575,31.340,120.610););out geom;',
);

/** 4. 寒山寺（阊门外，单独西扩范围查询） */
await fetchTo(
  'hanshan.json',
  '[out:json][timeout:25];nwr["name"~"寒山寺"](31.300,120.560,31.330,120.590);out geom tags;',
);

/** 5. 合并 4 个水系分块 → waterways.json
 *  build-scene-data.mjs 优先读这个合并文件；历史上它来源不明（无脚本产出），
 *  从零复现时会缺失并静默回退到分块。这里显式产出，闭合链路。
 *
 *  幂等策略：若合并文件已存在，只有当它比"4 分块合并结果"要素更少时才覆盖。
 *  这样从零复现能生成该文件，而重跑不会用分块版本破坏一份可能更完整的既有文件
 *  （历史上手工合并版曾含分块抓取边界外的 1 个额外几何点）。 */
const waterTiles = ['waterways-sw.json', 'waterways-se.json', 'waterways-nw.json', 'waterways-ne.json'];
const seen = new Map();
for (const name of waterTiles) {
  const json = JSON.parse(await readFile(new URL(name, RAW_DIR), 'utf8'));
  for (const el of json.elements ?? []) {
    if (el.type !== 'way' || !el.geometry) continue;
    // 同一 way 落在多个分块边缘被重复抓取：保留几何点最全的版本，
    // 使合并结果对分块读取顺序不敏感。
    const prev = seen.get(el.id);
    if (!prev || (el.geometry?.length ?? 0) > (prev.geometry?.length ?? 0)) seen.set(el.id, el);
  }
}
const merged = { elements: [...seen.values()] };
const mergedFile = new URL('waterways.json', RAW_DIR);
if (await exists(mergedFile)) {
  const current = JSON.parse(await readFile(mergedFile, 'utf8'));
  const curCount = current.elements?.length ?? 0;
  if (curCount >= merged.elements.length) {
    console.log(`[merge] waterways.json 已存在且更完整 (${curCount} ≥ ${merged.elements.length})，保留`);
  } else {
    await writeFile(mergedFile, JSON.stringify(merged));
    console.log(`[merge] waterways.json 覆盖为 4 分块合并 (${merged.elements.length} ways)`);
  }
} else {
  await writeFile(mergedFile, JSON.stringify(merged));
  console.log(`[merge] waterways.json ← 4 分块新建 (${merged.elements.length} ways)`);
}

console.log('\n抓取完成。下一步: node scripts/build-scene-data.mjs');
