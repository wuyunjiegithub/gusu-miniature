import type { CSSProperties } from 'react';
import { Html } from '@react-three/drei';
import { LANDMARKS } from '../data/landmarks';
import { sceneGeometry } from '../data/sceneGeometry';
import { useSandTable } from '../store/useSandTable';
import { LANDMARK_TYPE_COLORS } from '../constants/palette';
import { localToVector3 } from '../utils/geo';
import { filterLandmarks } from '../utils/filterLandmarks';
import { HERITAGE_LANDMARKS } from '../data/heritage';
import { heritageAnchor } from '../data/heritageFootprints';

/**
 * 景点标签（FR-08）：屏幕空间 HTML 钉在 3D 坐标上，位置取统一坐标系中的质心。
 * 所有有几何数据的景点都常显（不再按 LOD 只剩 P0），
 * 左侧色点按景点类型取色，P0 用主标签、其余用次标签，避免全景下过密。
 */
export function LandmarkLabels() {
  const selectedId = useSandTable((state) => state.selectedId);
  const select = useSandTable((state) => state.select);
  const lod = useSandTable((state) => state.lod);
  const filters = useSandTable((state) => state.filters);

  const heritageLevel = new Map(HERITAGE_LANDMARKS.map((h) => [h.id, h.level]));

  // 与侧栏共享筛选条件：搜索/筛选后场景标签同步收敛。
  // 文保单位（P3）数量多，全景（L0）下与主景点标签叠成一片；
  // 只在近景/中景（L1/L2）显示，放大后逐处浮现，保持全景可读。
  const visible = filterLandmarks(LANDMARKS, filters, heritageLevel).filter((landmark) => {
    if (!sceneGeometry.landmarks[landmark.id]) return false;
    if (landmark.priority === 'P3' && lod === 'L0') return false;
    return true;
  });

  return (
    <group>
      {visible.map((landmark) => {
        const centroid = sceneGeometry.landmarks[landmark.id].centroid;
        // 文保院落按路网避让会离开 OSM 质心几十米，标签跟着院落走才不会飘在半空
        const [x, z] = heritageLevel.has(landmark.id)
          ? heritageAnchor(landmark.id, [centroid.x, centroid.z])
          : [centroid.x, centroid.z];
        const major = landmark.priority === 'P0';
        const style = { '--accent': LANDMARK_TYPE_COLORS[landmark.type] } as CSSProperties;
        const className = [
          'landmark-label',
          major ? 'is-major' : '',
          selectedId === landmark.id ? 'is-active' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <Html
            key={landmark.id}
            position={localToVector3([x, z], major ? 72 : 58)}
            center
            zIndexRange={[10, 0]}
          >
            <button type="button" className={className} style={style} onClick={() => select(landmark.id)}>
              {landmark.name}
            </button>
          </Html>
        );
      })}
    </group>
  );
}
