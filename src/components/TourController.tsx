import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { CITY_TOUR, KF_START, TOUR_TOTAL_MS } from '../data/tourRoutes';
import { useSandTable } from '../store/useSandTable';

interface ControlsLike {
  target: THREE.Vector3;
  enabled: boolean;
  update: () => void;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
}

/** power2.inOut */
function smooth(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}
function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}
function easeIn(t: number): number {
  return t * t * t;
}
function applyEase(kind: string | undefined, t: number): number {
  if (kind === 'linear') return t;
  if (kind === 'easeOut') return easeOut(t);
  if (kind === 'easeIn') return easeIn(t);
  return smooth(t);
}

interface Pose {
  pos: THREE.Vector3;
  target: THREE.Vector3;
}

function poseOf(index: number): Pose {
  const f = CITY_TOUR.keyframes[index];
  return {
    pos: new THREE.Vector3(...f.pos),
    target: new THREE.Vector3(...f.target),
  };
}

/**
 * 电影级整体漫游控制器：与 CameraRig 互斥，漫游期间唯一相机写入者。
 *
 * 时间推进用「墙钟累计」（不受帧率影响，暂停精确冻结）；相机位置用前/后关键帧
 * 推导的 Catmull-Rom 平滑插值，让全景环绕→俯冲→旋转→景点跳转是一条连续镜头，
 * 而不是在每个景点急停再重新起步。
 */
export function TourController() {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as unknown as ControlsLike | null;

  const wasActive = useRef(false);
  const clock = useRef(0); // 已播放的漫游毫秒数（暂停时不增长）
  const lastWall = useRef(0);
  const lastIndex = useRef(-1);
  const lastProgressPush = useRef(0);
  const curPos = useRef(new THREE.Vector3());
  const curTarget = useRef(new THREE.Vector3());

  // 用户鼠标拖动/滚轮时中断漫游
  useEffect(() => {
    if (!controls) return;
    const onUserInput = () => {
      if (useSandTable.getState().tour.active) useSandTable.getState().exitTour();
    };
    controls.addEventListener('start', onUserInput);
    return () => controls.removeEventListener('start', onUserInput);
  }, [controls]);

  useFrame(() => {
    const state = useSandTable.getState();
    const tour = state.tour;
    const now = performance.now();

    if (!tour.active) {
      if (wasActive.current && controls) controls.enabled = true;
      wasActive.current = false;
      lastIndex.current = -1;
      return;
    }
    if (!controls) return;

    if (!wasActive.current) {
      wasActive.current = true;
      controls.enabled = false;
      clock.current = 0;
      lastWall.current = now;
      lastIndex.current = -1;
      // 从当前相机位姿切入首帧，避免开场跳变
      curPos.current.copy(camera.position);
      curTarget.current.copy(controls.target);
    }

    // 墙钟增量：暂停不累计，倍速直接乘；单帧上限 3s 容忍低帧率/防后台跳变
    const wallDelta = Math.min(now - lastWall.current, 3000);
    lastWall.current = now;
    if (!tour.paused) clock.current += wallDelta * tour.speed;

    // 终点：退出漫游
    if (clock.current >= TOUR_TOTAL_MS) {
      state.setTourProgress(1);
      state.exitTour();
      return;
    }

    // 定位当前关键帧区间
    const frames = CITY_TOUR.keyframes;
    let i = frames.length - 2;
    if (i < 0) i = 0;
    for (let k = KF_START.length - 1; k >= 0; k -= 1) {
      if (clock.current >= KF_START[k]) { i = k; break; }
    }
    i = Math.min(Math.max(i, 0), frames.length - 2);

    const frame = frames[i];
    const next = frames[i + 1];
    const segStart = KF_START[i];
    const t = Math.min(1, Math.max(0, (clock.current - segStart) / frame.ms));

    // 取前后关键帧做 Catmull-Rom：p1=当前起点，p2=下一帧终点；
    // p0/p3 提供切线，让镜头经过关键点时速度与方向连续。
    const p1 = poseOf(i);
    const p2 = poseOf(i + 1);
    const p0 = poseOf(Math.max(0, i - 1));
    const p3 = poseOf(Math.min(frames.length - 1, i + 2));
    const k = applyEase(frame.ease, t);

    catmull(p0.pos, p1.pos, p2.pos, p3.pos, k, curPos.current);
    catmull(p0.target, p1.target, p2.target, p3.target, k, curTarget.current);

    camera.position.copy(curPos.current);
    controls.target.copy(curTarget.current);
    camera.lookAt(controls.target);
    controls.update();

    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__tourCam = {
        x: camera.position.x, y: camera.position.y, z: camera.position.z,
      };
    }

    // HUD 同步：帧序号、字幕、进度（每 ~100ms 写一次，避免高频重渲染）
    if (i !== tour.index) state.setTourIndex(i);
    if (now - lastProgressPush.current > 100) {
      lastProgressPush.current = now;
      state.setTourProgress(clock.current / TOUR_TOTAL_MS);
    }
  });

  return null;
}

/** 均匀 Catmull-Rom 插值，结果写入 out */
function catmull(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, t: number, out: THREE.Vector3) {
  const t2 = t * t;
  const t3 = t2 * t;
  out.set(
    0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
  );
}
