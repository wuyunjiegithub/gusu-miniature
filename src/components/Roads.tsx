import { useMemo } from 'react';
import * as THREE from 'three';
import { useRoads } from '../hooks/useRoads';
import { useSandTable } from '../store/useSandTable';
import { buildRibbons } from '../utils/ribbon';
import { roadSurfaceY } from '../data/outerCity';

/** 道路面高（米）：抬高以避免远视距下的深度冲突 */
const MINOR_ROAD_Y = 1.2;
/** 主干道再抬高 0.1m：与支路在路口重叠时由深度缓冲稳定分出前后，避免共面闪烁 */
const MAJOR_ROAD_Y = 1.3;
const MAJOR_WIDTH = 26;
const MINOR_WIDTH = 11;

/**
 * 道路（M1）：OSM highway 折线 → 带状面，主干/支路各合并为一个 mesh（2 draw call）。
 * 路网已覆盖城外 3–5.8km，路面高度按半径从城内基准平滑降到外围地面。
 */
export function Roads() {
  const data = useRoads();
  const season = useSandTable((state) => state.season);
  /** 冬季路面覆一层薄霜，比春夏秋更浅更冷 */
  const winter = season === 'winter';

  const majorGeo = useMemo(
    () => (data ? buildRibbons(data.major, MAJOR_WIDTH, (x, z) => roadSurfaceY(x, z, MAJOR_ROAD_Y)) : null),
    [data],
  );
  const minorGeo = useMemo(
    () => (data ? buildRibbons(data.minor, MINOR_WIDTH, (x, z) => roadSurfaceY(x, z, MINOR_ROAD_Y)) : null),
    [data],
  );

  if (!data) return null;

  return (
    <group>
      {minorGeo && (
        <mesh geometry={minorGeo} receiveShadow>
          <meshStandardMaterial
            color={winter ? '#e3e9ee' : '#474a4e'}
            roughness={winter ? 1 : 0.82}
            metalness={winter ? 0 : 0.06}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      {majorGeo && (
        <mesh geometry={majorGeo} receiveShadow>
          <meshStandardMaterial
            color={winter ? '#dbe3ea' : '#3c3f43'}
            roughness={winter ? 1 : 0.8}
            metalness={winter ? 0 : 0.08}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
    </group>
  );
}
