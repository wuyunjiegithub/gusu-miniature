import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useTransit } from '../hooks/useTransit';
import { buildRibbons } from '../utils/ribbon';
import { roadSurfaceY } from '../data/outerCity';
import { clipLinesToRadius } from '../utils/clip';
import { WORLD_LIMIT } from '../constants/geo';
import { sceneGeometry } from '../data/sceneGeometry';
import { pointInRing } from '../utils/geo';
import { inWater as inWaterField } from '../utils/waterField';
import type { LocalPoint2 } from '../types';

/** 轨道线离地高度：略高于地面与道路，沙盘里一眼可辨 */
const LINE_Y = 2.1;
/** 线宽收窄成"线位示意"，太宽会被误读成一条路面 */
const LINE_WIDTH = 5;
const STATION_R = 5;

/* ---------------- 水面避让 ----------------
 * 地铁在河里是隧道，但沙盘上把彩色带子画在水面上就成了"路修到水里"。
 * 这里把线位在水面处剪断：过河段不画，两岸各自收头。
 * 景点精细模型自身的河道/水面不在 sceneGeometry.waterways 里，
 * 线位压到模型上也一样难看，直接把景点轮廓一并当作"不画"的区域。
 */
const landmarkRings: LocalPoint2[][] = Object.values(sceneGeometry.landmarks)
  .map((item) => item.outline as LocalPoint2[] | undefined)
  .filter((ring): ring is LocalPoint2[] => Boolean(ring && ring.length > 2));

const inWater = (x: number, z: number): boolean => {
  if (inWaterField(x, z)) return true;
  return landmarkRings.some((ring) => pointInRing(ring, x, z));
};

/** 折线按水面切段，只保留陆上部分 */
function clipToLand(line: LocalPoint2[]): LocalPoint2[][] {
  const pieces: LocalPoint2[][] = [];
  let current: LocalPoint2[] = [];
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(len / 8));
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      const x = a[0] + (b[0] - a[0]) * t;
      const z = a[1] + (b[1] - a[1]) * t;
      if (inWater(x, z)) {
        if (current.length > 1) pieces.push(current);
        current = [];
      } else {
        const last = current[current.length - 1];
        if (!last || Math.hypot(last[0] - x, last[1] - z) > 0.5) current.push([x, z]);
      }
    }
  }
  const tail = line[line.length - 1];
  if (!inWater(tail[0], tail[1])) current.push(tail);
  if (current.length > 1) pieces.push(current);
  return pieces;
}


/**
 * 轨道交通（苏州地铁 1–5 号线等）：OSM route=subway 关系的真实走向，
 * 按线路官方色画成带状线，站点用白色小圆柱表示。
 * 沙盘尺度下不做高架结构，只表达线位与换乘节点。
 */
export function Transit() {
  const data = useTransit();
  const stationRef = useRef<THREE.InstancedMesh>(null);

  const lines = useMemo(
    () =>
      (data?.lines ?? []).map((line) => ({
        color: line.color,
        geometry: buildRibbons(
          clipLinesToRadius(line.segments, WORLD_LIMIT).flatMap(clipToLand),
          LINE_WIDTH,
          (x, z) => roadSurfaceY(x, z, LINE_Y),
        ),
      })),
    [data],
  );

  const stations = data?.stations ?? [];

  const stationGeometry = useMemo(
    () => new THREE.CylinderGeometry(STATION_R, STATION_R, 2.4, 12),
    [],
  );
  const stationMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#f4f1e8', roughness: 0.7 }),
    [],
  );

  useLayoutEffect(() => {
    const mesh = stationRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    stations.forEach((station, i) => {
      dummy.position.set(station.x, roadSurfaceY(station.x, station.z, LINE_Y) + 1.2, station.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [stations]);

  if (!data) return null;

  return (
    <group>
      {lines.map((line, i) => (
        <mesh key={`${line.color}-${i}`} geometry={line.geometry} frustumCulled={false}>
          <meshStandardMaterial
            color={line.color}
            emissive={line.color}
            emissiveIntensity={0.12}
            roughness={0.6}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-3}
            polygonOffsetUnits={-3}
          />
        </mesh>
      ))}
      <instancedMesh
        ref={stationRef}
        args={[stationGeometry, stationMaterial, Math.max(1, stations.length)]}
        count={stations.length}
        frustumCulled={false}
      />
    </group>
  );
}
