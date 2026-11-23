import { useFrame, useThree } from '@react-three/fiber';
import { PerspectiveCamera } from 'three';
import { cameraPose } from '../utils/cameraPose';

/**
 * 每帧把相机注视目标写入共享的可变对象，供 Canvas 外的小地图画"当前视点"指示器。
 * 不写 zustand、不触发 React 重渲染（与 perfStats 同范式）。
 */
export function CameraPoseSync() {
  const controls = useThree((state) => state.controls) as unknown as
    | { target: { x: number; y: number; z: number } }
    | null;
  const viewportHeight = useThree((state) => state.size.height);

  useFrame(({ camera }) => {
    const target = controls?.target ?? camera.position;
    cameraPose.x = target.x;
    cameraPose.y = target.y;
    cameraPose.z = target.z;

    const dx = target.x - camera.position.x;
    const dy = target.y - camera.position.y;
    const dz = target.z - camera.position.z;
    const distance = Math.hypot(dx, dy, dz);
    cameraPose.distance = distance;

    if (Math.hypot(dx, dz) > 0.001) {
      cameraPose.heading = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
    }
    if (camera instanceof PerspectiveCamera && viewportHeight > 0) {
      cameraPose.metersPerPixel =
        (2 * distance * Math.tan(camera.fov * Math.PI / 360)) / viewportHeight;
    }
  });
  return null;
}
