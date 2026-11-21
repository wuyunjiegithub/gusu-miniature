import { useMemo } from 'react';
import { useRoads } from '../hooks/useRoads';
import { useSandTable } from '../store/useSandTable';
import { buildBridgeGeometry, computeBridgeSites } from '../utils/bridges';
import { createRoadMaterial } from './Roads';

/**
 * 城内石桥：由道路与河道交点自动定位，全部桥合并为两组几何（桥面 / 石作）。
 *
 * 两种形态：
 *   · 城内河道水面高于路面 → 石拱桥，桥面拱起但仍是沥青路面，
 *     车道线从两端路面连续铺过（几何里带 aRoad，直接复用道路材质）；
 *   · 城外山塘河/上塘河水面低于路面 → 平桥，桥面压到路面下 2cm，
 *     由路面（含车道线）直接铺过，桥体只露出栏板、腹板与下到河床的桥墩。
 */
export function CanalBridges() {
  const roads = useRoads();
  const winter = useSandTable((state) => state.season === 'winter');

  const geometry = useMemo(() => {
    if (!roads) return null;
    return buildBridgeGeometry(computeBridgeSites(roads));
  }, [roads]);

  // 拱桥桥面吃同一套道路标线材质：过桥时边线/虚线不会突然消失
  const archMat = useMemo(
    () => createRoadMaterial(winter ? '#43474b' : '#3c3f43', winter ? 0.93 : 0.8, '#efe9d6'),
    [winter],
  );

  if (!geometry) return null;

  return (
    <group>
      {geometry.flatDeck.getAttribute('position').count > 0 && (
        <mesh geometry={geometry.flatDeck} castShadow receiveShadow>
          <meshStandardMaterial color={winter ? '#4b4f53' : '#45484c'} roughness={0.9} />
        </mesh>
      )}
      {geometry.archDeck.getAttribute('position').count > 0 && (
        <mesh geometry={geometry.archDeck} material={archMat} castShadow receiveShadow />
      )}
      <mesh geometry={geometry.stone} castShadow receiveShadow>
        <meshStandardMaterial
          color={winter ? '#e6ecef' : '#9b988e'}
          roughness={0.95}
          flatShading
        />
      </mesh>
    </group>
  );
}
