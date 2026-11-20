import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { sceneGeometry } from '../data/sceneGeometry';
import { SEASON_LOOKS } from '../constants/seasons';
import { useSandTable } from '../store/useSandTable';
import { buildRibbons } from '../utils/ribbon';
import { buildOutlineRing } from '../utils/ring';
import { createCityGroundTexture, GROUND_WORLD } from '../utils/cityGroundTexture';

const GROUND_Y = -2;
const MOAT_WIDTH = 120;
const MOAT_Y = 1.4;
const CANAL_WIDTH = 30;
const CANAL_Y = 2.4;

/**
 * 程序化水面波纹贴图（凹凸贴图）：柔和的横向波峰，
 * 通过滚动 UV 产生流动感，不需要额外纹理资源。
 */
function createRippleTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, size, size);

    // 两层不同频率的波纹，叠加后不至于过于规则
    for (let band = 0; band < 2; band += 1) {
      const count = band === 0 ? 7 : 13;
      for (let i = 0; i < count; i += 1) {
        const baseY = (i / count) * size + band * 4.7;
        const amp = 2.2 + band * 1.4;
        const grad = ctx.createLinearGradient(0, baseY - 7, 0, baseY + 7);
        grad.addColorStop(0, 'rgba(128,128,128,0)');
        grad.addColorStop(0.5, band === 0 ? 'rgba(226,226,226,0.9)' : 'rgba(182,182,182,0.55)');
        grad.addColorStop(1, 'rgba(128,128,128,0)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = band === 0 ? 3.2 : 1.8;
        ctx.beginPath();
        for (let x = -8; x <= size + 8; x += 4) {
          const y = baseY + Math.sin((x / size) * Math.PI * 2 + i * 1.7) * amp;
          if (x === -8) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/**
 * 水系（FR-02）：
 * - 外围陆地基准面
 * - 环城河：沿古城轮廓向外 120m 的环带水面
 * - 城内河道：OSM waterway 折线加宽为 30m 带状水面，强化"三纵三横"肌理
 * 水面用滚动凹凸贴图表现流动，夜晚反射更明显；水色随四季变化，冬季结冰静止。
 */
export function WaterSystem() {
  const season = useSandTable((state) => state.season);
  const look = SEASON_LOOKS[season];
  const night = useSandTable((state) => state.time === 'night');
  const moatGeo = useMemo(
    () => buildOutlineRing(sceneGeometry.cityOutline, MOAT_WIDTH, MOAT_Y),
    [],
  );
  const canalGeo = useMemo(
    () => buildRibbons(sceneGeometry.waterways, CANAL_WIDTH, CANAL_Y),
    [],
  );

  const ripple = useMemo(() => createRippleTexture(), []);
  const groundTexture = useMemo(() => createCityGroundTexture(), []);
  const offsetRef = useRef({ x: 0, y: 0 });

  useFrame((_, delta) => {
    // 结冰期水面静止；其余季节沿河道方向缓慢滚动
    if (!look.frozen) {
      offsetRef.current.y -= delta * 0.03;
      offsetRef.current.x += delta * 0.011;
    }
    ripple.offset.set(offsetRef.current.x % 1, offsetRef.current.y % 1);
  });

  // 夜间水面压暗、降低粗糙度，让灯影贴片（NightLights）更清晰
  const waterColor = night ? '#152c42' : look.water;
  const waterRoughness = look.frozen ? 0.66 : night ? 0.2 : 0.4;
  const waterMetalness = look.frozen ? 0.06 : night ? 0.28 : 0.05;
  const bumpScale = look.frozen ? 0.1 : night ? 0.65 : 0.45;

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, GROUND_Y, 0]} receiveShadow>
        <planeGeometry args={[GROUND_WORLD, GROUND_WORLD]} />
        <meshStandardMaterial map={groundTexture} color={look.land} roughness={1} />
      </mesh>
      <mesh geometry={moatGeo}>
        <meshStandardMaterial
          color={waterColor}
          roughness={waterRoughness}
          metalness={waterMetalness}
          bumpMap={ripple}
          bumpScale={bumpScale}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh geometry={canalGeo}>
        <meshStandardMaterial
          color={waterColor}
          roughness={waterRoughness}
          metalness={waterMetalness}
          bumpMap={ripple}
          bumpScale={bumpScale}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}
