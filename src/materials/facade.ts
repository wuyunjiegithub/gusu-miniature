import * as THREE from 'three';

/**
 * 立面细节着色器：按每个实例的真实尺寸，在墙面上程序化绘制
 * 窗格、窗框、大门、勒脚与檐口阴影；夜间约四成窗户透出暖光。
 * 纯着色器实现，不增加任何 draw call 与顶点。
 *
 * 同一段着色器按 uModern 分成两支：
 *   0 —— 古城粉墙：窄高木窗、九宫格木棂、木门
 *   1 —— 城外现代：逐层通长玻璃带、深灰竖梃、玻璃入口
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
/** 城内外立面风格：0 古城粉墙木窗，1 现代通长玻璃带 */
uniform float uModern;
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
      float winHalfH = min(1.35, rowH * 0.34) * (0.72 + 0.28 * fract(cellSeed * 7.31));
      float winHalfW = min(0.62, colW * 0.27) * (0.62 + 0.38 * fract(cellSeed2 * 5.17));
      winHalfW = mix(winHalfW, winHalfW * 0.55, gable);
      float winMask = step(0.26, cellSeed2);
      winMask *= mix(1.0, step(0.7, cellSeed2), gable);

      // 大门：按建筑种子在四个立面中选一面，底层居中（山墙不开门）
      float faceId = abs(vFacadeNormal.x) > 0.5
        ? (vFacadeNormal.x > 0.0 ? 0.0 : 1.0)
        : (vFacadeNormal.z > 0.0 ? 2.0 : 3.0);
      float doorFace = floor(vFacadeSeed * 4.0);
      float sill = 0.0;

      if (uModern > 0.5) {
        // 现代立面：逐层通长玻璃带 + 深灰竖梃 + 混凝土楼层腰线
        float mStart = 2.0;
        float mUsable = max(h - mStart - 0.8, 1.0);
        float mRows = h < 10.0 ? 1.0 : clamp(floor(mUsable / 3.7 + 0.45), 1.0, 6.0);
        float mRowH = mUsable / mRows;
        float mRowId = clamp(floor((y - mStart) / mRowH), 0.0, mRows - 1.0);
        float mCy = mStart + (mRowId + 0.5) * mRowH;
        float bandHalf = min(mRowH * 0.32, 1.05);
        float band = facadeBand(abs(y - mCy), bandHalf, 0.06);
        // 玻璃带按 2.4m 分格，竖梃只有几厘米，远处自动淡出
        float bayLine = abs(fract(u / 2.4) - 0.5) * 2.0;
        float mullFade = 1.0 - smoothstep(0.12, 0.3, facadePx);
        float mull = smoothstep(0.84, 0.96, bayLine) * band * mullFade;
        vec3 glass = mix(vec3(0.34, 0.42, 0.48), vec3(0.14, 0.19, 0.24), smoothstep(-bandHalf, bandHalf, y - mCy));
        glass = mix(glass, vec3(0.4, 0.48, 0.53), vFacadeSeed * 0.35);
        diffuseColor.rgb = mix(diffuseColor.rgb, glass, band * 0.94 * detailFade);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.17, 0.19, 0.21), mull * 0.7 * detailFade);
        // 楼层之间的腰线
        float floorLine = facadeBand(abs(y - (mStart + mRowId * mRowH)), 0.14, 0.06);
        diffuseColor.rgb *= 1.0 - floorLine * 0.18 * detailFade;
        // 首层入口：整面深灰玻璃门
        float entrance = 0.0;
        if (abs(faceId - doorFace) < 0.5) {
          entrance = facadeBand(abs(u - faceW * 0.5), 1.7, 0.06)
            * facadeBand(abs(y - 1.3), 1.5, 0.06);
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.09, 0.13, 0.16), entrance * 0.92 * detailFade);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.58, 0.6), entrance * step(0.5, fract(u * 3.1)) * 0.2 * detailFade);
        // 现代楼里更多窗亮着，形成成片灯光
        facadeGlow = band * step(cellSeed, 0.5) * detailFade;
        sill = 0.0;
      } else {
        // 古城木作立面：青砖勒脚 + 砖套木窗 + 石库门与砖雕门罩
        float doorFaceOn = step(abs(faceId - doorFace), 0.5) * (1.0 - gable);
        float du = abs(u - faceW * 0.5);

        // 青砖勒脚：高约 0.55m，顶部收一道压顶线；粉墙上偶有雨痕
        float plinthBand = 1.0 - smoothstep(0.5, 0.58, y);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.36, 0.38, 0.37), plinthBand * 0.8 * detailFade);
        float plinthCap = facadeBand(abs(y - 0.56), 0.03, 0.04);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.26, 0.28, 0.27), plinthCap * 0.7 * detailFade);
        float streak = smoothstep(0.35, 0.95, abs(sin(u * 1.7 + vFacadeSeed * 31.0)));
        diffuseColor.rgb *= 1.0 - streak * (1.0 - smoothstep(0.4, 3.0, y)) * 0.06 * detailFade;

        // 石库门：门洞 + 门套 + 双扇木门 + 门槛石
        float doorZone = 0.0;
        if (doorFaceOn > 0.5) {
          float dv = abs(y - 1.18);
          doorZone = facadeBand(du, 0.7, 0.05) * facadeBand(dv, 1.18, 0.05);
          float doorFrame = facadeBand(du, 0.88, 0.05) * facadeBand(dv, 1.36, 0.05) * (1.0 - doorZone);
          float doorSeam = facadeBand(du, 0.02, 0.02) * doorZone;
          float threshold = facadeBand(du, 0.94, 0.05) * facadeBand(abs(y - 0.05), 0.06, 0.03);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.43, 0.41), doorFrame * 0.9 * detailFade);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.24, 0.16, 0.1), doorZone * detailFade);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.13, 0.09, 0.06), doorSeam * 0.8 * detailFade);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.5, 0.5, 0.48), threshold * 0.8 * detailFade);
          // 砖雕门罩：门上方两级挑出的青砖线脚
          float hood1 = facadeBand(du, 1.08, 0.06) * facadeBand(abs(y - 2.62), 0.1, 0.05);
          float hood2 = facadeBand(du, 0.92, 0.06) * facadeBand(abs(y - 2.84), 0.07, 0.04);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.34, 0.33), hood1 * 0.85 * detailFade);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.22, 0.21), hood2 * 0.85 * detailFade);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.6, hood1 * 0.25 * detailFade);
        }

        // 窗洞：青砖窗套 + 内层木框 + 玻璃 + 九宫格木棂 + 窗台 + 窗楣
        float winOuter = facadeBand(dx, winHalfW + 0.13, 0.04) * facadeBand(dy, winHalfH + 0.13, 0.04);
        float win = facadeBand(dx, winHalfW, 0.03) * facadeBand(dy, winHalfH, 0.03);
        float winOn = win * winMask * (1.0 - doorZone);
        float brickRing = winOuter * winMask * (1.0 - win) * (1.0 - doorZone);
        float woodRing = facadeBand(dx, winHalfW + 0.05, 0.03)
          * facadeBand(dy, winHalfH + 0.05, 0.03) * (1.0 - win) * winMask * (1.0 - doorZone);

        sill = facadeBand(dx, winHalfW + 0.16, 0.05)
          * facadeBand(abs(y - (cy - winHalfH - 0.15)), 0.06, 0.03) * winMask * (1.0 - doorZone);
        float lintel = facadeBand(dx, winHalfW + 0.18, 0.06)
          * facadeBand(abs(y - (cy + winHalfH + 0.17)), 0.07, 0.04) * winMask * (1.0 - doorZone);

        // 玻璃上沿受檐影更暗，下沿略亮；木棂两竖两横，形成九宫格
        vec3 glass = mix(vec3(0.16, 0.2, 0.25), vec3(0.05, 0.07, 0.1), smoothstep(-winHalfH, winHalfH, y - cy));
        float mulV = (1.0 - smoothstep(0.02, 0.05, abs(abs(dx) - winHalfW * 0.36))) * winOn;
        float mulV2 = (1.0 - smoothstep(0.02, 0.05, abs(abs(dx) - winHalfW * 0.7))) * winOn;
        float mulH = (1.0 - smoothstep(0.02, 0.05, abs(y - (cy + winHalfH * 0.38)))) * winOn;
        float mulH2 = (1.0 - smoothstep(0.02, 0.05, abs(y - (cy - winHalfH * 0.38)))) * winOn;
        // 窗棂仅 3cm 宽，像素覆盖超过 10cm 时淡出，避免远景木棂闪烁
        float mullion = clamp(mulV + mulV2 + mulH + mulH2, 0.0, 1.0)
          * (1.0 - smoothstep(0.10, 0.22, facadePx));

        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.46, 0.48, 0.46), brickRing * 0.85 * detailFade);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.33, 0.24, 0.16), woodRing * 0.9 * detailFade);
        diffuseColor.rgb = mix(diffuseColor.rgb, glass, winOn * detailFade);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.31, 0.2), mullion * 0.92 * detailFade);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.84, 0.82, 0.77), sill * 0.9 * detailFade);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.7, lintel * detailFade);

        // 夜间点灯：约四成窗户亮暖光
        facadeGlow = winOn * step(cellSeed, 0.55) * detailFade;
      }

      // 冬季墙面：苏州民居本来就是粉墙（#f4efe4 一档），和白屋顶并置会糊成一片雪。
      // 雪后光照整体偏亮（环境光 0.5 + 白太阳 2.75），只压一档仍然过曝发白，
      // 这里压到 0.35 左右：实测墙面落到中性灰（约 #8a8a8a），与积雪屋顶
      // （约 #f0f0f0）拉开两档明度。只做乘法、不换成固定灰，各户色差仍保留。
      if (uFrost > 0.5) {
        diffuseColor.rgb *= vec3(0.35, 0.36, 0.39);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.90, 0.93), sill * 0.5 * detailFade);
      }

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

export interface FacadeUniforms {
  night: { value: number };
  frost: { value: number };
}

export interface FacadeMaterial {
  material: THREE.MeshStandardMaterial;
  uniforms: FacadeUniforms;
}

/**
 * 创建立面材质。夜景与冬霜用普通对象持有 uniform，
 * 调用方（BuildingField / Outskirts）在 time / season 变化时改 value 即可。
 */
export function createFacadeMaterial(
  modern: boolean,
  night: boolean,
  winter: boolean,
): FacadeMaterial {
  const uniforms: FacadeUniforms = {
    night: { value: night ? 1 : 0 },
    frost: { value: winter ? 1 : 0 },
  };
  const material = new THREE.MeshStandardMaterial({ roughness: 0.92 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uModern = { value: modern ? 1 : 0 };
    shader.uniforms.uNight = uniforms.night;
    shader.uniforms.uFrost = uniforms.frost;
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
  return { material, uniforms };
}
