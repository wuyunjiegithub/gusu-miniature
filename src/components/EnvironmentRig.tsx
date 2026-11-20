import { useLayoutEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useSandTable } from '../store/useSandTable';
import type { Season } from '../constants/seasons';

interface LightPreset {
  /** 天空/雾底色 */
  bg: string;
  fogNear: number;
  fogFar: number;
  ambient: number;
  ambientColor: string;
  hemi: number;
  hemiSky: string;
  hemiGround: string;
  sunColor: string;
  sunIntensity: number;
  /** 日照方位：冬季更斜，春季更暖 */
  sunPosition: [number, number, number];
  fillColor: string;
  fillIntensity: number;
}

const LOOK: Record<Season, { day: LightPreset; night: LightPreset }> = {
  spring: {
    day: {
      bg: '#cfe3ea',
      fogNear: 6500,
      fogFar: 17500,
      ambient: 0.32,
      ambientColor: '#fffaf0',
      hemi: 0.5,
      hemiSky: '#dceeff',
      hemiGround: '#93a07c',
      sunColor: '#fff4e2',
      sunIntensity: 3.2,
      sunPosition: [2100, 1500, -1300],
      fillColor: '#dfe8f2',
      fillIntensity: 0.24,
    },
    night: {
      bg: '#0e1726',
      fogNear: 5200,
      fogFar: 15000,
      ambient: 0.4,
      ambientColor: '#93a9c9',
      hemi: 0.62,
      hemiSky: '#2a3c57',
      hemiGround: '#4a3324',
      sunColor: '#9fb8dc',
      sunIntensity: 0.48,
      sunPosition: [-1400, 1900, -900],
      fillColor: '#6d88b0',
      fillIntensity: 0.35,
    },
  },
  summer: {
    day: {
      bg: '#c2dcea',
      fogNear: 6200,
      fogFar: 17000,
      ambient: 0.34,
      ambientColor: '#fdfbf2',
      hemi: 0.52,
      hemiSky: '#d8ecff',
      hemiGround: '#7f9068',
      sunColor: '#fff2d6',
      sunIntensity: 3.55,
      sunPosition: [2150, 1600, -1250],
      fillColor: '#dfe8f2',
      fillIntensity: 0.24,
    },
    night: {
      bg: '#0c1524',
      fogNear: 5000,
      fogFar: 14800,
      ambient: 0.38,
      ambientColor: '#93a9c9',
      hemi: 0.6,
      hemiSky: '#283a55',
      hemiGround: '#48331f',
      sunColor: '#9fb8dc',
      sunIntensity: 0.46,
      sunPosition: [-1400, 1900, -900],
      fillColor: '#6d88b0',
      fillIntensity: 0.34,
    },
  },
  autumn: {
    day: {
      bg: '#ccd6d4',
      fogNear: 5600,
      fogFar: 16000,
      ambient: 0.32,
      ambientColor: '#fff4e6',
      hemi: 0.5,
      hemiSky: '#e8e4d2',
      hemiGround: '#9a8f6e',
      sunColor: '#ffe7c0',
      // 秋日太阳更低，影子更长
      sunIntensity: 3.15,
      sunPosition: [2350, 1150, -1450],
      fillColor: '#e3e0d4',
      fillIntensity: 0.22,
    },
    night: {
      bg: '#121722',
      fogNear: 4600,
      fogFar: 14000,
      ambient: 0.42,
      ambientColor: '#9aa9c0',
      hemi: 0.58,
      hemiSky: '#2c3745',
      hemiGround: '#4d3a26',
      sunColor: '#b7c4d8',
      sunIntensity: 0.46,
      sunPosition: [-1400, 1800, -950],
      fillColor: '#738097',
      fillIntensity: 0.32,
    },
  },
  winter: {
    day: {
      // 雪后天光：整体明亮、色温偏冷，雾更白更近
      bg: '#d9e2e8',
      fogNear: 5200,
      fogFar: 16500,
      ambient: 0.5,
      ambientColor: '#f4f8fc',
      hemi: 0.56,
      hemiSky: '#e6eef6',
      hemiGround: '#c6d0d4',
      sunColor: '#ffffff',
      sunIntensity: 2.75,
      sunPosition: [2200, 1450, -1400],
      fillColor: '#e3ebf2',
      fillIntensity: 0.32,
    },
    night: {
      bg: '#16202c',
      fogNear: 4200,
      fogFar: 13000,
      ambient: 0.46,
      ambientColor: '#a8bdd6',
      hemi: 0.62,
      hemiSky: '#28394f',
      hemiGround: '#4a5558',
      sunColor: '#a9c0d8',
      sunIntensity: 0.5,
      sunPosition: [-1500, 1750, -900],
      fillColor: '#6f8aa8',
      fillIntensity: 0.36,
    },
  },
};

/**
 * 环境系统：昼夜 × 四季 驱动天空色、雾、日照方位与强度，
 * 以及天空中的太阳 / 月亮。四季通过"光的角度与色温 + 雾的浓度"拉开时令感。
 */

/** 日/月距离：落在远裁面内，避开雾（材质 fog=false） */
const SKY_DISTANCE = 9000;

export function EnvironmentRig() {
  const { scene } = useThree();
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const time = useSandTable((state) => state.time);
  const season = useSandTable((state) => state.season);

  const night = time === 'night';
  const preset = LOOK[season][night ? 'night' : 'day'];

  /** 太阳 / 月亮沿用日照方位，但压低到 22° 仰角，保证在全景视角里也能看到 */
  const skyPosition = useMemo(() => {
    const dir = new THREE.Vector3(...preset.sunPosition);
    dir.y = Math.hypot(dir.x, dir.z) * Math.tan(THREE.MathUtils.degToRad(22));
    return dir.normalize().multiplyScalar(SKY_DISTANCE);
  }, [preset]);

  useLayoutEffect(() => {
    scene.background = new THREE.Color(preset.bg);
    scene.fog = new THREE.Fog(preset.bg, preset.fogNear, preset.fogFar);
    return () => {
      scene.fog = null;
    };
  }, [scene, preset]);

  // 阴影参数用命令式配置，确保正交阴影相机在属性写入后更新投影矩阵
  useLayoutEffect(() => {
    const light = sunRef.current;
    if (!light) return;
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    light.shadow.bias = -0.0006;
    light.shadow.normalBias = 0.6;
    const cam = light.shadow.camera as THREE.OrthographicCamera;
    cam.left = -3200;
    cam.right = 3200;
    cam.top = 3200;
    cam.bottom = -3200;
    cam.near = 100;
    cam.far = 9000;
    cam.updateProjectionMatrix();
  }, [preset.sunPosition]);

  return (
    <group>
      {/* 夜间保留基础环境光，避免古城变成一片死黑 */}
      <ambientLight intensity={preset.ambient} color={preset.ambientColor} />
      <hemisphereLight
        args={[preset.hemiSky, preset.hemiGround, preset.hemi]}
      />
      <directionalLight
        ref={sunRef}
        position={preset.sunPosition}
        intensity={preset.sunIntensity}
        color={preset.sunColor}
      />
      <directionalLight
        position={[-1400, 900, -1000]}
        intensity={preset.fillIntensity}
        color={preset.fillColor}
      />
      {/* 城市灯火的低角度暖色反光 */}
      {night && <directionalLight position={[900, 320, 700]} intensity={0.3} color="#ff9a5c" />}

      {/* 日 / 月：关闭雾与色调映射，保证在天空底色上清晰 */}
      {night ? (
        <group position={skyPosition}>
          <mesh>
            <sphereGeometry args={[210, 24, 16]} />
            <meshBasicMaterial color="#eef3fa" fog={false} toneMapped={false} />
          </mesh>
          <mesh>
            <sphereGeometry args={[440, 24, 16]} />
            <meshBasicMaterial
              color="#9db6d8"
              transparent
              opacity={0.16}
              fog={false}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        </group>
      ) : (
        <group position={skyPosition}>
          <mesh>
            <sphereGeometry args={[260, 24, 16]} />
            <meshBasicMaterial color="#fff6d6" fog={false} toneMapped={false} />
          </mesh>
          <mesh>
            <sphereGeometry args={[520, 24, 16]} />
            <meshBasicMaterial
              color="#ffd98b"
              transparent
              opacity={0.2}
              fog={false}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        </group>
      )}
    </group>
  );
}
