import { useMemo } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Html } from '@react-three/drei';
import { CITY_GATES, type CityGate } from '../data/cityGates';
import { createHipRoofGeometry } from '../utils/roof';
import { useSandTable } from '../store/useSandTable';

/** 与 CityWall 对齐：墙基 -1.5、墙高 9（墙顶 7.5） */
const GATE_BASE_Y = -1.5;
const BASE_H = 14.5; // 城台从 -1.5 到 13

/** 城门楼材质取色（冬季覆薄霜整体转冷） */
function palette(winter: boolean) {
  return {
    stone: winter ? '#eef2f5' : '#9c9282',
    wood: winter ? '#8e5f52' : '#7a3a2c',
    plaster: winter ? '#f7f9fa' : '#ece4d4',
    roof: winter ? '#eef2f6' : '#4a525a',
  };
}

/** 合并同材质构件，压低 draw call */
function gateGeometries() {
  const stone: THREE.BufferGeometry[] = [];
  const wood: THREE.BufferGeometry[] = [];
  const plaster: THREE.BufferGeometry[] = [];
  const roof: THREE.BufferGeometry[] = [];

  const box = (
    w: number, h: number, d: number, x: number, y: number, z: number,
  ): THREE.BufferGeometry => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

  // 城台：两侧墩台 + 门楣，中间留 10m 宽门洞
  stone.push(
    box(18, BASE_H, 22, -14, BASE_H / 2, 0),
    box(18, BASE_H, 22, 14, BASE_H / 2, 0),
    box(10, 5, 22, 0, BASE_H - 2.5, 0),
  );
  // 券脸（前后各一道半圆石券）
  stone.push(new THREE.RingGeometry(5, 6, 24, 1, 0, Math.PI).translate(0, 4.5, 11.08));
  stone.push(
    new THREE.RingGeometry(5, 6, 24, 1, 0, Math.PI).rotateY(Math.PI).translate(0, 4.5, -11.08),
  );

  // 城台顶平台 + 女墙
  stone.push(box(46, 0.7, 22, 0, BASE_H + 0.35, 0));
  stone.push(
    box(46, 1.0, 0.9, 0, BASE_H + 1.2, 10.55),
    box(46, 1.0, 0.9, 0, BASE_H + 1.2, -10.55),
    box(0.9, 1.0, 22, 22.55, BASE_H + 1.2, 0),
    box(0.9, 1.0, 22, -22.55, BASE_H + 1.2, 0),
  );

  // 城楼：下层檐柱 + 墙身
  const towerY = BASE_H + 0.7;
  for (const x of [-10.5, -3.5, 3.5, 10.5]) {
    for (const z of [-4.2, 4.2]) {
      wood.push(
        new THREE.CylinderGeometry(0.32, 0.32, 4.4, 8).translate(x, towerY + 2.2, z),
      );
    }
  }
  wood.push(box(24.2, 0.5, 9.4, 0, towerY + 4.35, 0));
  plaster.push(box(21.5, 4.0, 7.6, 0, towerY + 2.1, 0));

  // 两层庑殿顶
  const lower = createHipRoofGeometry(31, 14, 2.7).translate(0, towerY + 4.5, 0);
  const upperBodyY = towerY + 5.8;
  plaster.push(box(16, 2.4, 6, 0, upperBodyY + 1.2, 0));
  const upper = createHipRoofGeometry(22, 10.5, 3.3).translate(0, upperBodyY + 2.4, 0);
  roof.push(lower, upper);

  const merge = (list: THREE.BufferGeometry[]): THREE.BufferGeometry =>
    mergeGeometries(list, false) ?? list[0];
  return {
    stone: merge(stone),
    wood: merge(wood),
    plaster: merge(plaster),
    roof: merge(roof),
  };
}

function Gate({ gate, winter }: { gate: CityGate; winter: boolean }) {
  const geo = useMemo(gateGeometries, []);
  const colors = palette(winter);
  const rotation = Math.atan2(-gate.tangent[1], gate.tangent[0]);

  return (
    <group position={[gate.x, GATE_BASE_Y, gate.z]} rotation={[0, rotation, 0]}>
      <mesh geometry={geo.stone} castShadow receiveShadow>
        <meshStandardMaterial color={colors.stone} roughness={0.95} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={geo.plaster} castShadow receiveShadow>
        <meshStandardMaterial color={colors.plaster} roughness={0.9} />
      </mesh>
      <mesh geometry={geo.wood} castShadow>
        <meshStandardMaterial color={colors.wood} roughness={0.85} />
      </mesh>
      <mesh geometry={geo.roof} castShadow>
        <meshStandardMaterial color={colors.roof} roughness={0.88} side={THREE.DoubleSide} />
      </mesh>
      {/* 城门标注：遗存为金色方点，复建为石青色方点 */}
      <Html position={[0, 44, 0]} center zIndexRange={[9, 0]}>
        <span className={`gate-label${gate.kind === 'relic' ? ' is-relic' : ''}`}>
          {gate.name}
        </span>
      </Html>
    </group>
  );
}

/** 苏州古城九门：城墙上的城台与重檐城楼，并带名称标注 */
export function CityGates() {
  const winter = useSandTable((state) => state.season === 'winter');
  return (
    <group>
      {CITY_GATES.map((gate) => (
        <Gate key={gate.name} gate={gate} winter={winter} />
      ))}
    </group>
  );
}
