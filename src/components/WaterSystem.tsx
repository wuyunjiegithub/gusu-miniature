import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { sceneGeometry } from '../data/sceneGeometry';
import { SEASON_LOOKS } from '../constants/seasons';
import { GROUND_DISC_RADIUS } from '../constants/geo';
import { useSandTable } from '../store/useSandTable';
import { buildRibbons } from '../utils/ribbon';
import { buildOutlineRing, buildRingBank } from '../utils/ring';
import { createCityGroundTexture } from '../utils/cityGroundTexture';
import { getSkyReflection } from '../utils/skyEnv';
import { clipLineToRadius } from '../utils/clip';
import { outerWaterHalf } from '../constants/geo';

/** 外围地面高度（城外基准面） */
const GROUND_Y = -2;
/** 外围地面圆盘厚度：与古城底座同厚，侧面封边后才像一块实体沙盘 */
const DISC_THICKNESS = 24;

const MOAT_WIDTH = 120;
const MOAT_Y = 1.4;
/** 水面从城墙外侧 4.6m 起铺：城墙厚 8m，留出干岸后墙脚不再泡在水里 */
const MOAT_INSET = 4.6;
/** 护城河石驳岸顶面（压住水面硬边） */
const MOAT_BANK_Y = 1.52;
const MOAT_BANK_WIDTH = 3.2;

const CANAL_WIDTH = 12;
const CANAL_Y = 0.35;

/** 城外水道：与山塘街模型内河同高，水面低于街面约 1.2m */
const SHANTANG_Y = -1.3;

/**
 * 盘门水门：程序化重建的盘门（Panmen.tsx）水门洞在城墙局部 x=5，
 * 城墙 group 定位 (-782.3, 2457.8) + 绕 Y 旋转 -7.64° 后，水门洞中心
 * 约在世界 (-777, 2458.5)。城内侧水面在城墙处收口，穿过水门洞；
 * 城外交给护城河（moatGeo）。
 */
const PANMEN_GATE = {
  /** 水门洞中心世界 x（城墙局部 x=5 经旋转/平移后） */
  x: -777,
  /** waterway#11（盘门水门水道）城内起点 z */
  z0: 2240,
  /** 城墙处收口 z（水门洞中心） */
  z1: 2458.5,
  /** 与水门洞宽（9.3m）一致，水面从门洞里过 */
  width: 9,
  y: 1.78,
};

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
 * - 外围地面：半径 5.9km 的圆盘 + 侧壁，沙盘至此为止，不再向天际线蔓延
 * - 环城河：沿古城轮廓向外 120m 的环带水面，两侧补石驳岸，城墙不再泡水
 * - 城内河道：OSM waterway 折线加宽为 30m 带状水面
 * - 山塘河：城西北的山塘街水道，与山塘街模型内河同高
 * - 盘门水门：从水门打通吴门桥到护城河的水面
 * 水面用滚动凹凸贴图表现流动；冬季结冰静止，并转成镜面反光。
 */
export function WaterSystem() {
  const season = useSandTable((state) => state.season);
  const look = SEASON_LOOKS[season];
  const night = useSandTable((state) => state.time === 'night');

  const moatGeo = useMemo(
    () => buildOutlineRing(sceneGeometry.cityOutline, MOAT_WIDTH, MOAT_Y, MOAT_INSET),
    [],
  );
  const moatBankInner = useMemo(
    () =>
      buildRingBank(sceneGeometry.cityOutline, MOAT_INSET, MOAT_BANK_WIDTH, MOAT_BANK_Y, GROUND_Y - 1),
    [],
  );
  const moatBankOuter = useMemo(
    () =>
      buildRingBank(
        sceneGeometry.cityOutline,
        MOAT_INSET + MOAT_WIDTH,
        MOAT_BANK_WIDTH,
        MOAT_BANK_Y,
        GROUND_Y - 1,
      ),
    [],
  );
  // 盘门水门那一段单独按 1.78m 铺（见 gateGeo），从城内河网里剔除，
  // 否则 2.4m 的水带会压在新水面上方，桥下又变成一条悬空的水槽
  const cityWaterways = useMemo(
    () =>
      sceneGeometry.waterways.filter(
        (line) =>
          !(line.length === 2 && Math.abs(line[0][0] - PANMEN_GATE.x) < 4 && Math.abs(line[1][0] - PANMEN_GATE.x) < 4),
      ),
    [],
  );
  const canalGeo = useMemo(() => buildRibbons(cityWaterways, CANAL_WIDTH, CANAL_Y), [cityWaterways]);
  // 每条城外水道按自己的半宽铺：山塘河 8m（与山塘街模型内河完全重合），其余 26m。
  // 逐条建几何，避免裁剪后索引错位把 8m 宽度套到上塘河上。
  const outerCanalGeos = useMemo(
    () =>
      (sceneGeometry.outerWaterways ?? []).flatMap((line, i) => {
        const clipped = clipLineToRadius(line, GROUND_DISC_RADIUS - 40);
        if (clipped.length < 2) return [];
        return [buildRibbons([clipped], outerWaterHalf(i) * 2, SHANTANG_Y)];
      }),
    [],
  );
  // 盘门水门：水面只铺到城墙线（水门），不再跟着 OSM 水道一路戳进护城河。
  // 城墙外侧到吴门桥之间是护城河水面，交给 moatGeo 表达。
  const gateEndZ = PANMEN_GATE.z1;

  const gateGeo = useMemo(
    () =>
      buildRibbons(
        [
          [
            [PANMEN_GATE.x, PANMEN_GATE.z0],
            [PANMEN_GATE.x, gateEndZ],
          ],
        ],
        PANMEN_GATE.width,
        PANMEN_GATE.y,
      ),
    [gateEndZ],
  );

  const groundTexture = useMemo(() => createCityGroundTexture(), []);
  const ripple = useMemo(() => createRippleTexture(), []);
  const skyReflection = useMemo(() => getSkyReflection(season), [season]);
  const offsetRef = useRef({ x: 0, y: 0 });

  useFrame((_, delta) => {
    // 结冰期水面静止；其余季节沿河道方向缓慢滚动
    if (!look.frozen) {
      offsetRef.current.y -= delta * 0.03;
      offsetRef.current.x += delta * 0.011;
    }
    ripple.offset.set(offsetRef.current.x % 1, offsetRef.current.y % 1);
  });

  // 冰面：粗糙度极低 + 天光反射，形成一整片薄冰的反光；河面结冰后不再起伏
  const frozen = look.frozen;
  const iceAtNight = frozen && night;
  const waterColor = iceAtNight ? '#28323e' : frozen ? '#cfe2ec' : night ? '#152c42' : look.water;
  const roughness = frozen ? (night ? 0.1 : 0.06) : night ? 0.2 : 0.42;
  const metalness = frozen ? (night ? 0.42 : 0.3) : night ? 0.28 : 0.06;
  const bumpScale = frozen ? 0 : night ? 0.65 : 0.45;
  // 夜里冰面只留一点天光反射，太亮会把护城河变成一条白带
  const envIntensity = iceAtNight ? 0.7 : frozen ? 1.6 : night ? 0.55 : 0.3;

  const surfaces: { key: string; geometry: THREE.BufferGeometry }[] = [
    { key: 'moat', geometry: moatGeo },
    { key: 'canal', geometry: canalGeo },
    ...outerCanalGeos.map((geometry, i) => ({ key: `outer-${i}`, geometry })),
    { key: 'gate', geometry: gateGeo },
  ];

  return (
    <group>
      {/* 外围地面：圆盘 + 侧壁封边 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, GROUND_Y, 0]} receiveShadow>
        <circleGeometry args={[GROUND_DISC_RADIUS, 128]} />
        <meshStandardMaterial map={groundTexture} color={look.land} roughness={1} />
      </mesh>
      <mesh position={[0, GROUND_Y - DISC_THICKNESS / 2, 0]}>
        <cylinderGeometry
          args={[GROUND_DISC_RADIUS, GROUND_DISC_RADIUS, DISC_THICKNESS, 128, 1, true]}
        />
        <meshStandardMaterial color="#6f6a60" roughness={0.95} side={THREE.DoubleSide} />
      </mesh>

      {surfaces.map((surface) => (
        <mesh key={surface.key} name={`water-${surface.key}`} geometry={surface.geometry}>
          <meshStandardMaterial
            color={waterColor}
            roughness={roughness}
            metalness={metalness}
            bumpMap={frozen ? null : ripple}
            bumpScale={bumpScale}
            envMap={skyReflection}
            envMapIntensity={envIntensity}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}

      {/* 护城河石驳岸：内外两道，压住水面硬边，远看是完整的河床剖面 */}
      {[moatBankInner, moatBankOuter].map((geometry, index) => (
        <mesh key={index} geometry={geometry} receiveShadow>
          <meshStandardMaterial
            color={season === 'winter' ? '#dde4e8' : '#a49c90'}
            roughness={0.95}
            flatShading
          />
        </mesh>
      ))}
    </group>
  );
}

/** 水面标高（供驳岸、桥、船共用，避免多处硬编码） */
export const WATER_LEVEL = {
  canal: CANAL_Y,
  moat: MOAT_Y,
  shantang: SHANTANG_Y,
  panmenGate: PANMEN_GATE.y,
} as const;
