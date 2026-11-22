/**
 * 数据清单完整性校验：数据管线的"第一道门禁"。
 * 检查 data/raw 关键原始数据、public/data 与 src/data 关键生成物的存在性与规模。
 * 目的：防止文件缺失让下游 QA 门禁因"空数据"而假通过。
 *
 * 用法: node scripts/check-manifest.mjs
 * 失败时 process.exitCode = 1。
 */
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gate, report } from './lib/qa-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const j = async (p) => JSON.parse(await readFile(path.join(ROOT, p), 'utf8'));
const exists = async (p) => {
  try {
    await access(path.join(ROOT, p));
    return true;
  } catch {
    return false;
  }
};

/* ---------- 1. 原始数据：关键分块必须齐全 ---------- */
const rawRequired = [
  'data/raw/waterways.json',
  ...['sw', 'se', 'nw', 'ne'].map((q) => `data/raw/waterways-${q}.json`),
  'data/raw/landmark-polygons.json',
  'data/raw/streets.json',
  'data/raw/hanshan.json',
  ...Array.from({ length: 3 }, (_, r) =>
    Array.from({ length: 3 }, (_, c) => `data/raw/buildings-${r}-${c}.json`),
  ).flat(),
  ...Array.from({ length: 3 }, (_, r) =>
    Array.from({ length: 3 }, (_, c) => `data/raw/roads-${r}-${c}.json`),
  ).flat(),
  'data/raw/transit.json',
  'data/raw/heritage.json',
  // 补充景点：含唐寅祠/桃花坞（曾因缺抓取脚本而断链）
  ...['guanqian', 'shuangta', 'beisita', 'xiyuansi', 'shilu', 'taohuawu'].map(
    (n) => `data/raw/extra-${n}.json`,
  ),
];
const missingRaw = [];
for (const p of rawRequired) if (!(await exists(p))) missingRaw.push(p);
gate('原始数据文件齐全', missingRaw.length, {
  max: 0,
  note: `要求 ${rawRequired.length} 个${missingRaw.length ? '，缺: ' + missingRaw.join(', ') : ''}`,
});

/* ---------- 2. 原始数据规模：防止抓到空响应 ---------- */
const buildingsRaw = (
  await Promise.all(
    Array.from({ length: 3 }, (_, r) =>
      Array.from({ length: 3 }, (_, c) => j(`data/raw/buildings-${r}-${c}.json`)),
    ).flat(),
  )
).reduce((n, o) => n + (o.elements?.length ?? 0), 0);
gate('建筑原始要素数', buildingsRaw, { min: 8000, note: '基线≈9228 个 OSM 轮廓（其余为程序化补白至 25506）' });

const water = await j('data/raw/waterways.json');
gate('水系合并 way 数', water.elements?.length ?? 0, { min: 100, note: '基线=119' });

const heritageRaw = await j('data/raw/heritage.json');
gate('文保候选 POI 数', heritageRaw.elements?.length ?? 0, { min: 500, note: '基线≈1896' });

/* ---------- 3. 生成物：存在性与规模 ---------- */
const buildings = await j('public/data/buildings.json');
const buildingCount =
  (buildings.pitched?.length ?? 0) + (buildings.flat?.length ?? 0) + (buildings.outer?.length ?? 0);
// 建筑避让改用真实路面半宽后，剔除了约 4500 栋压路建筑（原本房子长在马路上）。
// 修复后基线约 23400（±800），下限下调到 22000 仍能捕获数据灾难性丢失。
gate('建筑实例总数', buildingCount, { min: 22000, note: '基线≈23400（压路避让修复后）' });

const roads = await j('public/data/roads.json');
gate('主干路段数', roads.major?.length ?? 0, { min: 1600, note: '基线=1776；清理折返尖头/窄闭环/孤立碎段与双幅合并后约 1776' });
gate('次干路段数', roads.minor?.length ?? 0, { min: 1500, note: '基线=1901（含立交匝道）' });

const transit = await j('public/data/transit.json');
gate('地铁线路数', transit.lines?.length ?? 0, { min: 7, note: '基线=9' });

const scene = await j('src/data/scene-geometry.json');
gate('城轮廓点数', scene.cityOutline?.length ?? 0, { min: 50, note: '基线=100' });
gate('城内河道条数', scene.waterways?.length ?? 0, {
  min: 1,
  note: '基线=2（9 段 10~80m 孤立水洼已剔除，只留连通主河道）',
});
gate('景点轮廓数', Object.values(scene.landmarks ?? {}).filter((l) => l.outline).length, {
  min: 10,
  note: '基线=14',
});

const outlinePng = await exists('public/textures/suzhou-old-city-outline.png');
gate('城轮廓参考 PNG', outlinePng ? 1 : 0, { expect: 1 });

report('check-manifest');
