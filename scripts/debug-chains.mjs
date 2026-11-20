/** 诊断：水系链的闭合情况与外城河 way 的端点分布 */
import { readFile } from 'node:fs/promises';

const ORIGIN = { lon: 120.621, lat: 31.311 };
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);
const toLocal = (p) => ({
  x: (p.lon - ORIGIN.lon) * M_PER_DEG_LON,
  z: -(p.lat - ORIGIN.lat) * M_PER_DEG_LAT,
});
const pointKey = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;

const raw = JSON.parse(await readFile(new URL('../data/raw/waterways.json', import.meta.url), 'utf8'));
const ways = raw.elements.filter((e) => e.type === 'way' && e.geometry);
console.log('ways:', ways.length);

// 外城河专项
const moatWays = ways.filter((w) => w.tags?.name === '外城河');
console.log('\n外城河 ways:', moatWays.length);
for (const w of moatWays) {
  const g = w.geometry;
  console.log(`  way/${w.id} ${g.length} pts  start=(${g[0].lon.toFixed(5)},${g[0].lat.toFixed(5)}) end=(${g[g.length - 1].lon.toFixed(5)},${g[g.length - 1].lat.toFixed(5)})`);
}

// 端点度数统计：护城河环上的交叉点应度数>=2
const degree = new Map();
for (const w of ways) {
  const g = w.geometry;
  for (const p of [g[0], g[g.length - 1]]) {
    const k = pointKey(p);
    degree.set(k, (degree.get(k) ?? 0) + 1);
  }
}
let deg1 = 0;
for (const [, d] of degree) if (d === 1) deg1 += 1;
console.log(`\n端点总数 ${degree.size}，度数=1 的悬空端点 ${deg1}`);

// 简单串链（同 build 脚本逻辑）
const endpointMap = new Map();
ways.forEach((w, i) => {
  const g = w.geometry;
  for (const [end, p] of [['start', g[0]], ['end', g[g.length - 1]]]) {
    const k = pointKey(p);
    if (!endpointMap.has(k)) endpointMap.set(k, []);
    endpointMap.get(k).push({ i, end });
  }
});
const used = new Array(ways.length).fill(false);
const chains = [];
for (let i = 0; i < ways.length; i += 1) {
  if (used[i]) continue;
  used[i] = true;
  const chain = [{ way: i, pts: [...ways[i].geometry] }];
  const pts = [...ways[i].geometry];
  for (;;) {
    const cands = (endpointMap.get(pointKey(pts[pts.length - 1])) ?? []).filter((c) => !used[c.i]);
    if (!cands.length) break;
    const c = cands[0];
    used[c.i] = true;
    const g = ways[c.i].geometry;
    if (c.end === 'start') pts.push(...g.slice(1));
    else pts.push(...g.slice(0, -1).reverse());
  }
  for (;;) {
    const cands = (endpointMap.get(pointKey(pts[0])) ?? []).filter((c) => !used[c.i]);
    if (!cands.length) break;
    const c = cands[0];
    used[c.i] = true;
    const g = ways[c.i].geometry;
    if (c.end === 'end') pts.unshift(...g.slice(0, -1));
    else pts.unshift(...g.slice(1).reverse());
  }
  chains.push(pts);
}
console.log(`\n链总数 ${chains.length}`);
const closed = chains.filter((c) => pointKey(c[0]) === pointKey(c[c.length - 1]) && c.length > 3);
console.log('闭合链:', closed.length);
for (const c of closed) {
  const local = c.map(toLocal);
  let area = 0;
  for (let i = 0; i < local.length - 1; i += 1) area += local[i].x * local[i + 1].z - local[i + 1].x * local[i].z;
  area = Math.abs(area / 2);
  console.log(`  闭合链 ${c.length} pts, 面积 ${(area / 1e6).toFixed(2)} km²`);
}
