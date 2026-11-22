/**
 * waterField / 环内索引 与朴素实现的逐点比对：
 * node scripts/qa-waterfield.mjs
 * 网格索引一旦有偏移或漏格，表现是"某几座桥消失""个别路灯插进河里"，
 * 肉眼极难发现，必须在数据层做一次等价比对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { gate, report } from './lib/qa-gate.mjs';

const root = path.resolve(import.meta.dirname, '..');
const sg = JSON.parse(fs.readFileSync(path.join(root, 'src/data/scene-geometry.json'), 'utf8'));

const CANAL_HALF = 6, CANAL_Y = 0.35;
const MOAT_INNER = 4.6, MOAT_OUTER = MOAT_INNER + 120, MOAT_Y = 1.4;
const SHANTANG_HALF = 4, SHANGTANG_HALF = 13, SHANTANG_Y = -1.3;
const ring = sg.cityOutline;

const pointInRing = (r, x, z) => {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i, i += 1) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};
const distSeg = (x, z, a, b) => {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 ? ((x - a[0]) * dx + (z - a[1]) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
};
const distLine = (x, z, line) => {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i += 1) best = Math.min(best, distSeg(x, z, line[i], line[i + 1]));
  return best;
};
const ringClosed = [...ring, ring[0]];

/** 朴素实现（改造前的原样逻辑） */
const outerHalf = (i) => (i === 0 ? SHANTANG_HALF : SHANGTANG_HALF);
const naive = (x, z, margin = 0) => {
  for (const line of sg.waterways) if (distLine(x, z, line) < CANAL_HALF + margin) return CANAL_Y;
  if ((sg.outerWaterways ?? []).some((line, i) => distLine(x, z, line) < outerHalf(i) + margin)) return SHANTANG_Y;
  if (!pointInRing(ring, x, z)) {
    const d = distLine(x, z, ringClosed);
    if (d >= MOAT_INNER - 0.6 - margin && d < MOAT_OUTER + margin) return MOAT_Y;
  }
  return null;
};

/* ---- 复刻 waterField 的网格实现 ---- */
const MAX_MARGIN = 8, CELL = 64;
const segs = [];
const push = (line, kind, half = SHANTANG_HALF) => {
  for (let i = 0; i < line.length - 1; i += 1) {
    segs.push({ ax: line[i][0], az: line[i][1], bx: line[i + 1][0], bz: line[i + 1][1], kind, half });
  }
};
sg.waterways.forEach((l) => push(l, 0, CANAL_HALF));
(sg.outerWaterways ?? []).forEach((l, i) => push(l, 1, outerHalf(i)));
push([...ring, ring[0]], 2, 0);

const reachOf = (s) => (s.kind === 2 ? MOAT_OUTER + MAX_MARGIN : s.half + MAX_MARGIN);
const grid = new Map();
const key = (ix, iz) => ix * 8192 + iz;
for (const s of segs) {
  const r = reachOf(s);
  const x0 = Math.floor((Math.min(s.ax, s.bx) - r) / CELL);
  const x1 = Math.floor((Math.max(s.ax, s.bx) + r) / CELL);
  const z0 = Math.floor((Math.min(s.az, s.bz) - r) / CELL);
  const z1 = Math.floor((Math.max(s.az, s.bz) + r) / CELL);
  for (let ix = x0; ix <= x1; ix += 1)
    for (let iz = z0; iz <= z1; iz += 1) {
      const k = key(ix, iz);
      (grid.get(k) ?? grid.set(k, []).get(k)).push(s);
    }
}
const d2seg = (x, z, s) => {
  const dx = s.bx - s.ax, dz = s.bz - s.az;
  const l2 = dx * dx + dz * dz;
  let t = l2 ? ((x - s.ax) * dx + (z - s.az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = s.ax + t * dx, pz = s.az + t * dz;
  return (x - px) * (x - px) + (z - pz) * (z - pz);
};
const indexed = (x, z, margin = 0) => {
  const m = Math.min(margin, MAX_MARGIN);
  const bucket = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!bucket) return null;
  const cR2 = (CANAL_HALF + m) ** 2;
  const mi = MOAT_INNER - 0.6 - m, mo = MOAT_OUTER + m;
  let moatMin2 = Infinity;
  for (const s of bucket) {
    const d2 = d2seg(x, z, s);
    if (s.kind === 0) { if (d2 < cR2) return CANAL_Y; }
    else if (s.kind === 1) { if (d2 < (s.half + m) ** 2) return SHANTANG_Y; }
    else if (d2 < moatMin2) moatMin2 = d2;
  }
  if (moatMin2 >= mi * mi && moatMin2 < mo * mo && !pointInRing(ring, x, z)) return MOAT_Y;
  return null;
};

/* ---- 逐点比对 ---- */
let total = 0, mismatch = 0;
const samples = [];
for (let x = -4400; x <= 4400; x += 20) {
  for (let z = -4400; z <= 4400; z += 20) {
    for (const margin of [0, 3, 4]) {
      total += 1;
      const a = naive(x, z, margin);
      const b = indexed(x, z, margin);
      if (a !== b) {
        mismatch += 1;
        if (samples.length < 8) samples.push({ x, z, margin, naive: a, indexed: b });
      }
    }
  }
}
console.log(`[水域场] 比对 ${total} 点（含 margin 0/3/4），不一致 ${mismatch}`);
if (samples.length) console.log(samples);

/* ---- 环内索引比对 ---- */
// 与 geo.ts 相同的分桶
const RING_BINS = 96;
let minZ = Infinity, maxZ = -Infinity;
for (const [, z] of ring) { if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
const binH = (maxZ - minZ) / RING_BINS;
const bins = Array.from({ length: RING_BINS }, () => []);
for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
  const zi = ring[i][1], zj = ring[j][1];
  if (zj === zi) continue;
  let b0 = Math.floor((Math.min(zi, zj) - minZ) / binH);
  let b1 = Math.floor((Math.max(zi, zj) - minZ) / binH);
  if (b0 < 0) b0 = 0;
  if (b1 > RING_BINS - 1) b1 = RING_BINS - 1;
  for (let b = b0; b <= b1; b += 1) bins[b].push(j);
}
const fastIn = (x, z) => {
  const bin = Math.floor((z - minZ) / binH);
  if (bin < 0 || bin >= RING_BINS) return false;
  let inside = false;
  for (const j of bins[bin]) {
    const i = j + 1 === ring.length ? 0 : j + 1;
    const [xj, zj] = ring[j];
    const [xi, zi] = ring[i];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};
let ptTotal = 0, ptBad = 0;
const ptSamples = [];
for (let x = -3000; x <= 3000; x += 10) {
  for (let z = -3000; z <= 3000; z += 10) {
    ptTotal += 1;
    const a = pointInRing(ring, x, z);
    const b = fastIn(x, z);
    if (a !== b) {
      ptBad += 1;
      if (ptSamples.length < 8) ptSamples.push({ x, z, brute: a, fast: b });
    }
  }
}
console.log(`[环内索引] 比对 ${ptTotal} 点，不一致 ${ptBad}`);
if (ptSamples.length) console.log(ptSamples);

/* ---- 数据门禁：索引等价性必须严格一致，否则桥位/路灯会错位 ---- */
gate('采样点数（防空数据假通过）', total, { min: 300000 });
gate('水域场索引不一致数', mismatch, { expect: 0 });
gate('环内索引不一致数', ptBad, { expect: 0 });
report('qa-waterfield');
