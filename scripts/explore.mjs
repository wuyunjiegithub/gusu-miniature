/**
 * 探测 Overpass 上的可用数据：护城河 / 古城相关要素 / 景点多边形
 * 用法: node scripts/explore.mjs
 */
import { overpassQuery, BBOX } from './lib/overpass.mjs';

const explore = async (label, query) => {
  console.log(`\n===== ${label} =====`);
  const json = await overpassQuery(query);
  for (const el of json.elements ?? []) {
    const tags = el.tags ?? {};
    console.log(
      `${el.type}/${el.id}  name=${tags.name ?? '-'}  ` +
        `${tags.waterway ?? tags.tourism ?? tags.historic ?? tags.highway ?? tags.boundary ?? ''} ` +
        `geom=${el.geometry?.length ?? el.members?.length ?? 0}`,
    );
  }
};

await explore(
  '名称含"护城河"的要素',
  `[out:json][timeout:25];nwr["name"~"护城河"](${BBOX});out tags;`,
);

await explore(
  '景点 attraction（古城范围）',
  `[out:json][timeout:25];(relation["tourism"="attraction"]["name"](31.286,120.596,31.336,120.646);way["tourism"="attraction"]["name"](31.286,120.596,31.336,120.646););out tags;`,
);

await explore(
  '博物馆/古迹/城门',
  `[out:json][timeout:25];nwr["tourism"="museum"]["name"](31.286,120.596,31.336,120.646);nwr["historic"~"^(city_gate|fort|castle|monument)$"]["name"](31.286,120.596,31.336,120.646);out tags;`,
);
