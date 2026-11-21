import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { sceneGeometry } from '../data/sceneGeometry';
import { CITY_GATES, GATE_HALF_WIDTH, PANMEN_GATE_GAP_HALF } from '../data/cityGates';
import { useSandTable } from '../store/useSandTable';
import { buildWallGeometry, splitClosedLine } from '../utils/wall';

/** 城墙：厚 8m、高 9.7m，沿护城河轮廓内侧环绕；城门处留口 */
const WALL_THICKNESS = 8;
/** 墙基压到外围地面（-2m）以下：外侧不会露出悬空的墙脚 */
const WALL_BASE_Y = -2.2;
/** 墙高补回墙基下沉的 0.7m，墙顶仍保持 7.5m */
const WALL_HEIGHT = 9.7;
const WALL_TOP = WALL_BASE_Y + WALL_HEIGHT;
const MERLON_SPACING = 6;
const MERLON_SIZE: [number, number, number] = [2.2, 1.2, 1.0];

/**
 * 城墙（M1 补充）：由古城轮廓生成的闭合墙体，阊门/胥门/平门处断开交由城楼，
 * 墙顶按 6m 间距排布垛口（雉堞）。
 */
export function CityWall() {
  const winter = useSandTable((state) => state.season === 'winter');
  const merlonRef = useRef<THREE.InstancedMesh>(null);

  const geometries = useMemo(() => {
    const runs = splitClosedLine(
      sceneGeometry.cityOutline,
      CITY_GATES.map((g) => {
        // 盘门：GLB 自带 318m 长的城墙段（含水陆城门），落在城墙线上；
        // 程序化城墙要在盘门处留出等长的大口，由 GLB 城墙段填补，
        // 否则两段墙重叠、或者城门处出现双层墙。其余城门仍留 46m 标准口。
        const half = g.name === '盘门' ? PANMEN_GATE_GAP_HALF : GATE_HALF_WIDTH;
        return [g.sAlong - half, g.sAlong + half] as [number, number];
      }),
    );
    return runs.map((run) =>
      buildWallGeometry(run, WALL_THICKNESS, WALL_HEIGHT, WALL_BASE_Y, false),
    );
  }, []);

  const merlons = useMemo(() => {
    const line = sceneGeometry.cityOutline;
    const items: Array<{ x: number; z: number; rot: number }> = [];
    let s = 0;
    for (let i = 0; i < line.length; i += 1) {
      const a = line[i];
      const b = line[(i + 1) % line.length];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      const steps = Math.max(1, Math.round(len / MERLON_SPACING));
      const rot = Math.atan2(-dz, dx);
      for (let k = 0; k < steps; k += 1) {
        const t = k / steps;
        const along = s + len * t;
        // 城门洞口处不放垛口；盘门大口同样跳过（GLB 城墙自带垛口）
        if (
          CITY_GATES.some((g) => {
            const half = g.name === '盘门' ? PANMEN_GATE_GAP_HALF : GATE_HALF_WIDTH;
            return Math.abs(along - g.sAlong) < half + 5;
          })
        ) {
          continue;
        }
        items.push({ x: a[0] + dx * t, z: a[1] + dz * t, rot });
      }
      s += len;
    }
    return items;
  }, []);

  useLayoutEffect(() => {
    const mesh = merlonRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    merlons.forEach((m, i) => {
      dummy.position.set(m.x, WALL_TOP, m.z);
      dummy.rotation.set(0, m.rot, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [merlons]);

  const merlonGeometry = useMemo(() => {
    const geo = new THREE.BoxGeometry(...MERLON_SIZE);
    geo.translate(0, MERLON_SIZE[1] / 2, 0);
    return geo;
  }, []);
  const merlonMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }),
    [],
  );

  useLayoutEffect(() => {
    merlonMaterial.color.set(winter ? '#f0f4f7' : '#bcb2a1');
  }, [winter, merlonMaterial]);

  return (
    <group>
      {geometries.map((geometry, i) => (
        <mesh key={i} geometry={geometry} receiveShadow castShadow>
          <meshStandardMaterial color={winter ? '#e3eaf0' : '#b6ac9c'} roughness={0.95} flatShading />
        </mesh>
      ))}
      <instancedMesh
        ref={merlonRef}
        args={[merlonGeometry, merlonMaterial, Math.max(1, merlons.length)]}
      />
    </group>
  );
}
 