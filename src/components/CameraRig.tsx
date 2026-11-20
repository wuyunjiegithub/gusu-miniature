import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { PANORAMA_VIEW } from '../constants/geo';
import { useSandTable } from '../store/useSandTable';
import { sceneGeometry } from '../data/sceneGeometry';

interface ControlsLike {
  target: THREE.Vector3;
  enabled: boolean;
  update: () => void;
}

interface CameraAnim {
  active: boolean;
  t: number;
  fromCam: THREE.Vector3;
  toCam: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
}

const FLY_DURATION = 1.2;

/** 平滑加减速（与 power2.inOut 一致） */
function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/**
 * 景点聚焦动画（FR-09）：选中 → 相机平滑推近至景点；
 * 取消选中 → 同一套动画反向回到全景。动画期间禁用轨道控制避免争抢相机。
 *
 * 用 useFrame 驱动而不是 gsap：OrbitControls 每帧都会用 target + offset
 * 重算相机位置，外部补间容易被打断，直接在渲染循环里插值最稳定。
 */
export function CameraRig() {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as unknown as ControlsLike | null;
  const selectedId = useSandTable((state) => state.selectedId);
  const animRef = useRef<CameraAnim | null>(null);

  useEffect(() => {
    if (!controls) return;

    const geo = selectedId ? sceneGeometry.landmarks[selectedId] : undefined;
    const centroid = geo?.centroid;

    let toCam: THREE.Vector3;
    let toTarget: THREE.Vector3;

    if (centroid) {
      // 按景点轮廓尺度自适应推近距离，避免小景点过近、大景区被截断
      let span = 300;
      if (geo?.outline?.length) {
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const [x, z] of geo.outline) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
        span = Math.max(maxX - minX, maxZ - minZ);
      }
      const dist = Math.max(320, span * 1.35);
      toCam = new THREE.Vector3(
        centroid.x + dist * 0.62,
        dist * 0.5,
        centroid.z + dist * 0.62,
      );
      toTarget = new THREE.Vector3(centroid.x, 10, centroid.z);
    } else {
      toCam = new THREE.Vector3(
        PANORAMA_VIEW.position.x,
        PANORAMA_VIEW.position.y,
        PANORAMA_VIEW.position.z,
      );
      toTarget = new THREE.Vector3(
        PANORAMA_VIEW.target.x,
        PANORAMA_VIEW.target.y,
        PANORAMA_VIEW.target.z,
      );
    }

    animRef.current = {
      active: true,
      t: 0,
      fromCam: camera.position.clone(),
      toCam,
      fromTarget: controls.target.clone(),
      toTarget,
    };
    controls.enabled = false;

    return () => {
      animRef.current = null;
      controls.enabled = true;
    };
  }, [selectedId, camera, controls]);

  useFrame((_, delta) => {
    const anim = animRef.current;
    if (!controls || !anim?.active) return;

    anim.t = Math.min(1, anim.t + delta / FLY_DURATION);
    const k = easeInOut(anim.t);
    camera.position.lerpVectors(anim.fromCam, anim.toCam, k);
    controls.target.lerpVectors(anim.fromTarget, anim.toTarget, k);
    camera.lookAt(controls.target);
    // 同步一次轨道内部状态，避免动画结束后残留的阻尼增量把相机拽回去
    controls.update();

    if (anim.t >= 1) {
      anim.active = false;
      controls.enabled = true;
    }
  });

  return null;
}

/** 右键平移范围与最低相机高度（沙盘顶面 y=0，底座到 -24）。
 * 西侧寒山寺在 -5.45km，范围需覆盖到城外景点，否则聚焦时会被夹回 3.2km 处看到一片空地 */
const PAN_LIMIT = 5800;
const CAMERA_MIN_Y = 45;

/**
 * 平移边界（FR-06）：允许右键拖拽平移，但把轨道目标限制在沙盘范围内，
 * 并同步位移相机，避免把沙盘拖出视野或让镜头钻进地面。
 */
export function PanBounds() {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as unknown as ControlsLike | null;

  useFrame(() => {
    if (!controls) return;
    const target = controls.target;
    const cx = THREE.MathUtils.clamp(target.x, -PAN_LIMIT, PAN_LIMIT);
    const cy = THREE.MathUtils.clamp(target.y, 0, 90);
    const cz = THREE.MathUtils.clamp(target.z, -PAN_LIMIT, PAN_LIMIT);
    const dx = cx - target.x;
    const dy = cy - target.y;
    const dz = cz - target.z;
    if (dx || dy || dz) {
      target.set(cx, cy, cz);
      camera.position.x += dx;
      camera.position.y += dy;
      camera.position.z += dz;
    }
    if (camera.position.y < CAMERA_MIN_Y) camera.position.y = CAMERA_MIN_Y;
  });

  return null;
}
