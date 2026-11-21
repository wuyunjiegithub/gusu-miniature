import { useMemo } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HERITAGE_LANDMARKS, type HeritageKind } from '../data/heritage';
import {
  getHeritageModelSpec,
  idSeed,
  makeRng,
  type HeritageModelSpec,
} from '../data/heritageModels';
import { sceneGeometry } from '../data/sceneGeometry';
import { useSandTable } from '../store/useSandTable';
import { SEASON_LOOKS } from '../constants/seasons';
import { createHipRoofGeometry } from '../utils/roof';
import { HERITAGE_FOOTPRINTS } from '../data/heritageFootprints';

/**
 * 古城内国保 / 省保文保单位（31 处）的程序化精细建模。
 *
 * 不再是"每类一个 box"的占位体块：按每处的建筑原型（园林 / 殿宇 / 宅第 /
 * 砖塔 / 城门 / 石峰 / 近代学堂）生成有辨识度的构件——粉墙黛瓦厅堂、攒尖亭、
 * 游廊、太湖石假山、水面岛屿、重檐屋面、牌坊、戏台、须弥座塔、钟楼等，
 * 达到已建景点（拙政园等 GLB）的读图层级。
 *
 * 所有几何按材质分桶全局合并（十几个 draw call），四季通过材质换色；
 * 朝向 / 随机种子由 id 派生，同类文保彼此不雷同。无 Blender 依赖、可复现。
 */

type MatKey =
  | 'base'
  | 'lawn'
  | 'plaster'
  | 'templeWall'
  | 'brick'
  | 'wood'
  | 'tile'
  | 'stone'
  | 'water'
  | 'rock'
  | 'dark'
  | 'trunk'
  | 'crownA'
  | 'crownB';

type Buckets = Partial<Record<MatKey, THREE.BufferGeometry[]>>;

/** 每处文保的青石台面顶标高（建筑构件自此向上生长） */
const BASE_TOP = 1.2;

/**
 * 构件构造器：把局部坐标（原点 = 文保质心，+y 向上）的几何施加朝向与平移后
 * 投进全局材质桶。统一转为非索引并去掉 uv，保证跨图元（Box/Cylinder/屋顶）
 * 能安全合并。
 */
class Builder {
  private readonly c: number;
  private readonly s: number;

  constructor(
    private readonly buckets: Buckets,
    private readonly cx: number,
    private readonly cz: number,
    private readonly rot: number,
  ) {
    this.c = Math.cos(rot);
    this.s = Math.sin(rot);
  }

  add(key: MatKey, source: THREE.BufferGeometry, lx: number, ly: number, lz: number, localRot = 0) {
    // Box/Cylinder 带索引与 uv，屋顶几何是非索引无 uv；统一到非索引 + position/normal
    let geo = source;
    if (geo.index) {
      const flat = geo.toNonIndexed();
      geo.dispose();
      geo = flat;
    }
    geo.deleteAttribute('uv');
    geo.deleteAttribute('uv1');
    geo.deleteAttribute('uv2');
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();

    if (localRot) geo.rotateY(localRot);
    if (this.rot) geo.rotateY(this.rot);
    // 与 three.js rotateY 一致：局部 (lx,lz) → (lx*c+lz*s, -lx*s+lz*c)
    const wx = this.cx + lx * this.c + lz * this.s;
    const wz = this.cz - lx * this.s + lz * this.c;
    geo.translate(wx, ly, wz);
    (this.buckets[key] ??= []).push(geo);
  }

  /** 长方体，y 为底面标高 */
  box(key: MatKey, w: number, h: number, d: number, x: number, y: number, z: number, localRot = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, h / 2, 0);
    this.add(key, g, x, y, z, localRot);
  }

  /** 正多棱柱 / 锥台，y 为底面标高 */
  prism(
    key: MatKey,
    rTop: number,
    rBottom: number,
    h: number,
    sides: number,
    x: number,
    y: number,
    z: number,
    phase = 0,
  ) {
    const g = new THREE.CylinderGeometry(rTop, rBottom, h, sides, 1, false, phase);
    g.translate(0, h / 2, 0);
    this.add(key, g, x, y, z);
  }

  /** 庑殿 / 歇山屋面（屋脊沿 X 方向），y 为檐口标高 */
  roof(key: MatKey, w: number, d: number, h: number, x: number, y: number, z: number, localRot = 0) {
    const g = createHipRoofGeometry(w, d, h);
    this.add(key, g, x, y, z, localRot);
  }

  /** 扁圆盘（水面 / 绿地 / 台基），y 为底面标高 */
  disc(key: MatKey, r: number, thickness: number, x: number, y: number, z: number, seg = 16, flat = 1) {
    const g = new THREE.CylinderGeometry(r, r, thickness, seg);
    g.scale(1, 1, flat);
    g.translate(0, thickness / 2, 0);
    this.add(key, g, x, y, z);
  }
}

/** 台基 + 绿地：所有原型共用 */
function basePlatform(b: Builder, r: number) {
  b.disc('base', r, BASE_TOP, 0, 0, 0, 12);
}

/** 厅堂：石阶 + 墙身（粉墙/赭红/青砖）+ 木裙板/窗带 + 瓦顶（可重檐） */
function hall(
  b: Builder,
  x: number,
  z: number,
  w: number,
  d: number,
  h: number,
  o: { wall?: MatKey; doubleEave?: boolean; brickHall?: boolean; western?: boolean; rot?: number } = {},
) {
  const wall: MatKey = o.wall ?? 'plaster';
  const rot = o.rot ?? 0;
  b.box('stone', w + 1.4, 0.5, d + 1.4, x, BASE_TOP, z, rot);
  b.box(wall, w, h, d, x, BASE_TOP + 0.5, z, rot);
  if (o.western) {
    // 西式校舍 / 里弄：石砌腰线 + 成排窗洞（深色带）
    b.box('stone', w + 0.3, 0.35, d + 0.3, x, BASE_TOP + 0.5 + h * 0.52, z, rot);
    b.box('dark', w * 0.86, h * 0.34, d + 0.18, x, BASE_TOP + 0.5 + h * 0.2, z, rot);
  } else if (!o.brickHall) {
    // 木裙板 + 檐下额枋
    b.box('wood', w * 0.94, 0.95, d + 0.12, x, BASE_TOP + 0.5, z, rot);
    b.box('wood', w + 0.2, 0.3, d + 0.3, x, BASE_TOP + 0.5 + h - 0.45, z, rot);
  }
  const y0 = BASE_TOP + 0.5 + h;
  if (o.brickHall) {
    // 无梁殿：砖砌叠涩顶，不用木构瓦屋面
    b.box('dark', w + 0.6, 0.7, d + 0.6, x, y0, z, rot);
    b.box('dark', w * 0.86, 0.6, d * 0.82, x, y0 + 0.7, z, rot);
  } else {
    const rh = Math.min(3.0, 0.42 * h + 0.9);
    b.roof('tile', w + 2.2, d + 2.2, rh, x, y0, z, rot);
    // 正脊压顶
    b.box('dark', w * 0.9, 0.28, 0.5, x, y0 + rh - 0.1, z, rot);
    if (o.doubleEave) {
      b.roof('tile', w * 0.62, d * 0.66, rh * 0.78, x, y0 + rh + 0.5, z, rot);
      b.box('dark', w * 0.5, 0.24, 0.42, x, y0 + rh + 0.5 + rh * 0.78 - 0.08, z, rot);
    }
  }
}

/** 攒尖亭：石座 + 亭身 + 攒尖瓦顶 + 宝顶 */
function pavilion(b: Builder, x: number, z: number, r: number, h: number) {
  b.prism('stone', r * 1.12, r * 1.18, 0.45, 8, x, BASE_TOP, z);
  b.prism('wood', r * 0.82, r * 0.9, h, 6, x, BASE_TOP + 0.45, z, Math.PI / 6);
  b.prism('tile', 0.18, r * 1.5, h * 0.52, 6, x, BASE_TOP + 0.45 + h - 0.25, z, Math.PI / 6);
  b.prism('dark', 0.12, 0.34, 0.9, 6, x, BASE_TOP + 0.45 + h + h * 0.52 - 0.25, z);
}

/** 游廊：矮墙 + 两坡顶 */
function corridor(
  b: Builder,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  width = 2.2,
) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 3) return;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const rot = -Math.atan2(dz, dx);
  b.box('plaster', len, 1.0, width * 0.55, cx, BASE_TOP, cz, rot);
  b.roof('tile', len + 1.2, width + 1.4, 1.15, cx, BASE_TOP + 1.0, cz, rot);
}

/** 太湖石假山：不规则多棱柱堆叠，带瘦漏透的错落轮廓 */
function rockery(b: Builder, cx: number, cz: number, spread: number, count: number, rng: () => number) {
  for (let i = 0; i < count; i += 1) {
    const a = rng() * Math.PI * 2;
    const dist = rng() * spread;
    const x = cx + Math.cos(a) * dist;
    const z = cz + Math.sin(a) * dist * 0.8;
    const r = 1.3 + rng() * 2.4;
    const h = 2.0 + rng() * 4.2;
    const sides = 5 + Math.floor(rng() * 3);
    b.prism('rock', r * 0.62, r, h, sides, x, BASE_TOP, z, rng() * Math.PI);
    if (rng() > 0.45) {
      b.prism('rock', r * 0.3, r * 0.55, h * 0.5, sides, x + 0.4, BASE_TOP + h, z - 0.3, rng() * Math.PI);
    }
  }
}

/** 水池：石岸 + 水面（+ 小岛） */
function pond(b: Builder, x: number, z: number, rx: number, rz: number, rng: () => number) {
  b.disc('stone', rx + 1.1, 0.22, x, BASE_TOP, z, 20, rz / rx);
  b.disc('water', rx, 0.12, x, BASE_TOP + 0.16, z, 20, rz / rx);
  if (rng() > 0.35) {
    const ix = x + (rng() - 0.5) * rx * 0.7;
    const iz = z + (rng() - 0.5) * rz * 0.7;
    b.disc('rock', rx * 0.18, 0.3, ix, BASE_TOP + 0.2, iz, 9, 0.85);
    if (rng() > 0.5) b.prism('rock', rx * 0.06, rx * 0.12, 1.8, 6, ix, BASE_TOP + 0.5, iz);
  }
}

/** 点景树：树干 + 双层树冠（按随机分到两个色桶） */
function trees(b: Builder, spots: Array<[number, number, number]>, rng: () => number) {
  for (const [x, z, h] of spots) {
    b.prism('trunk', 0.24, 0.42, h * 0.46, 5, x, BASE_TOP, z);
    const crown: MatKey = rng() > 0.5 ? 'crownA' : 'crownB';
    b.prism(crown, h * 0.1, h * 0.24, h * 0.42, 7, x, BASE_TOP + h * 0.34, z, rng() * 0.5);
    b.prism(crown, h * 0.05, h * 0.17, h * 0.34, 7, x, BASE_TOP + h * 0.6, z, rng() * 0.5);
  }
}

/** 在矩形占地内散布树位，避开已有的建筑/水面中心 */
function scatterTrees(
  r: number,
  count: number,
  rng: () => number,
  avoid: Array<[number, number, number]> = [],
): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  let attempts = 0;
  while (out.length < count && attempts < count * 40) {
    attempts += 1;
    const x = (rng() * 2 - 1) * r * 0.86;
    const z = (rng() * 2 - 1) * r * 0.86;
    if (x * x + z * z > r * r * 0.78) continue;
    if (avoid.some(([ax, az, ar]) => (x - ax) ** 2 + (z - az) ** 2 < ar * ar)) continue;
    out.push([x, z, 4.2 + rng() * 2.8]);
  }
  return out;
}

/* ---------------- 建筑原型 ---------------- */

function buildGarden(b: Builder, spec: HeritageModelSpec, rng: () => number) {
  const r = spec.radius ?? 22;
  basePlatform(b, r);
  b.disc('lawn', r * 0.93, 0.12, 0, BASE_TOP, 0, 16);

  // 园墙：环墙 + 瓦顶压顶，留一处洞门
  const gateAt = Math.floor(rng() * 12);
  for (let i = 0; i < 12; i += 1) {
    if (i === gateAt) continue;
    const a = (i / 12) * Math.PI * 2;
    const wx = Math.cos(a) * r * 0.93;
    const wz = Math.sin(a) * r * 0.93;
    b.box('plaster', r * 0.5, 3.0, 0.55, wx, BASE_TOP, wz, -a + Math.PI / 2);
    b.box('tile', r * 0.52, 0.32, 0.9, wx, BASE_TOP + 3.0, wz, -a + Math.PI / 2);
  }

  const avoid: Array<[number, number, number]> = [];
  // 主厅（坐北，即 -z 侧）与若干厅堂
  const hallCount = spec.halls ?? 2;
  for (let i = 0; i < hallCount; i += 1) {
    const a = -Math.PI / 2 + (i - (hallCount - 1) / 2) * 0.9;
    const hx = Math.cos(a) * r * 0.52;
    const hz = Math.sin(a) * r * 0.52;
    hall(b, hx, hz, 11 - i, 7, 5.2, {
      wall: spec.western && i === 0 ? 'brick' : 'plaster',
      western: spec.western && i === 0,
    });
    avoid.push([hx, hz, 7]);
  }

  // 水池（中园主景）
  if (spec.pond !== false) {
    const pr = r * 0.4;
    pond(b, r * 0.05, r * 0.1, pr, pr * 0.78, rng);
    avoid.push([r * 0.05, r * 0.1, pr + 2]);
  }

  // 假山（环秀山庄 / 五峰园以假山为主景）
  if (spec.rockery) {
    const spread = spec.rockery === 2 ? r * 0.34 : r * 0.2;
    rockery(b, -r * 0.42, r * 0.22, spread, spec.rockery === 2 ? 12 : 6, rng);
    avoid.push([-r * 0.42, r * 0.22, spread + 3]);
  }

  // 攒尖亭
  const pavCount = spec.pavilions ?? 2;
  for (let i = 0; i < pavCount; i += 1) {
    const a = (i / Math.max(1, pavCount)) * Math.PI * 2 + 0.6;
    const px = Math.cos(a) * r * 0.66;
    const pz = Math.sin(a) * r * 0.6;
    pavilion(b, px, pz, 2.3 + rng() * 0.7, 4.0);
    avoid.push([px, pz, 3.5]);
  }

  // 游廊：沿池东岸一段
  corridor(b, r * 0.5, -r * 0.35, r * 0.56, r * 0.42);
  avoid.push([r * 0.53, 0, 4]);

  trees(b, scatterTrees(r, spec.rockery === 2 ? 9 : 12, rng, avoid), rng);
}

function buildTemple(b: Builder, spec: HeritageModelSpec, rng: () => number) {
  const r = spec.radius ?? 21;
  basePlatform(b, r);

  // 中轴自南（+z）向北（-z）：牌坊/照壁 → 山门 → 若干进院落主殿
  let z = r * 0.78;
  if (spec.paifang) {
    b.box('stone', 0.9, 5.2, 0.9, -4.5, BASE_TOP, z);
    b.box('stone', 0.9, 5.2, 0.9, 4.5, BASE_TOP, z);
    b.box('wood', 11, 0.8, 1.1, 0, BASE_TOP + 4.3, z);
    b.roof('tile', 12, 2.6, 1.4, 0, BASE_TOP + 5.1, z);
    z -= r * 0.26;
  }

  // 山门
  hall(b, 0, z, 9, 6, 4.4, { wall: 'templeWall', doubleEave: false });
  z -= r * 0.34;

  const courts = spec.courts ?? 1;
  const hallCount = spec.halls ?? 2;
  const avoid: Array<[number, number, number]> = [];
  for (let i = 0; i < hallCount; i += 1) {
    const hz = z - i * (r * 0.42);
    if (hz < -r * 0.72) break;
    const isMain = i === 1 || (hallCount <= 2 && i === hallCount - 1);
    const hw = isMain ? r * 0.82 : r * 0.66;
    hall(b, 0, hz, hw, r * 0.42, isMain ? 8.2 : 6.2, {
      wall: 'templeWall',
      doubleEave: isMain,
      brickHall: spec.brickHall && isMain,
    });
    avoid.push([0, hz, hw * 0.6]);
    // 配殿
    if (!spec.brickHall && r > 16) {
      const sx = r * 0.62;
      hall(b, -sx, hz + r * 0.05, r * 0.3, r * 0.2, 4.6, { wall: 'plaster' });
      hall(b, sx, hz + r * 0.05, r * 0.3, r * 0.2, 4.6, { wall: 'plaster' });
    }
  }

  // 戏台（会馆）：主殿前的开放式台
  if (spec.operaStage) {
    b.box('stone', r * 0.6, 0.8, r * 0.3, 0, BASE_TOP, r * 0.35);
    b.box('wood', r * 0.55, 0.9, r * 0.26, 0, BASE_TOP + 0.8, r * 0.35);
    b.roof('tile', r * 0.7, r * 0.38, 2.0, 0, BASE_TOP + 1.7, r * 0.35);
  }

  // 文庙泮池
  if (spec.pond) pond(b, 0, r * 0.55, r * 0.3, r * 0.12, rng);

  trees(b, scatterTrees(r, 7, rng, avoid), rng);
}

function buildResidence(b: Builder, spec: HeritageModelSpec, rng: () => number) {
  const r = spec.radius ?? 19;
  basePlatform(b, r);

  if (spec.paifang) {
    // 官署门楼
    b.box('stone', 1, 5.6, 1, -3.6, BASE_TOP, r * 0.72);
    b.box('stone', 1, 5.6, 1, 3.6, BASE_TOP, r * 0.72);
    b.roof('tile', 10, 3, 1.6, 0, BASE_TOP + 5.6, r * 0.72);
  }

  const courts = spec.courts ?? 2;
  const hallCount = spec.halls ?? 2;
  const avoid: Array<[number, number, number]> = [];
  // 门厅
  hall(b, 0, r * 0.68, r * 0.5, r * 0.24, 4.2, { wall: 'plaster' });

  for (let i = 0; i < hallCount; i += 1) {
    const hz = r * 0.34 - i * (r * 0.5);
    if (hz < -r * 0.7) break;
    hall(b, 0, hz, r * (0.66 - i * 0.03), r * 0.28, 5.4, {
      wall: 'plaster',
      western: spec.western,
      doubleEave: i === 1,
    });
    avoid.push([0, hz, r * 0.35]);
    // 厢房（多进民居的左右配房）
    if (i < courts && r > 15) {
      for (const sx of [-1, 1]) {
        const xx = sx * r * 0.6;
        b.box('plaster', r * 0.16, 3.6, r * 0.42, xx, BASE_TOP, hz - r * 0.12);
        b.roof('tile', r * 0.2, r * 0.46, 1.2, xx, BASE_TOP + 3.6, hz - r * 0.12);
      }
    }
  }

  // 宅园（织造署西花园）
  if (spec.pond) {
    pond(b, -r * 0.42, -r * 0.38, r * 0.24, r * 0.2, rng);
    avoid.push([-r * 0.42, -r * 0.38, r * 0.3]);
  }
  if (spec.rockery) {
    rockery(b, r * 0.1, -r * 0.45, r * 0.18, spec.rockery === 2 ? 9 : 4, rng);
    avoid.push([r * 0.1, -r * 0.45, r * 0.24]);
  }

  trees(b, scatterTrees(r, 6, rng, avoid), rng);
}

function buildPagoda(b: Builder, spec: HeritageModelSpec) {
  const r = spec.radius ?? 11;
  const tiers = spec.tiers ?? 5;
  basePlatform(b, r);
  // 须弥座
  b.prism('stone', r * 0.62, r * 0.7, 1.6, 8, 0, BASE_TOP, 0);
  b.box('stone', r * 0.5, 0.5, r * 0.5, 0, BASE_TOP + 1.6, 0);
  let y = BASE_TOP + 2.1;
  let rad = r * 0.44;
  const tierH = Math.min(4.2, (22 - y) / tiers);
  for (let i = 0; i < tiers; i += 1) {
    b.prism('dark', rad * 0.86, rad, tierH, 8, 0, y, 0, Math.PI / 8);
    // 每层出檐
    b.prism('tile', rad * 0.9, rad * 1.42, 0.55, 8, 0, y + tierH - 0.1, 0, Math.PI / 8);
    y += tierH;
    rad *= 0.9;
  }
  // 塔刹
  b.prism('dark', 0.2, rad * 0.5, 1.6, 8, 0, y, 0);
  b.prism('tile', 0.1, 0.5, 0.7, 8, 0, y + 1.6, 0);
}

function buildGate(b: Builder, spec: HeritageModelSpec, rng: () => number) {
  const r = spec.radius ?? 12;
  basePlatform(b, r);
  // 两侧城墙墩 + 中间门洞（用楣梁跨越）
  for (const sx of [-1, 1]) {
    b.box('stone', r * 0.42, 7.5, r * 0.5, sx * r * 0.56, BASE_TOP, 0);
    // 垛口
    for (let k = -1; k <= 1; k += 1) {
      b.box('stone', r * 0.12, 0.9, r * 0.5, sx * r * 0.56 + k * r * 0.14, BASE_TOP + 7.5, 0);
    }
  }
  b.box('stone', r * 0.72, 2.4, r * 0.5, 0, BASE_TOP + 5.1, 0);
  // 城楼
  b.box('wood', r * 0.9, 3.4, r * 0.42, 0, BASE_TOP + 7.5, 0);
  b.roof('tile', r * 1.1, r * 0.56, 2.2, 0, BASE_TOP + 10.9, 0);
  trees(b, scatterTrees(r, 4, rng), rng);
}

function buildRock(b: Builder, spec: HeritageModelSpec, rng: () => number) {
  const r = spec.radius ?? 10;
  basePlatform(b, r);
  if (spec.stele) {
    // 赑屃碑座 + 碑身 + 碑额
    b.box('stone', 5.2, 1.3, 3.0, 0, BASE_TOP, 0);
    b.prism('stone', 1.8, 2.2, 1.0, 6, 0, BASE_TOP + 1.3, 0);
    b.box('dark', 3.2, 7.0, 0.9, 0, BASE_TOP + 2.3, 0);
    b.roof('tile', 4.6, 1.8, 1.2, 0, BASE_TOP + 9.3, 0);
  } else {
    // 瑞云峰：瘦皱漏透的太湖石峰（错落多棱柱 + 穿孔感的分叉）
    b.prism('stone', 3.2, 3.8, 1.2, 8, 0, BASE_TOP, 0, 0.3);
    const rng2 = rng;
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2;
      const h = 5 + rng2() * 5;
      b.prism(
        'rock',
        0.7 + rng2(),
        1.8 + rng2() * 1.2,
        h,
        6,
        Math.cos(a) * (1.2 + rng2() * 1.4),
        BASE_TOP + 1.2,
        Math.sin(a) * (1.2 + rng2() * 1.4),
        rng2() * Math.PI,
      );
    }
    b.prism('rock', 0.6, 1.6, 6.5, 6, 0.3, BASE_TOP + 1.2, -0.2, 0.4);
  }
}

function buildAcademy(b: Builder, spec: HeritageModelSpec, rng: () => number) {
  const r = spec.radius ?? 19;
  basePlatform(b, r);
  const hallCount = spec.halls ?? 2;
  const avoid: Array<[number, number, number]> = [];
  for (let i = 0; i < hallCount; i += 1) {
    const a = i * 0.7 - 0.35;
    const x = Math.cos(a) * r * 0.32;
    const z = -Math.sin(a) * r * 0.32;
    hall(b, x, z, r * 0.62, r * 0.3, 7.5 + (i % 2) * 1.6, {
      wall: 'brick',
      western: true,
      rot: a * 0.3,
    });
    avoid.push([x, z, r * 0.35]);
  }
  if (spec.bellTower) {
    b.box('brick', r * 0.24, 18, r * 0.24, r * 0.5, BASE_TOP, -r * 0.42);
    b.prism('tile', 0.3, r * 0.2, 5.5, 4, r * 0.5, BASE_TOP + 18, -r * 0.42, Math.PI / 4);
    b.prism('dark', 0.08, 0.22, 1.2, 6, r * 0.5, BASE_TOP + 23.5, -r * 0.42);
    avoid.push([r * 0.5, -r * 0.42, r * 0.2]);
  }
  trees(b, scatterTrees(r, 9, rng, avoid), rng);
}

function buildSite(buckets: Buckets, id: string, kind: HeritageKind) {
  const spec = getHeritageModelSpec(id, kind);
  const rng = makeRng(idSeed(id));
  // 院落中心与半宽来自 heritage-footprints.json（按路网避让求解）：
  // 不再直接用 OSM 质心 —— 那些点常常落在马路上。
  const fp = HERITAGE_FOOTPRINTS[id];
  const radius = Math.max(5, fp?.r ?? spec.radius ?? 20);
  const tuned: HeritageModelSpec = { ...spec, radius };
  const center = fp ?? sceneGeometry.landmarks[id]?.centroid;
  if (!center) return;
  const b = new Builder(buckets, center.x, center.z, spec.rot);

  switch (spec.archetype) {
    case 'garden':
      buildGarden(b, tuned, rng);
      break;
    case 'temple':
      buildTemple(b, tuned, rng);
      break;
    case 'residence':
      buildResidence(b, tuned, rng);
      break;
    case 'pagoda':
      buildPagoda(b, tuned);
      break;
    case 'gate':
      buildGate(b, tuned, rng);
      break;
    case 'rock':
      buildRock(b, tuned, rng);
      break;
    case 'academy':
      buildAcademy(b, tuned, rng);
      break;
  }
}

/** 材质桶合并为每桶一个几何 */
function mergeBuckets(buckets: Buckets): Partial<Record<MatKey, THREE.BufferGeometry>> {
  const out: Partial<Record<MatKey, THREE.BufferGeometry>> = {};
  (Object.keys(buckets) as MatKey[]).forEach((key) => {
    const list = buckets[key] ?? [];
    const merged = mergeGeometries(list, false);
    list.forEach((g) => g.dispose());
    if (merged) {
      merged.computeVertexNormals();
      out[key] = merged;
    }
  });
  return out;
}

export function Heritage() {
  const season = useSandTable((state) => state.season);
  const look = SEASON_LOOKS[season];
  const winter = season === 'winter';
  const geometries = useMemo(() => {
    const buckets: Buckets = {};
    for (const item of HERITAGE_LANDMARKS) {
      if (HERITAGE_FOOTPRINTS[item.id]?.hidden) continue;
      buildSite(buckets, item.id, item.kind);
    }
    return mergeBuckets(buckets);
  }, []);

  const materials = useMemo<Record<MatKey, THREE.MeshStandardMaterial>>(
    () => ({
      base: new THREE.MeshStandardMaterial({ color: winter ? '#b7bec4' : look.ground, roughness: 0.96 }),
      lawn: new THREE.MeshStandardMaterial({ color: winter ? '#c6d0d4' : look.lawn, roughness: 1 }),
      plaster: new THREE.MeshStandardMaterial({ color: winter ? '#eef1f3' : '#ece5d6', roughness: 0.92 }),
      // 赭红墙：qa-heritage 探针以夏季 #b0713d 识别文保建筑群
      templeWall: new THREE.MeshStandardMaterial({ color: winter ? '#c9a07a' : '#b0713d', roughness: 0.9 }),
      brick: new THREE.MeshStandardMaterial({ color: winter ? '#c9b0a4' : '#9c5b45', roughness: 0.92 }),
      wood: new THREE.MeshStandardMaterial({ color: winter ? '#8a6a5c' : '#5d3c2e', roughness: 0.88 }),
      tile: new THREE.MeshStandardMaterial({
        color: winter ? '#eef2f6' : '#454b54',
        roughness: 0.9,
        flatShading: true,
        side: THREE.DoubleSide,
      }),
      stone: new THREE.MeshStandardMaterial({ color: winter ? '#e3e7ea' : '#a9a294', roughness: 0.95 }),
      water: new THREE.MeshStandardMaterial({
        color: look.water,
        roughness: winter ? 0.55 : 0.18,
        metalness: winter ? 0 : 0.12,
        transparent: !winter,
        opacity: winter ? 1 : 0.92,
        side: THREE.DoubleSide,
      }),
      rock: new THREE.MeshStandardMaterial({ color: winter ? '#d6dad6' : '#8f8b7f', roughness: 0.97, flatShading: true }),
      dark: new THREE.MeshStandardMaterial({ color: winter ? '#cfd3d0' : '#4a4438', roughness: 0.9 }),
      trunk: new THREE.MeshStandardMaterial({ color: winter ? '#6b6156' : '#6b5440', roughness: 0.96 }),
      crownA: new THREE.MeshStandardMaterial({ color: look.crowns[0], roughness: 0.9, flatShading: true }),
      crownB: new THREE.MeshStandardMaterial({ color: look.crowns[1] ?? look.crowns[0], roughness: 0.9, flatShading: true }),
    }),
    [look, winter],
  );

  return (
    <group>
      {(Object.keys(geometries) as MatKey[]).map((key) => {
        // 冬季落叶：树冠不渲染，只留树干与常绿的少量松柏（由 crownB 承担）
        if (winter && key === 'crownA') return null;
        const geo = geometries[key];
        if (!geo) return null;
        const castShadow = key !== 'base' && key !== 'lawn' && key !== 'water';
        const receiveShadow = key !== 'water' && key !== 'crownA' && key !== 'crownB';
        return (
          <mesh
            key={key}
            name={`heritage-${key}`}
            geometry={geo}
            material={materials[key]}
            castShadow={castShadow}
            receiveShadow={receiveShadow}
          />
        );
      })}
    </group>
  );
}
