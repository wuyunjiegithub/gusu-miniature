import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useSandTable } from '../store/useSandTable';
import { TOUR_DURATION, TOUR_SHOTS } from '../data/tourTimeline';

interface ControlsLike {
  target: THREE.Vector3;
  enabled: boolean;
  update: () => void;
}

interface Route {
  curve: THREE.CatmullRomCurve3;
  aim: THREE.CatmullRomCurve3;
  start: number;
  duration: number;
}

const toVec3 = ([x, y, z]: readonly [number, number, number]) => new THREE.Vector3(x, y, z);

/**
 * 全屏电影预览的相机导演：
 * 按 tourTimeline 的段落推进 Catmull-Rom 相机与注视点，独占镜头控制。
 * 进入时记录当前机位与昼夜，退出（Esc 或播完）原样还原，不打断用户构图。
 */
export function TourPreview() {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const controls = useThree((state) => state.controls) as unknown as ControlsLike | null;
  const active = useSandTable((state) => state.previewActive);

  const routes = useMemo<Route[]>(() => {
    let cursor = 0;
    return TOUR_SHOTS.map((shot) => {
      const route: Route = {
        curve: new THREE.CatmullRomCurve3(shot.camera.map(toVec3), false, 'centripetal', 0.5),
        aim: new THREE.CatmullRomCurve3(shot.target.map(toVec3), false, 'centripetal', 0.5),
        start: cursor,
        duration: shot.duration,
      };
      cursor += shot.duration;
      return route;
    });
  }, []);

  const startRef = useRef<number | null>(null);
  const shotRef = useRef(-1);
  const savedRef = useRef<{
    cam: THREE.Vector3;
    target: THREE.Vector3;
    fov: number;
    time: 'day' | 'night';
  } | null>(null);

  useEffect(() => {
    if (!active || !controls) return;
    const { time } = useSandTable.getState();
    savedRef.current = {
      cam: camera.position.clone(),
      target: controls.target.clone(),
      fov: camera.fov,
      time,
    };
    controls.enabled = false;
    camera.up.set(0, 1, 0);
    startRef.current = performance.now();
    shotRef.current = -1;

    return () => {
      const saved = savedRef.current;
      controls.enabled = true;
      if (saved) {
        camera.position.copy(saved.cam);
        controls.target.copy(saved.target);
        camera.fov = saved.fov;
        camera.updateProjectionMatrix();
        camera.lookAt(controls.target);
        controls.update();
        useSandTable.getState().setTime(saved.time);
      }
      startRef.current = null;
      shotRef.current = -1;
      savedRef.current = null;
    };
  }, [active, camera, controls]);

  useFrame(() => {
    if (!active || !controls || startRef.current === null) return;
    const elapsed = (performance.now() - startRef.current) / 1000;
    if (elapsed >= TOUR_DURATION) {
      useSandTable.getState().exitPreview();
      return;
    }

    let index = routes.length - 1;
    for (let i = 0; i < routes.length; i += 1) {
      if (elapsed < routes[i].start + routes[i].duration) {
        index = i;
        break;
      }
    }
    const route = routes[index];
    const shot = TOUR_SHOTS[index];
    const local = THREE.MathUtils.clamp((elapsed - route.start) / route.duration, 0, 1);

    camera.position.copy(route.curve.getPointAt(local));
    camera.lookAt(route.aim.getPointAt(local));
    const fov = shot.fov[0] + (shot.fov[1] - shot.fov[0]) * local;
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    if (shotRef.current !== index) {
      shotRef.current = index;
      const state = useSandTable.getState();
      state.setPreviewCaption(shot.caption);
      if (shot.time) {
        state.setTime(shot.time);
        // 昼夜切换用一个黑场闪接遮住光照突变（见 PreviewOverlay）
        if (shot.time === 'night') window.dispatchEvent(new Event('tour:dusk'));
      }
    }
  });

  return null;
}
