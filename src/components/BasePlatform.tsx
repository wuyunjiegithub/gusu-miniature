import { useMemo } from 'react';
import * as THREE from 'three';
import { BASE_THICKNESS } from '../constants/geo';
import { SEASON_LOOKS } from '../constants/seasons';
import { sceneGeometry } from '../data/sceneGeometry';
import { useSandTable } from '../store/useSandTable';

/**
 * 沙盘底座（FR-01）：真实古城轮廓（护城河闭合环，OSM 派生）拉伸成实体沙盘台。
 * Shape 点取 (x, -z)，配合 rotation.x=-π/2 使形状 y 轴映射到世界 -z。
 * 台面按季节取苔绿 / 冷灰色，作为街巷之间的地面底色。
 */
export function BasePlatform() {
  const season = useSandTable((state) => state.season);
  const look = SEASON_LOOKS[season];

  const geometry = useMemo(() => {
    const shape = new THREE.Shape(
      sceneGeometry.cityOutline.map(([x, z]) => new THREE.Vector2(x, -z)),
    );
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: BASE_THICKNESS,
      bevelEnabled: false,
    });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, -BASE_THICKNESS, 0); // 顶面落在 y=0
    return geo;
  }, []);

  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial color={look.ground} roughness={0.95} />
    </mesh>
  );
}
