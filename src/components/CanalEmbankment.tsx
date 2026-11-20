import { useMemo } from 'react';
import * as THREE from 'three';
import { sceneGeometry } from '../data/sceneGeometry';
import { useSandTable } from '../store/useSandTable';
import { buildEmbankmentGeometry } from '../utils/embankment';

/**
 * 城内运河驳岸：压顶石条 + 裙墙 + 河埠头 + 系船石，合并为单个 mesh（1 draw call）。
 * 与水面同高体系（2.4m），雪天整体提亮。
 */
export function CanalEmbankment() {
  const winter = useSandTable((state) => state.season === 'winter');
  const geometry = useMemo(() => buildEmbankmentGeometry(sceneGeometry.waterways), []);

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color={winter ? '#e4eaee' : '#a9a196'}
        roughness={0.96}
        side={THREE.DoubleSide}
        flatShading
      />
    </mesh>
  );
}
