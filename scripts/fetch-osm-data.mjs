/**
 * OSM 数据抓取：古城水系（含外城河轮廓）+ 主要景点轮廓/坐标
 * 产出 data/raw/*.json（Overpass 原始几何，WGS84 经纬度）
 * 特性：逐查询落盘、断点续传（已存在的文件自动跳过）
 * 用法: node scripts/fetch-osm-data.mjs
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

console.log('\n抓取完成。下一步: node scripts/build-scene-data.mjs');
