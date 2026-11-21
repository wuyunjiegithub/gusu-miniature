import { useMemo } from 'react';
import * as THREE from 'three';
import { useSandTable } from '../store/useSandTable';
import { SEASON_LOOKS } from '../constants/seasons';

/**
 * 虎丘剑池（补充地标细节）：
 * 虎丘山腰的长方形水池，传说是吴王阖闾的葬剑处，池水常年不涸。
 * 虎丘塔立在山顶，剑池在其北下方山腰处。
 *
 * 山体是程序化多峰山脊（Hills），这里不重建山体，只在剑池位置
 * 放一片紧贴山腰的深色水面 + 一圈石沿，远看是一口嵌在山上的泉池。
 */

/** 剑池世界位置（虎丘主峰北侧山腰）与标高 */
const POOL = {
  x: -4628,
  z: -3010,
  // 山体在该处实际高度约 66.6m（Hills 程序化生成），水面略高于山体表面
  y: 67,
  // 长方形，长轴沿山体西南-东北
  w: 18,
  d: 10,
  rot: -0.25,
};

export function Jianchi() {
  const season = useSandTable((state) => state.season);
  const look = SEASON_LOOKS[season];
  const frozen = look.frozen;
  const night = useSandTable((state) => state.time === 'night');

  const waterColor = frozen
    ? night
      ? '#28323e'
      : '#cfe2ec'
    : night
      ? '#152c42'
      : '#2c5d55';

  return (
    <group position={[POOL.x, POOL.y, POOL.z]} rotation={[0, POOL.rot, 0]}>
      {/* 池底水面：略高于山体表面，避免与山体 z-fighting */}
      <mesh position={[0, 0.18, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[POOL.w, POOL.d]} />
        <meshStandardMaterial
          color={waterColor}
          roughness={frozen ? 0.1 : 0.3}
          metalness={0.1}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* 一圈石沿：四块矮石条围住水面 */}
      {[
        { s: [POOL.w + 1.6, 1, 1.4], p: [0, -0.5, -(POOL.d / 2 + 0.3)] },
        { s: [POOL.w + 1.6, 1, 1.4], p: [0, -0.5, POOL.d / 2 + 0.3] },
        { s: [1.4, 1, POOL.d + 1.6], p: [-(POOL.w / 2 + 0.3), -0.5, 0] },
        { s: [1.4, 1, POOL.d + 1.6], p: [POOL.w / 2 + 0.3, -0.5, 0] },
      ].map((item, i) => (
        <mesh key={i} position={item.p as [number, number, number]}>
          <boxGeometry args={item.s as [number, number, number]} />
          <meshStandardMaterial
            color={season === 'winter' ? '#dde4e8' : '#8a8377'}
            roughness={0.95}
            flatShading
          />
        </mesh>
      ))}
    </group>
  );
}
