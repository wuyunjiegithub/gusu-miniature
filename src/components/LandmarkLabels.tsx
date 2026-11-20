import type { CSSProperties } from 'react';
import { Html } from '@react-three/drei';
import { LANDMARKS } from '../data/landmarks';
import { sceneGeometry } from '../data/sceneGeometry';
import { useSandTable } from '../store/useSandTable';
import { LANDMARK_TYPE_COLORS } from '../constants/palette';
import { localToVector3 } from '../utils/geo';

/**
 * 景点标签（FR-08）：屏幕空间 HTML 钉在 3D 坐标上，位置取统一坐标系中的质心。
 * 所有有几何数据的景点都常显（不再按 LOD 只剩 P0），
 * 左侧色点按景点类型取色，P0 用主标签、其余用次标签，避免全景下过密。
 */
export function LandmarkLabels() {
  const selectedId = useSandTable((state) => state.selectedId);
  const select = useSandTable((state) => state.select);

  const visible = LANDMARKS.filter((landmark) => sceneGeometry.landmarks[landmark.id]);

  return (
    <group>
      {visible.map((landmark) => {
        const { x, z } = sceneGeometry.landmarks[landmark.id].centroid;
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
