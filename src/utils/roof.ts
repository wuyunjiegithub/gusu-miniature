import * as THREE from 'three';

/** 单位坡屋顶（底 1×1，脊高 1，屋脊沿 x 轴），城内民居与城外街区共用 */
export function createPitchedRoofGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const v = new Float32Array([
    // 南坡
    -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, 0,
    -0.5, 0, -0.5, 0.5, 1, 0, -0.5, 1, 0,
    // 北坡
    0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 1, 0,
    0.5, 0, 0.5, -0.5, 1, 0, 0.5, 1, 0,
    // 山墙
    -0.5, 0, 0.5, -0.5, 0, -0.5, -0.5, 1, 0,
    0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 1, 0,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return geo;
}

/** 单位庑殿顶（底 w×d，脊高 h，屋脊沿 x 轴）；用于城门楼 */
export function createHipRoofGeometry(w: number, d: number, h: number): THREE.BufferGeometry {
  const hw = w / 2;
  const hd = d / 2;
  const rh = Math.max(0, hw - hd * 0.72);
  const geo = new THREE.BufferGeometry();
  const v = new Float32Array([
    // 南坡
    -hw, 0, -hd, hw, 0, -hd, rh, h, 0,
    -hw, 0, -hd, rh, h, 0, -rh, h, 0,
    // 北坡
    hw, 0, hd, -hw, 0, hd, -rh, h, 0,
    hw, 0, hd, -rh, h, 0, rh, h, 0,
    // 东歇山
    hw, 0, -hd, hw, 0, hd, rh, h, 0,
    // 西歇山
    -hw, 0, hd, -hw, 0, -hd, -rh, h, 0,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return geo;
}
