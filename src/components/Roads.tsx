import { useMemo } from 'react';
import * as THREE from 'three';
import { useRoads } from '../hooks/useRoads';
import { useSandTable } from '../store/useSandTable';
import { buildRibbons } from '../utils/ribbon';
import { roadSurfaceY } from '../data/outerCity';
import { clipLinesToRadius } from '../utils/clip';
import { WORLD_LIMIT } from '../constants/geo';
import type { LocalPoint2 } from '../types';

/** 道路面高（米）：抬高以避免远视距下的深度冲突 */
const MINOR_ROAD_Y = 1.2;
/** 主干道再抬高 0.18m：与支路在路口重叠时由深度缓冲稳定分出前后，避免共面闪烁 */
const MAJOR_ROAD_Y = 1.38;
const MAJOR_WIDTH = 26;
const MINOR_WIDTH = 11;

/**
 * 路面标线着色器：车道线、虚实线全部按断面 UV 在片元里画，
 * 不新增任何几何；路网 1300km，用几何画标线会多出几十万三角形。
 */
const ROAD_VERTEX_PARS = /* glsl */ `
attribute vec3 aRoad;
varying vec3 vRoad;
`;

const ROAD_VERTEX_BODY = /* glsl */ `
  vRoad = aRoad;
`;

const ROAD_FRAGMENT_PARS = /* glsl */ `
varying vec3 vRoad;
uniform float uMarkFade;
uniform vec3 uMarkColor;
`;

const ROAD_FRAGMENT_BODY = /* glsl */ `
{
  float u = vRoad.x;
  float v = vRoad.y;
  // 路口遮罩：另一条同高路面压上来时，两套标线共面会一起闪，这里直接淡掉
  float junction = vRoad.z;
  // 横断面一像素的归一化宽度：细线边缘随它加宽，等价于解析抗锯齿。
  // 上限必须小：以前放到 0.16，远处一条边线被摊成 4m 宽的渐变，
  // 不透明度被稀释到几乎看不见，于是"要拉近才看得到标线"。
  float aaU = clamp(fwidth(u) * 1.6, 0.0025, 0.05);
  // 一像素跨过多少米路面：只用来轻微降对比，不再让标线整体消失
  float metersPerPx = fwidth(v);
  float far = smoothstep(0.5, 2.2, metersPerPx);
  float mask = uMarkFade * junction * mix(1.0, 0.62, far);
  // 中心虚线是高频图案：远处按像素跨度淡出，避免摩尔纹与闪动
  float dashFade = 1.0 - smoothstep(0.45, 1.6, metersPerPx);

  if (mask > 0.001) {
    // 两侧车道边线（实线）
    float edge = 1.0 - smoothstep(0.016, 0.016 + aaU, abs(u - 0.055));
    edge = max(edge, 1.0 - smoothstep(0.016, 0.016 + aaU, abs(u - 0.945)));
    // 中心虚线：8m 周期，约 3m 实 / 5m 空（12m 在老城密路网里显得过于稀疏）
    float d = fract(v / 8.0);
    float dashMask = smoothstep(0.04, 0.10, d) * (1.0 - smoothstep(0.40, 0.46, d));
    float center = 1.0 - smoothstep(0.011, 0.011 + aaU, abs(u - 0.5));
    float mark = max(edge, center * dashMask * dashFade);
    diffuseColor.rgb = mix(diffuseColor.rgb, uMarkColor, clamp(mark, 0.0, 1.0) * mask);
  }
}
`;

/** 道路标线材质：在标准材质上注入标线绘制。桥面也复用同一套，保证过桥不丢标线 */
export function createRoadMaterial(baseColor: string, roughness: number, marking: string) {
  const mat = new THREE.MeshStandardMaterial({
    color: baseColor,
    roughness,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
  const uniforms = {
    uMarkFade: { value: 1 },
    uMarkColor: { value: new THREE.Color(marking) },
  };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMarkFade = uniforms.uMarkFade;
    shader.uniforms.uMarkColor = uniforms.uMarkColor;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ROAD_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${ROAD_VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ROAD_FRAGMENT_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${ROAD_FRAGMENT_BODY}`);
  };
  mat.customProgramCacheKey = () => 'road-marking';
  return mat;
}

/**
 * 标线遮罩：顶点到"任意同高路面中心线"的最近距离。
 * 带状面顶点距自身中心线恰好半宽（half），所以 minDist < half 就说明这里
 * 被另一条同高路面压住了（路口、并线、短接），标线在此淡出，
 * 避免两套标线共面叠加、俯视下一明一暗地闪。
 */
function buildMarkMask(lines: LocalPoint2[][], half: number): (x: number, z: number) => number {
  const CELL = 16;
  const cellKey = (ix: number, iz: number) => ix * 100000 + iz;
  const segs: { ax: number; az: number; bx: number; bz: number }[] = [];
  const grid = new Map<number, number[]>();

  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i += 1) {
      const [ax, az] = line[i];
      const [bx, bz] = line[i + 1];
      if (Math.hypot(bx - ax, bz - az) < 0.4) continue;
      const id = segs.push({ ax, az, bx, bz }) - 1;
      const x0 = Math.floor(Math.min(ax, bx) / CELL);
      const x1 = Math.floor(Math.max(ax, bx) / CELL);
      const z0 = Math.floor(Math.min(az, bz) / CELL);
      const z1 = Math.floor(Math.max(az, bz) / CELL);
      for (let ix = x0; ix <= x1; ix += 1)
        for (let iz = z0; iz <= z1; iz += 1) {
          const k = cellKey(ix, iz);
          let bucket = grid.get(k);
          if (!bucket) grid.set(k, (bucket = []));
          bucket.push(id);
        }
    }
  }

  const lo = half - 0.6;
  const hi = half + 1.2;
  return (x, z) => {
    const ix0 = Math.floor((x - hi) / CELL);
    const ix1 = Math.floor((x + hi) / CELL);
    const iz0 = Math.floor((z - hi) / CELL);
    const iz1 = Math.floor((z + hi) / CELL);
    let best = Infinity;
    for (let ix = ix0; ix <= ix1; ix += 1) {
      for (let iz = iz0; iz <= iz1; iz += 1) {
        const bucket = grid.get(cellKey(ix, iz));
        if (!bucket) continue;
        for (const id of bucket) {
          const s = segs[id];
          const dx = s.bx - s.ax;
          const dz = s.bz - s.az;
          const l2 = dx * dx + dz * dz;
          let t = l2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(x - s.ax - t * dx, z - s.az - t * dz);
          if (d < best) {
            best = d;
            if (best <= lo) return 0;
          }
        }
      }
    }
    if (best >= hi) return 1;
    const k = (best - lo) / (hi - lo);
    return k * k * (3 - 2 * k);
  };
}

/**
 * 道路（M1）：OSM highway 折线 → 带状面，主干/支路各合并为一个 mesh（2 draw call）。
 * 路网裁到 5.8km（寒山寺为界），路面高度按半径从城内基准平滑降到外围地面。
 * 车道虚实线由着色器绘制；冬季路面保持干净的深色沥青，不做积雪覆盖。
 */
export function Roads() {
  const data = useRoads();
  const season = useSandTable((state) => state.season);
  const winter = season === 'winter';

  const majorLines = useMemo(
    () => (data ? clipLinesToRadius(data.major, WORLD_LIMIT) : null),
    [data],
  );
  const minorLines = useMemo(
    () => (data ? clipLinesToRadius(data.minor, WORLD_LIMIT) : null),
    [data],
  );

  const majorGeo = useMemo(
    () =>
      majorLines
        ? buildRibbons(majorLines, MAJOR_WIDTH, (x, z) => roadSurfaceY(x, z, MAJOR_ROAD_Y), {
            roadUV: true,
            markMask: buildMarkMask(majorLines, MAJOR_WIDTH / 2),
          })
        : null,
    [majorLines],
  );
  const minorGeo = useMemo(
    () =>
      minorLines
        ? buildRibbons(minorLines, MINOR_WIDTH, (x, z) => roadSurfaceY(x, z, MINOR_ROAD_Y), {
            roadUV: true,
            markMask: buildMarkMask(minorLines, MINOR_WIDTH / 2),
          })
        : null,
    [minorLines],
  );

  const minorMat = useMemo(
    () => {
      const mat = createRoadMaterial(winter ? '#4b4f53' : '#474a4e', winter ? 0.95 : 0.82, '#e2ddcd');
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = 1;
      mat.polygonOffsetUnits = 1;
      return mat;
    },
    [winter],
  );
  const majorMat = useMemo(
    () => {
      const mat = createRoadMaterial(winter ? '#43474b' : '#3c3f43', winter ? 0.93 : 0.8, '#efe9d6');
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = 0;
      mat.polygonOffsetUnits = 0;
      return mat;
    },
    [winter],
  );

  if (!data) return null;

  return (
    <group>
      {minorGeo && (
        <mesh geometry={minorGeo} receiveShadow material={minorMat} />
      )}
      {majorGeo && (
        <mesh geometry={majorGeo} receiveShadow material={majorMat} />
      )}
    </group>
  );
}
