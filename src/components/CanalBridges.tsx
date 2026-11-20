import { useMemo } from 'react';
import { useRoads } from '../hooks/useRoads';
import { useSandTable } from '../store/useSandTable';
import { buildBridgeGeometry, computeBridgeSites } from '../utils/bridges';

/**
 * 城内石桥：由道路与河道交点自动定位，全部桥合并为一个几何体。
 * 桥面高于水面 1m 以上，两侧有石栏板与立柱，桥下为石墩。
 */
export function CanalBridges() {
  const roads = useRoads();
  const winter = useSandTable((state) => state.season === 'winter');

  const geometry = useMemo(
    () => (roads ? buildBridgeGeometry(computeBridgeSites(roads)) : null),
    [roads],
  );

  if (!geometry) return null;

  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial
        color={winter ? '#e6ecef' : '#9b988e'}
        roughness={0.95}
        flatShading
      />
    </mesh>
  );
}
