import { useMemo } from 'react';
import * as THREE from 'three';
import { lonLatToVector3 } from '../utils/geo';
import { HILLS, HILL_SHAPE, type HillSpec } from '../data/hills';
import { SEASON_LOOKS } from '../constants/seasons';
import { useSandTable } from '../store/useSandTable';

/** 城外地形基准面（与外围陆地同高） */
const GROUND_LEVEL = -2;

const fract = (v: number): number => v - Math.floor(v);
const hash2 = (x: number, y: number, seed: number): number =>
  fract(Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453);
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** 二维值噪声 */
const valueNoise = (x: number, y: number, seed: number): number => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smoothstep(0, 1, x - xi);
  const v = smoothstep(0, 1, y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};

/** 山脊噪声：|2n-1| 取反后得到连绵的脊线，而不是一团团的圆包 */
const ridgeNoise = (x: number, y: number, seed: number): number => {
  let sum = 0;
  let amp = 0.55;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < 4; o += 1) {
    const n = valueNoise(x * freq, y * freq, seed + o * 17);
    sum += amp * (1 - Math.abs(2 * n - 1));
    norm += amp;
    freq *= 2.07;
    amp *= 0.48;
  }
  return sum / norm;
};

interface Lobe {
  /** 峰位（-1..1，相对长/短轴） */
  u: number;
  v: number;
  /** 相对高度 */
  a: number;
  /** 峰体在长/短轴方向上的铺展（-1..1 单位） */
  su: number;
  sv: number;
}

/**
 * 各山体的峰体组合：真实山丘是多峰相连的脊，不是单锥。
 * 主峰 + 2~3 个次峰错开布置，中间留鞍部，山脊线自然断续。
 */
const LOBES: Record<string, Lobe[]> = {
  虎丘: [
    { u: -0.02, v: 0.04, a: 1.0, su: 0.5, sv: 0.44 },
    { u: 0.42, v: -0.32, a: 0.52, su: 0.3, sv: 0.26 },
    { u: -0.46, v: 0.28, a: 0.44, su: 0.32, sv: 0.28 },
  ],
  狮子山: [
    { u: -0.56, v: 0.04, a: 0.66, su: 0.32, sv: 0.32 },
    { u: -0.08, v: -0.06, a: 1.0, su: 0.3, sv: 0.32 },
    { u: 0.34, v: 0.1, a: 0.78, su: 0.26, sv: 0.28 },
    { u: 0.7, v: -0.14, a: 0.46, su: 0.24, sv: 0.22 },
  ],
};

const DEFAULT_LOBES: Lobe[] = [{ u: 0, v: 0, a: 1, su: 0.45, sv: 0.4 }];

/** 山脚以下的高度视为"不出土"，这些格子的三角形不生成（否则会铺出一块平板） */
const TOE_EPS = 0.35;

/**
 * 单座山体：椭圆占地上叠加多峰高斯 + 山脊噪声，边缘平滑收进地面。
 *
 * 两个容易踩的坑，这里都绕开了：
 * 1) 不能把整个外接矩形都铺成 y=0 的平面——外围地面是有贴图的，
 *    平板会和它撞成一块突兀的浅色台座；
 * 2) 山顶不能收成近白色——浅色山顶 + 圆滑轮廓就是富士山，
 *    这里山顶走岩石色，只有冬天下雪才转白。
 */
function createHillGeometry(
  hill: HillSpec,
  seed: number,
  lowHex: string,
  highHex: string,
  lawnHex: string,
  landHex: string,
  winter: boolean,
): THREE.BufferGeometry {
  const shape = HILL_SHAPE[hill.name] ?? { rx: 0.95, rz: 0.7, rot: 0 };
  const lobes = LOBES[hill.name] ?? DEFAULT_LOBES;

  // 网格分辨率随体量走：狮子山约 13m 一格，虎丘更细
  const NX = hill.radius > 600 ? 132 : 96;
  const NZ = Math.max(56, Math.round(NX * (shape.rz / shape.rx)));
  const rx = hill.radius * shape.rx * 0.98;
  const rz = hill.radius * shape.rz * 0.98;

  const stride = NX + 1;
  const heights = new Float32Array(stride * (NZ + 1));
  const us = new Float32Array(NX + 1);
  const vs = new Float32Array(NZ + 1);

  // 边缘半径带噪声：轮廓不是一个规整椭圆（三个不同频率叠加，避免看出周期性）
  const edgeWobble = (u: number, v: number): number => {
    const th = Math.atan2(v, u);
    return (
      1 +
      0.115 * Math.sin(th * 3 + seed * 2.1) +
      0.07 * Math.sin(th * 5 - seed * 1.7) +
      0.045 * Math.sin(th * 8 + seed * 3.3)
    );
  };

  let maxH = 0;
  for (let iv = 0; iv <= NZ; iv += 1) {
    const v = (iv / NZ) * 2 - 1;
    vs[iv] = v;
    for (let iu = 0; iu <= NX; iu += 1) {
      const u = (iu / NX) * 2 - 1;
      us[iu] = u;

      const q = Math.hypot(u, v) / edgeWobble(u, v);
      // 山脚范围：0.30 以内是山体主体，0.30→1.0 之间一路收进地面
      const toe = 1 - smoothstep(0.3, 1.0, q);
      if (toe <= 0) {
        heights[iv * stride + iu] = 0;
        continue;
      }
      // 指数 0.55：山腰明显变陡，山脚依然是缓的（真实山丘的凹形坡）
      const mask = Math.pow(toe, 0.55);

      // 峰体：高斯叠加。同一座山的几个峰互相咬合，峰间留鞍部
      let body = 0;
      for (const lobe of lobes) {
        const du = (u - lobe.u) / lobe.su;
        const dv = (v - lobe.v) / lobe.sv;
        body += lobe.a * Math.exp(-Math.pow(du * du + dv * dv, 0.72));
      }

      const px = u * rx;
      const pz = v * rz;
      // 两级山脊：低频定山形走向，高频出冲沟，谷底压低
      const ridge = ridgeNoise(px / 250 + seed, pz / 250 - seed, seed + 3);
      const gully = ridgeNoise(px / 95 - seed, pz / 95 + seed, seed + 21);
      const detail = valueNoise(px / 46, pz / 46, seed + 9);

      // 山脊调制：让山体裂成几个有坡度的块面，而不是一个均匀的鼓包
      const relief = 0.66 + 0.5 * (ridge - 0.5) + 0.22 * (gully - 0.5);
      // 山脊线本身轻微偏移，制造不对称
      const lean = 1 + 0.16 * Math.sin(q * 4.2 + seed * 5);
      const h = mask * (body * relief * lean + 0.05 * detail * mask);
      heights[iv * stride + iu] = Math.max(0, h);
      if (h > maxH) maxH = h;
    }
  }

  const scale = maxH > 0 ? hill.height / maxH : 0;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // 山脚几乎贴地、受满正射日照，用原色会比带贴图的地面更亮，压暗一点才接得上
  const plain = new THREE.Color(landHex).multiplyScalar(0.83);
  // 山脚色偏向林色而不是草色：否则山脚一圈会亮成荧光带
  const foot = new THREE.Color(lowHex).lerp(new THREE.Color(lawnHex), 0.22);
  const low = new THREE.Color(lowHex);
  const high = new THREE.Color(hill.color || highHex);
  // 山顶裸岩：往暖灰靠，避免浅绿/近白的尖顶
  const rock = winter ? new THREE.Color(highHex) : new THREE.Color('#8a8478');
  const color = new THREE.Color();

  for (let iv = 0; iv <= NZ; iv += 1) {
    for (let iu = 0; iu <= NX; iu += 1) {
      const u = us[iu];
      const v = vs[iv];
      const y = heights[iv * stride + iu] * scale;
      positions.push(u * rx, y, v * rz);

      const t = Math.min(1, y / Math.max(hill.height, 1));
      // 平地色 → 山脚林缘 → 山腰林色 → 山顶岩色。
      // 第一段过渡压在 1.5% 高度以内，山脚不会拖出一圈灰白边。
      color.copy(plain).lerp(foot, smoothstep(0.0, 0.015, t));
      color.lerp(low, smoothstep(0.012, 0.14, t));
      color.lerp(high, smoothstep(0.16, 0.66, t));
      color.lerp(rock, smoothstep(0.66, 0.97, t) * (winter ? 0.9 : 0.62));
      const jitter = 0.9 + valueNoise(u * 34, v * 34, seed + 5) * 0.17;
      colors.push(color.r * jitter, color.g * jitter, color.b * jitter);
    }
  }

  for (let iv = 0; iv < NZ; iv += 1) {
    for (let iu = 0; iu < NX; iu += 1) {
      const a = iv * stride + iu;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      const hMax = Math.max(heights[a], heights[b], heights[c], heights[d]) * scale;
      // 整格都贴地：不生成——山脚之外不铺任何面
      if (hMax < TOE_EPS) continue;
      // 绕序保证法线朝上：俯视时正面可见
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * 山体：苏州城外真实山丘位置（HILLS），几何为多峰山脊 + 山脚缓坡，
 * 高度沿用沙盘艺术放大比例。
 */
export function Hills() {
  const season = useSandTable((state) => state.season);
  const look = SEASON_LOOKS[season];
  const hills = useMemo(
    () =>
      HILLS.map((hill) => ({
        ...hill,
        position: lonLatToVector3(hill.lon, hill.lat, GROUND_LEVEL),
        rotation: HILL_SHAPE[hill.name]?.rot ?? 0,
        geometry: createHillGeometry(
          hill,
          hill.lon * 37 + hill.lat * 11,
          look.hillLow,
          look.hillHigh,
          look.lawn,
          look.land,
          season === 'winter',
        ),
      })),
    [look, season],
  );

  return (
    <group>
      {hills.map((hill) => (
        <mesh
          key={hill.name}
          geometry={hill.geometry}
          position={hill.position}
          rotation={[0, hill.rotation, 0]}
          // 山体在 4–9km 外，已超出阴影相机范围（±3.2km），
          // 采样阴影贴图边缘会误判成全黑；这里只保留天光与日照。
          receiveShadow={false}
        >
          <meshStandardMaterial vertexColors flatShading roughness={1} />
        </mesh>
      ))}
    </group>
  );
}
