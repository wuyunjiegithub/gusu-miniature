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

/** 西园寺（西园戒幢律寺，way 736382204）+ 院内殿宇 */
await fetchTo(
  'extra-xiyuansi.json',
  '[out:json][timeout:30];(way(736382204);way["building"](31.3180,120.5850,31.3280,120.5960););out geom tags;',
);

/** 石路商圈（石路步行街 retail 面，way 561176608）+ 步行街 */
await fetchTo(
  'extra-shilu.json',
  '[out:json][timeout:30];(way(561176608);way["highway"="pedestrian"]["name"="石路"](31.3080,120.5980,31.3240,120.6140);way["landuse"="retail"](31.3080,120.5980,31.3240,120.6140););out geom tags;',
);

/** 桃花坞片区（唐寅祠 way 529003248 + 桃花坞大街街区骨架）
 *  build-scene-data.mjs:433-470 消费此文件产出 tangyinci / taohuawu 两处景点。
 *  历史断链：此查询长期缺失，从零拉取会永久丢失这两处景点。 */
await fetchTo(
  'extra-taohuawu.json',
  '[out:json][timeout:40];(way(529003248);way["name"="桃花坞大街"](31.3100,120.5950,31.3350,120.6220);nwr["name"~"唐寅祠"](31.3100,120.5950,31.3350,120.6220););out geom tags;',
);

console.log('\n抓取完成。下一步: node scripts/build-scene-data.mjs');
