import fs from 'node:fs';
import path from 'node:path';
import { gate, report } from './lib/qa-gate.mjs';

const root = path.resolve(import.meta.dirname, '..');
const roads = JSON.parse(fs.readFileSync(path.join(root, 'public/data/roads.json'), 'utf8'));
const sg = JSON.parse(fs.readFileSync(path.join(root, 'src/data/scene-geometry.json'), 'utf8'));

const CANAL_HALF = 15, CANAL_Y = 2.4;
const MOAT_INNER = 4.6, MOAT_OUTER = MOAT_INNER + 120, MOAT_Y = 1.4;
const SHANTANG_HALF = 4, SHANGTANG_HALF = 13, SHANTANG_Y = -1.3;
const outerHalf = (i) => (i === 0 ? SHANTANG_HALF : SHANGTANG_HALF);

const cityRing = sg.cityOutline;
const cityRingClosed = [...cityRing, cityRing[0]];
const waterways = sg.waterways ?? [];
const outerWaterways = sg.outerWaterways ?? [];

console.log('cityOutline 点数', cityRing.length);
console.log('waterways', waterways.length, 'outerWaterways', outerWaterways.length);

function pointInPolygon(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if ((zi > p[1]) !== (zj > p[1]) && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
const distToSeg = (x, z, a, b) => {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
};
const distToLine = (x, z, line) => {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i += 1) best = Math.min(best, distToSeg(x, z, line[i], line[i + 1]));
  return best;
};

function waterKind(x, z) {
  for (const line of waterways) if (distToLine(x, z, line) < CANAL_HALF) return { kind: 'canal', y: CANAL_Y };
  for (let i = 0; i < outerWaterways.length; i += 1) {
    if (distToLine(x, z, outerWaterways[i]) < outerHalf(i)) return { kind: 'shantang', y: SHANTANG_Y };
  }
  if (!pointInPolygon([x, z], cityRing)) {
    const d = distToLine(x, z, cityRingClosed);
    if (d >= MOAT_INNER - 0.6 && d < MOAT_OUTER) return { kind: 'moat', y: MOAT_Y };
  }
  return null;
}

// 1) 先统计全城有多少道路采样点落在护城河里（先不判是否在城内）
let moatPts = 0, canalPts = 0, shantangPts = 0, total = 0;
for (const kind of ['major', 'minor']) {
  for (const line of roads[kind]) {
    for (let i = 0; i < line.length - 1; i += 1) {
      const a = line[i], b = line[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(len / 4));
      for (let s = 0; s < steps; s += 1) {
        const t = s / steps;
        const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
        total += 1;
        const w = waterKind(x, z);
        if (w?.kind === 'moat') moatPts += 1;
        else if (w?.kind === 'canal') canalPts += 1;
        else if (w?.kind === 'shantang') shantangPts += 1;
      }
    }
  }
}
console.log(`采样点 ${total}：护城河内 ${moatPts}、城内河道 ${canalPts}、山塘河 ${shantangPts}`);

// 2) 复算桥位
const sites = [];
const MAX_SPAN = 210, STEP = 4;
const stat = { canal: 0, moat: 0, shantang: 0 };
const skipped = { short: 0, long: 0, dup: 0 };
for (const kind of ['major', 'minor']) {
  for (const line of roads[kind]) {
    if (line.length < 2) continue;
    const samples = [];
    for (let i = 0; i < line.length - 1; i += 1) {
      const a = line[i], b = line[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(len / STEP));
      for (let s = 0; s < steps; s += 1) {
        const t = s / steps;
        const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
        samples.push({ x, z, w: waterKind(x, z) });
      }
    }
    samples.push({ x: line[line.length - 1][0], z: line[line.length - 1][1], w: waterKind(line[line.length - 1][0], line[line.length - 1][1]) });

    let i = 0;
    while (i < samples.length) {
      if (!samples[i].w) { i += 1; continue; }
      let j = i;
      let wy = samples[i].w.y;
      const kindW = samples[i].w.kind;
      while (j + 1 < samples.length && samples[j + 1].w) { j += 1; wy = Math.max(wy, samples[j].w.y); }
      const s0 = samples[i], s1 = samples[j];
      const span = Math.hypot(s1.x - s0.x, s1.z - s0.z);
      if (span < 5) skipped.short += 1;
      else if (span > MAX_SPAN) skipped.long += 1;
      else {
        const x = (s0.x + s1.x) / 2, z = (s0.z + s1.z) / 2;
        const dup = sites.some((s) => Math.hypot(s.x - x, s.z - z) < 34);
        if (dup) skipped.dup += 1;
        else { sites.push({ x, z, span, kindW, y: wy }); stat[kindW] += 1; }
      }
      i = j + 1;
    }
  }
}
console.log('桥位统计', stat, '跳过', skipped, '总数', sites.length);

// 3) 护城河桥位坐标
for (const k of ['moat', 'canal', 'shantang']) {
  console.log(`\n${k} 桥位：`);
  for (const s of sites.filter((v) => v.kindW === k)) {
    console.log(`  (${s.x.toFixed(0)}, ${s.z.toFixed(0)}) span=${s.span.toFixed(0)}m`);
  }
}

// 门禁：三类桥位都必须存在，任何一个归零都说明道路/水系数据损坏。
// 基线：moat=8, canal=2, shantang=5, 总数=15。
gate('桥位总数', sites.length, { min: 10, note: '基线=15' });
gate('护城河桥位数', stat.moat, { min: 4, note: '基线=8' });
gate('城内河道桥位数', stat.canal, { min: 1, note: '基线=2' });
gate('山塘河桥位数', stat.shantang, { min: 2, note: '基线=5' });
report('qa-bridges');
