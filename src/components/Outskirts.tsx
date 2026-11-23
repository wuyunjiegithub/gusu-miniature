import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { buildOuterCity, OUTER_GROUND_Y, TOWER_COLORS } from '../data/outerCity';
import { useSandTable } from '../store/useSandTable';
import { useRoads } from '../hooks/useRoads';
import { MODERN_ROOF_COLORS, MODERN_WALL_COLORS } from '../constants/palette';
import { createFacadeMaterial } from '../materials/facade';

const hash = (i: number): number => {
  const v = Math.sin(i * 78.233 + 11.7) * 43758.5453;
  return v - Math.floor(v);
};

/**
 * 外围片区（M1 补充，艺术化）：古城外约 3–5.8km（西至寒山寺）的连续城市蔓延。
 * 3km 以内使用真实 OSM 建筑；此层负责更远处的街景肌理——
 * 沿真实 OSM 主干道/街巷在两旁填充现代街区：浅灰混凝土墙、平屋面女儿墙、
 * 屋顶设备与少量玻璃高层，与古城粉墙黛瓦形成时代分界。
 * 体块数据由 data/outerCity 统一生成，夜景灯光复用同一份。
 */
export function Outskirts() {
  const wallRef = useRef<THREE.InstancedMesh>(null);
  const roofRef = useRef<THREE.InstancedMesh>(null);
  const roofUnitRef = useRef<THREE.InstancedMesh>(null);
  const towerRef = useRef<THREE.InstancedMesh>(null);
  const towerCapRef = useRef<THREE.InstancedMesh>(null);
  const winter = useSandTable((state) => state.season === 'winter');
  const night = useSandTable((state) => state.time === 'night');
  const roads = useRoads();

  const city = useMemo(() => (roads ? buildOuterCity(roads) : null), [roads]);
  const blocks = city?.blocks ?? [];
  const towers = city?.towers ?? [];

  const wallGeometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), []);
  /** 立面复用城内同一套着色器（现代分支）：玻璃带、窗光、冬霜 */
  const facadeUniformsRef = useRef<{ night: { value: number }; frost: { value: number } } | null>(null);
  const wallMaterial = useMemo(() => {
    const facade = createFacadeMaterial(true, night, winter);
    facadeUniformsRef.current = facade.uniforms;
    return facade.material;
  }, []);

  useEffect(() => {
    if (!facadeUniformsRef.current) return;
    facadeUniformsRef.current.night.value = night ? 1 : 0;
    facadeUniformsRef.current.frost.value = winter ? 1 : 0;
  }, [night, winter]);
  const roofMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ roughness: 0.9 }),
    [],
  );
  /** 屋顶设备（水箱 / 空调机组 / 楼梯间） */
  const roofUnitMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#6f767c', roughness: 0.92 }),
    [],
  );
  /** 现代高层：冷灰玻璃幕墙 */
  const towerMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.28 }),
    [],
  );
  const towerCapMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#4d545a', roughness: 0.9 }),
    [],
  );

  useLayoutEffect(() => {
    const walls = wallRef.current;
    const roofs = roofRef.current;
    const roofUnits = roofUnitRef.current;

    if (walls && roofs) {
      const dummy = new THREE.Object3D();
      const color = new THREE.Color();
      blocks.forEach((block, i) => {
        dummy.position.set(block.x, OUTER_GROUND_Y, block.z);
        dummy.rotation.set(0, block.rot, 0);
        dummy.scale.set(block.w, block.h, block.d);
        dummy.updateMatrix();
        walls.setMatrixAt(i, dummy.matrix);
        color.set(
          winter
            ? '#eef2f5'
            : MODERN_WALL_COLORS[Math.floor(hash(i + 23) * MODERN_WALL_COLORS.length)],
        );
        walls.setColorAt(i, color);

        // 平屋面 + 薄女儿墙压顶
        dummy.position.set(block.x, OUTER_GROUND_Y + block.h, block.z);
        dummy.rotation.set(0, block.rot, 0);
        dummy.scale.set(block.w * 1.03, 0.9, block.d * 1.03);
        dummy.updateMatrix();
        roofs.setMatrixAt(i, dummy.matrix);
        color.set(
          winter
            ? '#e3e9ee'
            : MODERN_ROOF_COLORS[Math.floor(hash(i + 61) * MODERN_ROOF_COLORS.length)],
        );
        roofs.setColorAt(i, color);

        // 约三成屋顶放设备箱，打破平屋顶的单调轮廓
        if (roofUnits) {
          if (hash(i * 3.7 + 31) < 0.3) {
            dummy.position.set(
              block.x + (hash(i + 7) - 0.5) * block.w * 0.45,
              OUTER_GROUND_Y + block.h + 0.9,
              block.z + (hash(i + 11) - 0.5) * block.d * 0.45,
            );
            dummy.rotation.set(0, block.rot, 0);
            dummy.scale.set(
              2.4 + hash(i + 13) * 3.2,
              1.2 + hash(i + 17) * 1.4,
              2.2 + hash(i + 19) * 2.8,
            );
          } else {
            dummy.scale.set(0, 0, 0);
          }
          dummy.updateMatrix();
          roofUnits.setMatrixAt(i, dummy.matrix);
        }
      });
      walls.instanceMatrix.needsUpdate = true;
      roofs.instanceMatrix.needsUpdate = true;
      if (walls.instanceColor) walls.instanceColor.needsUpdate = true;
      if (roofs.instanceColor) roofs.instanceColor.needsUpdate = true;
      if (roofUnits) roofUnits.instanceMatrix.needsUpdate = true;
    }

    const towersMesh = towerRef.current;
    const capsMesh = towerCapRef.current;
    if (!towersMesh || !capsMesh) return;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    towers.forEach((tower, i) => {
      dummy.position.set(tower.x, OUTER_GROUND_Y, tower.z);
      dummy.rotation.set(0, tower.rot, 0);
      dummy.scale.set(tower.w, tower.h, tower.d);
      dummy.updateMatrix();
      towersMesh.setMatrixAt(i, dummy.matrix);
      color.set(TOWER_COLORS[i % TOWER_COLORS.length]);
      towersMesh.setColorAt(i, color);

      dummy.position.set(tower.x, OUTER_GROUND_Y + tower.h, tower.z);
      dummy.scale.set(tower.w * 1.02, 1.6, tower.d * 1.02);
      dummy.updateMatrix();
      capsMesh.setMatrixAt(i, dummy.matrix);
    });
    towersMesh.instanceMatrix.needsUpdate = true;
    capsMesh.instanceMatrix.needsUpdate = true;
    if (towersMesh.instanceColor) towersMesh.instanceColor.needsUpdate = true;
  }, [blocks, towers, winter]);

  const count = Math.max(1, blocks.length);
  const towerCount = Math.max(1, towers.length);
  return (
    <group>
      <instancedMesh
        ref={wallRef}
        args={[wallGeometry, wallMaterial, count]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={roofRef}
        args={[wallGeometry, roofMaterial, count]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={roofUnitRef}
        args={[wallGeometry, roofUnitMaterial, count]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={towerRef}
        args={[wallGeometry, towerMaterial, towerCount]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={towerCapRef}
        args={[wallGeometry, towerCapMaterial, towerCount]}
        frustumCulled={false}
      />
    </group>
  );
}
