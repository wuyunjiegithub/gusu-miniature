import { useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import { LANDMARKS } from '../data/landmarks';
import { sceneGeometry } from '../data/sceneGeometry';
import { useSandTable } from '../store/useSandTable';
import { LandmarkModel } from './LandmarkModel';
import { LANDMARK_TYPE_COLORS } from '../constants/palette';
import { SEASON_LOOKS } from '../constants/seasons';
import type { LocalPoint2 } from '../types';

const LANDMARK_HEIGHT = 14;
/** 园林类只做低矮铺装，避免遮住绿地与树木 */
const GARDEN_PAD_HEIGHT = 2.2;
/** 已替换为精细 GLB 的景点：底座压成薄石台（顶面 1.6m，高于 1.2m 的道路面，避免共面闪烁） */
const PAD_OVERRIDE: Record<string, number> = {
  panmen: 1.6,
  zhuozhengyuan: 1.6,
  liuyuan: 1.6,
  shuangta: 1.6,
  beisita: 1.6,
  shizilin: 1.6,
  wangshiyuan: 1.6,
  'suzhou-museum': 1.6,
  canglangting: 1.6,
  hanshansi: 1.6,
  tangyinci: 1.6,
  shantangjie: 1.6,
};

/** 已完成精细建模的景点（阶段3 逐步扩充）；自带地形的模型再抬高 0.25m 露出底座边沿 */
const DETAILED_MODELS: Array<{ id: string; url: string; baseY?: number }> = [
  { id: 'panmen', url: '/models/panmen.glb', baseY: 1.6 },
  { id: 'zhuozhengyuan', url: '/models/zhuozhengyuan.glb', baseY: 1.85 },
  { id: 'liuyuan', url: '/models/liuyuan.glb', baseY: 1.85 },
  // 街道样板段贴地：街面 ≈ 1.3m，与周边道路（1.2/1.3m）齐平
  { id: 'pingjiang', url: '/models/pingjiang.glb', baseY: 1.25 },
  { id: 'guanqianjie', url: '/models/guanqianjie.glb', baseY: 1.25 },
  { id: 'shuangta', url: '/models/shuangta.glb', baseY: 1.85 },
  { id: 'beisita', url: '/models/beisita.glb', baseY: 1.85 },
  { id: 'shizilin', url: '/models/shizilin.glb', baseY: 1.85 },
  { id: 'wangshiyuan', url: '/models/wangshiyuan.glb', baseY: 1.85 },
  { id: 'suzhou-museum', url: '/models/suzhou_museum.glb', baseY: 1.85 },
  { id: 'canglangting', url: '/models/canglangting.glb', baseY: 1.85 },
  { id: 'hanshansi', url: '/models/hanshansi.glb', baseY: 1.85 },
  { id: 'tangyinci', url: '/models/tangyinci.glb', baseY: 1.85 },
  { id: 'taohuawu', url: '/models/taohuawu.glb', baseY: 1.25 },
  { id: 'shantangjie', url: '/models/shantangjie.glb', baseY: 1.85 },
];

const DETAILED_IDS = new Set(DETAILED_MODELS.map((model) => model.id));

/** 城外地标没有底座沙盘承托，石台需下沉到外围地面（-2m），避免悬空 */
const PAD_SINK: Record<string, number> = { liuyuan: 2, hanshansi: 2 };

/** 轮廓环 → 拉伸几何（Shape 点取 (x,-z)，rotateX 后顶面朝上） */
function outlineToGeometry(outline: LocalPoint2[], depth: number, sink = 0): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: depth + sink, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  if (sink) geo.translate(0, -sink, 0);
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

  const geometries = useMemo(() => {
    const map = new Map<string, THREE.ExtrudeGeometry>();
    for (const landmark of LANDMARKS) {
      const geo = sceneGeometry.landmarks[landmark.id];
      if (geo?.outline) {
        // 已有精细 GLB 的景点一律压成薄石台，避免 14m 高的占位体块
        // 把模型整个扣在里面（山塘街曾因此完全看不到模型）
        const depth =
          PAD_OVERRIDE[landmark.id] ??
          (DETAILED_IDS.has(landmark.id)
            ? 1.6
            : landmark.type === 'garden'
              ? GARDEN_PAD_HEIGHT
              : LANDMARK_HEIGHT);
        map.set(
          landmark.id,
          outlineToGeometry(geo.outline, depth, PAD_SINK[landmark.id] ?? 0),
        );
      }
    }
    return map;
  }, []);

  return (
    <group>
      {LANDMARKS.map((landmark) => {
        const geo = sceneGeometry.landmarks[landmark.id];
        if (!geo) return null;
        const selected = selectedId === landmark.id;
        const color = LANDMARK_TYPE_COLORS[landmark.type];
        // 精细模型的石台用城内青石板色，保持与街巷铺装一致（否则是大片米色平台）
        const padColor = DETAILED_IDS.has(landmark.id) ? SEASON_LOOKS[season].ground : color;
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
          <mesh key={landmark.id} geometry={geometries.get(landmark.id)} onClick={onClick}>
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
        <LandmarkModel key={model.id} id={model.id} url={model.url} baseY={model.baseY} />
      ))}
    </group>
  );
}
