import { sceneGeometry } from './sceneGeometry';
import { lonLatToVector3 } from '../utils/geo';

/** 城门性质：真遗存 / 原址复建，用于标签配色区分 */
export type GateKind = 'relic' | 'rebuilt';

export interface CityGate {
  name: string;
  kind: GateKind;
  /** 墙面定位点（场景坐标） */
  x: number;
  z: number;
  /** 沿墙方向单位向量 */
  tangent: [number, number];
  /** 沿轮廓累计里程（米） */
  sAlong: number;
}

/**
 * 苏州古城九座城门：
 * - 真遗存：盘门（水陆城门）、胥门、金门
 * - 原址复建：阊门、相门（匠门）、娄门、葑门、齐门、平门
 * 坐标取原址近似经纬度，再投影到城墙轮廓上，保证城门落在墙上并沿墙走向。
 */
const TARGETS: { name: string; lon: number; lat: number; kind: GateKind }[] = [
  { name: '阊门', lon: 120.6013986, lat: 31.3173146, kind: 'rebuilt' },
  { name: '胥门', lon: 120.6083156, lat: 31.2994969, kind: 'relic' },
  { name: '金门', lon: 120.6012, lat: 31.3053, kind: 'relic' },
  { name: '平门', lon: 120.6074628, lat: 31.3287192, kind: 'rebuilt' },
  { name: '齐门', lon: 120.6216, lat: 31.332, kind: 'rebuilt' },
  { name: '娄门', lon: 120.6428, lat: 31.3235, kind: 'rebuilt' },
  { name: '相门', lon: 120.6435, lat: 31.312, kind: 'rebuilt' },
  { name: '葑门', lon: 120.6363, lat: 31.2962, kind: 'rebuilt' },
  { name: '盘门', lon: 120.6047, lat: 31.2912, kind: 'relic' },
];

/** 城台沿墙半宽（两侧墙段在此留口） */
export const GATE_HALF_WIDTH = 23;

const ring = sceneGeometry.cityOutline;

/** 把真实坐标投影到城墙轮廓上，得到定位点、切向与里程 */
function resolve(): CityGate[] {
  const cum: number[] = [0];
  for (let i = 1; i <= ring.length; i += 1) {
    const a = ring[i - 1];
    const b = ring[i % ring.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }

  return TARGETS.map((target) => {
    const v = lonLatToVector3(target.lon, target.lat, 0);
    let best = { d: Infinity, x: 0, z: 0, tx: 1, tz: 0, s: 0 };
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len2 = dx * dx + dz * dz;
      let t = len2 > 0 ? ((v.x - a[0]) * dx + (v.z - a[1]) * dz) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = a[0] + dx * t;
      const pz = a[1] + dz * t;
      const d = Math.hypot(v.x - px, v.z - pz);
      if (d < best.d) {
        const len = Math.sqrt(len2) || 1;
        best = { d, x: px, z: pz, tx: dx / len, tz: dz / len, s: cum[i] + len * t };
      }
    }
    return {
      name: target.name,
      kind: target.kind,
      x: best.x,
      z: best.z,
      tangent: [best.tx, best.tz] as [number, number],
      sAlong: best.s,
    };
  });
}

export const CITY_GATES: CityGate[] = resolve();
