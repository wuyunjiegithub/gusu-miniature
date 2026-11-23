import { useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import { LANDMARKS } from '../data/landmarks';
import { sceneGeometry } from '../data/sceneGeometry';
import { useSandTable } from '../store/useSandTable';
import { LandmarkModel } from './LandmarkModel';
import { EXTRA_LANDMARKS } from '../data/extraLandmarks';
import { HERITAGE_IDS } from '../data/heritage';
import { LANDMARK_TYPE_COLORS } from '../constants/palette';
import { SEASON_LOOKS } from '../constants/seasons';
import { trimOutlineFromRoads } from '../utils/trimOutline';
import { useRoads } from '../hooks/useRoads';
import type { LocalPoint2 } from '../types';

const LANDMARK_HEIGHT = 14;
/** 园林类只做低矮铺装，避免遮住绿地与树木 */
const GARDEN_PAD_HEIGHT = 2.2;
/**
 * 精细模型石台的顶面。必须低于支路路面（1.2m）：OSM 的景点轮廓与路网是两套
 * 数据，总会有街道从景区轮廓里穿过（石路步行街、山塘街、园内小路），
 * 台面一旦高于路面就把马路和标线整段盖掉。压到路面以下后，路网永远在石台
 * 之上，石台只作为模型与街巷之间的铺装过渡。
 */
const CITY_PAD_TOP = 1.1;

/** 已完成精细建模的景点（阶段3 逐步扩充）；自带地形的模型再抬高 0.25m 露出底座边沿 */
const DETAILED_MODELS: Array<{ id: string; url: string; baseY?: number; outside?: boolean }> = [
  // 盘门改由 Panmen.tsx 程序化按真实尺寸重建（城墙+水陆城门+瑞光塔+吴门桥），不再加载 GLB
  { id: 'zhuozhengyuan', url: '/models/zhuozhengyuan.glb', baseY: 1.25 },
  { id: 'liuyuan', url: '/models/liuyuan.glb', baseY: 1.25, outside: true },
  // 街道样板段贴地：街面 ≈ 1.3m，与周边道路（1.2/1.3m）齐平
  { id: 'pingjiang', url: '/models/pingjiang.glb', baseY: 1.25 },
  { id: 'guanqianjie', url: '/models/guanqianjie.glb', baseY: 1.25 },
  { id: 'shuangta', url: '/models/shuangta.glb', baseY: 1.25 },
  { id: 'beisita', url: '/models/beisita.glb', baseY: 1.25 },
  { id: 'shizilin', url: '/models/shizilin.glb', baseY: 1.25 },
  { id: 'wangshiyuan', url: '/models/wangshiyuan.glb', baseY: 1.25 },
  { id: 'suzhou-museum', url: '/models/suzhou_museum.glb', baseY: 1.25 },
  { id: 'canglangting', url: '/models/canglangting.glb', baseY: 1.25 },
  { id: 'hanshansi', url: '/models/hanshansi.glb', baseY: 1.25, outside: true },
  { id: 'tangyinci', url: '/models/tangyinci.glb', baseY: 1.25 },
  { id: 'taohuawu', url: '/models/taohuawu.glb', baseY: 1.25 },
  // 山塘街在阊门外：整段落在城外基准面上，街面比城外地面高约 1.2m（沿河堤岸）
  { id: 'shantangjie', url: '/models/shantangjie.glb', baseY: -0.75, outside: true },
  { id: 'xiyuansi', url: '/models/xiyuansi.glb', baseY: 1.25, outside: true },
  { id: 'shilu', url: '/models/shilu.glb', baseY: 1.25, outside: true },
];

const DETAILED_IDS = new Set(DETAILED_MODELS.map((model) => model.id));

/** 城外补建地标（程序化生成，见 ProceduralLandmarks）自带底座，不铺石台 */
const PROCEDURAL_IDS = new Set(EXTRA_LANDMARKS.map((item) => item.id));

/**
 * 不铺石台的精细模型：盘门 GLB 自带城墙、水陆城门、瑞光塔与吴门桥，
 * 是一个横跨城墙内外的整体，落在城墙线（z≈2467）上；景区 outline 石台
 * 只到城内（z≤2392），铺了反而与移位的城门分离、变成一块孤立的平台。
 */
const NO_PAD_IDS = new Set(['panmen']);

/**
 * 城外地标没有城内沙盘台承托，石台要一直落到外围地面（-2m）；
 * 山塘街低到河面以下，否则会把模型自带的山塘河埋在台子里。
 */
const PAD_TOP: Record<string, number> = {
  // 山塘街石台压到河面（-1.3m）以下，模型内河与山塘河才能连成一条水
  shantangjie: -1.34,
  // 石路底板已切出上塘河并下探到水面以下，石台同样压到河面以下，否则会重新盖住河道
  shilu: -1.34,
};

const OUTSIDE_IDS = new Set(DETAILED_MODELS.filter((model) => model.outside).map((model) => model.id));

/** 城外地面高度（与 WaterSystem 的 GROUND_Y 一致） */
const OUTER_GROUND_Y = -2;

/** 轮廓环 → 拉伸几何（Shape 点取 (x,-z)，rotateX 后顶面朝上） */
function outlineToGeometry(
  outline: LocalPoint2[],
  top: number,
  bottom: number,
): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: top - bottom, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bottom, 0);
  return geo;
}

/**
 * 景点（FR-05 / FR-07）：真实轮廓驱动。
 * 面状景点 = 轮廓拉伸体块；街道型景点 = 折线 + 质心拾取块。
 * 每个 mesh 独立材质，emissive 高亮天然避免"串亮"。
 * 阶段3 起逐个替换为精细 GLB 模型。
 */
export function Landmarks() {
  const selectedId = useSandTable((state) => state.selectedId);
  const select = useSandTable((state) => state.select);
  const season = useSandTable((state) => state.season);
  const roads = useRoads();

  const geometries = useMemo(() => {
    const map = new Map<string, THREE.ExtrudeGeometry>();
    for (const landmark of LANDMARKS) {
      if (PROCEDURAL_IDS.has(landmark.id)) continue;
      if (HERITAGE_IDS.has(landmark.id)) continue;
      if (NO_PAD_IDS.has(landmark.id)) continue;
      const geo = sceneGeometry.landmarks[landmark.id];
      if (!geo?.outline) continue;
      // 已有精细 GLB 的景点一律压成薄石台，避免 14m 高的占位体块
      // 把模型整个扣在里面（山塘街曾因此完全看不到模型）
      const top =
        PAD_TOP[landmark.id] ??
        (DETAILED_IDS.has(landmark.id)
          ? CITY_PAD_TOP
          : landmark.type === 'garden'
            ? GARDEN_PAD_HEIGHT
            : LANDMARK_HEIGHT);
      // 城外与盘门（跨护城河）的石台落到外围地面，避免露出悬空的台底
      const bottom = OUTSIDE_IDS.has(landmark.id) ? OUTER_GROUND_Y : 0;
      // 石台一律按路网裁剪：城内景点（拙政园东侧最明显）与城外景点
      // （留园、山塘街、石路一带同样有铺装路网）都会出现 OSM 轮廓顶点
      // 伸进路面、拉伸后盖住马路和标线的问题，裁剪后边界退到路缘外。
      const outline = roads ? trimOutlineFromRoads(geo.outline, roads) : geo.outline;
      map.set(landmark.id, outlineToGeometry(outline, top, bottom));
    }
    return map;
  }, [roads]);

  return (
    <group>
      {LANDMARKS.map((landmark) => {
        const geo = sceneGeometry.landmarks[landmark.id];
        if (!geo) return null;
        // 城外补建地标：模型自己带底座，这里不再铺石台
        if (PROCEDURAL_IDS.has(landmark.id)) return null;
        // 城内文保单位：由 Heritage.tsx 程序化渲染体块，这里不再铺石台
        if (HERITAGE_IDS.has(landmark.id)) return null;
        // 盘门：GLB 自带城墙+城门+塔+桥，跨城墙内外，不铺石台
        if (NO_PAD_IDS.has(landmark.id)) return null;
        const selected = selectedId === landmark.id;
        const color = LANDMARK_TYPE_COLORS[landmark.type];
        // 精细模型的石台用城内青石板色，保持与街巷铺装一致（否则是大片米色平台）；
        // 园林的石台铺成草色——园墙外的空地被模型遮不住，绿底才不会像一块沙地
        const padColor = DETAILED_IDS.has(landmark.id)
          ? landmark.type === 'garden'
            ? SEASON_LOOKS[season].lawn
            : SEASON_LOOKS[season].ground
          : color;
        const onClick = (event: { stopPropagation: () => void }) => {
          event.stopPropagation();
          select(landmark.id);
        };

        // 街道型：折线 + 质心拾取块
        if (!geo.outline) {
          // 已有精细 GLB 的街道样板段（平江路 / 观前街）不再渲染占位
          if (DETAILED_IDS.has(landmark.id)) return null;
          return (
            <group key={landmark.id}>
              {geo.path && (
                <Line
                  points={geo.path.map(([x, z]) => [x, 1.42, z] as [number, number, number])}
                  color={color}
                  lineWidth={4}
                />
              )}
              <mesh position={[geo.centroid.x, LANDMARK_HEIGHT / 2, geo.centroid.z]} onClick={onClick}>
                <boxGeometry args={[60, LANDMARK_HEIGHT, 60]} />
                <meshStandardMaterial
                  color={color}
                  emissive={selected ? '#ffb84d' : '#000000'}
                  emissiveIntensity={selected ? 0.6 : 0}
                />
              </mesh>
            </group>
          );
        }

        // 面状：轮廓拉伸
        return (
          <mesh key={landmark.id} name={`pad-${landmark.id}`} geometry={geometries.get(landmark.id)} onClick={onClick}>
            <meshStandardMaterial
              color={padColor}
              // 石台面积大，暖色发光会把青石板整片染成米黄、与城内割裂；
              // 选中反馈改为中性提亮，靠侧栏与标签承担识别
              emissive={selected ? '#ffffff' : '#000000'}
              emissiveIntensity={selected ? 0.06 : 0}
            />
          </mesh>
        );
      })}
      {/* 已完成的精细模型（阶段3） */}
      {DETAILED_MODELS.map((model) => (
        <LandmarkModel
          key={model.id}
          id={model.id}
          url={model.url}
          baseY={model.baseY}
          outside={model.outside}
        />
      ))}
    </group>
  );
}
