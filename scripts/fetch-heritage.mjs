import { overpassQuery } from './lib/overpass.mjs';
import { writeFile, mkdir } from 'node:fs/promises';

// 古城 bbox（含外扩缓冲）
const BBOX = '31.270,120.580,31.352,120.662';
// 名称关键词：覆盖园林/寺庙/祠/宅/馆/门/塔/府/署/楼/阁/殿/观/宫/故居/旧址/会馆/书院/碑
const nameRe = '园|寺|庙|祠|堂|宅|馆|门|塔|府|署|楼|阁|殿|观|宫|故居|旧居|旧址|会馆|书院|碑|桥|庄|亭|馆|义庄';

const query = `[out:json][timeout:90];
(
  nwr["historic"](${BBOX});
  nwr["heritage"](${BBOX});
  nwr["tourism"~"attraction|museum"](${BBOX});
  nwr["amenity"~"place_of_worship|university|college|school|library|theatre|arts_centre"](${BBOX});
  nwr["name"~"${nameRe}"](${BBOX});
);
out geom tags;`;

console.log('[query] 拉取古城文保候选 POI ...');
const json = await overpassQuery(query);
await mkdir(new URL('../data/raw/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/raw/heritage.json', import.meta.url), JSON.stringify(json));
console.log(`[save] heritage.json (${json.elements?.length ?? 0} elements)`);
