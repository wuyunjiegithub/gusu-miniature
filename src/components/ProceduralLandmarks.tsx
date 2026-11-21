import { useMemo } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EXTRA_LANDMARKS, type ExtraLandmark } from '../data/extraLandmarks';
import { sceneGeometry } from '../data/sceneGeometry';
import { useSandTable } from '../store/useSandTable';
import { SEASON_LOOKS } from '../constants/seasons';

/**
 * 城外补建地标（程序化，不依赖 Blender 资产）。
 *
 * 两套生成器：
 * - 石拱桥：平面轮廓 + 拱券开洞 → ExtrudeGeometry，拱洞是真的洞，不是贴图；
 * - 楼阁式塔：八角棱柱逐层收分 + 出檐，整体带倾角。
 *
 * 都按"米"建模，直接落在 sceneGeometry 注入的质心上。
 */

const STONE = '#a39b8e';
const STONE_DARK = '#8d8679';
const TILE = '#5a6068';

type Spec = Record<string, number>;

/* ---------------- 石拱桥 ---------------- */

/** 桥面纵断面：跨中最高、两端落到 edgeY（二次抛物线） */
const makeDeckProfile = (half: number, deckY: number, edgeY: number) => (u: number): number => {
  const t = Math.min(1, Math.abs(u) / half);
  return edgeY + (deckY - edgeY) * (1 - t * t);
};

function archBridgeGeometry(spec: Spec): THREE.BufferGeometry[] {
  const L = spec.length ?? 120;
  const W = spec.width ?? 11;
  const deckY = spec.deckY ?? 9;
  const edgeY = spec.edgeY ?? 2.6;
  const baseY = spec.baseY ?? -1.4;
  const spanCount = Math.max(1, Math.round(spec.spanCount ?? 3));
  const rise = spec.rise ?? 5;
  const railH = spec.railH ?? 1;

  const half = L / 2;
  const deckAt = makeDeckProfile(half, deckY, edgeY);

  // ---- 主轮廓：底部到桥面，沿桥面弧线回来
  // 顶边必须和 deckAt 用同一条线，否则拱洞顶点会穿出轮廓、earcut 直接丢掉这个洞
  const shape = new THREE.Shape();
  shape.moveTo(-half, baseY);
  shape.lineTo(half, baseY);
  const deckSteps = 32;
  for (let i = 0; i <= deckSteps; i += 1) {
    const u = half - (2 * half * i) / deckSteps;
    shape.lineTo(u, deckAt(u));
  }
  shape.lineTo(-half, baseY);

  // ---- 拱券开洞：两端各留一段桥台，拱间留桥墩
  const abut = L * 0.07;
  const pierW = Math.max(3.5, L * 0.035);
  const usable = L - abut * 2 - pierW * (spanCount - 1);
  // 中间主拱最大，两侧依次收小
  const weights =
    spanCount === 1
      ? [1]
      : spanCount === 2
        ? [0.44, 0.56]
        : spanCount === 3
          ? [0.23, 0.54, 0.23]
          : Array.from({ length: spanCount }, (_, i) => {
              const d = Math.abs(i - (spanCount - 1) / 2) / ((spanCount - 1) / 2 + 1e-6);
              return 1 - 0.42 * d;
            });
  const weightSum = weights.reduce((a, b) => a + b, 0);

  let cursor = -half + abut;
  for (let i = 0; i < spanCount; i += 1) {
    const spanW = (usable * weights[i]) / weightSum;
    const u0 = cursor;
    const u1 = cursor + spanW;
    const uc = (u0 + u1) / 2;
    // 拱顶离桥面留 1.3m 厚的拱圈
    const apex = Math.max(deckAt(uc) - 1.3, baseY + 1.2);
    const spring = Math.max(baseY + 0.25, apex - rise);

    const hole = new THREE.Path();
    hole.moveTo(u0, baseY + 0.02);
    hole.lineTo(u0, spring);
    hole.quadraticCurveTo(uc, spring + (apex - spring) * 2, u1, spring);
    hole.lineTo(u1, baseY + 0.02);
    hole.lineTo(u0, baseY + 0.02);
    shape.holes.push(hole);

    cursor = u1 + (i < spanCount - 1 ? pierW : 0);
  }

  const body = new THREE.ExtrudeGeometry(shape, {
    depth: W,
    bevelEnabled: false,
    curveSegments: 14,
    steps: 1,
  });
  body.translate(0, 0, -W / 2);

  // ---- 两侧石栏板：沿桥面弧线拉出矮墙
  const positions: number[] = [];
  const quad = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
  ) => {
    positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  };
  const inset = W / 2 - 0.42;
  const steps = 48;
  for (let s = 0; s < steps; s += 1) {
    const u0 = -half + (2 * half * s) / steps;
    const u1 = -half + (2 * half * (s + 1)) / steps;
    const y0 = deckAt(u0);
    const y1 = deckAt(u1);
    for (const sign of [-1, 1] as const) {
      const v = sign * inset;
      const vOut = sign * (W / 2);
      // 顶面
      quad([u0, y0 + railH, v], [u0, y0 + railH, vOut], [u1, y1 + railH, vOut], [u1, y1 + railH, v]);
      // 内立面
      quad([u0, y0, v], [u1, y1, v], [u1, y1 + railH, v], [u0, y0 + railH, v]);
    }
  }
  const rail = new THREE.BufferGeometry();
  rail.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  rail.computeVertexNormals();

  // 统一到世界坐标：先绕 Y 转到桥轴方向
  const angle = spec.angle ?? 0;
  const m = new THREE.Matrix4().makeRotationY(-angle);
  body.applyMatrix4(m);
  rail.applyMatrix4(m);

  return [body, rail];
}

/* ---------------- 楼阁式塔 ---------------- */

function pagodaGeometry(spec: Spec): THREE.BufferGeometry[] {
  const tiers = Math.max(3, Math.round(spec.tiers ?? 7));
  const baseRadius = spec.baseRadius ?? 7;
  const taper = spec.taper ?? 0.9;
  const tierHeight = spec.tierHeight ?? 4.5;
  const overhang = spec.eaveOverhang ?? 1.5;
  const lean = spec.lean ?? 0;

  const bodyGeos: THREE.BufferGeometry[] = [];
  const roofGeos: THREE.BufferGeometry[] = [];

  // 须弥座
  const podium = new THREE.CylinderGeometry(baseRadius * 1.35, baseRadius * 1.5, 2.4, 8, 1, false);
  podium.translate(0, 1.2, 0);
  bodyGeos.push(podium);

  let y = 2.4;
  for (let i = 0; i < tiers; i += 1) {
    const r = baseRadius * Math.pow(taper, i);
    const h = tierHeight * (1 - i * 0.045);

    // 塔身
    const wall = new THREE.CylinderGeometry(r * 0.96, r, h, 8, 1, false);
    wall.translate(0, y + h / 2, 0);
    bodyGeos.push(wall);

    // 出檐（薄八角盘，外沿翻起）
    const eave = new THREE.CylinderGeometry(r + overhang, r + overhang * 0.35, 0.85, 8, 1, false);
    eave.translate(0, y + h + 0.42, 0);
    roofGeos.push(eave);

    // 檐上平座
    const belt = new THREE.CylinderGeometry(r * 0.9, r + overhang * 0.5, 0.5, 8, 1, false);
    belt.translate(0, y + h + 1.05, 0);
    bodyGeos.push(belt);

    y += h + 1.25;
  }

  // 塔刹
  const topR = baseRadius * Math.pow(taper, tiers - 1) * 0.92;
  const spire = new THREE.CylinderGeometry(0.5, topR * 0.55, 5.5, 8, 1, false);
  spire.translate(0, y + 2.75, 0);
  roofGeos.push(spire);
  const ball = new THREE.SphereGeometry(1.05, 10, 8);
  ball.translate(0, y + 5.9, 0);
  roofGeos.push(ball);

  const apply = (list: THREE.BufferGeometry[]) => {
    const merged = mergeGeometries(list, false);
    list.forEach((g) => g.dispose());
    if (!merged) return null;
    if (lean !== 0) merged.applyMatrix4(new THREE.Matrix4().makeRotationZ(lean));
    merged.computeVertexNormals();
    return merged;
  };

  const body = apply(bodyGeos);
  const roof = apply(roofGeos);
  return [body, roof].filter((g): g is THREE.BufferGeometry => Boolean(g));
}

/* ---------------- 渲染 ---------------- */

function landmarkGeometries(item: ExtraLandmark): THREE.BufferGeometry[] {
  return item.kind === 'arch-bridge' ? archBridgeGeometry(item.spec) : pagodaGeometry(item.spec);
}

/**
 * 城外补建地标：几何在模块内一次生成，材质按季节换色。
 * 石作和瓦面分两个 mesh，共 4 个 draw call。
 */
export function ProceduralLandmarks() {
  const season = useSandTable((state) => state.season);
  const look = SEASON_LOOKS[season];

  const items = useMemo(
    () =>
      EXTRA_LANDMARKS.map((item) => {
        const centroid = sceneGeometry.landmarks[item.id]?.centroid ?? { x: 0, z: 0 };
        const baseY = item.kind === 'pagoda' ? (item.spec.baseY ?? 0) : 0;
        return {
          id: item.id,
          kind: item.kind,
          position: [centroid.x, baseY, centroid.z] as [number, number, number],
          geometries: landmarkGeometries(item),
        };
      }),
    [],
  );

  return (
    <group>
      {items.map((item) => (
        <group key={item.id} position={item.position}>
          {item.geometries.map((geometry, index) => (
            <mesh
              key={index}
              geometry={geometry}
              castShadow={false}
              receiveShadow={item.kind === 'arch-bridge'}
            >
              {index === 0 ? (
                <meshStandardMaterial
                  color={season === 'winter' ? '#b9b6ad' : STONE}
                  roughness={0.94}
                  flatShading
                />
              ) : (
                <meshStandardMaterial
                  color={
                    // 桥栏板是石作，塔顶是瓦作，按 kind 区分
                    item.kind === 'arch-bridge'
                      ? season === 'winter'
                        ? '#b9b6ad'
                        : STONE_DARK
                      : season === 'winter'
                        ? look.hillHigh
                        : TILE
                  }
                  roughness={0.9}
                  flatShading
                />
              )}
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}
