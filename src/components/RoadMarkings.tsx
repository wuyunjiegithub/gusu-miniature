import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useRoads } from '../hooks/useRoads';
import { useSandTable } from '../store/useSandTable';
import { buildCrosswalkGeometry, findJunctions, type Junction } from '../utils/junctions';

/** 主干道路面高度（与 Roads 的 MAJOR_ROAD_Y 一致） */
const ROAD_Y = 1.3;
/** 标线贴片离路面的微小抬升，避免与路面共面闪烁 */
const DECAL_Y = ROAD_Y + 0.06;
/** 斑马线距路口中心的距离 */
const CROSSWALK_SETBACK = 15;
/** 主干道宽度（与 Roads 的 MAJOR_WIDTH 一致） */
const MAJOR_WIDTH = 26;

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

  const junctions = useMemo<Junction[]>(
    () => (roads ? findJunctions(roads.major, { maxRadius: 2700, limit: 220 }) : []),
    [roads],
  );

  const crosswalkGeo = useMemo(() => {
    if (junctions.length === 0) return null;
    const positions = buildCrosswalkGeometry(junctions, DECAL_Y, {
      roadWidth: MAJOR_WIDTH - 4,
      setback: CROSSWALK_SETBACK,
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    return geo;
  }, [junctions]);

  /** 每个进口道一组信号灯：位置 + 朝向 + 相位（红/绿） */
  const signals = useMemo(() => {
    const items: { x: number; z: number; rot: number; green: boolean }[] = [];
    junctions.forEach((junction, i) => {
      junction.dirs.forEach(([dx, dz], k) => {
        if (items.length >= 760) return;
        // 右行：灯杆立在进口道右侧路缘
        const nx = -dz;
        const nz = dx;
        const x = junction.x + dx * CROSSWALK_SETBACK + nx * (MAJOR_WIDTH / 2 - 2.5);
        const z = junction.z + dz * CROSSWALK_SETBACK + nz * (MAJOR_WIDTH / 2 - 2.5);
        items.push({
          x,
          z,
          rot: Math.atan2(-dz, dx),
          green: hash(i * 7.7 + k * 3.1) > 0.5,
        });
      });
    });
    return items;
  }, [junctions]);

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
      {crosswalkGeo && (
        <mesh geometry={crosswalkGeo} renderOrder={1}>
          <meshStandardMaterial
            color="#e6e1d2"
            roughness={0.9}
            polygonOffset
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
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
  );
}
