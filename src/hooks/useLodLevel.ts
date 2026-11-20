import { useFrame, useThree } from '@react-three/fiber';
import { LOD_THRESHOLDS } from '../constants/geo';
import { useSandTable } from '../store/useSandTable';
import type { LodLevel } from '../types';

/**
 * 每帧根据相机到城心的距离推导 LOD 层级（FR-11）。
 * 仅在层级实际变化时写 store，避免每帧触发 React 重渲染。
 */
export function useLodLevel(): void {
  const camera = useThree((state) => state.camera);
  const setLod = useSandTable((state) => state.setLod);

  useFrame(() => {
    const distance = camera.position.length();
    const next: LodLevel =
      distance > LOD_THRESHOLDS.L0_MIN ? 'L0' : distance < LOD_THRESHOLDS.L2_MAX ? 'L2' : 'L1';
    if (next !== useSandTable.getState().lod) {
      setLod(next);
    }
  });
}
