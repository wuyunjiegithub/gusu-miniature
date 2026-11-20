import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useBuildings } from '../hooks/useBuildings';
import { useSandTable } from '../store/useSandTable';
import { ROOF_COLORS, WALL_COLORS } from '../constants/palette';
import { createPitchedRoofGeometry } from '../utils/roof';

const hash = (i: number): number => {
  const v = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};

/** 城外白模落地高度（与外围陆地齐平） */
const OUTER_BASE_Y = -2;

/**
 * 立面细节着色器：按每个实例的真实尺寸，在墙面上程序化绘制
 * 窗格、窗框、大门、勒脚与檐口阴影；夜间约四成窗户透出暖光。
 * 纯着色器实现，不增加任何 draw call 与顶点。
 */
const FACADE_VERTEX_PARS = /* glsl */ `
varying vec3 vFacadeLocal;
varying vec3 vFacadeNormal;
varying vec3 vFacadeScale;
varying float vFacadeSeed;
`;

const FACADE_VERTEX_BODY = /* glsl */ `
  vFacadeScale = vec3(
    length(instanceMatrix[0].xyz),
    length(instanceMatrix[1].xyz),
    length(instanceMatrix[2].xyz)
  );
  vFacadeLocal = position;
  vFacadeNormal = normal;
  vec3 facadeInstancePos = instanceMatrix[3].xyz;
  vFacadeSeed = fract(sin(dot(facadeInstancePos.xz, vec2(12.9898, 78.233))) * 43758.5453);
`;

const FACADE_FRAGMENT_PARS = /* glsl */ `
varying vec3 vFacadeLocal;
varying vec3 vFacadeNormal;
varying vec3 vFacadeScale;
varying float vFacadeSeed;
uniform float uNight;
uniform float uFrost;
/** 当前窗格的夜间灯色（含亮度），暖黄为主、少量冷白 */
vec3 facadeGlowTint = vec3(1.0, 0.77, 0.48);
/**
 * 边界柔化补偿：按像素在墙面上的覆盖尺寸（米）加宽过渡带。
 * 细窗框、窗棂只有几厘米，远看不足一个像素，硬边会在镜头移动时高频闪烁，
 * 这里让边缘宽度随 fwidth 自适应，等价于解析抗锯齿。
 */
float facadeSoftBias = 0.0;
float facadeBand(float d, float halfW, float soft) {
  return 1.0 - smoothstep(halfW, halfW + soft + facadeSoftBias, d);
}
`;

const FACADE_FRAGMENT_BODY = /* glsl */ `
float facadeGlow = 0.0;
{
  float detailFade = 1.0 - smoothstep(900.0, 1900.0, length(vViewPosition));
  if (detailFade > 0.001) {
    float faceAxis = abs(vFacadeNormal.x) > 0.5 ? 1.0 : (abs(vFacadeNormal.z) > 0.5 ? 2.0 : 0.0);
    if (faceAxis > 0.5) {
      bool sideFace = faceAxis < 1.5;
      float faceW = sideFace ? vFacadeScale.z : vFacadeScale.x;
      float u = (sideFace ? vFacadeLocal.z * vFacadeScale.z : vFacadeLocal.x * vFacadeScale.x)
        + faceW * 0.5;
      float h = max(vFacadeScale.y, 1.0);
      float y = clamp(vFacadeLocal.y, 0.0, 1.0) * h;
      // 一个像素覆盖的墙面尺寸（米），用于自适应柔化窗框/窗棂等细边
      float facadePx = max(fwidth(u), fwidth(y));
      facadeSoftBias = clamp(facadePx, 0.0, 0.35);
      // 坡顶民居的山墙（短边）少开窗
      float gable = sideFace ? 1.0 - step(24.0, h) : 0.0;

      // 勒脚与檐口阴影
      float plinth = 1.0 - smoothstep(0.45, 0.68, y);
      float eave = smoothstep(h - 0.55, h - 0.15, y);
      diffuseColor.rgb *= 1.0 - (plinth * 0.13 + eave * 0.1) * detailFade;

      // 开间（列）划分：普通立面最多 2 个开间，宽立面才开 3 个
      float margin = clamp(faceW * 0.16, 0.5, 1.4);
      float innerW = max(faceW - margin * 2.0, 0.6);
      float colSpacing = 5.0;
      float maxCols = faceW > 14.0 ? 3.0 : 2.0;
      float cols = clamp(floor(innerW / colSpacing + 0.45), 1.0, maxCols);
      float colW = innerW / cols;
      float colId = clamp(floor((u - margin) / colW), 0.0, cols - 1.0);
      float cu = margin + (colId + 0.5) * colW;
      float dx = abs(u - cu);

      // 楼层划分：民居（h<12）最多 2 层窗，其余最多 4 层（对应 3~6 层建筑）
      float startY = 1.9;
      float usable = max(h - startY - 0.8, 1.0);
      float rawRows = floor(usable / 4.3 + 0.45);
      float rows = h < 12.0 ? min(rawRows, 2.0) : clamp(rawRows, 1.0, 4.0);
      float rowH = usable / rows;
      float rowId = clamp(floor((y - startY) / rowH), 0.0, rows - 1.0);
      float cy = startY + (rowId + 0.5) * rowH;
      float dy = abs(y - cy);

      // 每格独立随机：窗型尺寸有差异，约 26% 开间不开窗
      float cellSeed = fract(
        sin(dot(vec2(colId + 1.0, rowId + 1.0), vec2(12.9898, 78.233)) + vFacadeSeed * 37.7) * 43758.5453
      );
      float cellSeed2 = fract(cellSeed * 91.73 + 0.37);
      float winHalfH = min(1.2, rowH * 0.3) * (0.7 + 0.3 * fract(cellSeed * 7.31));
      float winHalfW = min(0.7, colW * 0.3) * (0.62 + 0.38 * fract(cellSeed2 * 5.17));
      winHalfW = mix(winHalfW, winHalfW * 0.55, gable);
      float winMask = step(0.26, cellSeed2);
      winMask *= mix(1.0, step(0.7, cellSeed2), gable);

      // 大门：按建筑种子在四个立面中选一面，底层居中（山墙不开门）
      float faceId = abs(vFacadeNormal.x) > 0.5
        ? (vFacadeNormal.x > 0.0 ? 0.0 : 1.0)
        : (vFacadeNormal.z > 0.0 ? 2.0 : 3.0);
      float doorFace = floor(vFacadeSeed * 4.0);
      float doorZone = 0.0;
      if (abs(faceId - doorFace) < 0.5 && gable < 0.5) {
        float du = abs(u - faceW * 0.5);
        float dv = abs(y - 1.18);
        doorZone = facadeBand(du, 0.7, 0.05) * facadeBand(dv, 1.18, 0.05);
        float doorFrame = facadeBand(du, 0.84, 0.05) * facadeBand(dv, 1.32, 0.05) * (1.0 - doorZone);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.74, doorFrame * detailFade);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.27, 0.18, 0.12), doorZone * detailFade);
      }

      // 窗洞：木框 + 玻璃 + 窗棂 + 窗台 + 窗楣
      float winOuter = facadeBand(dx, winHalfW + 0.1, 0.04) * facadeBand(dy, winHalfH + 0.1, 0.04);
      float win = facadeBand(dx, winHalfW, 0.03) * facadeBand(dy, winHalfH, 0.03);
      float winOn = win * winMask * (1.0 - doorZone);
      float frameOn = winOuter * winMask * (1.0 - win) * (1.0 - doorZone);

      float sill = facadeBand(dx, winHalfW + 0.14, 0.05)
        * facadeBand(abs(y - (cy - winHalfH - 0.12)), 0.06, 0.03) * winMask * (1.0 - doorZone);
      float lintel = facadeBand(dx, winHalfW + 0.16, 0.06)
        * facadeBand(abs(y - (cy + winHalfH + 0.14)), 0.07, 0.04) * winMask * (1.0 - doorZone);

      // 玻璃上沿受檐影更暗，下沿略亮；木棂两竖一横
      vec3 glass = mix(vec3(0.16, 0.2, 0.25), vec3(0.05, 0.07, 0.1), smoothstep(-winHalfH, winHalfH, y - cy));
      float mulV = (1.0 - smoothstep(0.02, 0.05, abs(abs(dx) - winHalfW * 0.34))) * winOn;
      float mulH = (1.0 - smoothstep(0.02, 0.05, abs(y - (cy + winHalfH * 0.42)))) * winOn;
      // 窗棂仅 3cm 宽，像素覆盖超过 10cm 时淡出，避免远景木棂闪烁
      float mullion = clamp(mulV + mulH, 0.0, 1.0) * (1.0 - smoothstep(0.10, 0.22, facadePx));

      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.78, frameOn * detailFade);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.33, 0.24, 0.17), frameOn * 0.8 * detailFade);
      diffuseColor.rgb = mix(diffuseColor.rgb, glass, winOn * detailFade);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.47, 0.35, 0.24), mullion * 0.9 * detailFade);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.84, 0.82, 0.77), sill * 0.9 * detailFade);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.7, lintel * detailFade);

      // 积雪：墙面提亮，窗台挂雪
      if (uFrost > 0.5) {
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), 0.28 * detailFade);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.97, 0.98, 1.0), sill * 0.6 * detailFade);
      }

      // 夜间点灯：约四成窗户亮暖光
      facadeGlow = winOn * step(cellSeed, 0.55) * detailFade;

      // 窗光色温：每户偏暖程度不同，少数改用冷白灯；亮度也有差异
      float tintSeed = fract(vFacadeSeed * 17.31 + cellSeed * 5.73);
      vec3 warmTint = mix(vec3(1.0, 0.68, 0.36), vec3(1.0, 0.87, 0.64), fract(tintSeed * 2.13));
      float coolMix = step(0.86, fract(tintSeed * 7.7 + 0.19));
      facadeGlowTint = mix(warmTint, vec3(0.74, 0.84, 1.0), coolMix)
        * (1.15 + 0.85 * fract(tintSeed * 3.1 + 0.4));
    }
  }
}
`;

/**
 * 屋瓦细节着色器：沿屋脊方向按 0.38m 间距绘制瓦垄线，远处自动淡出。
 * 与墙体一样是纯着色器实现，不增加几何量。
 */
const ROOF_VERTEX_PARS = /* glsl */ `
varying vec3 vRoofLocal;
varying vec3 vRoofNormal;
varying vec3 vRoofScale;
`;

const ROOF_VERTEX_BODY = /* glsl */ `
  vRoofScale = vec3(
    length(instanceMatrix[0].xyz),
    length(instanceMatrix[1].xyz),
    length(instanceMatrix[2].xyz)
  );
  vRoofLocal = position;
  vRoofNormal = normal;
`;

const ROOF_FRAGMENT_PARS = /* glsl */ `
varying vec3 vRoofLocal;
varying vec3 vRoofNormal;
varying vec3 vRoofScale;
uniform float uFrost;
`;

const ROOF_FRAGMENT_BODY = /* glsl */ `
{
  float tileFade = 1.0 - smoothstep(650.0, 1500.0, length(vViewPosition));
  float xm = (vRoofLocal.x + 0.5) * vRoofScale.x;
  float stripeCoord = xm / 0.38;
  float stripe = abs(fract(stripeCoord) - 0.5) * 2.0;
  // 瓦垄周期只有 0.38m：当一像素覆盖接近一个瓦垄时淡出，消除远景摩尔纹与闪烁
  float stripeAA = 1.0 - smoothstep(0.35, 0.9, fwidth(stripeCoord));
  float tileMask = tileFade * stripeAA;
  // 坡顶几何是双面渲染的，法线朝下的一侧靠 gl_FrontFacing 翻面参与光照，
  // 这里判"是否朝上的瓦面"必须取绝对值，否则两个坡面永远命中不了
  if (tileMask > 0.001 && abs(vRoofNormal.y) > 0.2) {
    diffuseColor.rgb *= 1.0 - smoothstep(0.55, 1.0, stripe) * 0.16 * tileMask;
  }
  // 积雪：朝上的瓦面覆雪，保留瓦垄凹槽，避免整片纯白
  if (uFrost > 0.5 && abs(vRoofNormal.y) > 0.04) {
    float cover = smoothstep(0.04, 0.32, abs(vRoofNormal.y));
    float groove = smoothstep(0.5, 1.0, stripe) * 0.24 * stripeAA;
    vec3 frostColor = mix(vec3(0.93, 0.95, 0.98), diffuseColor.rgb, groove);
    // 每栋屋面的积雪厚度略有差异
    float thin = 0.7 + 0.22 * fract(vRoofScale.x * 0.37 + vRoofScale.z * 0.63);
    diffuseColor.rgb = mix(diffuseColor.rgb, frostColor, cover * thin);
  }
}
`;

/**
 * 风格化屋顶群（FR-03 / M1）：
 * OSM 建筑轮廓 → 定向包围盒实例，墙体 + 坡顶 + 平顶三个 InstancedMesh（3 draw call）。
 * 坡顶屋脊已按长边对齐；实例颜色带确定性变化，避免"塑料感"。
 */
export function BuildingField() {
  const data = useBuildings();
  /**
   * 城外需要坡顶的建筑。
   * OSM 城外形体里有一部分 roofH 为 0（平顶建筑），若按 1mm 高度生成坡顶，
   * 坡面几乎与墙体顶面共面：远视距下深度缓冲分辨不出这 1mm，整片屋面会
   * 与浅色墙顶交替 z-fighting 而闪烁（白天黑夜都闪）。这类建筑直接用墙顶
   * 作为屋面，不再生成退化坡顶。
   */
  const outerPitched = useMemo(
    () => (data ? data.outer.filter((rec) => rec[6] > 0.05) : []),
    [data],
  );
  const wallsRef = useRef<THREE.InstancedMesh>(null);
  const pitchedRef = useRef<THREE.InstancedMesh>(null);
  const flatRef = useRef<THREE.InstancedMesh>(null);
  const outerRef = useRef<THREE.InstancedMesh>(null);
  const outerRoofRef = useRef<THREE.InstancedMesh>(null);
  const shadowRef = useRef<THREE.InstancedMesh>(null);

  const wallGeo = useMemo(
    () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    [],
  );
  const roofGeo = useMemo(() => createPitchedRoofGeometry(), []);
  const slabGeo = useMemo(
    () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    [],
  );
  /** 偏移投影面：以假投影替代实时阴影，低成本提供立体感 */
  const shadowGeo = useMemo(() => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), []);
  const shadowMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#1b2430',
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      }),
    [],
  );

  /** 夜间点灯开关（立面着色器 uniform） */
  const night = useSandTable((state) => state.time === 'night');
  const nightRef = useRef(night);
  nightRef.current = night;
  const nightUniformRef = useRef<{ value: number } | null>(null);

  /** 冬霜开关（墙体/屋顶/平顶/城外白模着色器 uniform） */
  const winter = useSandTable((state) => state.season === 'winter');
  const winterRef = useRef(winter);
  winterRef.current = winter;
  const frostUniformsRef = useRef<Array<{ value: number }>>([]);

  useEffect(() => {
    if (nightUniformRef.current) nightUniformRef.current.value = night ? 1 : 0;
  }, [night]);

  useEffect(() => {
    for (const uniform of frostUniformsRef.current) uniform.value = winter ? 1 : 0;
  }, [winter]);

  /** 给自定义材质注入冬霜 uniform（简单材质整体提亮） */
  const injectFrost = (mat: THREE.MeshStandardMaterial, strength: number) => {
    mat.onBeforeCompile = (shader) => {
      const uniform = { value: winterRef.current ? 1 : 0 };
      frostUniformsRef.current.push(uniform);
      shader.uniforms.uFrost = uniform;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uFrost;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>\n  if (uFrost > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.90, 0.93, 0.96), ${strength.toFixed(2)});`,
        );
    };
  };

  /** 墙体材质：注入立面程序化细节（窗、门、勒脚、檐口、夜间窗光、积雪） */
  const wallMat = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.92 });
    mat.onBeforeCompile = (shader) => {
      const uniform = { value: nightRef.current ? 1 : 0 };
      shader.uniforms.uNight = uniform;
      nightUniformRef.current = uniform;
      const frostUniform = { value: winterRef.current ? 1 : 0 };
      shader.uniforms.uFrost = frostUniform;
      frostUniformsRef.current.push(frostUniform);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${FACADE_VERTEX_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FACADE_VERTEX_BODY}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FACADE_FRAGMENT_PARS}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${FACADE_FRAGMENT_BODY}`)
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>\n  totalEmissiveRadiance += facadeGlowTint * facadeGlow * uNight * 2.4;`,
        );
    };
    return mat;
  }, []);

  /** 坡顶材质：注入瓦垄线细节与积雪 */
  const roofMat = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      const frostUniform = { value: winterRef.current ? 1 : 0 };
      shader.uniforms.uFrost = frostUniform;
      frostUniformsRef.current.push(frostUniform);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${ROOF_VERTEX_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${ROOF_VERTEX_BODY}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${ROOF_FRAGMENT_PARS}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${ROOF_FRAGMENT_BODY}`);
    };
    return mat;
  }, []);

  const slabMat = useMemo(() => {
    const slab = new THREE.MeshStandardMaterial({ roughness: 0.9 });
    injectFrost(slab, 0.8);
    return slab;
  }, []);

  useLayoutEffect(() => {
    if (!data) return;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    const applyRecord = (mesh: THREE.InstancedMesh | null, index: number, rec: number[]) => {
      if (!mesh) return;
      const [x, z, w, d, rot, h] = rec;
      dummy.position.set(x, 0, z);
      dummy.rotation.set(0, rot, 0);
      // 相邻 OSM 建筑常共用同一面墙：完全共面会深度冲突（z-fighting）而闪烁，
      // 按实例微缩 0.6%~1.2%，让共面墙体错开几厘米（远看无感，近看也不会露缝）
      const shrink = 0.988 + hash(index * 3.17 + 11.3) * 0.006;
      dummy.scale.set(w * shrink, h, d * shrink);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    };

    // 墙体：坡顶建筑 + 平顶建筑
    const walls = wallsRef.current;
    if (walls) {
      let i = 0;
      for (const rec of [...data.pitched, ...data.flat]) {
        applyRecord(walls, i, rec);
        color.set(WALL_COLORS[Math.floor(hash(i) * WALL_COLORS.length)]);
        walls.setColorAt(i, color);
        i += 1;
      }
      walls.instanceMatrix.needsUpdate = true;
      if (walls.instanceColor) walls.instanceColor.needsUpdate = true;
    }

    // 坡顶
    const pitched = pitchedRef.current;
    if (pitched) {
      data.pitched.forEach((rec, i) => {
        const [x, z, w, d, rot, h, roofH] = rec;
        // 相邻等高等脊建筑的坡面会完全共面，远看时整片屋面深度相同而闪烁。
        // 每个实例的平面尺寸做 0.5% 差异，使重叠坡面错开几厘米（视觉无感）
        const jitter = 0.995 + hash(i * 5.31 + 3.7) * 0.01;
        dummy.position.set(x, h, z);
        dummy.rotation.set(0, rot, 0);
        dummy.scale.set(w * 1.08 * jitter, roofH, d * 1.08 * jitter);
        dummy.updateMatrix();
        pitched.setMatrixAt(i, dummy.matrix);
        color.set(ROOF_COLORS[Math.floor(hash(i + 97) * ROOF_COLORS.length)]);
        pitched.setColorAt(i, color);
      });
      pitched.instanceMatrix.needsUpdate = true;
      if (pitched.instanceColor) pitched.instanceColor.needsUpdate = true;
    }

    // 平顶女儿墙板
    const flat = flatRef.current;
    if (flat) {
      data.flat.forEach((rec, i) => {
        const [x, z, w, d, rot, h, roofH] = rec;
        // 同坡顶：相邻平顶板的顶面会共面，做 0.5% 尺寸差异 + 2cm 以内随机抬升
        const jitter = 0.995 + hash(i * 4.63 + 2.1) * 0.01;
        dummy.position.set(x, h + hash(i * 9.19 + 0.7) * 0.02, z);
        dummy.rotation.set(0, rot, 0);
        dummy.scale.set(w * 1.03 * jitter, roofH, d * 1.03 * jitter);
        dummy.updateMatrix();
        flat.setMatrixAt(i, dummy.matrix);
        color.set('#4e535a');
        flat.setColorAt(i, color);
      });
      flat.instanceMatrix.needsUpdate = true;
      if (flat.instanceColor) flat.instanceColor.needsUpdate = true;
    }

    // 城外真实建筑：与城内共用立面着色器（窗、门、檐口、夜间窗光）
    const outerMesh = outerRef.current;
    if (outerMesh) {
      data.outer.forEach((rec, i) => {
        const [x, z, w, d, rot, h] = rec;
        dummy.position.set(x, OUTER_BASE_Y, z);
        dummy.rotation.set(0, rot, 0);
        const shrink = 0.988 + hash(i * 2.71 + 5.9) * 0.006;
        dummy.scale.set(w * shrink, h, d * shrink);
        dummy.updateMatrix();
        outerMesh.setMatrixAt(i, dummy.matrix);
        color.set(WALL_COLORS[Math.floor(hash(i + 53) * WALL_COLORS.length)]);
        outerMesh.setColorAt(i, color);
      });
      outerMesh.instanceMatrix.needsUpdate = true;
      if (outerMesh.instanceColor) outerMesh.instanceColor.needsUpdate = true;
    }

    // 城外真实建筑的坡顶（与城内同一套瓦垄材质；平顶建筑（roofH≈0）不生成坡顶）
    const outerRoof = outerRoofRef.current;
    if (outerRoof) {
      outerPitched.forEach((rec, i) => {
        const [x, z, w, d, rot, h, roofH] = rec;
        const jitter = 0.995 + hash(i * 6.17 + 8.3) * 0.01;
        dummy.position.set(x, OUTER_BASE_Y + h, z);
        dummy.rotation.set(0, rot, 0);
        dummy.scale.set(w * 1.06 * jitter, roofH, d * 1.06 * jitter);
        dummy.updateMatrix();
        outerRoof.setMatrixAt(i, dummy.matrix);
        color.set(ROOF_COLORS[Math.floor(hash(i + 191) * ROOF_COLORS.length)]);
        outerRoof.setColorAt(i, color);
      });
      outerRoof.instanceMatrix.needsUpdate = true;
      if (outerRoof.instanceColor) outerRoof.instanceColor.needsUpdate = true;
    }

    // 假投影：按建筑高度朝太阳反方向偏移，形成统一的城市投影肌理
    const shadows = shadowRef.current;
    if (shadows) {
      let i = 0;
      const pushShadow = (rec: number[], baseY: number) => {
        const [x, z, w, d, rot, h] = rec;
        // 太阳位于 +X / -Z 方向，投影朝 -X / +Z 拉长；比例按高度线性
        dummy.position.set(x - h * 1.15, baseY, z + h * 1.15);
        dummy.rotation.set(0, rot, 0);
        dummy.scale.set(w + h * 0.95, 1, d + h * 0.95);
        dummy.updateMatrix();
        shadows.setMatrixAt(i, dummy.matrix);
        i += 1;
      };
      for (const rec of [...data.pitched, ...data.flat]) pushShadow(rec, 1.55);
      for (const rec of data.outer) pushShadow(rec, -1.95);
      shadows.instanceMatrix.needsUpdate = true;
    }
  }, [data, outerPitched]);

  if (!data) return null;

  return (
    <group>
      <instancedMesh
        ref={shadowRef}
        args={[shadowGeo, shadowMat, data.pitched.length + data.flat.length + data.outer.length]}
        frustumCulled={false}
      />
      {/* 城外背景白模（渲染顺序早于城内建筑，视觉上退后） */}
      <instancedMesh
        ref={outerRef}
        args={[wallGeo, wallMat, Math.max(1, data.outer.length)]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={outerRoofRef}
        args={[roofGeo, roofMat, Math.max(1, outerPitched.length)]}
        frustumCulled={false}
      />
      {/*
        建筑不使用实时阴影：1.6 万实例的阴影贴图在 6400m 阴影相机下只有约 3m/texel，
        自阴影（shadow acne）会在游走视角时产生大片闪烁；建筑投影已由上方偏移的
        假投影贴片统一表现，这里关闭可同时消除闪烁并省下一整个阴影渲染阶段。
      */}
      <instancedMesh
        ref={wallsRef}
        args={[wallGeo, wallMat, data.pitched.length + data.flat.length]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={pitchedRef}
        args={[roofGeo, roofMat, data.pitched.length]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={flatRef}
        args={[slabGeo, slabMat, data.flat.length]}
        frustumCulled={false}
      />
    </group>
  );
}
