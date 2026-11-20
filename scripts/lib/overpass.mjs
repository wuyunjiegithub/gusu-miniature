/**
 * Overpass API 客户端与几何组装工具
 * 纪律：按分块/小范围查询，不整城拉取（开发流程 阶段2）
 */

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const USER_AGENT = 'gusu-miniature/0.1 (data pipeline; contact: local-dev)';

/** 古城 bbox（含外扩缓冲） */
export const BBOX = '31.270,120.580,31.352,120.662'; // south,west,north,east

export async function overpassQuery(query, { retries = 3, timeoutMs = 120_000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
          },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          console.warn(`[overpass] ${endpoint} -> HTTP ${res.status}`);
          continue;
        }
        const json = await res.json();
        console.log(`[overpass] ${endpoint} OK, ${json.elements?.length ?? 0} elements`);
        return json;
      } catch (err) {
        console.warn(`[overpass] ${endpoint} failed: ${err.message}`);
      }
    }
    if (attempt < retries) {
      const wait = attempt * 10_000;
      console.warn(`[overpass] retry ${attempt}/${retries - 1} after ${wait / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw new Error('All Overpass endpoints failed');
}

const samePoint = (a, b) => a.lat === b.lat && a.lon === b.lon;
const isClosed = (nodes) => nodes.length > 3 && samePoint(nodes[0], nodes[nodes.length - 1]);

/**
 * 将 multipolygon relation 的 outer member 组装成闭合环
 * （Overpass out geom 下共享节点坐标完全一致，可直接端点匹配）
 */
export function assembleRings(members) {
  const outers = members.filter((m) => m.type === 'way' && m.role === 'outer' && m.geometry);
  const remaining = [...outers];
  const rings = [];
  let current = null;

  while (remaining.length > 0) {
    if (!current) {
      current = [...remaining.shift().geometry];
      continue;
    }
    const tail = current[current.length - 1];
    const idx = remaining.findIndex((m) => {
      const g = m.geometry;
      return samePoint(g[0], tail) || samePoint(g[g.length - 1], tail);
    });
    if (idx === -1) {
      if (isClosed(current)) rings.push(current);
      current = null;
      continue;
    }
    const [seg] = remaining.splice(idx, 1);
    const g = seg.geometry;
    if (samePoint(g[0], tail)) current.push(...g.slice(1));
    else current.push(...g.slice(0, -1).reverse());
  }
  if (current && isClosed(current)) rings.push(current);
  return rings;
}

/** 球面近似多边形面积（m²），用于挑选最大闭合环 */
export function ringAreaM2(ring) {
  const R = 6371000;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    const x1 = (a.lon * Math.PI / 180) * Math.cos(a.lat * Math.PI / 180) * R;
    const y1 = (a.lat * Math.PI / 180) * R;
    const x2 = (b.lon * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * R;
    const y2 = (b.lat * Math.PI / 180) * R;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2);
}

/** 射线法判断点是否在环内 */
export function ringContains(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i].lon;
    const yi = ring[i].lat;
    const xj = ring[j].lon;
    const yj = ring[j].lat;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function ringCentroid(ring) {
  let lon = 0;
  let lat = 0;
  const n = ring.length - 1; // 闭合环末点=首点
  for (let i = 0; i < n; i += 1) {
    lon += ring[i].lon;
    lat += ring[i].lat;
  }
  return { lon: lon / n, lat: lat / n };
}
