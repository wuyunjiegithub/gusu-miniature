import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useRoads } from '../hooks/useRoads';
import { useSandTable } from '../store/useSandTable';
import { buildCrosswalkGeometry, findJunctions, type Junction } from '../utils/junctions';

/** 主干道路面高度（与 Roads 的 MAJOR_ROAD_Y 保持一致：1.38） */
const ROAD_Y = 1.38;
/**
 * 标线贴片离路面的微小抬升，避免与路面共面闪烁。
 * 必须严格高于主干道路面（含重叠分层的最高层 1.38+0.03），
 * 否则斑马线会被路面深度挡住——以前这里是 1.36 < 1.38，斑马线一直埋在路面下。
 */
const DECAL_Y = ROAD_Y + 0.1;
/** 斑马线距路口中心的距离 */
const CROSSWALK_SETBACK = 15;
/** 主干道宽度（与 Roads 的 MAJOR_WIDTH 一致） */
const MAJOR_WIDTH = 26;

/**
 * 斑马线可铺宽度探针：
 *   1) 先确认这里确实有一条与"进口道方向"同向的主路——路口节点会把相交的
 *      每条路走向都收进来，照支路走向铺条纹会整条斜插到路外；
 *   2) 再沿过街方向逐点量路面，碰到路缘就停。
 * 两步都通过才返回可铺半宽，0 表示这里不铺。
 */
function makeWidthProbe(lines: [number, number][][], half: number) {
  const CELL = 40;
  const key = (ix: number, iz: number) => ix * 100000 + iz;
  const grid = new Map<number, number[]>();
  const segs: Array<[number, number, number, number]> = [];
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i += 1) {
      const [ax, az] = line[i];
      const [bx, bz] = line[i + 1];
      if (Math.hypot(bx - ax, bz - az) < 0.4) continue;
      const id = segs.push([ax, az, bx, bz]) - 1;
      for (let ix = Math.floor(Math.min(ax, bx) / CELL); ix <= Math.floor(Math.max(ax, bx) / CELL); ix += 1)
        for (let iz = Math.floor(Math.min(az, bz) / CELL); iz <= Math.floor(Math.max(az, bz) / CELL); iz += 1) {
          const k = key(ix, iz);
          let bucket = grid.get(k);
          if (!bucket) grid.set(k, (bucket = []));
          bucket.push(id);
        }
    }
  }
  const limit = half - 0.6;
  /** 最近路段的下标与距离，dist > limit 视为不在路面上 */
  const nearest = (x: number, z: number) => {
    let bestD = Infinity;
    let bestId = -1;
    for (let ix = Math.floor((x - limit) / CELL); ix <= Math.floor((x + limit) / CELL); ix += 1) {
      for (let iz = Math.floor((z - limit) / CELL); iz <= Math.floor((z + limit) / CELL); iz += 1) {
        const bucket = grid.get(key(ix, iz));
        if (!bucket) continue;
        for (const id of bucket) {
          const [ax, az, bx, bz] = segs[id];
          const dx = bx - ax;
          const dz = bz - az;
          const l2 = dx * dx + dz * dz;
          let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(x - ax - t * dx, z - az - t * dz);
          if (d < bestD) {
            bestD = d;
            bestId = id;
          }
        }
      }
    }
    return bestId < 0 || bestD > limit ? null : segs[bestId];
  };

  return (x: number, z: number, nx: number, nz: number, dx: number, dz: number) => {
    const seg = nearest(x, z);
    if (!seg) return 0;
    const len = Math.hypot(seg[2] - seg[0], seg[3] - seg[1]) || 1;
    const ux = (seg[2] - seg[0]) / len;
    const uz = (seg[3] - seg[1]) / len;
    // 方向差超过约 35° 说明这条"进口道"在这里其实不存在
    if (Math.abs(ux * dx + uz * dz) < 0.82) return 0;
    let reach = 0;
    for (let s = 0.5; s <= half; s += 0.5) {
      if (!nearest(x + nx * s, z + nz * s) || !nearest(x - nx * s, z - nz * s)) break;
      reach = s;
    }
    return reach;
  };
}

/** 红绿灯杆高与信号灯头尺寸 */
const POLE_HEIGHT = 6.4;
const HEAD_SIZE: [number, number, number] = [1.15, 0.42, 0.34];

const hash = (v: number): number => {
  const t = Math.sin(v * 45.13 + 9.7) * 43758.5453;
  return t - Math.floor(t);
};

/**
 * 路口设施（本次新增）：
 * - 斑马线：按主干道交叉口自动铺设，六个白条横跨路面
 * - 红绿灯：每个进口道一根灯杆 + 一组红/绿信号灯头
 * 全部走 InstancedMesh / 合并几何，几十上百个路口只增加个位数 draw call。
 */
export function RoadMarkings() {
  const roads = useRoads();
  const night = useSandTable((state) => state.time === 'night');
  // LOD：斑马线与红绿灯是近景才可辨的精细路面细节，只在 L2 显示（FR-11）
  const lod = useSandTable((state) => state.lod);

  const junctions = useMemo<Junction[]>(() => {
    if (!roads) return [];
    // 老城路口很密：直接逐个铺斑马线会叠成一片白色格纹，
    // 先按 55m 间距稀疏化，只保留真正像"路口"的位置。
    const kept: Junction[] = [];
    for (const junction of findJunctions(roads.major, { maxRadius: 2700, limit: 260 })) {
      if (kept.every((k) => Math.hypot(k.x - junction.x, k.z - junction.z) > 55)) kept.push(junction);
    }
    return kept;
  }, [roads]);

  const onMajor = useMemo(
    () => (roads ? makeWidthProbe(roads.major, MAJOR_WIDTH / 2) : null),
    [roads],
  );

  const crosswalkGeo = useMemo(() => {
    if (junctions.length === 0 || !onMajor) return null;
    const positions = buildCrosswalkGeometry(junctions, DECAL_Y, {
      roadWidth: MAJOR_WIDTH - 4,
      setback: CROSSWALK_SETBACK,
      widthAt: onMajor,
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    return geo;
  }, [junctions, onMajor]);

  /** 每个进口道一组信号灯：位置 + 朝向 + 相位（红/绿） */
  const signals = useMemo(() => {
    const items: { x: number; z: number; rot: number; green: boolean }[] = [];
    if (!onMajor) return items;
    junctions.forEach((junction, i) => {
      junction.dirs.forEach(([dx, dz], k) => {
        if (items.length >= 760) return;
        // 右行：灯杆立在进口道右侧路缘
        const nx = -dz;
        const nz = dx;
        const x = junction.x + dx * CROSSWALK_SETBACK + nx * (MAJOR_WIDTH / 2 - 2.5);
        const z = junction.z + dz * CROSSWALK_SETBACK + nz * (MAJOR_WIDTH / 2 - 2.5);
        // 只在真正存在这条进口道（斑马线可铺）时才立灯，否则灯杆会飘在空地或路中间
        if (onMajor(junction.x + dx * CROSSWALK_SETBACK, junction.z + dz * CROSSWALK_SETBACK, nx, nz, dx, dz) <= 0)
          return;
        items.push({
          x,
          z,
          rot: Math.atan2(-dz, dx),
          green: hash(i * 7.7 + k * 3.1) > 0.5,
        });
      });
    });
    return items;
  }, [junctions, onMajor]);

  const poleRef = useRef<THREE.InstancedMesh>(null);
  const redRef = useRef<THREE.InstancedMesh>(null);
  const greenRef = useRef<THREE.InstancedMesh>(null);

  const poleGeo = useMemo(
    () => new THREE.CylinderGeometry(0.13, 0.16, 1, 5, 1, true).translate(0, 0.5, 0),
    [],
  );
  const headGeo = useMemo(() => new THREE.BoxGeometry(...HEAD_SIZE), []);

  const poleMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#3a3d41', roughness: 0.8 }),
    [],
  );
  const redMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#8d1f18',
        emissive: '#ff3b26',
        emissiveIntensity: night ? 3.2 : 1.4,
        roughness: 0.6,
        toneMapped: false,
      }),
    [night],
  );
  const greenMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#1d6b3f',
        emissive: '#3ce08a',
        emissiveIntensity: night ? 2.6 : 1.1,
        roughness: 0.6,
        toneMapped: false,
      }),
    [night],
  );

  const reds = useMemo(() => signals.filter((s) => !s.green), [signals]);
  const greens = useMemo(() => signals.filter((s) => s.green), [signals]);

  useLayoutEffect(() => {
    const dummy = new THREE.Object3D();
    const poles = poleRef.current;
    if (poles) {
      signals.forEach((signal, i) => {
        dummy.position.set(signal.x, ROAD_Y, signal.z);
        dummy.rotation.set(0, signal.rot, 0);
        dummy.scale.set(1, POLE_HEIGHT, 1);
        dummy.updateMatrix();
        poles.setMatrixAt(i, dummy.matrix);
      });
      poles.instanceMatrix.needsUpdate = true;
    }

    const place = (mesh: THREE.InstancedMesh | null, list: typeof signals) => {
      if (!mesh) return;
      list.forEach((signal, i) => {
        dummy.position.set(signal.x, ROAD_Y + POLE_HEIGHT - 0.2, signal.z);
        dummy.rotation.set(0, signal.rot, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    };
    place(redRef.current, reds);
    place(greenRef.current, greens);
  }, [signals, reds, greens]);

  // 信号灯材质随昼夜变化亮度
  useEffect(() => {
    redMat.needsUpdate = true;
    greenMat.needsUpdate = true;
  }, [redMat, greenMat, night]);

  return (
    <group>
      {/* 斑马线在 L1 中景也要可见：路口没有斑马线时，车道线在远处就像一条光板带；
          灯杆与灯头仍是近景细节，留在 L2（远处只有一两个像素，反而变噪点） */}
      {crosswalkGeo && (
        <mesh geometry={crosswalkGeo} renderOrder={1} visible={lod !== 'L0'}>
          <meshStandardMaterial
            color="#e6e1d2"
            roughness={0.9}
            polygonOffset
            polygonOffsetFactor={-4}
            polygonOffsetUnits={-4}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      <group visible={lod === 'L2'}>
        <instancedMesh
          ref={poleRef}
          args={[poleGeo, poleMat, Math.max(1, signals.length)]}
          count={signals.length}
          frustumCulled={false}
        />
        <instancedMesh
          ref={redRef}
          args={[headGeo, redMat, Math.max(1, reds.length)]}
          count={reds.length}
          frustumCulled={false}
        />
        <instancedMesh
          ref={greenRef}
          args={[headGeo, greenMat, Math.max(1, greens.length)]}
          count={greens.length}
          frustumCulled={false}
        />
      </group>
    </group>
  );
}
