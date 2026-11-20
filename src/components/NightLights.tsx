import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useRoads } from '../hooks/useRoads';
import { useBuildings } from '../hooks/useBuildings';
import { useSandTable } from '../store/useSandTable';
import { sceneGeometry } from '../data/sceneGeometry';
import { buildOuterCity, OUTER_GROUND_Y } from '../data/outerCity';
import type { RoadLines } from '../data/outerCity';
import { pointInRing } from '../utils/geo';
import type { LocalPoint2 } from '../types';

/** 路灯间距（米） */
const LAMP_SPACING = 70;
const MAX_LAMPS = 4200;
const MAX_LANTERNS = 3600;

const LAMP_HEIGHT = 6.2;
const LANTERN_Y = 5.4;
/** 灯笼挂在檐下，距离屋檐 0.95m */
const LANTERN_DROP = 0.95;
/** 沿街民居挂灯笼的比例 */
const LANTERN_RATIO = 0.055;

interface Spot {
  x: number;
  z: number;
  /** 折线法向，用于路灯贴边布置 */
  nx: number;
  nz: number;
  /** 灯笼高度（挂在屋檐下），路灯不填 */
  y?: number;
}

/** 沿折线按固定间距重采样 */
function sampleLine(points: LocalPoint2[], spacing: number, out: Spot[], limit: number): void {
  let carry = spacing;
  for (let i = 0; i < points.length - 1 && out.length < limit; i += 1) {
    const [x0, z0] = points[i];
    const [x1, z1] = points[i + 1];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const nx = -dz / len;
    const nz = dx / len;
    let t = carry;
    while (t <= len && out.length < limit) {
      out.push({ x: x0 + (dx * t) / len, z: z0 + (dz * t) / len, nx, nz });
      t += spacing;
    }
    carry = t - len;
  }
}

/** 点光晕贴图（径向渐变），用于路灯与灯笼的辉光 */
function createGlowTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGlowGeometry(spots: Spot[], y: number): THREE.BufferGeometry {
  const positions = new Float32Array(spots.length * 3);
  spots.forEach((spot, i) => {
    positions[i * 3] = spot.x;
    positions[i * 3 + 1] = spot.y ?? y;
    positions[i * 3 + 2] = spot.z;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geo;
}

/** 城内河道 / 护城河水面高度（略高于水面，避免深度冲突） */
const CANAL_REFLECT_Y = 2.43;
const MOAT_REFLECT_Y = 1.43;
/** 灯影贴片数量上限（单个几何体、一次 draw call） */
const REFLECT_LIMIT = 720;

const hash = (v: number): number => {
  const t = Math.sin(v * 12.9898 + 78.233) * 43758.5453;
  return t - Math.floor(t);
};

/**
 * 水面灯影：沿河道/护城河按固定间距铺贴细长暖色光斑，
 * 夜间与岸边灯火叠加后形成倒影效果。合并为单个几何体。
 */
function buildReflectionGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];

  const push = (
    x: number,
    z: number,
    tx: number,
    tz: number,
    len: number,
    wid: number,
    y: number,
  ) => {
    if (positions.length / 18 >= REFLECT_LIMIT) return;
    const nx = -tz;
    const nz = tx;
    const hl = len / 2;
    const hw = wid / 2;
    const ax = x - tx * hl - nx * hw;
    const az = z - tz * hl - nz * hw;
    const bx = x - tx * hl + nx * hw;
    const bz = z - tz * hl + nz * hw;
    const cx = x + tx * hl + nx * hw;
    const cz = z + tz * hl + nz * hw;
    const dx = x + tx * hl - nx * hw;
    const dz = z + tz * hl - nz * hw;
    positions.push(ax, y, az, bx, y, bz, cx, y, cz, ax, y, az, cx, y, cz, dx, y, dz);
    uvs.push(0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0);
  };

  // 城内河道：贴片沿河走向拉长，少量横向偏移避免排成一条线
  for (const line of sceneGeometry.waterways) {
    let carry = 8;
    for (let i = 0; i < line.length - 1 && positions.length / 18 < REFLECT_LIMIT; i += 1) {
      const [x0, z0] = line[i];
      const [x1, z1] = line[i + 1];
      const sx = x1 - x0;
      const sz = z1 - z0;
      const len = Math.hypot(sx, sz);
      if (len < 1) continue;
      const tx = sx / len;
      const tz = sz / len;
      let t = carry;
      while (t <= len && positions.length / 18 < REFLECT_LIMIT) {
        const f = t / len;
        const px = x0 + sx * f;
        const pz = z0 + sz * f;
        const h = hash(px * 0.013 + pz * 0.027);
        const off = (h - 0.5) * 5;
        push(
          px - tz * off,
          pz + tx * off,
          tx,
          tz,
          8 + h * 9,
          2 + h * 1.4,
          CANAL_REFLECT_Y,
        );
        t += 26;
      }
      carry = t - len;
    }
  }

  // 环城河：沿城墙轮廓外侧铺开，灯影更宽、更疏
  const ring: LocalPoint2[] = sceneGeometry.cityOutline;
  let carry = 20;
  for (let i = 0; i < ring.length && positions.length / 18 < REFLECT_LIMIT; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const sx = b[0] - a[0];
    const sz = b[1] - a[1];
    const len = Math.hypot(sx, sz);
    if (len < 1) continue;
    const tx = sx / len;
    const tz = sz / len;
    let t = carry;
    while (t <= len && positions.length / 18 < REFLECT_LIMIT) {
      const f = t / len;
      const px = a[0] + sx * f;
      const pz = a[1] + sz * f;
      // 法线朝城外
      let nx = -tz;
      let nz = tx;
      if (pointInRing(ring, px + nx * 10, pz + nz * 10)) {
        nx = -nx;
        nz = -nz;
      }
      const h = hash(px * 0.011 + pz * 0.019);
      const off = 30 + h * 62;
      push(px + nx * off, pz + nz * off, tx, tz, 13 + h * 12, 3.4 + h * 2.2, MOAT_REFLECT_Y);
      t += 64;
    }
    carry = t - len;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geo;
}

/**
 * 城外街区灯火：给 3–5.8km 的外围民居与高层按立面撒窗光，
 * 并沿环城主干道布路灯。单个 Points 几何体，一次 draw call。
 */
function buildOuterNightGlow(roads: RoadLines | null): {
  windows: THREE.BufferGeometry;
  lamps: THREE.BufferGeometry;
} {
  const winPos: number[] = [];
  const winColor: number[] = [];
  const lampPos: number[] = [];
  const lampColor: number[] = [];

  if (!roads) {
    const windows = new THREE.BufferGeometry();
    windows.setAttribute('position', new THREE.Float32BufferAttribute(winPos, 3));
    windows.setAttribute('color', new THREE.Float32BufferAttribute(winColor, 3));
    const lamps = new THREE.BufferGeometry();
    lamps.setAttribute('position', new THREE.Float32BufferAttribute(lampPos, 3));
    lamps.setAttribute('color', new THREE.Float32BufferAttribute(lampColor, 3));
    return { windows, lamps };
  }

  const city = buildOuterCity(roads);
  const warm = [1.0, 0.78, 0.5];
  const cold = [0.85, 0.9, 1.0];

  const pushWindow = (x: number, y: number, z: number, seed: number): void => {
    const c = hash(seed) > 0.82 ? cold : warm;
    const k = 0.55 + hash(seed + 7) * 0.45;
    winPos.push(x, y, z);
    winColor.push(c[0] * k, c[1] * k, c[2] * k);
  };

  // 民居：每栋 2~3 扇亮窗，落在四个立面上
  city.blocks.forEach((b, i) => {
    const ca = Math.cos(b.rot);
    const sa = Math.sin(b.rot);
    const n = 2 + Math.floor(hash(i * 3.7 + 1.3) * 2);
    for (let k = 0; k < n; k += 1) {
      const seed = i * 11.3 + k * 5.1;
      const face = Math.floor(hash(seed) * 4);
      const along = (hash(seed + 2) - 0.5) * 0.8;
      const y = OUTER_GROUND_Y + b.h * (0.25 + hash(seed + 3) * 0.62);
      let lx: number;
      let lz: number;
      if (face < 2) {
        lx = (face === 0 ? 1 : -1) * b.w * 0.52;
        lz = along * b.d;
      } else {
        lx = along * b.w;
        lz = (face === 2 ? 1 : -1) * b.d * 0.52;
      }
      pushWindow(b.x + lx * ca + lz * sa, y, b.z - lx * sa + lz * ca, seed);
    }
  });

  // 高层：逐层点灯，约四成楼层留暗，形成竖向灯带
  city.towers.forEach((t, i) => {
    const ca = Math.cos(t.rot);
    const sa = Math.sin(t.rot);
    const floors = Math.max(1, Math.floor((t.h - 5) / 3.4));
    for (let f = 0; f < floors; f += 1) {
      const seed = 40000 + i * 37 + f * 3.1;
      if (hash(seed) < 0.42) continue;
      const y = OUTER_GROUND_Y + 3.5 + f * 3.4;
      const face = Math.floor(hash(seed + 1) * 4);
      const along = (hash(seed + 2) - 0.5) * 0.7;
      let lx: number;
      let lz: number;
      if (face < 2) {
        lx = (face === 0 ? 1 : -1) * t.w * 0.52;
        lz = along * t.d;
      } else {
        lx = along * t.w;
        lz = (face === 2 ? 1 : -1) * t.d * 0.52;
      }
      pushWindow(t.x + lx * ca + lz * sa, y, t.z - lx * sa + lz * ca, seed);
    }
  });

  // 城外路灯：沿真实 OSM 主干道布点，只取 3km 以外
  const side = 16.6;
  /** 城外透视距离远，灯距放宽以控制光点数量 */
  const OUTER_LAMP_SPACING = 110;
  for (const line of roads.major) {
    if (line.length < 2) continue;
    let carry = 35;
    for (let i = 0; i < line.length - 1; i += 1) {
      const [x0, z0] = line[i];
      const [x1, z1] = line[i + 1];
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const nx = -dz / len;
      const nz = dx / len;
      let t = carry;
      let flip = 1;
      while (t <= len) {
        const f = t / len;
        const px = x0 + dx * f + nx * side * flip;
        const pz = z0 + dz * f + nz * side * flip;
        if (Math.hypot(px, pz) > 3100) {
          lampPos.push(px, OUTER_GROUND_Y + 7.5, pz);
          lampColor.push(1.0, 0.79, 0.48);
        }
        flip = -flip;
        t += OUTER_LAMP_SPACING;
      }
      carry = t - len;
    }
  }

  const windows = new THREE.BufferGeometry();
  windows.setAttribute('position', new THREE.Float32BufferAttribute(winPos, 3));
  windows.setAttribute('color', new THREE.Float32BufferAttribute(winColor, 3));

  const lamps = new THREE.BufferGeometry();
  lamps.setAttribute('position', new THREE.Float32BufferAttribute(lampPos, 3));
  lamps.setAttribute('color', new THREE.Float32BufferAttribute(lampColor, 3));

  return { windows, lamps };
}

/**
 * 夜景灯光（FR-10 夜景增强）：
 * - 城内主干道路灯（灯杆 + 发光灯头 + 暖色辉光）
 * - 民居檐下红灯笼：按建筑实例选址，挂在正立面屋檐下，不再沿路随机漂浮
 * - 城外 3–5.8km 街区窗光与环城路灯：避免夜里城外一圈全黑
 * 建筑窗光由 BuildingField 的立面着色器统一点亮。
 * 全部走 InstancedMesh / Points，仅在夜间显示。
 */
export function NightLights() {
  const roads = useRoads();
  const buildings = useBuildings();
  const night = useSandTable((state) => state.time === 'night');

  const poleRef = useRef<THREE.InstancedMesh>(null);
  const bulbRef = useRef<THREE.InstancedMesh>(null);
  const lanternRef = useRef<THREE.InstancedMesh>(null);
  const cordRef = useRef<THREE.InstancedMesh>(null);

  const glowTexture = useMemo(() => createGlowTexture(), []);

  const layout = useMemo(() => {
    const lamps: Spot[] = [];
    const lanterns: Spot[] = [];

    if (roads) {
      for (const line of roads.major) {
        // 城外路段的灯由 buildOuterNightGlow 用光点表达，这里只做城内灯杆
        const mid = line[Math.floor(line.length / 2)];
        if (Math.hypot(mid[0], mid[1]) > 3300) continue;
        const start = lamps.length;
        sampleLine(line, LAMP_SPACING, lamps, MAX_LAMPS);
        // 灯杆退到路缘，避免立在主干道正中间
        for (let i = start; i < lamps.length; i += 1) {
          lamps[i].x += lamps[i].nx * 7.5;
          lamps[i].z += lamps[i].nz * 7.5;
        }
      }
    }
    const innerLamps = lamps.filter((s) => Math.hypot(s.x, s.z) < 3100);

    // 红灯笼挂到民居屋檐下：从已测绘的坡顶建筑中按确定性概率抽样
    if (buildings) {
      for (const [x, z, w, d, rot, h] of buildings.pitched) {
        if (h < 6.5 || h > 24 || w < 4) continue;
        const seed = hash(x * 0.37 + z * 0.61);
        if (seed > LANTERN_RATIO) continue;

        // 立面选择：长边立面（局部 ±z），沿墙随机偏移，挂在檐下
        const side = hash(seed * 91.7 + 0.13) > 0.5 ? 1 : -1;
        const along = (hash(seed * 13.1 + 0.71) - 0.5) * w * 0.5;
        const out = d / 2 + 0.55;
        const ca = Math.cos(rot);
        const sa = Math.sin(rot);
        lanterns.push({
          x: x + along * ca + out * sa * side,
          z: z - along * sa + out * ca * side,
          nx: 0,
          nz: 0,
          y: h - LANTERN_DROP,
        });
        if (lanterns.length >= MAX_LANTERNS) break;
      }
    }

    return { lamps: innerLamps, lanterns };
  }, [roads, buildings]);

  const glowGeos = useMemo(
    () => ({
      lamp: makeGlowGeometry(layout.lamps, LAMP_HEIGHT + 0.2),
      lantern: makeGlowGeometry(layout.lanterns, LANTERN_Y),
    }),
    [layout],
  );

  /** 水面灯影：城外环城河 + 城内河道 */
  const reflectionGeo = useMemo(() => buildReflectionGeometry(), []);

  /** 城外街区窗光与真实主干道路灯 */
  const outerGlow = useMemo(() => buildOuterNightGlow(roads), [roads]);

  const [poleMat, bulbMat, lanternMat] = useMemo(
    () => [
      new THREE.MeshStandardMaterial({ color: '#2b2c30', roughness: 0.85 }),
      new THREE.MeshStandardMaterial({
        color: '#ffe6bc',
        emissive: '#ffb35c',
        emissiveIntensity: 2.4,
        toneMapped: false,
      }),
      new THREE.MeshStandardMaterial({
        color: '#8f1f18',
        emissive: '#ff3b26',
        emissiveIntensity: 1.9,
        toneMapped: false,
      }),
    ],
    [],
  );

  const poleGeo = useMemo(
    () => new THREE.CylinderGeometry(0.16, 0.24, 1, 4, 1, true).translate(0, 0.5, 0),
    [],
  );
  const bulbGeo = useMemo(() => new THREE.OctahedronGeometry(0.5, 0), []);
  const lanternGeo = useMemo(() => new THREE.OctahedronGeometry(0.62, 0), []);

  useLayoutEffect(() => {
    const dummy = new THREE.Object3D();

    const poles = poleRef.current;
    const bulbs = bulbRef.current;
    if (poles && bulbs && layout.lamps.length) {
      layout.lamps.forEach((spot, i) => {
        dummy.position.set(spot.x, 0, spot.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, LAMP_HEIGHT, 1);
        dummy.updateMatrix();
        poles.setMatrixAt(i, dummy.matrix);

        dummy.position.set(spot.x, LAMP_HEIGHT + 0.2, spot.z);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        bulbs.setMatrixAt(i, dummy.matrix);
      });
      poles.instanceMatrix.needsUpdate = true;
      bulbs.instanceMatrix.needsUpdate = true;
    }

    const lanterns = lanternRef.current;
    const cords = cordRef.current;
    if (lanterns && layout.lanterns.length) {
      layout.lanterns.forEach((spot, i) => {
        const y = spot.y ?? LANTERN_Y;
        dummy.position.set(spot.x, y, spot.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1.35, 1);
        dummy.updateMatrix();
        lanterns.setMatrixAt(i, dummy.matrix);

        // 檐下吊绳：从灯笼顶端接到屋檐
        if (cords) {
          dummy.position.set(spot.x, y + 0.8, spot.z);
          dummy.scale.set(0.14, 0.7, 0.14);
          dummy.updateMatrix();
          cords.setMatrixAt(i, dummy.matrix);
        }
      });
      lanterns.instanceMatrix.needsUpdate = true;
      if (cords) cords.instanceMatrix.needsUpdate = true;
    }
  }, [layout]);

  return (
    <group visible={night}>
      <instancedMesh
        ref={poleRef}
        args={[poleGeo, poleMat, Math.max(1, layout.lamps.length)]}
        count={layout.lamps.length}
        frustumCulled={false}
      />
      <instancedMesh
        ref={bulbRef}
        args={[bulbGeo, bulbMat, Math.max(1, layout.lamps.length)]}
        count={layout.lamps.length}
        frustumCulled={false}
      />
      <instancedMesh
        ref={cordRef}
        args={[poleGeo, poleMat, Math.max(1, layout.lanterns.length)]}
        count={layout.lanterns.length}
        frustumCulled={false}
      />
      <instancedMesh
        ref={lanternRef}
        args={[lanternGeo, lanternMat, Math.max(1, layout.lanterns.length)]}
        count={layout.lanterns.length}
        frustumCulled={false}
      />
      <points geometry={glowGeos.lamp} frustumCulled={false}>
        <pointsMaterial
          map={glowTexture}
          color="#ffcf8f"
          size={26}
          sizeAttenuation
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
      <points geometry={glowGeos.lantern} frustumCulled={false}>
        <pointsMaterial
          map={glowTexture}
          color="#ff5a38"
          size={20}
          sizeAttenuation
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
      {/* 灯笼外层柔光：增强夜间光晕层次 */}
      <points geometry={glowGeos.lantern} frustumCulled={false}>
        <pointsMaterial
          map={glowTexture}
          color="#ff7a3a"
          size={44}
          sizeAttenuation
          transparent
          opacity={0.3}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
      {/* 河面灯影：贴在水面上的细长暖色光斑 */}
      <mesh geometry={reflectionGeo} renderOrder={2} frustumCulled={false}>
        <meshBasicMaterial
          map={glowTexture}
          color="#ffab63"
          transparent
          opacity={0.42}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* 城外街区窗光：民居逐窗、高层逐层 */}
      <points geometry={outerGlow.windows} frustumCulled={false}>
        <pointsMaterial
          map={glowTexture}
          vertexColors
          size={20}
          sizeAttenuation
          transparent
          opacity={0.9}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
      {/* 城外主干道路灯 */}
      <points geometry={outerGlow.lamps} frustumCulled={false}>
        <pointsMaterial
          map={glowTexture}
          vertexColors
          size={30}
          sizeAttenuation
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  );
}
