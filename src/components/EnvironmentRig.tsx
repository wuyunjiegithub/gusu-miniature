import { useLayoutEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useSandTable } from '../store/useSandTable';
import { getSkyReflection } from '../utils/skyEnv';
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

/**
 * 夜晚统一走"灯火通明"的基调：环境光与半球光抬到接近黄昏，
 * 城市轮廓、屋顶关系仍然可读，再由路灯、窗光与红灯笼提供层次。
 */
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
      bg: '#101a29',
      fogNear: 5600,
      fogFar: 15500,
      ambient: 0.62,
      ambientColor: '#a9b8cd',
      hemi: 0.95,
      hemiSky: '#33496b',
      hemiGround: '#6a4526',
      sunColor: '#a8bee0',
      sunIntensity: 0.6,
      sunPosition: [-1400, 1900, -900],
      fillColor: '#7f9ac0',
      fillIntensity: 0.42,
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
      bg: '#0e1826',
      fogNear: 5400,
      fogFar: 15200,
      ambient: 0.6,
      ambientColor: '#a9b8cd',
      hemi: 0.92,
      hemiSky: '#314768',
      hemiGround: '#684323',
      sunColor: '#a8bee0',
      sunIntensity: 0.58,
      sunPosition: [-1400, 1900, -900],
      fillColor: '#7f9ac0',
      fillIntensity: 0.4,
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
      bg: '#131926',
      fogNear: 5000,
      fogFar: 14500,
      ambient: 0.62,
      ambientColor: '#aeb6c6',
      hemi: 0.94,
      hemiSky: '#37445c',
      hemiGround: '#6d4a26',
      sunColor: '#bcc9dd',
      sunIntensity: 0.58,
      sunPosition: [-1400, 1800, -950],
      fillColor: '#8491a8',
      fillIntensity: 0.4,
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
      bg: '#17222f',
      fogNear: 4600,
      fogFar: 13800,
      ambient: 0.66,
      ambientColor: '#b4c6da',
      hemi: 0.98,
      hemiSky: '#31455f',
      hemiGround: '#5c5a52',
      sunColor: '#b4c8de',
      sunIntensity: 0.6,
      sunPosition: [-1500, 1750, -900],
      fillColor: '#8399b4',
      fillIntensity: 0.44,
    },
  },
};

/**
 * 环境系统：昼夜 × 四季 驱动天空色、雾、日照方位与强度。
 * 四季通过"光的角度与色温 + 雾的浓度"拉开时令感。
 * 天空不再画日月实体：沙盘是俯视的模型台，天体只会喧宾夺主。
 */
export function EnvironmentRig() {
  const { scene, gl } = useThree();
  const time = useSandTable((state) => state.time);
  const season = useSandTable((state) => state.season);

  const night = time === 'night';
  const preset = LOOK[season][night ? 'night' : 'day'];

  useLayoutEffect(() => {
    scene.background = new THREE.Color(preset.bg);
    scene.fog = new THREE.Fog(preset.bg, preset.fogNear, preset.fogFar);
    return () => {
      scene.fog = null;
    };
  }, [scene, preset]);

  // 夜景整体提亮一档曝光：灯火通明的主城不能靠压暗周围来显亮
  useLayoutEffect(() => {
    gl.toneMappingExposure = night ? 1.28 : 1.1;
  }, [gl, night]);

  // 天空反射：把四季天空渐变挂为全局 environment，让白墙黛瓦、坡顶、
  // 石板与树干统一反射同一片天光，整个沙盘的光照彼此协调。
  // 水面与园林 GLB 已各自显式挂 envMap，不会被这里的全局值覆盖。
  useLayoutEffect(() => {
    scene.environment = getSkyReflection(season);
    // 渐变天光较柔和，压低全局反射强度，避免粗糙墙面被染成一片冷白
    (scene as THREE.Scene & { environmentIntensity: number }).environmentIntensity = night
      ? 0.28
      : season === 'winter'
        ? 0.5
        : 0.4;
    return () => {
      scene.environment = null;
    };
  }, [scene, season, night]);

  return (
    <group>
      {/* 夜间保留较高的环境光，避免古城变成一片死黑 */}
      <ambientLight intensity={preset.ambient} color={preset.ambientColor} />
      <hemisphereLight args={[preset.hemiSky, preset.hemiGround, preset.hemi]} />
      <directionalLight
        position={preset.sunPosition}
        intensity={preset.sunIntensity}
        color={preset.sunColor}
      />
      <directionalLight
        position={[-1400, 900, -1000]}
        intensity={preset.fillIntensity}
        color={preset.fillColor}
      />
      {/* 城市灯火的低角度暖色反光：把主城的白墙黛瓦染上一层暖调 */}
      {night && <directionalLight position={[900, 320, 700]} intensity={0.62} color="#ffa063" />}
      {night && <directionalLight position={[-700, 260, -600]} intensity={0.3} color="#ff7a4a" />}
    </group>
  );
}
