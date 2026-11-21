import { useFrame, useThree } from '@react-three/fiber';
import { cameraPose } from '../utils/cameraPose';

/**
 * 每帧把相机注视目标写入共享的可变对象，供 Canvas 外的小地图画"当前视点"指示器。
 * 不写 zustand、不触发 React 重渲染（与 perfStats 同范式）。
 */
export function CameraPoseSync() {
  const controls = useThree((state) => state.controls) as unknown as
    | { target: { x: number; z: number } }
    | null;
  useFrame(({ camera }) => {
    if (controls?.target) {
      cameraPose.x = controls.target.x;
      cameraPose.z = controls.target.z;
    } else {
      cameraPose.x = camera.position.x;
      cameraPose.z = camera.position.z;
    }
    cameraPose.distance = camera.position.length();
  });
  return null;
}
