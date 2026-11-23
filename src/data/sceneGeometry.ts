import raw from './scene-geometry.json';
import type { LocalPoint2, SceneGeometry } from '../types';
import { lonLatToLocal } from '../utils/geo';
import { EXTRA_LANDMARKS } from './extraLandmarks';
import { HERITAGE_LANDMARKS } from './heritage';

/**
 * 场景几何唯一数据源（OSM 派生，局部米制坐标）。
 * 由 scripts/build-scene-data.mjs 生成，勿手工编辑。
 *
 * 这里只做一处运行期修正：城内河道不能伸进护城河。
 */

/** 与 WaterSystem 的 MOAT_INSET 一致：护城河内岸到城墙线的距离 */
const MOAT_INSET = 4.6;
/**
 * 河道出口的截断位置：护城河内岸再往河里 2m。
 * 留一点重叠是为了让水口真正接到护城河水面，不在岸边留一条缝；
 * 2m 的驳岸端头正好压在护城河内岸的驳岸带下面，看不出来。
 */
const MOAT_CUT = MOAT_INSET + 2;

const pointInRing = (ring: LocalPoint2[], x: number, z: number): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};

const distToSeg = (x: number, z: number, a: LocalPoint2, b: LocalPoint2): number => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
};

const distToRing = (ring: LocalPoint2[], x: number, z: number): number => {
  let best = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    best = Math.min(best, distToSeg(x, z, ring[i], ring[(i + 1) % ring.length]));
  }
  return best;
};

const cityRing = (raw as unknown as SceneGeometry).cityOutline;

/**
 * 是否已经"出了城墙、进了护城河"。
 * 城内河道本来就是靠城墙内的一圈水网，正常都在城内；
 * 只有盘门水门那一条会被 OSM 画成笔直穿出城外。
 */
const isIntoMoat = (p: LocalPoint2): boolean =>
  !pointInRing(cityRing, p[0], p[1]) && distToRing(cityRing, p[0], p[1]) > MOAT_CUT;

/**
 * 把折线尾部收回护城河内岸。
 *
 * 盘门水道在 OSM 里是从城里笔直画到 z≈2492 的，比城墙线（z≈2468）多出二十多米。
 * 直接渲染的后果：水面和两侧石驳岸一起插进护城河，尽头齐茬断在水中间，
 * 远看就像"一座桥横在河心"。这里沿折线二分找到护城河内岸，把多余那段切掉。
 */
function trimAtMoatInner(line: LocalPoint2[]): LocalPoint2[] {
  if (line.length < 2) return line;
  let cut = line.length - 1;
  while (cut > 0 && isIntoMoat(line[cut])) cut -= 1;
  // 尾部没出城，原样返回
  if (cut === line.length - 1) return line;

  const inside = line[cut];
  const outside = line[cut + 1];
  const at = (t: number): LocalPoint2 => [
    inside[0] + (outside[0] - inside[0]) * t,
    inside[1] + (outside[1] - inside[1]) * t,
  ];

  // 二分出越过护城河内岸的那一刻（inside 在城内、outside 已经在河里）
  let lo = 0;
  let hi = 1;
  for (let iter = 0; iter < 16; iter += 1) {
    const mid = (lo + hi) / 2;
    if (isIntoMoat(at(mid))) hi = mid;
    else lo = mid;
  }
  return [...line.slice(0, cut + 1), at(hi)];
}

const base = raw as unknown as SceneGeometry;

/* ---------------- 盘门水门水道：对齐程序化水门洞、末端收到城墙 ----------------
 * waterway#11 是 OSM 画的盘门水门水道（x=-776），从城里一路画到 z=2492，
 * 末端已经穿过城墙南墙戳进护城河。盘门程序化重建（Panmen.tsx）的水门洞
 * 中心约在世界 (-777, 2458.5)，所以把这条水道的 x 修正到 -777、末端收到
 * 城墙处，让它从水门洞正中穿过；城外交给护城河。
 * 下游 waterField / Trees / Transit 的水域判定都会跟着正确。
 */
const PANMEN_GATE_OSM_X = -776;
const PANMEN_GATE_X = -777;
const PANMEN_GATE_WALL_Z = 2458.5;

const trimPanmenGate = (line: LocalPoint2[]): LocalPoint2[] => {
  if (line.length !== 2) return line;
  const [a, b] = line;
  if (Math.abs(a[0] - PANMEN_GATE_OSM_X) > 4 || Math.abs(b[0] - PANMEN_GATE_OSM_X) > 4) return line;
  // 只收 z 超出城墙线的末端
  const maxZ = Math.max(a[1], b[1]);
  const minZ = Math.min(a[1], b[1]);
  const endZ = Math.min(maxZ, PANMEN_GATE_WALL_Z);
  return [
    [PANMEN_GATE_X, minZ],
    [PANMEN_GATE_X, endZ],
  ] as LocalPoint2[];
};

/* ---------------- 盘门景区内多余水道：填成陆地 ----------------
 * 盘门三景已由 Panmen.tsx 程序化重建（城墙+水陆城门+瑞光塔+吴门桥）。
 * 景区 polygon 范围内原有 OSM 的孤立短水道（如 waterway#3，x≈-691、
 * z≈2299~2340 的 40m 断头水沟），重建后与城门/护城河都对不上，属于
 * 多余水域。这里把它们剔除，让盘门景区恢复为城内陆地。
 */
const isPanmenInnerStrayWater = (line: LocalPoint2[]): boolean => {
  // 只处理盘门景区 outline 内的短水道（< 100m），且不是水门水道
  const xs = line.map((p) => p[0]);
  const zs = line.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const len = Math.hypot(maxX - minX, maxZ - minZ);
  const inPanmenPad =
    minX > -982 && maxX < -523 && minZ > 2052 && maxZ < 2392;
  return inPanmenPad && len < 100;
};

/* ---------------- 盘门景区轮廓：切掉伸向护城河的细长凸出 ----------------
 * OSM 里盘门景区的边界把吴门桥的引桥也圈了进去，于是轮廓在南侧拖出
 * 一条 18m 宽、60 多米长的指状凸起，末端直逼护城河内岸。
 * 石台一拉伸，斜视时就像"一段桥躺在河里"。这里把南边界压到 z≤2392；
 * 盘门三景（含吴门桥）现由 Panmen.tsx 程序化重建，景区石台已不再为盘门铺设
 * （见 Landmarks 的 NO_PAD_IDS），这里仅保留轮廓裁剪供后续复用。
 */
const PANMEN_PAD_SOUTH_LIMIT = 2392;

const trimPanmenPad = (ring: LocalPoint2[]): LocalPoint2[] =>
  ring.map(([x, z]) => [x, Math.min(z, PANMEN_PAD_SOUTH_LIMIT)] as LocalPoint2);

/* ---------------- 城外补建地标：注入质心与占地轮廓 ----------------
 * 侧栏列表、镜头聚焦、标签、建筑剔除都读 sceneGeometry.landmarks[id]，
 * 所以补建的地标也要在这里登记，否则点了菜单镜头不会动。
 */
const padRing = (radius: number, sides = 12): LocalPoint2[] =>
  Array.from({ length: sides }, (_, i) => {
    const a = (i / sides) * Math.PI * 2;
    return [Math.cos(a) * radius, Math.sin(a) * radius] as LocalPoint2;
  });

const extraLandmarks: Record<string, { centroid: { x: number; z: number }; outline: LocalPoint2[] }> = {};
for (const item of EXTRA_LANDMARKS) {
  const local = item.at
    ? { x: item.at[0], z: item.at[1] }
    : lonLatToLocal(item.lon, item.lat);
  const radius = item.padRadius > 0 ? item.padRadius : 14;
  extraLandmarks[item.id] = {
    centroid: local,
    outline: padRing(radius).map(([x, z]) => [x + local.x, z + local.z] as LocalPoint2),
  };
}

/* ---------------- 城内文保单位（国保/省保）：注入质心与占地轮廓 ----------------
 * 与城外补建地标同理：侧栏、聚焦、标签、建筑剔除都读 sceneGeometry.landmarks[id]，
 * 文保单位也要在这里登记才能被检索与聚焦。按类别给不同占地半径。
 */
const heritageLandmarks: Record<string, { centroid: { x: number; z: number }; outline: LocalPoint2[] }> = {};
for (const item of HERITAGE_LANDMARKS) {
  const local = lonLatToLocal(item.lon, item.lat);
  const radius =
    item.kind === 'garden' || item.kind === 'temple' || item.kind === 'school' ? 24
      : item.kind === 'mansion' ? 20
        : 12;
  heritageLandmarks[item.id] = {
    centroid: local,
    outline: padRing(radius).map(([x, z]) => [x + local.x, z + local.z] as LocalPoint2),
  };
}

const baseLandmarks = base.landmarks as Record<string, SceneGeometry['landmarks'][string]>;

/* ---------------- 城外河道（山塘河）避让山体 ----------------
 * 山塘河从阊门通到虎丘，终点是虎丘山脚。但 OSM 的河道折线一路画进了
 * 虎丘山体（艺术化放大后 radius=430m），前 10 个点都在山里，远看就是
 * "河流到山中断了"。这里把穿进虎丘山体的一段切掉，让河道止于山脚。
 */
const HILLS_FOR_WATER: Array<{ x: number; z: number; rx: number; rz: number; rot: number }> = [
  { x: -4612, z: -2983, rx: 430 * 0.95, rz: 430 * 0.7, rot: -0.25 }, // 虎丘
  { x: -5136, z: 668, rx: 760 * 1.0, rz: 760 * 0.52, rot: 0.16 }, // 狮子山
];

const inAnyHill = (x: number, z: number): boolean => {
  for (const h of HILLS_FOR_WATER) {
    const dx = x - h.x;
    const dz = z - h.z;
    const c = Math.cos(-h.rot);
    const s = Math.sin(-h.rot);
    const u = dx * c - dz * s;
    const v = dx * s + dz * c;
    if ((u * u) / (h.rx * h.rx) + (v * v) / (h.rz * h.rz) < 1) return true;
  }
  return false;
};

/** 把穿进山体的折线段切掉，只保留山体外部分（多个连续片段时保留最长者） */
function trimOuterAtHills(line: LocalPoint2[]): LocalPoint2[] {
  const segments: LocalPoint2[][] = [];
  let cur: LocalPoint2[] = [];
  for (const p of line) {
    if (inAnyHill(p[0], p[1])) {
      if (cur.length >= 2) segments.push(cur);
      cur = [];
    } else {
      cur.push(p);
    }
  }
  if (cur.length >= 2) segments.push(cur);
  if (segments.length === 0) return [];
  // 保留最长的一段（山塘河主体在古城方向）
  segments.sort((a, b) => b.length - a.length);
  return segments[0];
}

/* ---------------- 平江河已并入静态数据 ----------------
 * 平江路精细模型内河与城市河道网的衔接（对齐中心线、南接干将河、北接临顿河）
 * 由 scripts/build-scene-data.mjs 直接写进 scene-geometry.json 的 waterways：
 * 这样 build-buildings 能按同一条折线剔除沿河民居，水面、驳岸、桥位、水域判定
 * 全部共用一份数据，运行期不再手工补线（避免出现两条互不对齐的平江河）。
 */

export const sceneGeometry: SceneGeometry = {
  ...base,
  waterways: [
    ...base.waterways
      .map(trimAtMoatInner)
      .map(trimPanmenGate)
      .filter((l) => !isPanmenInnerStrayWater(l)),
  ],
  // 上塘河（阊门—枫桥）已并入 scene-geometry.json 的 outerWaterways，
  // 不再在运行期手写：路网避让、桥位与水面渲染必须读同一条折线。
  outerWaterways: (base.outerWaterways ?? [])
    .map(trimOuterAtHills)
    .filter((l) => l.length >= 2),
  landmarks: {
    ...baseLandmarks,
    ...(baseLandmarks.panmen
      ? {
          panmen: {
            ...baseLandmarks.panmen,
            outline: trimPanmenPad(baseLandmarks.panmen.outline ?? []),
            /**
             * 盘门三景（水陆城门 + 瑞光塔 + 吴门桥）由 Panmen.tsx 程序化按真实
             * 尺寸重建，锚点在城墙南墙的盘门城门 (-780, 2467.8)。景区 polygon
             * 的质心 (-789, 2268.5) 落在城内园林里，会误导侧栏聚焦与标签定位，
             * 这里把质心覆盖到城门位置，聚焦/标签/模型锚点三者一致。
             */
            centroid: { x: -780, z: 2467.8 },
          },
        }
      : {}),
    ...extraLandmarks,
    ...heritageLandmarks,
  },
};
