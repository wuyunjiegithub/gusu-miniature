import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { arcBetween, splitClosedLine } from '../src/utils/wall';

const ring = (
  JSON.parse(fs.readFileSync('src/data/scene-geometry.json', 'utf8')) as {
    cityOutline: [number, number][];
  }
).cityOutline;

const cum = (() => {
  const out = [0];
  for (let i = 1; i <= ring.length; i += 1) {
    const a = ring[i - 1];
    const b = ring[i % ring.length];
    out.push(out[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return out;
})();
const total = cum[cum.length - 1];
const pointAt = (s: number): [number, number] => {
  let i = 0;
  while (i < ring.length - 1 && cum[i + 1] < s) i += 1;
  const f = (s - cum[i]) / (cum[i + 1] - cum[i] || 1);
  const a = ring[i];
  const b = ring[(i + 1) % ring.length];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
};

/** 盘门留口：与 CityWall / Panmen 共用同一里程 */
const PANMEN_S = 2757.3;
const PANMEN_HALF = 165;

describe('arcBetween（盘门城墙段取线）', () => {
  it('端点落在留口里程上，与城墙留口两端重合', () => {
    const line = arcBetween(ring, PANMEN_S - PANMEN_HALF, PANMEN_S + PANMEN_HALF);
    const [ax, az] = line[0];
    const [bx, bz] = line[line.length - 1];
    const [wx, wz] = pointAt(PANMEN_S - PANMEN_HALF);
    const [ex, ez] = pointAt(PANMEN_S + PANMEN_HALF);
    expect(Math.hypot(ax - wx, az - wz)).toBeLessThan(0.01);
    expect(Math.hypot(bx - ex, bz - ez)).toBeLessThan(0.01);
  });

  it('折线长度等于留口弧长（不是弦长）', () => {
    const line = arcBetween(ring, PANMEN_S - PANMEN_HALF, PANMEN_S + PANMEN_HALF);
    let len = 0;
    for (let i = 0; i < line.length - 1; i += 1) {
      len += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
    }
    // 之前用直墙近似，长度只有弦长（≈325m），与弧长差 20m 以上，两端各缺一段
    expect(len).toBeGreaterThan(2 * PANMEN_HALF - 1);
    expect(len).toBeLessThan(2 * PANMEN_HALF + 1);
  });

  it('沿轮廓逐点跟随，中段贴合轮廓而非切角', () => {
    const line = arcBetween(ring, PANMEN_S - PANMEN_HALF, PANMEN_S + PANMEN_HALF);
    // 折线每个顶点都必须落在轮廓上（切角的直线会在折角处离开轮廓十几米）
    for (const [x, z] of line) {
      let best = Infinity;
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
        best = Math.min(best, Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz)));
      }
      expect(best).toBeLessThan(0.05);
    }
  });

  it('程序化城墙留口 + 盘门段共同覆盖整圈城墙，不留缺口', () => {
    // 其余城门留 23m，盘门留 165m（由 Panmen 段填补）
    const gates: Array<{ s: number; half: number; name: string }> = [
      { s: 2757.3, half: PANMEN_HALF, name: '盘门' },
    ];
    // 只验证盘门附近 600m 范围：留口两侧的城墙必须紧贴留口端点
    const runs = splitClosedLine(ring, [[PANMEN_S - PANMEN_HALF, PANMEN_S + PANMEN_HALF]]);
    const covered = new Set<number>();
    for (const run of runs) {
      for (let i = 0; i < run.length - 1; i += 1) {
        const a = run[i];
        const b = run[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const steps = Math.max(1, Math.round(len));
        for (let k = 0; k <= steps; k += 1) {
          const x = a[0] + ((b[0] - a[0]) * k) / steps;
          const z = a[1] + ((b[1] - a[1]) * k) / steps;
          covered.add(Math.round((Math.atan2(z, x) * 180) / Math.PI));
        }
      }
    }
    const panmen = arcBetween(ring, PANMEN_S - PANMEN_HALF, PANMEN_S + PANMEN_HALF);
    expect(panmen.length).toBeGreaterThan(1);
    expect(gates[0].name).toBe('盘门');

    // 留口两端点必须被两侧城墙段包含（不是只差 1m 也算连上，要真的到端点）
    for (const s of [PANMEN_S - PANMEN_HALF, PANMEN_S + PANMEN_HALF]) {
      const [px, pz] = pointAt(s);
      const touched = runs.some((run) =>
        run.some(([x, z]) => Math.hypot(x - px, z - pz) < 0.05),
      );
      expect(touched, `s=${s}`).toBe(true);
    }
    expect(total).toBeGreaterThan(2000);
  });
});
