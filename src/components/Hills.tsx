import { useMemo } from 'react';
import * as THREE from 'three';
import { lonLatToVector3 } from '../utils/geo';
import { HILLS } from '../data/hills';
import { SEASON_LOOKS } from '../constants/seasons';
import { useSandTable } from '../store/useSandTable';

/** 城外地形基准面（与外围陆地同高） */
const GROUND_LEVEL = -2;

const fract = (v: number): number => v - Math.floor(v);
const hash2 = (x: number, y: number, seed: number): number =>
  fract(Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453);
const smooth = (t: number): number => t * t * (3 - 2 * t);

/** 二维值噪声 */
const valueNoise = (x: number, y: number, seed: number): number => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};

/** 分形噪声：山脊起伏 */
const fbm = (x: number, y: number, seed: number): number => {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < 3; o += 1) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 13);
    freq *= 2;
    amp *= 0.5;
  }
  return sum / 0.875;
};

/**
 * 单座山体：极坐标网格 + 分形噪声扰动，形成不对称的浑圆山脊，
 * 顶部与陡坡转岩色，山脚转植被色；不再用规则的半球。
 */
function createHillGeometry(
  seed: number,
  radius: number,
  height: number,
  lowHex: string,
  highHex: string,
): THREE.BufferGeometry {
  const RINGS = 20;
  const SEG = 48;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const low = new THREE.Color(lowHex);
  const high = new THREE.Color(highHex);
  const color = new THREE.Color();

  const nApex = fbm(seed * 0.7, seed * 1.3, seed);
  for (let i = 0; i <= RINGS; i += 1) {
    const r = i / RINGS;
    for (let j = 0; j < SEG; j += 1) {
      const th = (j / SEG) * Math.PI * 2;
      const n = i === 0 ? nApex : fbm(Math.cos(th) * 2.1 + seed * 0.37, Math.sin(th) * 2.1 + seed * 0.71, seed);
      const n2 = fbm(Math.cos(th) * 4.3 + seed, Math.sin(th) * 4.3 + seed * 2, seed + 11);
      const ridge = i === 0 ? 1 : 1 + 0.16 * Math.sin(th * 2 + seed * 1.7);
      const wobble = 1 + 0.14 * (n2 - 0.5);
      const rr = r * wobble;

      const x = Math.cos(th) * rr * radius * 1.08;
      const z = Math.sin(th) * rr * radius * 0.92;
      const y = height * Math.pow(1 - r, 1.45) * (0.74 + 0.4 * n) * ridge;
      positions.push(x, y, z);

      const t = smooth(Math.min(1, Math.max(0, y / Math.max(height, 0.001))));
      color.copy(low).lerp(high, smooth(Math.min(1, Math.max(0, (t - 0.28) / 0.5))));
      const jitter = 0.94 + n2 * 0.12;
      colors.push(color.r * jitter, color.g * jitter, color.b * jitter);
    }
  }

  for (let i = 0; i < RINGS; i += 1) {
    for (let j = 0; j < SEG; j += 1) {
      const a = i * SEG + j;
      const b = i * SEG + ((j + 1) % SEG);
      const c = (i + 1) * SEG + j;
      const d = (i + 1) * SEG + ((j + 1) % SEG);
      // 绕序必须让面法线朝外朝上：反了的话正面被剔除（山体透出天空），
      // 只剩背面的内向法线参与光照（整座山发黑）。
      indices.push(a, b, c, b, d, c);
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
 * 山体：苏州城外真实山丘位置（HILLS），几何为带噪声的不规则山脊，
 * 高度沿用沙盘艺术放大比例。
 */
export function Hills() {
  const season = useSandTable((state) => state.season);
  const look = SEASON_LOOKS[season];
  const hills = useMemo(
    () =>
      HILLS.map((hill, i) => ({
        ...hill,
        position: lonLatToVector3(hill.lon, hill.lat, GROUND_LEVEL),
        rotation: (i * 1.37) % Math.PI,
        geometry: createHillGeometry(i + 1, hill.radius, hill.height, look.hillLow, look.hillHigh),
      })),
    [look],
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
