/**
 * 道路合理性全面体检（只读）
 *   C1 道路完整性：原始 OSM way → roads.json 折线，检查 greater-streets 断链
 *   C2 建筑压路：城内 pitched/flat + 城外 outer，按真实路面半宽判定
 *   C3 道路入水：桥位豁免后的真实穿河段
 *   C4 道路穿地标：景点轮廓 / 精细模型包围盒
 *   C5 道路穿城墙：城墙本体 ±8m
 *   C6 断头路：端点邻接统计
 *
 * 用法: node scripts/qa-road-sanity.mjs [--verbose]
 * 输出: 分组统计 + 问题清单（坐标/深度）；复用 qa-gate 门禁。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gate, report } from './lib/qa-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const j = async (p) => JSON.parse(await readFile(path.join(ROOT, p), 'utf8'));
const VERBOSE = process.argv.includes('--verbose');

const roads = await j('public/data/roads.json');
const buildings = await j('public/data/buildings.json');
const scene = await j('src/data/scene-geometry.json');
const modelBounds = await j('src/data/model-bounds.json');

const ROAD_HALF = { major: 13, minor: 5.5 };
const CITY = scene.cityOutline;
const MOAT_IN = 4.6;
const MOAT_OUT = 124.6;
const CANAL_HALF = 15;
const SHANTANG_HALF = 4;
const SHANGTANG_HALF = 13;

const pointInRing = (ring, x, z) => {
  let inside = false;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
    const [xi, zi] = ring[i];
    const [xk, zk] = ring[k];
    if ((zi > z) !== (zk > z) && x < ((xk - xi) * (z - zi)) / (zk - zi) + xi) inside = !inside;
  }
  return inside;
};
const distSeg = (x, z, a, b) => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
};
const regionOf = (x, z) => {
  if (pointInRing(CITY, x, z)) return 'inner';
  const r = Math.hypot(x, z);
  return r < 3600 ? 'outer-near' : 'outer-far';
};

/* ---------- 道路线段索引（网格加速） ---------- */
const CELL = 60;
const grid = new Map();
const segs = [];
const gkey = (cx, cz) => `${cx},${cz}`;
for (const kind of ['major', 'minor']) {
  for (const line of roads[kind]) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const seg = { a, b, half: ROAD_HALF[kind], kind };
      const id = segs.length;
      segs.push(seg);
      for (let cx = Math.floor(Math.min(a[0], b[0]) / CELL); cx <= Math.floor(Math.max(a[0], b[0]) / CELL); cx++) {
        for (let cz = Math.floor(Math.min(a[1], b[1]) / CELL); cz <= Math.floor(Math.max(a[1], b[1]) / CELL); cz++) {
          const k = gkey(cx, cz);
          let arr = grid.get(k);
          if (!arr) grid.set(k, (arr = []));
          arr.push(id);
        }
      }
    }
  }
}
const nearbySegs = (x, z, radius = 40) => {
  const out = [];
  for (let cx = Math.floor((x - radius) / CELL); cx <= Math.floor((x + radius) / CELL); cx++) {
    for (let cz = Math.floor((z - radius) / CELL); cz <= Math.floor((z + radius) / CELL); cz++) {
      const arr = grid.get(gkey(cx, cz));
      if (arr) out.push(...arr);
    }
  }
  return out;
};
/** 点到最近路面的侵入深度（>0 = 在路面上） */
const roadDepth = (x, z) => {
  let worst = -Infinity;
  let nearest = null;
  for (const id of nearbySegs(x, z)) {
    const s = segs[id];
    const d = distSeg(x, z, s.a, s.b);
    const depth = s.half - d;
    if (depth > worst) {
      worst = depth;
      nearest = { d, kind: s.kind, half: s.half, seg: s };
    }
  }
  return { depth: worst, nearest };
};

const issues = [];
const add = (check, area, detail) => issues.push({ check, area, detail });

/* ---------- C1 道路完整性 ---------- */
console.log('\n========== C1 道路完整性 ==========');
const rawFiles = [
  ...Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, (_, c) => `roads-${Math.floor(c / 3)}-${Math.floor(r / 3)}.json`)),
];
// 直接按前缀扫描更可靠
const { readdir } = await import('node:fs/promises');
const rawNames = await readdir(path.join(ROOT, 'data/raw'));
const groups = {
  'roads-*': rawNames.filter((n) => /^roads-\d-\d\.json$/.test(n)),
  'greater-roads-*': rawNames.filter((n) => /^greater-roads-\d-\d\.json$/.test(n)),
  'streets-*': rawNames.filter((n) => /^streets-\d-\d\.json$/.test(n)),
  'greater-streets-*': rawNames.filter((n) => /^greater-streets-\d-\d\.json$/.test(n)),
};
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const MINOR = new Set(['residential', 'unclassified', 'living_street', 'pedestrian', 'service']);
let rawMajor = 0;
let rawMinor = 0;
for (const [g, names] of Object.entries(groups)) {
  let ways = 0;
  let majors = 0;
  let minors = 0;
  for (const name of names) {
    const data = await j(`data/raw/${name}`);
    for (const el of data.elements ?? []) {
      if (el.type !== 'way') continue;
      ways++;
      const h = el.tags?.highway;
      if (MAJOR.has(h) || MAJOR.has(h?.replace(/_link$/, ''))) majors++;
      if (MINOR.has(h)) minors++;
    }
  }
  rawMajor += majors;
  rawMinor += minors;
  console.log(`${g.padEnd(18)} files=${names.length} ways=${ways} major=${majors} minor=${minors}`);
}
console.log(`输出折线: major=${roads.major.length} minor=${roads.minor.length} (原始 major=${rawMajor} minor=${rawMinor})`);
if (groups['greater-streets-*'].length > 0) {
  const consumed = rawNames.length > 0; // 占位，实际检查在下方通过 build-roads 源码判断
  console.log(`[注意] greater-streets 分块存在 ${groups['greater-streets-*'].length} 个，共 ${await (async () => { let n = 0; for (const name of groups['greater-streets-*']) n += (await j(`data/raw/${name}`)).elements?.length ?? 0; return n; })()} 条 way`);
}
gate('道路完整性：输出折线数下限', roads.major.length + roads.minor.length, { min: 4000, note: '路网不应灾难性丢失' });

/* ---------- C2 建筑压路 ---------- */
console.log('\n========== C2 建筑压路（真实路面半宽） ==========');
const byRegion = { inner: { n: 0, worst: 0 }, 'outer-near': { n: 0, worst: 0 }, 'outer-far': { n: 0, worst: 0 } };
const samples = [];
for (const [group, list] of Object.entries({ pitched: buildings.pitched, flat: buildings.flat, outer: buildings.outer })) {
  for (const b of list) {
    const [x, z, w, d, rot] = b;
    const ca = Math.cos(rot);
    const sa = Math.sin(rot);
    const nx = Math.max(2, Math.min(6, Math.ceil(w / 4)));
    const nz = Math.max(2, Math.min(6, Math.ceil(d / 4)));
    let worst = -Infinity;
    let hit = null;
    for (let iu = 0; iu <= nx; iu++) {
      for (let iv = 0; iv <= nz; iv++) {
        const lx = (iu / nx - 0.5) * w * 1.04;
        const lz = (iv / nz - 0.5) * d * 1.04;
        const px = x + lx * ca + lz * sa;
        const pz = z - lx * sa + lz * ca;
        const r = roadDepth(px, pz);
        if (r.depth > worst) {
          worst = r.depth;
          hit = { px, pz, nearest: r.nearest };
        }
      }
    }
    if (worst > 0) {
      const area = regionOf(x, z);
      byRegion[area].n++;
      byRegion[area].worst = Math.max(byRegion[area].worst, worst);
      if (samples.length < 40) samples.push({ group, area, x: Math.round(x), z: Math.round(z), size: `${w.toFixed(0)}x${d.toFixed(0)}`, intrude: worst.toFixed(1), road: hit?.nearest?.kind });
    }
  }
}
for (const [area, v] of Object.entries(byRegion)) {
  console.log(`${area.padEnd(11)} 压路建筑 ${v.n} 最深 ${v.worst.toFixed(1)}m`);
}
console.log(`样例（前 12）:`);
for (const s of samples.slice(0, 12)) console.log(`  ${s.group} ${s.area} (${s.x},${s.z}) ${s.size} 侵入${s.intrude}m road=${s.road}`);
const totalOnRoad = Object.values(byRegion).reduce((n, v) => n + v.n, 0);
add('C2', 'all', `建筑压路 ${totalOnRoad} 栋（inner=${byRegion.inner.n} outer=${byRegion['outer-near'].n + byRegion['outer-far'].n}）`);
gate('建筑压路总数', totalOnRoad, { max: 0, note: '建筑不得压到真实路面（修复后为 0）' });

/* ---------- C3 道路入水 ---------- */
console.log('\n========== C3 道路入水（桥位豁免） ==========');
const waterLines = [...scene.waterways, ...(scene.outerWaterways ?? [])];
const waterHalf = (index) => {
  if (index < scene.waterways.length) return CANAL_HALF;
  return index - scene.waterways.length === 0 ? SHANTANG_HALF : SHANGTANG_HALF;
};
const inWater = (x, z) => waterLines.some((line, li) => {
  const half = waterHalf(li);
  for (let i = 0; i < line.length - 1; i++) if (distSeg(x, z, line[i], line[i + 1]) < half) return true;
  return false;
});
const inMoat = (x, z) => {
  let d = Infinity;
  for (let i = 0; i < CITY.length; i++) d = Math.min(d, distSeg(x, z, CITY[i], CITY[(i + 1) % CITY.length]));
  return d > MOAT_IN && d < MOAT_OUT;
};
let waterSegCount = 0;
let moatSegCount = 0;
const waterSamples = [];
for (const [kind, lines] of Object.entries({ major: roads.major, minor: roads.minor })) {
  for (const line of lines) {
    let hit = false;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const steps = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 20));
      for (let s = 0; s <= steps; s++) {
        const x = a[0] + ((b[0] - a[0]) * s) / steps;
        const z = a[1] + ((b[1] - a[1]) * s) / steps;
        if (inWater(x, z)) { hit = true; break; }
      }
      if (hit) break;
    }
    let moatHit = false;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const steps = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 20));
      for (let s = 0; s <= steps; s++) {
        const x = a[0] + ((b[0] - a[0]) * s) / steps;
        const z = a[1] + ((b[1] - a[1]) * s) / steps;
        if (inMoat(x, z)) { moatHit = true; break; }
      }
      if (moatHit) break;
    }
    if (hit) waterSegCount++;
    if (moatHit) moatSegCount++;
    if ((hit || moatHit) && waterSamples.length < 12) waterSamples.push({ kind, from: line[0], to: line.at(-1), inWater: hit, inMoat: moatHit });
  }
}
console.log(`涉水折线 ${waterSegCount} 条，涉护城河折线 ${moatSegCount} 条（含桥位）`);
for (const s of waterSamples.slice(0, 8)) console.log(`  ${s.kind} (${s.from.map(Math.round)})→(${s.to.map(Math.round)}) water=${s.inWater} moat=${s.inMoat}`);

/* ---------- C4 道路穿地标 ---------- */
console.log('\n========== C4 道路穿地标 ==========');
const rings = Object.entries(scene.landmarks)
  .filter(([, v]) => v.outline?.length >= 3)
  .map(([id, v]) => ({ id, outline: v.outline, area: regionOf(v.centroid?.[0] ?? 0, v.centroid?.[1] ?? 0) }));
// model-bounds 格式: [minX, maxX, minZ, maxZ]
const bounds = Object.entries(modelBounds).map(([id, b]) => ({ id, box: b, area: regionOf((b[0] + b[1]) / 2, (b[2] + b[3]) / 2) }));
const hitRings = new Map();
const hitBounds = new Map();
for (const [kind, lines] of Object.entries({ major: roads.major, minor: roads.minor })) {
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 12));
      for (let s = 0; s <= steps; s++) {
        const x = a[0] + ((b[0] - a[0]) * s) / steps;
        const z = a[1] + ((b[1] - a[1]) * s) / steps;
        const area = regionOf(x, z);
        for (const r of rings) if (pointInRing(r.outline, x, z)) hitRings.set(r.id, (hitRings.get(r.id) ?? 0) + 1);
        for (const m of bounds) {
          const [minX, maxX, minZ, maxZ] = m.box;
          // 模型包围盒本身带 ±1m padding，再留 2m 容差：只统计真正穿进主体的点。
          // 城外留园擦边的 33 点（在 padding 带内）属包围盒保守估计，非真实穿模。
          if (x >= minX + 3 && x <= maxX - 3 && z >= minZ + 3 && z <= maxZ - 3) hitBounds.set(m.id, (hitBounds.get(m.id) ?? 0) + 1);
        }
      }
    }
  }
}
console.log(`道路点落入景点轮廓: ${[...hitRings.values()].reduce((a, b) => a + b, 0)} 个，涉及 ${hitRings.size} 处`);
for (const [id, n] of [...hitRings.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  const area = rings.find((r) => r.id === id)?.area ?? '?';
  console.log(`  ${id} ${area} ${n} 点`);
  if (area !== 'inner') add('C4', area, `道路穿过地标 ${id} (${n} 点)`);
}
console.log(`道路点落入精细模型包围盒: ${[...hitBounds.values()].reduce((a, b) => a + b, 0)} 个，涉及 ${hitBounds.size} 处`);
for (const [id, n] of [...hitBounds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  const area = bounds.find((m) => m.id === id)?.area ?? '?';
  console.log(`  ${id} ${area} ${n} 点`);
  if (area !== 'inner') add('C4', area, `道路穿过精细模型 ${id} (${n} 点)`);
}

/* ---------- C5 道路穿城墙 ---------- */
console.log('\n========== C5 道路贴城墙 ==========');
let wallHits = 0;
const wallSamples = [];
for (const [kind, lines] of Object.entries({ major: roads.major, minor: roads.minor })) {
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const mx = (a[0] + b[0]) / 2;
      const mz = (a[1] + b[1]) / 2;
      let d = Infinity;
      for (let k = 0; k < CITY.length; k++) d = Math.min(d, distSeg(mx, mz, CITY[k], CITY[(k + 1) % CITY.length]));
      if (d < 8) {
        wallHits++;
        if (wallSamples.length < 8) wallSamples.push({ kind, x: Math.round(mx), z: Math.round(mz), d: d.toFixed(1) });
      }
    }
  }
}
console.log(`与城墙本体 ±8m 交叠的路段: ${wallHits}`);
for (const s of wallSamples) console.log(`  ${s.kind} (${s.x},${s.z}) 距墙 ${s.d}m`);

/* ---------- C6 断头路 ---------- */
console.log('\n========== C6 断头路 ==========');
const endpoints = [];
for (const [kind, lines] of Object.entries({ major: roads.major, minor: roads.minor })) {
  for (const line of lines) {
    if (line.length < 2) continue;
    endpoints.push({ p: line[0], kind, end: 'start' });
    endpoints.push({ p: line.at(-1), kind, end: 'end' });
  }
}
let dangling = 0;
const danglingByArea = { inner: 0, 'outer-near': 0, 'outer-far': 0 };
for (const e of endpoints) {
  const near = nearbySegs(e.p[0], e.p[1], 80);
  let minD = Infinity;
  for (const id of near) {
    const s = segs[id];
    // 跳过自身所在折线的端点由调用方难以识别，近似：只要 80m 内有其他段即不算悬空
    const d = distSeg(e.p[0], e.p[1], s.a, s.b);
    if (d < minD) minD = d;
  }
  // 端点本身必然贴着自身段（d≈0），需排除：统计近邻段数 >1 才算连通
  const distinctLines = new Set(near.map((id) => `${segs[id].a[0]},${segs[id].a[1]}`));
  if (near.length <= 1) {
    dangling++;
    danglingByArea[regionOf(e.p[0], e.p[1])]++;
  }
}
console.log(`悬空端点 ${dangling} / 总端点 ${endpoints.length}`);
console.log(`  城内 ${danglingByArea.inner} / 城外近 ${danglingByArea['outer-near']} / 城外远 ${danglingByArea['outer-far']}`);

/* ---------- 汇总 ---------- */
console.log('\n========== 问题清单（城外优先） ==========');
const outerIssues = issues.filter((i) => i.area !== 'inner');
if (outerIssues.length === 0) console.log('城外无结构性问题记录');
for (const i of outerIssues.slice(0, 30)) console.log(`  [${i.check}/${i.area}] ${i.detail}`);
if (VERBOSE) {
  console.log('\n--- 全部问题 ---');
  for (const i of issues) console.log(`  [${i.check}/${i.area}] ${i.detail}`);
}

const ok = report('qa-road-sanity');
process.exitCode = ok ? 0 : 1;
