import { useMemo } from 'react';
import * as THREE from 'three';
import { useRoads } from '../hooks/useRoads';
import { useSandTable } from '../store/useSandTable';
import { buildRibbons } from '../utils/ribbon';
import { roadSurfaceY } from '../data/outerCity';
import { clipLinesToRadius } from '../utils/clip';
import { WORLD_LIMIT } from '../constants/geo';

/** 道路面高（米）：抬高以避免远视距下的深度冲突 */
const MINOR_ROAD_Y = 1.2;
/** 主干道再抬高 0.1m：与支路在路口重叠时由深度缓冲稳定分出前后，避免共面闪烁 */
const MAJOR_ROAD_Y = 1.3;
const MAJOR_WIDTH = 26;
const MINOR_WIDTH = 11;

/**
 * 路面标线着色器：车道线、虚实线全部按断面 UV 在片元里画，
 * 不新增任何几何；路网 1300km，用几何画标线会多出几十万三角形。
 */
const ROAD_VERTEX_PARS = /* glsl */ `
attribute vec2 aRoad;
varying vec2 vRoad;
`;

const ROAD_VERTEX_BODY = /* glsl */ `
  vRoad = aRoad;
`;

const ROAD_FRAGMENT_PARS = /* glsl */ `
varying vec2 vRoad;
uniform float uMarkFade;
uniform vec3 uMarkColor;
`;

const ROAD_FRAGMENT_BODY = /* glsl */ `
{
  float u = vRoad.x;
  float v = vRoad.y;
  // 横断面一像素的归一化宽度：细线边缘随它加宽，等价于解析抗锯齿
  float aaU = clamp(fwidth(u) * 1.6, 0.002, 0.16);
  // 一像素跨过多少米路面：远处整条标线淡出，消除摩尔纹与闪烁
  float metersPerPx = fwidth(v);
  float mask = uMarkFade * (1.0 - smoothstep(0.25, 0.95, metersPerPx));

  if (mask > 0.001) {
    // 两侧车道边线（实线）
    float edge = 1.0 - smoothstep(0.010, 0.010 + aaU, abs(u - 0.055));
    edge = max(edge, 1.0 - smoothstep(0.010, 0.010 + aaU, abs(u - 0.945)));
    // 中心虚线：12m 周期，约 4.5m 实 / 7.5m 空
    float d = fract(v / 12.0);
    float dashMask = smoothstep(0.03, 0.09, d) * (1.0 - smoothstep(0.40, 0.46, d));
    float center = 1.0 - smoothstep(0.008, 0.008 + aaU, abs(u - 0.5));
    float mark = max(edge, center * dashMask);
    diffuseColor.rgb = mix(diffuseColor.rgb, uMarkColor, clamp(mark, 0.0, 1.0) * mask);
  }
}
`;

/** 道路标线材质：在标准材质上注入标线绘制 */
function makeRoadMaterial(baseColor: string, roughness: number, marking: string) {
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
          })
        : null,
    [majorLines],
  );
  const minorGeo = useMemo(
    () =>
      minorLines
        ? buildRibbons(minorLines, MINOR_WIDTH, (x, z) => roadSurfaceY(x, z, MINOR_ROAD_Y), {
            roadUV: true,
          })
        : null,
    [minorLines],
  );

  const minorMat = useMemo(
    () => makeRoadMaterial(winter ? '#4b4f53' : '#474a4e', winter ? 0.95 : 0.82, '#e2ddcd'),
    [winter],
  );
  const majorMat = useMemo(
    () => makeRoadMaterial(winter ? '#43474b' : '#3c3f43', winter ? 0.93 : 0.8, '#efe9d6'),
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
