import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useBuildings } from '../hooks/useBuildings';
import { useSandTable } from '../store/useSandTable';
import {
  CLASSIC_ROOF_COLORS,
  CLASSIC_WALL_COLORS,
  MODERN_ROOF_COLORS,
  MODERN_WALL_COLORS,
} from '../constants/palette';
import { createPitchedRoofGeometry } from '../utils/roof';
import { createFacadeMaterial } from '../materials/facade';

const hash = (i: number): number => {
  const v = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};

/** 城外白模落地高度（与外围陆地齐平） */
const OUTER_BASE_Y = -2;

/**
 * 屋瓦细节着色器：沿屋脊方向按 0.38m 间距绘制瓦垄线，远处自动淡出。
 * 与墙体一样是纯着色器实现，不增加几何量。
 */
const ROOF_VERTEX_PARS = /* glsl */ `
varying vec3 vRoofLocal;
varying vec3 vRoofNormal;
varying vec3 vRoofScale;
varying float vRoofSeed;
`;

const ROOF_VERTEX_BODY = /* glsl */ `
  vRoofScale = vec3(
    length(instanceMatrix[0].xyz),
    length(instanceMatrix[1].xyz),
    length(instanceMatrix[2].xyz)
  );
  vRoofLocal = position;
  vRoofNormal = normal;
  vec3 roofInstancePos = instanceMatrix[3].xyz;
  vRoofSeed = fract(sin(dot(roofInstancePos.xz, vec2(12.9898, 78.233))) * 43758.5453);
`;

const ROOF_FRAGMENT_PARS = /* glsl */ `
varying vec3 vRoofLocal;
varying vec3 vRoofNormal;
varying vec3 vRoofScale;
varying float vRoofSeed;
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

  // 山墙头：坡顶两端的三角面是粉墙，不是瓦面。
  // 沿坡边压一道深色博风板、檐口再压一道，露出的白墙就是江南民居的山墙。
  if (abs(vRoofNormal.x) > 0.6) {
    float yw = clamp(vRoofLocal.y, 0.0, 1.0) * vRoofScale.y;
    float edgeD = abs(
      abs(vRoofLocal.z) * vRoofScale.z
      - 0.5 * (1.0 - clamp(vRoofLocal.y, 0.0, 1.0)) * vRoofScale.z
    );
    float verge = (1.0 - smoothstep(0.1, 0.26, edgeD)) * tileFade;
    float eaveDark = (1.0 - smoothstep(0.06, 0.22, yw)) * tileFade;
    vec3 gableWall = mix(vec3(0.9, 0.87, 0.8), vec3(0.15, 0.17, 0.19), clamp(verge + eaveDark, 0.0, 1.0));
    diffuseColor.rgb = mix(diffuseColor.rgb, gableWall, 0.95);
    // 山墙也是粉墙，雪后与立面墙体同步压暗，避免和屋面积雪糊成一片
    if (uFrost > 0.5) diffuseColor.rgb *= vec3(0.38, 0.39, 0.42);
  }
  // 坡顶几何是双面渲染的，法线朝下的一侧靠 gl_FrontFacing 翻面参与光照，
  // 这里判"是否朝上的瓦面"必须取绝对值，否则两个坡面永远命中不了
  else if (tileMask > 0.001 && abs(vRoofNormal.y) > 0.2) {
    // 正脊：沿屋脊压一条深色脊瓦
    float zw = vRoofLocal.z * vRoofScale.z;
    float ridge = 1.0 - smoothstep(0.1, 0.3, abs(zw));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1, 0.12, 0.14), ridge * 0.5 * tileFade);
    // 檐口滴水：贴近檐口的一圈颜色更沉
    float eaveLine = 1.0 - smoothstep(0.12, 0.42, clamp(vRoofLocal.y, 0.0, 1.0) * vRoofScale.y);
    diffuseColor.rgb *= 1.0 - eaveLine * 0.16 * tileFade;
    diffuseColor.rgb *= 1.0 - smoothstep(0.55, 1.0, stripe) * 0.16 * tileMask;
    // 旧瓦色差：个别瓦垄整列偏深，像经年的青瓦
    float tileId = floor(stripeCoord);
    float tileVar = fract(sin(tileId * 12.9898 + vRoofSeed * 78.233) * 43758.5453);
    diffuseColor.rgb *= 1.0 - step(0.78, tileVar) * 0.06 * tileMask;
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

  /** 冬霜开关（墙体/屋顶/平顶/城外白模着色器 uniform） */
  const winter = useSandTable((state) => state.season === 'winter');
  const winterRef = useRef(winter);
  winterRef.current = winter;
  const frostUniformsRef = useRef<Array<{ value: number }>>([]);
  /** 城内 / 城外两套立面材质各自的夜景 uniform */
  const facadeUniformsRef = useRef<Array<{ night: { value: number }; frost: { value: number } }>>([]);

  useEffect(() => {
    for (const uniforms of facadeUniformsRef.current) uniforms.night.value = night ? 1 : 0;
  }, [night]);

  useEffect(() => {
    for (const uniforms of facadeUniformsRef.current) uniforms.frost.value = winter ? 1 : 0;
    for (const uniform of frostUniformsRef.current) uniform.value = winter ? 1 : 0;
  }, [winter]);

  /**
   * 给自定义材质注入冬霜。
   * 只让"朝上的面"挂霜：女儿墙的竖直侧板属于墙体，跟着变白一样会和雪糊成一片。
   */
  const injectFrost = (mat: THREE.MeshStandardMaterial, strength: number) => {
    mat.onBeforeCompile = (shader) => {
      const uniform = { value: winterRef.current ? 1 : 0 };
      frostUniformsRef.current.push(uniform);
      shader.uniforms.uFrost = uniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vFrostUp;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vFrostUp = objectNormal.y;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uFrost;\nvarying float vFrostUp;',
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  if (uFrost > 0.5) {
    // 立面压暗成冷灰（与墙面同一口径），只有朝上的面挂雪，避免整体变白
    vec3 frostSide = diffuseColor.rgb * vec3(0.35, 0.36, 0.39);
    float frostUp = smoothstep(0.3, 0.85, vFrostUp);
    diffuseColor.rgb = mix(frostSide, vec3(0.88, 0.90, 0.93), frostUp * ${strength.toFixed(2)});
  }`,
        );
    };
  };

  /** 城内：古城粉墙木窗 */
  const wallMat = useMemo(() => {
    const facade = createFacadeMaterial(false, nightRef.current, winterRef.current);
    facadeUniformsRef.current.push(facade.uniforms);
    return facade.material;
  }, []);
  /** 城外：现代玻璃带立面 */
  const modernWallMat = useMemo(() => {
    const facade = createFacadeMaterial(true, nightRef.current, winterRef.current);
    facadeUniformsRef.current.push(facade.uniforms);
    return facade.material;
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
    // 0.8 会让平顶建筑的上半截整片发白（远处不衰减，最刺眼）；0.5 只够在顶面留一层薄雪
    injectFrost(slab, 0.5);
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
        color.set(CLASSIC_WALL_COLORS[Math.floor(hash(i) * CLASSIC_WALL_COLORS.length)]);
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
        color.set(CLASSIC_ROOF_COLORS[Math.floor(hash(i + 97) * CLASSIC_ROOF_COLORS.length)]);
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

    // 城外真实建筑：现代立面（通长玻璃带、浅灰混凝土墙）
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
        color.set(MODERN_WALL_COLORS[Math.floor(hash(i + 53) * MODERN_WALL_COLORS.length)]);
        outerMesh.setColorAt(i, color);
      });
      outerMesh.instanceMatrix.needsUpdate = true;
      if (outerMesh.instanceColor) outerMesh.instanceColor.needsUpdate = true;
    }

    // 城外真实建筑的平屋面：薄女儿墙压顶，与城内坡瓦顶形成风格分界
    const outerRoof = outerRoofRef.current;
    if (outerRoof) {
      data.outer.forEach((rec, i) => {
        const [x, z, w, d, rot, h] = rec;
        const jitter = 0.995 + hash(i * 6.17 + 8.3) * 0.01;
        dummy.position.set(x, OUTER_BASE_Y + h, z);
        dummy.rotation.set(0, rot, 0);
        dummy.scale.set(w * 1.02 * jitter, 0.8, d * 1.02 * jitter);
        dummy.updateMatrix();
        outerRoof.setMatrixAt(i, dummy.matrix);
        color.set(MODERN_ROOF_COLORS[Math.floor(hash(i + 191) * MODERN_ROOF_COLORS.length)]);
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
  }, [data]);

  if (!data) return null;

  return (
    <group>
      <instancedMesh
        ref={shadowRef}
        args={[shadowGeo, shadowMat, data.pitched.length + data.flat.length + data.outer.length]}
        frustumCulled={false}
      />
      {/* 城外背景建筑：现代立面，渲染顺序早于城内建筑，视觉上退后 */}
      <instancedMesh
        ref={outerRef}
        args={[wallGeo, modernWallMat, Math.max(1, data.outer.length)]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={outerRoofRef}
        args={[slabGeo, slabMat, Math.max(1, data.outer.length)]}
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
