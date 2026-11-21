import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { LOD_THRESHOLDS } from '../constants/geo';
import { useSandTable } from '../store/useSandTable';
import type { LodLevel } from '../types';

/**
 * 每帧根据「相机到注视点的实际距离」推导 LOD 层级（FR-11）。
 * 用相机到城心的距离有个陷阱：盘门、寒山寺等景点在城心 2.7km 之外，
 * 飞到景点近景时到城心仍然很远，会被误判成全景 L0，细节层被错误关掉。
 * 因此这里改取相机到轨道控制注视点（OrbitControls.target）的距离，
 * 这才是"我缩放到多近"的真实尺度。
 * 仅在层级实际变化时写 store，避免每帧触发 React 重渲染。
 */
export function useLodLevel(): void {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls);
  const setLod = useSandTable((state) => state.setLod);

  useFrame(() => {
    const target = (controls as { target?: THREE.Vector3 } | null)?.target;
    const distance = target ? camera.position.distanceTo(target) : camera.position.length();
    const next: LodLevel =
      distance > LOD_THRESHOLDS.L0_MIN ? 'L0' : distance < LOD_THRESHOLDS.L2_MAX ? 'L2' : 'L1';
    if (next !== useSandTable.getState().lod) {
      setLod(next);
    }
  });
}
