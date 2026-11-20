import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sceneGeometry } from '../data/sceneGeometry';

/** 水面高度（与 WaterSystem 一致） */
const WATER_Y = 2.4;
/** 船只总数上限 */
const BOAT_CAP = 18;

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

  // 合并失败时退化为空几何：宁可没船，也不能让整个场景崩溃
  return mergeGeometries([hull, canopy, deck]) ?? new THREE.BufferGeometry();
}

interface BoatSpot {
  x: number;
  z: number;
  /** 船头朝向（局部 +X 对齐河道切向） */
  rot: number;
}

/** 沿河道取点停船：避开河心，靠一侧岸边 */
function pickBoatSpots(): BoatSpot[] {
  const spots: BoatSpot[] = [];
  let seed = 3;

  for (const line of sceneGeometry.waterways) {
    for (let i = 0; i < line.length - 1 && spots.length < BOAT_CAP; i += 1) {
      const [x1, z1] = line[i];
      const [x2, z2] = line[i + 1];
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 60) continue;

      for (let d = 45; d < len - 35 && spots.length < BOAT_CAP; d += 140) {
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
        });
      }
    }
    if (spots.length >= BOAT_CAP) break;
  }
  return spots;
}

/**
 * 河道生机（M1 补充）：城内运河与环城河里停靠的乌篷船，
 * 位置沿真实河网取样、靠岸偏置，轻微上下浮动。
 */
export function CanalBoats() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const geo = useMemo(createBoatGeometry, []);
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, flatShading: true }),
    [],
  );
  const spots = useMemo(pickBoatSpots, []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const count = Math.max(1, spots.length);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    spots.forEach((spot, i) => {
      dummy.position.set(spot.x, WATER_Y, spot.z);
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
      dummy.position.set(spot.x, Math.sin(t * 0.8 + i * 1.7) * 0.02, spot.z);
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
