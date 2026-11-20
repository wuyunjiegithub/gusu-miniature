import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { OrbitControls } from '@react-three/drei';
import { CAMERA_LIMITS, PANORAMA_VIEW } from '../constants/geo';
import { useSandTable } from '../store/useSandTable';
import { BasePlatform } from './BasePlatform';
import { Hills } from './Hills';
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
import { LandmarkLabels } from './LandmarkLabels';
import { CameraRig, DebugCamera, PanBounds } from './CameraRig';
import { LodWatcher } from './LodWatcher';
import { PerfProbe } from './PerfProbe';

/**
 * 主场景：Canvas 管理相机与事件，业务状态经 store 驱动（FR-06 轨道控制）
 */
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
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.1;
      }}
      onPointerMissed={() => select(null)}
    >
      <EnvironmentRig />

      {/* 场景分层：外围陆地/片区 → 底座 → 山体 → 水面 → 道路 → 城墙 → 树木 → 建筑群（含城外白模）→ 景点 */}
      <Outskirts />
      <BasePlatform />
      <Hills />
      <WaterSystem />
      <Roads />
      <RoadMarkings />
      <Transit />
      <CanalBridges />
      <CanalEmbankment />
      <CanalBoats />
      <CityWall />
      <CityGates />
      <Trees />
      <BuildingField />
      <NightLights />
      <Landmarks />
      <LandmarkLabels />

      <CameraRig />
      <DebugCamera />
      <PanBounds />
      <LodWatcher />
      <PerfProbe />
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
    </Canvas>
  );
}