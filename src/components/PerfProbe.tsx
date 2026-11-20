import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { perfStats } from '../utils/perfStats';

/**
 * 性能采样：每 0.5s 记录一次帧率、draw call、三角面数（M1 验收口径）。
 */
export function PerfProbe() {
  const gl = useThree((state) => state.gl);
  const frames = useRef(0);
  const last = useRef(performance.now());

  useFrame(() => {
    frames.current += 1;
    const now = performance.now();
    const elapsed = now - last.current;
    if (elapsed >= 500) {
      perfStats.fps = Math.round((frames.current * 1000) / elapsed);
      perfStats.drawCalls = gl.info.render.calls;
      perfStats.triangles = gl.info.render.triangles;
      frames.current = 0;
      last.current = now;
    }
  });

  return null;
}
