/**
 * 轨道交通数据处理：OSM subway/light_rail 线路关系 → 局部米制折线，
 * 站点节点单独输出。产出 public/data/transit.json
 * 用法: node scripts/build-transit.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ORIGIN = { lon: 120.621, lat: 31.311 };
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);
const toLocal = (lon, lat) => ({
  x: (lon - ORIGIN.lon) * M_PER_DEG_LON,
  z: -(lat - ORIGIN.lat) * M_PER_DEG_LAT,
});

const FALLBACK = ['#e4002b', '#00a3e0', '#f5a623', '#2e8b57', '#8e44ad', '#c0392b', '#16a085'];

/** 与道路一致：城外数据止于约 5.8km */
const WORLD_LIMIT = 5800;

/** 折线裁剪到 ±WORLD_LIMIT 方框（Liang–Barsky 逐段） */
function clipPolyline(points, limit) {
  const pieces = [];
  let current = [];
  const flush = () => {
    if (current.length > 1) pieces.push(current);
    current = [];
  };
  const clipSegment = (a, b) => {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const p = [-dx, dx, -dz, dz];
    const q = [a[0] + limit, limit - a[0], a[1] + limit, limit - a[1]];
    let t0 = 0;
    let t1 = 1;
    for (let i = 0; i < 4; i += 1) {
      if (p[i] === 0) {
        if (q[i] < 0) return null;
      } else {
        const r = q[i] / p[i];
        if (p[i] < 0) {
          if (r > t1) return null;
          if (r > t0) t0 = r;
        } else {
          if (r < t0) return null;
          if (r < t1) t1 = r;
        }
      }
    }
    return [t0, t1];
  };

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const hit = clipSegment(a, b);
    if (!hit) {
      flush();
      continue;
    }
    const [t0, t1] = hit;
    const s = t0 === 0 ? a : [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
    const e = t1 === 1 ? b : [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
    if (current.length === 0) {
      current = [s, e];
    } else {
      const tail = current[current.length - 1];
      if (Math.abs(tail[0] - s[0]) < 0.5 && Math.abs(tail[1] - s[1]) < 0.5) current.push(e);
      else {
        flush();
        current = [s, e];
      }
    }
  }
  flush();
  return pieces;
}

const text = await readFile(new URL('../data/raw/transit.json', import.meta.url), 'utf8');
const elements = JSON.parse(text).elements ?? [];

const lines = [];
const stations = [];
const seenStation = new Set();
const seenLine = new Set();
let colorIdx = 0;

for (const el of elements) {
  if (el.type === 'node' && el.tags?.railway === 'station') {
    const p = toLocal(el.lon, el.lat);
    if (Math.abs(p.x) > WORLD_LIMIT || Math.abs(p.z) > WORLD_LIMIT) continue;
    const key = `${Math.round(p.x / 10)},${Math.round(p.z / 10)}`;
    if (seenStation.has(key)) continue;
    seenStation.add(key);
    stations.push({
      x: Math.round(p.x),
      z: Math.round(p.z),
      name: el.tags.name ?? '',
    });
    continue;
  }
  if (el.type !== 'relation') continue;
  if (!el.tags?.route || !/^(subway|light_rail)$/.test(el.tags.route)) continue;

  const segments = [];
  for (const member of el.members ?? []) {
    if (member.type !== 'way' || !member.geometry || member.geometry.length < 2) continue;
    if (member.role && member.role !== 'track' && member.role !== '') continue;
    const line = member.geometry.map((p) => {
      const local = toLocal(p.lon, p.lat);
      return [Math.round(local.x), Math.round(local.z)];
    });
    // 城际方向的线位会伸出外环，按同一范围裁掉
    for (const piece of clipPolyline(line, WORLD_LIMIT)) segments.push(piece);
  }
  if (segments.length === 0) continue;

  // 上下行是两条独立关系，几何完全重合；按线路号只保留一条
  const key = el.tags.ref ?? el.tags.name ?? '';
  if (seenLine.has(key)) continue;
  seenLine.add(key);

  const color = (el.tags.colour ?? el.tags.color ?? '').trim() || FALLBACK[colorIdx % FALLBACK.length];
  colorIdx += 1;
  lines.push({
    ref: el.tags.ref ?? el.tags.name ?? '轨道线',
    name: el.tags.name ?? '',
    color: color.startsWith('#') ? color : `#${color}`,
    segments,
  });
}

await mkdir(new URL('../public/data/', import.meta.url), { recursive: true });
const outFile = new URL('../public/data/transit.json', import.meta.url);
await writeFile(outFile, JSON.stringify({ meta: { origin: ORIGIN, unit: 'meter' }, lines, stations }));
console.log(`[轨道] 线路 ${lines.length} 条 / 站点 ${stations.length} 个 → ${outFile.pathname}`);
