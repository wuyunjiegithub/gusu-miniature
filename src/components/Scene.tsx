import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { OrbitControls } from '@react-three/drei';
import { CAMERA_LIMITS, PANORAMA_VIEW } from '../constants/geo';
import { useSandTable } from '../store/useSandTable';
import { BasePlatform } from './BasePlatform';
import { Hills } from './Hills';
import { Jianchi } from './Jianchi';
import { WaterSystem } from './WaterSystem';
import { Outskirts } from './Outskirts';
import { EnvironmentRig } from './EnvironmentRig';
import { Roads } from './Roads';
import { RoadMarkings } from './RoadMarkings';
import { Transit } from './Transit';
import { CanalBridges } from './CanalBridges';
import { CanalEmbankment } from './CanalEmbankment';
import { CanalBoats } from './CanalBoats';
import { CityWall } from './CityWall';
import { CityGates } from './CityGates';
import { Trees } from './Trees';
import { BuildingField } from './BuildingField';
import { NightLights } from './NightLights';
import { Landmarks } from './Landmarks';
import { ProceduralLandmarks } from './ProceduralLandmarks';
import { Heritage } from './Heritage';
import { Panmen } from './Panmen';
import { LandmarkLabels } from './LandmarkLabels';
import { CameraRig, DebugCamera, PanBounds } from './CameraRig';
import { TourController } from './TourController';
import { LodWatcher } from './LodWatcher';
import { PerfProbe } from './PerfProbe';
import { CameraPoseSync } from './CameraPoseSync';
import { useBuildings } from '../hooks/useBuildings';
import { useRoads } from '../hooks/useRoads';

/**
 * 主场景：Canvas 管理相机与事件，业务状态经 store 驱动（FR-06 轨道控制）
 */

/**
 * 图层排查开关（仅开发环境）：`?hide=roads,banks,gates,wall,bridges`。
 * 定位"这块几何是谁画的"时，逐个图层关掉比读代码快得多。
 */
const HIDDEN: Record<string, boolean> = (() => {
  if (!import.meta.env.DEV || typeof window === 'undefined') return {};
  const raw = new URLSearchParams(window.location.search).get('hide');
  const out: Record<string, boolean> = {};
  raw?.split(',').forEach((key) => {
    if (key) out[key.trim()] = true;
  });
  return out;
})();
const shown = (key: string): boolean => !HIDDEN[key];

/**
 * 调试钩子（仅开发环境）：把 scene 挂到 window，便于用 puppeteer 反查
 * "这块几何到底是哪个组件画的"。生产构建里整段被摇掉。
 */
function DebugSceneHook() {
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls);
  useEffect(() => {
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__scene = scene;
      w.__THREE = THREE;
      w.__camera = camera;
      w.__controls = controls;
    }
  }, [scene, camera, controls]);
  return null;
}


/**
 * 启动页收尾：index.html 里的 #boot 是一层纯静态画面，负责在"主线程被首帧
 * 计算锁死"的那几秒里给用户一个明确反馈。
 * 等建筑与路网数据都进场景、并且真的画出了两帧之后，再淡出移除——
 * 早一帧移除的话会露出还没铺满建筑的空地，反而更像卡住了。
 */
function BootGate() {
  const buildings = useBuildings();
  const roads = useRoads();
  const frames = useRef(0);
  const done = useRef(false);

  useFrame(() => {
    if (done.current) return;
    frames.current += 1;
    if (frames.current < 2 || !buildings || !roads) return;
    done.current = true;
    const boot = document.getElementById('boot');
    if (!boot) return;
    boot.classList.add('is-done');
    window.setTimeout(() => boot.remove(), 360);
  });

  // 兜底：数据接口异常时也别让启动页永远糊在上面
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const boot = document.getElementById('boot');
      if (boot) {
        boot.classList.add('is-done');
        window.setTimeout(() => boot.remove(), 360);
      }
    }, 25000);
    return () => window.clearTimeout(timer);
  }, []);

  return null;
}

export function Scene() {
  const select = useSandTable((state) => state.select);

  return (
    <Canvas
      camera={{
        position: [PANORAMA_VIEW.position.x, PANORAMA_VIEW.position.y, PANORAMA_VIEW.position.z],
        fov: 50,
        near: 20,
        far: 20000,
      }}
      dpr={[1, 1.5]}
      shadows="soft"
      // 场景纵深 16km 且路面/水面/底座间距只有 1~2m，用对数深度缓冲避免远近切换时 z-fighting
      gl={{ antialias: true, logarithmicDepthBuffer: true }}
      // 用户主动拖动/滚轮时中断漫游，把相机交还给手动控制
      onPointerDown={() => {
        if (useSandTable.getState().tour.active) useSandTable.getState().exitTour();
      }}
      onWheel={() => {
        if (useSandTable.getState().tour.active) useSandTable.getState().exitTour();
      }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.1;
        // 每次 program 链接后 three 都会同步读 shader 日志，几十个材质叠加起来
        // 是首屏明显的一段停顿。生产环境关掉；开发环境保留，否则注入的
        // onBeforeCompile 着色器出错时会被静默吞掉。
        if (import.meta.env.PROD) gl.debug.checkShaderErrors = false;
      }}
      onPointerMissed={() => select(null)}
    >
      <EnvironmentRig />

      {/* 场景分层：外围陆地/片区 → 底座 → 山体 → 水面 → 道路 → 城墙 → 树木 → 建筑群（含城外白模）→ 景点 */}
      {shown('outer') && <Outskirts />}
      {shown('base') && <BasePlatform />}
      <Hills />
      <Jianchi />
      {shown('water') && <WaterSystem />}
      {/* 标定物：?mark=1 在盘门水门正南放三个洋红方块（z=2400/2470/2540），用来自查几何落在哪 */}
      {import.meta.env.DEV && HIDDEN.mark && (
        <>
          {[2400, 2470, 2540].map((z) => (
            <mesh key={z} position={[-766, 14, z]}>
              <boxGeometry args={[26, 26, 26]} />
              <meshBasicMaterial color="#ff00ff" />
            </mesh>
          ))}
        </>
      )}
      {shown('roads') && <Roads />}
      {shown('markings') && <RoadMarkings />}
      <Transit />
      {shown('bridges') && <CanalBridges />}
      {shown('banks') && <CanalEmbankment />}
      {shown('boats') && <CanalBoats />}
      {shown('wall') && <CityWall />}
      {shown('gates') && <CityGates />}
      {shown('trees') && <Trees />}
      {shown('buildings') && <BuildingField />}
      <NightLights />
      {shown('landmarks') && <Landmarks />}
      {shown('landmarks') && <ProceduralLandmarks />}
      {shown('landmarks') && <Heritage />}
      {shown('landmarks') && <Panmen />}
      <LandmarkLabels />

      <CameraRig />
      <TourController />
      <PanBounds />
      <LodWatcher />
      <PerfProbe />
      <CameraPoseSync />
      <BootGate />
      <DebugSceneHook />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        // 允许右键拖拽平移；PanBounds 每帧把目标限制在沙盘范围内，防止拖出底座
        enablePan
        screenSpacePanning={false}
        panSpeed={0.7}
        minDistance={CAMERA_LIMITS.minDistance}
        maxDistance={CAMERA_LIMITS.maxDistance}
        maxPolarAngle={CAMERA_LIMITS.maxPolarAngle}
      />
      {/* 调试机位必须排在 OrbitControls 之后：useFrame 按挂载顺序执行，
          放后面才能保证每帧最后落位，不被控制器的阻尼重算拉回全景。 */}
      <DebugCamera />
    </Canvas>
  );
}