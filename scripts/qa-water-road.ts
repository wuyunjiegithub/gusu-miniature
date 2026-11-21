/**
 * 路 × 水 自洽门禁：
 *   1. 道路不允许"泡在水里"长距离并行（> 60m 且没有桥覆盖）——
 *      这是"河被路面压断、河从马路下面穿过"的根源；
 *   2. 允许的只有两类：桥位（整段被某座桥的桥面覆盖）与跨河短段。
 *
 * 与运行期保持一致：水面判定走 waterField，桥位走 bridges.computeBridgeSites。
 * 用法: npx vite-node scripts/qa-water-road.ts
 */
import { readFileSync } from 'node:fs';
import { waterLevelAt } from '../src/utils/waterField';
import { computeBridgeSites } from '../src/utils/bridges';

type P = [number, number];

const roads = JSON.parse(readFileSync('public/data/roads.json', 'utf8')) as {
  major: P[][];
  minor: P[][];
};
const sites = computeBridgeSites(roads);

/** 该点是否被某座桥的桥面覆盖（桥梁局部坐标：u 沿桥轴、v 横向） */
const coveredByBridge = (x: number, z: number): boolean => {
  for (const site of sites) {
    const dx = x - site.x;
    const dz = z - site.z;
    const cos = Math.cos(site.angle);
    const sin = Math.sin(site.angle);
    const u = dx * cos + dz * sin;
    const v = -dx * sin + dz * cos;
    if (Math.abs(u) <= site.deckHalf + 1.5 && Math.abs(v) <= site.halfWidth + 1) return true;
  }
  return false;
};

interface Run {
  kind: string;
  line: number;
  /** 沿路长度 */
  length: number;
  /** 弦长（起终点直线距离） */
  chord: number;
  head: P;
  tail: P;
  covered: boolean;
}

const runs: Run[] = [];
const STEP = 4;
const MIN_RUN = 60;

for (const kind of ['major', 'minor'] as const) {
  roads[kind].forEach((line, li) => {
    const samples: Array<{ x: number; z: number; wet: boolean }> = [];
    for (let i = 0; i < line.length - 1; i += 1) {
      const a = line[i];
      const b = line[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(len / STEP));
      for (let s = 0; s < steps; s += 1) {
        const t = s / steps;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[1] + (b[1] - a[1]) * t;
        samples.push({ x, z, wet: waterLevelAt(x, z) !== null });
      }
    }
    const last = line[line.length - 1];
    samples.push({ x: last[0], z: last[1], wet: waterLevelAt(last[0], last[1]) !== null });

    let i = 0;
    while (i < samples.length) {
      if (!samples[i].wet) {
        i += 1;
        continue;
      }
      let j = i;
      while (j + 1 < samples.length && samples[j + 1].wet) j += 1;
      let length = 0;
      for (let k = i; k < j; k += 1) {
        length += Math.hypot(samples[k + 1].x - samples[k].x, samples[k + 1].z - samples[k].z);
      }
      if (length > MIN_RUN) {
        const head: P = [samples[i].x, samples[i].z];
        const tail: P = [samples[j].x, samples[j].z];
        // 桥面覆盖判定用段内三点（跨中 + 两端各 1/4 处）：
        // 桥轴由水面段起终点决定，与道路走向可能差几度，只看中点容易误判
        const pick = (t: number) => samples[Math.round(i + (j - i) * t)];
        runs.push({
          kind,
          line: li,
          length,
          chord: Math.hypot(tail[0] - head[0], tail[1] - head[1]),
          head,
          tail,
          covered: [0.25, 0.5, 0.75].some((t) => {
            const p = pick(t);
            return coveredByBridge(p.x, p.z);
          }),
        });
      }
      i = j + 1;
    }
  });
}

const bad = runs.filter((run) => !run.covered);
const sorted = [...runs].sort((a, b) => b.length - a.length);

console.log(`桥 ${sites.length} 座；水中长段 ${runs.length} 处（>${MIN_RUN}m）`);
for (const run of sorted.slice(0, 6)) {
  console.log(
    `  ${run.kind}[${run.line}] 沿路 ${run.length.toFixed(0)}m 弦长 ${run.chord.toFixed(0)}m ` +
      `@(${run.head[0].toFixed(0)},${run.head[1].toFixed(0)})→(${run.tail[0].toFixed(0)},${run.tail[1].toFixed(0)}) ` +
      `${run.covered ? '桥面覆盖' : '无桥 ✗'}`,
  );
}

if (bad.length) {
  for (const run of bad) {
    console.error(
      `  ✗ ${run.kind}[${run.line}] 沿路 ${run.length.toFixed(0)}m ` +
        `@(${run.head[0].toFixed(0)},${run.head[1].toFixed(0)})→(${run.tail[0].toFixed(0)},${run.tail[1].toFixed(0)})`,
    );
  }
  console.error(`[qa-water-road] FAIL：${bad.length} 处道路泡在水里且没有桥`);
  process.exit(1);
}
console.log('[qa-water-road] PASS：所有水中长段都有桥面覆盖');
