import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { buildOuterCity, OUTER_GROUND_Y, TOWER_COLORS } from '../data/outerCity';
import { useSandTable } from '../store/useSandTable';
import { useRoads } from '../hooks/useRoads';
import { createPitchedRoofGeometry } from '../utils/roof';
import { ROOF_COLORS, WALL_COLORS } from '../constants/palette';

const hash = (i: number): number => {
  const v = Math.sin(i * 78.233 + 11.7) * 43758.5453;
  return v - Math.floor(v);
};

/**
 * 外围片区（M1 补充，艺术化）：古城外约 3–5.8km（西至寒山寺）的连续城市蔓延。
 * 3km 以内使用真实 OSM 建筑；此层负责更远处的街景肌理——
 * 沿真实 OSM 主干道/街巷在两旁填充带坡顶的民居商铺，
 * 另在主干道旁点缀少量高层，避免城外只剩一片空地。
 * 体块数据由 data/outerCity 统一生成，夜景灯光复用同一份。
 */
export function Outskirts() {
  const wallRef = useRef<THREE.InstancedMesh>(null);
  const roofRef = useRef<THREE.InstancedMesh>(null);
  const towerRef = useRef<THREE.InstancedMesh>(null);
  const towerCapRef = useRef<THREE.InstancedMesh>(null);
  const winter = useSandTable((state) => state.season === 'winter');
  const roads = useRoads();

  const city = useMemo(() => (roads ? buildOuterCity(roads) : null), [roads]);
  const blocks = city?.blocks ?? [];
  const towers = city?.towers ?? [];

  const wallGeometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), []);
  const roofGeometry = useMemo(() => createPitchedRoofGeometry(), []);
  const wallMaterial = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.95 }), []);
  const roofMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ roughness: 0.88, side: THREE.DoubleSide }),
    [],
  );
  const towerMaterial = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.82 }), []);
  const towerCapMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#6c7178', roughness: 0.9 }),
    [],
  );

  useLayoutEffect(() => {
    const walls = wallRef.current;
    const roofs = roofRef.current;

    if (walls && roofs) {
      const dummy = new THREE.Object3D();
      const color = new THREE.Color();
      blocks.forEach((block, i) => {
        dummy.position.set(block.x, OUTER_GROUND_Y, block.z);
        dummy.rotation.set(0, block.rot, 0);
        dummy.scale.set(block.w, block.h, block.d);
        dummy.updateMatrix();
        walls.setMatrixAt(i, dummy.matrix);
        color.set(winter ? '#eef2f5' : WALL_COLORS[Math.floor(hash(i + 23) * WALL_COLORS.length)]);
        walls.setColorAt(i, color);

        dummy.position.set(block.x, OUTER_GROUND_Y + block.h, block.z);
        dummy.scale.set(block.w * 1.1, block.roofH, block.d * 1.1);
        dummy.updateMatrix();
        roofs.setMatrixAt(i, dummy.matrix);
        color.set(winter ? '#e3e9ee' : ROOF_COLORS[Math.floor(hash(i + 61) * ROOF_COLORS.length)]);
        roofs.setColorAt(i, color);
      });
      walls.instanceMatrix.needsUpdate = true;
      roofs.instanceMatrix.needsUpdate = true;
      if (walls.instanceColor) walls.instanceColor.needsUpdate = true;
      if (roofs.instanceColor) roofs.instanceColor.needsUpdate = true;
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
      <instancedMesh ref={wallRef} args={[wallGeometry, wallMaterial, count]} frustumCulled={false} />
      <instancedMesh ref={roofRef} args={[roofGeometry, roofMaterial, count]} frustumCulled={false} />
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
