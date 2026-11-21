import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sceneGeometry } from '../data/sceneGeometry';
import { WATER_LEVEL } from './WaterSystem';

/** 城内水面高度（与 WaterSystem 一致） */
const WATER_Y = WATER_LEVEL.canal;
/** 城内 / 山塘河船只数量上限 */
const INNER_BOAT_CAP = 22;
const SHANTANG_BOAT_CAP = 26;

const hash = (v: number): number => {
  const t = Math.sin(v * 12.9898 + 4.1) * 43758.5453;
  return t - Math.floor(t);
};

/** 给子几何刷上统一顶点色，便于合并成一次 draw call */
function paint(geo: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  // 合并要求索引状态一致：ExtrudeGeometry 无索引，圆柱/立方体有索引，统一转成无索引
  const source = geo.index ? geo.toNonIndexed() : geo;
  const color = new THREE.Color(hex);
  const count = source.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  source.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return source;
}

/**
 * 乌篷船：尖头方尾的木船体 + 黑色半圆船篷 + 船头小甲板，
 * 三部分合并为一个几何，用顶点色区分材质。
 */
function createBoatGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-2.2, 0);
  shape.quadraticCurveTo(-2.0, 0.56, -1.1, 0.62);
  shape.lineTo(1.0, 0.6);
  shape.quadraticCurveTo(2.0, 0.55, 2.35, 0);
  shape.quadraticCurveTo(2.0, -0.55, 1.0, -0.6);
  shape.lineTo(-1.1, -0.62);
  shape.quadraticCurveTo(-2.0, -0.56, -2.2, 0);

  // paint() 会把带索引的几何转成无索引副本并返回，必须用返回值参与合并，
  // 否则三份几何索引状态不一致，mergeGeometries 直接返回 null（船就没了）
  const hull = paint(
    new THREE.ExtrudeGeometry(shape, {
      depth: 0.62,
      bevelEnabled: false,
      curveSegments: 4,
    })
      .rotateX(-Math.PI / 2)
      .translate(0, WATER_Y - 0.36, 0),
    '#5c4632',
  );

  const canopy = paint(
    new THREE.CylinderGeometry(0.56, 0.56, 2.0, 10)
      .rotateZ(Math.PI / 2)
      .translate(-0.15, WATER_Y + 0.36, 0),
    '#2f3236',
  );

  const deck = paint(
    new THREE.BoxGeometry(1.5, 0.08, 0.9).translate(1.35, WATER_Y + 0.26, 0),
    '#6b5237',
  );

  // 船头小灯：夜里的一点暖色，与两岸灯火呼应
  const lamp = paint(
    new THREE.BoxGeometry(0.22, 0.3, 0.22).translate(1.9, WATER_Y + 0.62, 0),
    '#d8a05a',
  );

  // 合并失败时退化为空几何：宁可没船，也不能让整个场景崩溃
  return mergeGeometries([hull, canopy, deck, lamp]) ?? new THREE.BufferGeometry();
}

interface BoatSpot {
  x: number;
  z: number;
  /** 船头朝向（局部 +X 对齐河道切向） */
  rot: number;
  /** 实例的 y 偏移：船体几何已按城内水面烘焙，别的河段需要整体下移 */
  y: number;
}

/** 沿河道取点停船：避开河心，靠一侧岸边 */
function pickInnerSpots(): BoatSpot[] {
  const spots: BoatSpot[] = [];
  let seed = 3;

  for (const line of sceneGeometry.waterways) {
    for (let i = 0; i < line.length - 1 && spots.length < INNER_BOAT_CAP; i += 1) {
      const [x1, z1] = line[i];
      const [x2, z2] = line[i + 1];
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 60) continue;

      for (let d = 45; d < len - 35 && spots.length < INNER_BOAT_CAP; d += 140) {
        seed += 1;
        if (hash(seed) > 0.45) continue;

        const t = d / len;
        const tx = (x2 - x1) / len;
        const tz = (z2 - z1) / len;
        const side = hash(seed + 3) > 0.5 ? 1 : -1;
        const offset = side * (4 + hash(seed + 7) * 3);
        spots.push({
          x: x1 + (x2 - x1) * t - tz * offset,
          z: z1 + (z2 - z1) * t + tx * offset,
          rot: Math.atan2(-tz, tx),
          y: 0,
        });
      }
    }
    if (spots.length >= INNER_BOAT_CAP) break;
  }
  return spots;
}

/**
 * 山塘河游船：沿山塘河均匀取样，靠一侧缓行停泊；
 * 石拱桥、河埠头附近各留一条，让"七里山塘"这段水街有生活气。
 */
function pickShantangSpots(): BoatSpot[] {
  const line = sceneGeometry.outerWaterways?.[0];
  if (!line || line.length < 2) return [];

  // 累计里程，按固定间距取点
  const cum: number[] = [0];
  for (let i = 0; i < line.length - 1; i += 1) {
    cum.push(cum[i] + Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]));
  }
  const total = cum[cum.length - 1];
  const spots: BoatSpot[] = [];
  let seed = 91;

  const at = (s: number): { x: number; z: number; tx: number; tz: number } => {
    const dist = Math.min(Math.max(s, 0), total - 0.001);
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < dist) i += 1;
    const segLen = cum[i + 1] - cum[i] || 1;
    const f = (dist - cum[i]) / segLen;
    const [x1, z1] = line[i];
    const [x2, z2] = line[i + 1];
    const len = Math.hypot(x2 - x1, z2 - z1) || 1;
    return {
      x: x1 + (x2 - x1) * f,
      z: z1 + (z2 - z1) * f,
      tx: (x2 - x1) / len,
      tz: (z2 - z1) / len,
    };
  };

  const spacing = total / (SHANTANG_BOAT_CAP + 1);
  for (let k = 0; k < SHANTANG_BOAT_CAP; k += 1) {
    seed += 1;
    const s = spacing * (k + 0.5) + (hash(seed) - 0.5) * spacing * 0.35;
    const p = at(s);
    const side = hash(seed + 5) > 0.5 ? 1 : -1;
    // 山塘河现在按模型内河 8m 宽绘制，船只收在中心线 ±1.9m 内，避免搁到石驳岸上
    const offset = side * (1 + hash(seed + 7) * 0.9);
    // 局部 +X 对齐河道切向：船头朝向 + 轻微摆动
    const rot = Math.atan2(-p.tz, p.tx);
    spots.push({
      x: p.x - p.tz * offset,
      z: p.z + p.tx * offset,
      rot,
      y: WATER_LEVEL.shantang - WATER_Y,
    });
  }
  return spots;
}

/**
 * 河道生机（M1 补充）：城内运河与山塘河里停靠的乌篷船，
 * 位置沿真实河网取样、靠岸偏置，轻微上下浮动。
 */
export function CanalBoats() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const geo = useMemo(createBoatGeometry, []);
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, flatShading: true }),
    [],
  );
  const spots = useMemo(() => [...pickInnerSpots(), ...pickShantangSpots()], []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const count = Math.max(1, spots.length);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    spots.forEach((spot, i) => {
      dummy.position.set(spot.x, spot.y, spot.z);
      dummy.rotation.set(0, spot.rot, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [spots, dummy]);

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const t = clock.elapsedTime;
    spots.forEach((spot, i) => {
      dummy.position.set(spot.x, spot.y + Math.sin(t * 0.8 + i * 1.7) * 0.02, spot.z);
      dummy.rotation.set(Math.sin(t * 0.6 + i) * 0.012, spot.rot, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geo, material, count]}
      frustumCulled={false}
      visible={spots.length > 0}
    />
  );
}
