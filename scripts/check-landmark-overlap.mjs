/**
 * 校验：背景建筑是否压进任何精细景点轮廓（用于发现 GLB 与民居重叠）
 * 用法: node scripts/check-landmark-overlap.mjs
 */
import { readFile } from 'node:fs/promises';
import { gate, report } from './lib/qa-gate.mjs';

const scene = JSON.parse(
  await readFile(new URL('../src/data/scene-geometry.json', import.meta.url), 'utf8'),
);
const data = JSON.parse(
  await readFile(new URL('../public/data/buildings.json', import.meta.url), 'utf8'),
);

const pointInRing = (ring, x, z) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};

const boxTouches = (rec, ring) => {
  const [x, z, w, d, rot] = rec;
  const ca = Math.cos(rot);
  const sa = Math.sin(rot);
  const pts = [
    [0, 0],
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [-w / 2, d / 2],
    [w / 2, d / 2],
    [0, -d / 2],
    [0, d / 2],
    [-w / 2, 0],
    [w / 2, 0],
  ];
  return pts.some(([u, v]) => pointInRing(ring, x + u * ca + v * sa, z - u * sa + v * ca));
};

let total = 0;
for (const [id, landmark] of Object.entries(scene.landmarks)) {
  if (!landmark.outline) continue;
  const ring = landmark.outline;
  const parts = [];
  for (const group of ['pitched', 'flat', 'outer']) {
    const n = (data[group] ?? []).filter((rec) => boxTouches(rec, ring)).length;
    if (n > 0) parts.push(`${group}=${n}`);
    total += n;
  }
  console.log(`${id.padEnd(16)} ${parts.length ? parts.join(' ') : 'OK'}`);
}
console.log(`总计重叠建筑: ${total}`);

// 门禁：panmen 单处重叠是已知可接受的基线（城墙贴近民居），超过 5 处说明建筑或景点轮廓错位。
gate('景点重叠建筑总数', total, { max: 5, note: '基线=1(panmen)，>5 视为轮廓/建筑错位' });
gate('含轮廓景点数（防空数据）', Object.values(scene.landmarks).filter((l) => l.outline).length, { min: 10 });
report('check-landmark-overlap');
