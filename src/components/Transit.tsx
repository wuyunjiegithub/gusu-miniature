import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useTransit } from '../hooks/useTransit';
import { buildRibbons } from '../utils/ribbon';
import { roadSurfaceY } from '../data/outerCity';
import { clipLinesToRadius } from '../utils/clip';
import { WORLD_LIMIT } from '../constants/geo';

/** 轨道线离地高度：略高于地面与道路，沙盘里一眼可辨 */
const LINE_Y = 2.1;
const LINE_WIDTH = 9;
const STATION_R = 5;

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
          clipLinesToRadius(line.segments, WORLD_LIMIT),
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
