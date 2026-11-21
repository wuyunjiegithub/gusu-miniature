import { Suspense, useLayoutEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { sceneGeometry } from '../data/sceneGeometry';
import { useSandTable } from '../store/useSandTable';
import { SEASON_LOOKS, type Season } from '../constants/seasons';
import { getSkyReflection } from '../utils/skyEnv';
import { useRoads } from '../hooks/useRoads';
import { boundsOf, fitLandmarkPlacement, getRoadClearance } from '../utils/roadClearance';
import { trimOutlineFromRoads } from '../utils/trimOutline';
import type { LocalPoint2 } from '../types';

/** 精细 GLB 默认落在景点石台顶面；与 Landmarks 的 CITY_PAD_TOP（1.1）保持一致 */
export const LANDMARK_BASE_Y = 1.1;

/**
 * 街景型景点：模型本身就是街面/沿街铺装，"压在马路上"是设计意图，
 * 不参与路网避让（否则一条街会被缩成一截）。
 */
const STREET_IDS = new Set(['pingjiang', 'guanqianjie', 'shantangjie', 'shilu', 'taohuawu']);

/**
 * 材质语义：GLB 由 scripts/blender/*.py 生成，材质名带前缀，
 * 借此按季节换色，不必改动模型文件本身。
 */
type MatKind = 'leaf' | 'blossom' | 'ground' | 'water' | 'tile' | 'wall' | 'lantern' | 'other';
/** 地面（含石作）统一取城内青石板色，不参与 SEASON_TINTS 硬编码 */
type TintKind = Exclude<MatKind, 'other' | 'ground'>;

function classify(name: string): MatKind {
  if (name.startsWith('leaf')) return 'leaf';
  if (name.startsWith('blossom')) return 'blossom';
  // ground/pave/stone 都是铺地与石作：与城内街巷同色，避免景点里出现大片草地或米色石板
  if (
    name === 'ground' ||
    name.startsWith('island') ||
    name.startsWith('pave') ||
    name.startsWith('stone')
  ) {
    return 'ground';
  }
  if (name.startsWith('water')) return 'water';
  if (name.startsWith('tile') || name.startsWith('roof')) return 'tile';
  // 寒山寺的黄墙是标志色，不参与换色
  if (name.startsWith('wall') && !name.includes('yellow')) return 'wall';
  if (name.startsWith('lantern')) return 'lantern';
  return 'other';
}

/** 秋季树冠：按材质顺序分配枫红、柿橙、银杏黄，避免整片同色 */
const AUTUMN_LEAVES = ['#b8432f', '#cf6a2e', '#d9a63c', '#a8503a'];

/**
 * 四季配色：景点跟城市一起换季。
 * 冬季瓦面覆雪、水面结冰、桃花转枯枝色，园林树木保持常青的灰绿。
 */
const SEASON_TINTS: Record<Season, Record<TintKind, string>> = {
  spring: {
    leaf: '#5c9a48',
    blossom: '#efc3cf',
    water: '#3f9ab0',
    tile: '#59626e',
    wall: '#efe9dd',
    lantern: '#c0402c',
  },
  summer: {
    leaf: '#37702f',
    blossom: '#d98ca0',
    water: '#2f7fa5',
    tile: '#4f5864',
    wall: '#f3eee2',
    lantern: '#c0402c',
  },
  autumn: {
    leaf: '#b8432f',
    blossom: '#8b6a50',
    water: '#3e6f74',
    tile: '#4d5560',
    wall: '#f0e9da',
    lantern: '#c0402c',
  },
  winter: {
    leaf: '#6d7d6c',
    blossom: '#6b5a4c',
    water: '#bdd2dd',
    tile: '#d5dde3',
    wall: '#f4f6f8',
    lantern: '#e0703c',
  },
};

/**
 * 瓦面程序化细化：模型没有贴图，屋面是一整块平色。
 * 在片元着色里加横向瓦垄与纵向瓦缝，并按屏幕导数淡出，远景不产生摩尔纹。
 */
function applyTileShader(mat: THREE.MeshStandardMaterial): void {
  if (mat.userData.tileShader) return;
  mat.userData.tileShader = true;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTilePos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTilePos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTilePos;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float tileRow = abs(fract(vTilePos.y * 1.35) - 0.5) * 2.0;
        float tileRidge = abs(fract((vTilePos.x + vTilePos.z) * 0.55) - 0.5) * 2.0;
        float tileDist = max(fwidth(vTilePos.y), fwidth(vTilePos.x + vTilePos.z));
        float tileFade = 1.0 - smoothstep(0.2, 0.5, tileDist);
        diffuseColor.rgb *= 1.0 - (0.11 + 0.09 * tileRow + 0.05 * tileRidge) * tileFade;
        `,
      );
  };
  mat.customProgramCacheKey = () => 'landmark-tile';
  mat.needsUpdate = true;
}

/** 夜景窗光共用的开关：0 = 白天，1 = 夜晚 */
const nightUniforms = new Set<{ value: number }>();

/**
 * 墙面细化：粉刷噪点、近地青苔，以及夜间按网格点亮的暖色窗洞。
 * 模型没有窗户材质，用局部坐标 + 物体法线在片元里"画"窗。
 */
function applyWallShader(mat: THREE.MeshStandardMaterial): void {
  if (mat.userData.wallShader) return;
  mat.userData.wallShader = true;
  const uNight = { value: 0 };
  nightUniforms.add(uNight);

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWallPos;\nvarying vec3 vWallNormal;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWallPos = position;\nvWallNormal = normal;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vWallPos;\nvarying vec3 vWallNormal;\nuniform float uNight;',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // 粉刷颗粒感，避免大面积纯白
        float wallGrain = fract(sin(dot(floor(vWallPos.xz * 0.9), vec2(12.9898, 78.233))) * 43758.5453);
        diffuseColor.rgb *= 0.965 + 0.035 * wallGrain;
        // 近地青苔：只在墙脚 1.8m 内淡淡泛绿
        float mossy = smoothstep(1.8, 0.0, vWallPos.y) * (0.6 + 0.4 * wallGrain);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.40, 0.47, 0.33), mossy * 0.16);
        `,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        // 夜间窗光：按法线选主方向，2.2m × 3.4m 网格开暖色小窗
        vec3 an = abs(vWallNormal);
        float wallU = an.x > an.z ? vWallPos.z : vWallPos.x;
        vec2 cell = vec2(fract(wallU / 2.2), fract(vWallPos.y / 3.4));
        float win = step(0.28, cell.x) * step(cell.x, 0.72) * step(0.3, cell.y) * step(cell.y, 0.78);
        win *= smoothstep(1.4, 2.2, vWallPos.y);
        totalEmissiveRadiance += vec3(1.0, 0.68, 0.38) * win * uNight * 0.9;
        `,
      );
  };
  mat.customProgramCacheKey = () => 'landmark-wall';
  mat.needsUpdate = true;
}

/**
 * 模型水平投影点（相对模型原点，即景点质心），按顶点抽样。
 *
 * 这里不能用 matrixWorld：模型挂载进 group 之后 matrixWorld 已含景点质心
 * 与缩放，用它算极坐标会得到"世界坐标"，半径变成千米级，缩放判断直接失效。
 * 改从根节点逐级累乘 local matrix，得到相对模型原点的坐标。
 */
function horizontalSamples(model: THREE.Object3D): LocalPoint2[] {
  const points: LocalPoint2[] = [];
  const v = new THREE.Vector3();
  const local = new THREE.Matrix4();
  const walk = (node: THREE.Object3D, parent: THREE.Matrix4) => {
    const m = new THREE.Matrix4().multiplyMatrices(parent, node.matrix);
    if (node instanceof THREE.Mesh) {
      const attr = node.geometry.getAttribute('position');
      if (attr) {
        const stride = Math.max(1, Math.floor(attr.count / 3000));
        for (let i = 0; i < attr.count; i += stride) {
          v.fromBufferAttribute(attr, i).applyMatrix4(m);
          points.push([v.x, v.z]);
        }
      }
    }
    for (const child of node.children) walk(child, m);
  };
  model.updateMatrix();
  model.traverse((node) => node.updateMatrix());
  for (const child of model.children) walk(child, local.identity());
  return points;
}

interface LandmarkModelProps {
  /** 景点 id，需与 scene-geometry.json 中的 key 一致 */
  id: string;
  /** public 下的模型路径 */
  url: string;
  /** 模型原点高度；自带地形底板的模型需略高于底座顶面 */
  baseY?: number;
  /** 城外地标：夜里不点灯笼，城外民居只留窗光 */
  outside?: boolean;
}

/**
 * 景点精细模型（阶段3）：由 scripts/blender/*.py 生成，
 * 单位为米、原点为景点质心，可直接按质心坐标落入沙盘。
 * 材质按名称做四季换色、瓦面程序化瓦垄，选中时整体自发光高亮。
 */
export function LandmarkModel({ id, url, baseY = LANDMARK_BASE_Y, outside }: LandmarkModelProps) {
  const { scene } = useGLTF(url);
  const selectedId = useSandTable((state) => state.selectedId);
  const select = useSandTable((state) => state.select);
  const season = useSandTable((state) => state.season);
  const night = useSandTable((state) => state.time === 'night');

  const model = useMemo(() => scene.clone(true), [scene]);
  const centroid = sceneGeometry.landmarks[id]?.centroid;
  const outline = sceneGeometry.landmarks[id]?.outline;
  const roads = useRoads();
  const selected = selectedId === id;
  const skyReflection = useMemo(() => getSkyReflection(season), [season]);

  /**
   * 模型通常就是照 OSM 轮廓建的、尺寸与轮廓相当；压路的主因是整块模型相对
   * 石台偏心（模型几何中心 ≠ 多边形面积质心，拙政园偏了 30~50m），
   * 而削石台只处理了"画出来的边界"，模型外墙没动。
   *
   * 所以落位分两步：先把模型包围盒中心对齐石台（裁剪后）包围盒中心，
   * 再在该位置求"不压路"的最大等比缩放——能只平移就只平移，放不下才缩。
   *
   * 街景型（平江路/观前街/山塘街/石路/桃花坞）模型本身就是街面，
   * 压"路"是设计意图，跳过。
   */
  const placement = useMemo(() => {
    if (!roads || !outline || !centroid || STREET_IDS.has(id)) return null;
    const pad = boundsOf(trimOutlineFromRoads(outline, roads));
    if (!pad) return null;
    return fitLandmarkPlacement(
      horizontalSamples(model),
      pad.center,
      [centroid.x, centroid.z],
      getRoadClearance(roads),
      { margin: 1.2, min: 0.55, step: 0.01 },
    );
  }, [roads, outline, model, centroid, id]);

  const fitScale = placement?.scale ?? 1;
  const offset = placement?.offset ?? [0, 0];

  useLayoutEffect(() => {
    const materials = new Set<THREE.Material>();
    model.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mat = child.material;
        if (Array.isArray(mat)) mat.forEach((m) => materials.add(m));
        else if (mat) materials.add(mat);
      }
    });

    const tint = SEASON_TINTS[season];
    let leafIndex = 0;
    for (const mat of materials) {
      if (!(mat instanceof THREE.MeshStandardMaterial)) continue;

      // 固有色偏灰：首次加载时小幅提高饱和度，让石、木、砖更有层次（只强化一次）
      if (!mat.userData.colorBoosted) {
        const hsl = { h: 0, s: 0, l: 0 };
        mat.color.getHSL(hsl);
        mat.color.setHSL(hsl.h, Math.min(1, hsl.s * 1.18), Math.min(1, hsl.l * 1.02));
        mat.userData.colorBoosted = true;
      }

      const kind = classify(mat.name);
      if (kind === 'leaf') {
        mat.color.set(season === 'autumn' ? AUTUMN_LEAVES[leafIndex % AUTUMN_LEAVES.length] : tint.leaf);
        leafIndex += 1;
      } else if (kind === 'ground') {
        // 与城内街巷铺装同一套青石板色
        mat.color.set(SEASON_LOOKS[season].ground);
      } else if (kind === 'water') {
        // 园林水面：低粗糙度 + 天空反射，俯视时能读到"水"，而不是一块蓝灰色地砖
        mat.color.set(season === 'winter' ? '#cfe2ec' : tint.water);
        mat.roughness = season === 'winter' ? 0.06 : 0.14;
        mat.metalness = season === 'winter' ? 0.3 : 0.18;
        mat.envMap = skyReflection;
        mat.envMapIntensity = season === 'winter' ? 1.5 : 0.6;
        mat.needsUpdate = true;
      } else if (kind !== 'other') {
        mat.color.set(tint[kind]);
      }

      if (kind === 'tile') applyTileShader(mat);
      if (kind === 'wall') applyWallShader(mat);

      // 选中高亮优先；夜间灯笼自发光（城外地标不点灯笼）
      const lanternLit = night && kind === 'lantern' && !outside;
      const glow = selected ? '#ffb84d' : lanternLit ? '#ff8a3c' : '#000000';
      mat.emissive.set(glow);
      // 选中高亮压到很低：强叠加会把白墙黛瓦整片染成米黄，看起来像"另一种风格"
      mat.emissiveIntensity = selected ? 0.12 : lanternLit ? 1.1 : 0;
    }

    for (const uniform of nightUniforms) uniform.value = night ? 1 : 0;
  }, [model, selected, season, night, outside, skyReflection]);

  if (!centroid) return null;

  return (
    <Suspense fallback={null}>
      <group
        name={`landmark-${id}`}
        position={[centroid.x + offset[0], baseY, centroid.z + offset[1]]}
        scale={fitScale}
        userData={{ landmarkScale: fitScale, landmarkOffset: offset }}
        onClick={(event) => {
          event.stopPropagation();
          select(id);
        }}
      >
        <primitive object={model} />
      </group>
    </Suspense>
  );
}

useGLTF.preload('/models/zhuozhengyuan.glb');
useGLTF.preload('/models/liuyuan.glb');
useGLTF.preload('/models/pingjiang.glb');
useGLTF.preload('/models/guanqianjie.glb');
useGLTF.preload('/models/shuangta.glb');
useGLTF.preload('/models/beisita.glb');
useGLTF.preload('/models/shizilin.glb');
useGLTF.preload('/models/wangshiyuan.glb');
useGLTF.preload('/models/suzhou_museum.glb');
useGLTF.preload('/models/canglangting.glb');
useGLTF.preload('/models/hanshansi.glb');
useGLTF.preload('/models/tangyinci.glb');
useGLTF.preload('/models/taohuawu.glb');
useGLTF.preload('/models/shantangjie.glb');
useGLTF.preload('/models/xiyuansi.glb');
useGLTF.preload('/models/shilu.glb');
