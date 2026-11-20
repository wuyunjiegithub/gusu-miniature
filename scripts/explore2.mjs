/**
 * 探测第二轮：水系名称、缺失景点（留园/苏博/平江路/山塘街/寒山寺）
 * 用法: node scripts/explore2.mjs
 */
import { overpassQuery, BBOX } from './lib/overpass.mjs';

const explore = async (label, query) => {
  console.log(`\n===== ${label} =====`);
  const json = await overpassQuery(query);
  for (const el of json.elements ?? []) {
    const tags = el.tags ?? {};
    console.log(
      `${el.type}/${el.id}  name=${tags.name ?? '-'}  ` +
        `${tags.waterway ?? tags.highway ?? tags.tourism ?? tags.historic ?? tags.natural ?? ''}`,
    );
  }
};

await explore(
  '水系（有名称）',
  `[out:json][timeout:40];(way["waterway"]["name"](${BBOX});relation["waterway"](${BBOX});relation["natural"="water"]["name"](${BBOX}););out tags;`,
);

await explore(
  '按名称找景点',
  `[out:json][timeout:40];nwr["name"~"留园|苏州博物馆|平江路|山塘街|寒山寺|平江历史街区"](${BBOX});out tags;`,
);
