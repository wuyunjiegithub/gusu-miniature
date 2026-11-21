import * as THREE from 'three';
import { GROUND_DISC_RADIUS } from '../constants/geo';

/** 外围地面圆盘直径（= 城外地面的贴图覆盖范围） */
export const GROUND_WORLD = GROUND_DISC_RADIUS * 2;
const SIZE = 2048;
const CELL = 160;

const hash = (i: number): number => {
  const v = Math.sin(i * 61.917 + 7.31) * 43758.5453;
  return v - Math.floor(v);
};

const toPx = (m: number): number => ((m + GROUND_WORLD / 2) / GROUND_WORLD) * SIZE;

/**
 * 城外城市肌理贴图：160m 街区 + 绿地。
 * 纯程序绘制，用作 11.8km 地面圆盘的颜色，让城外
 * 在俯视时读到连续的城市建成区，而不是一片裸土。
 * 灰度值贴近 1，最终色调由材质的季节色相乘得到。
 */
export function createCityGroundTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建城外地面贴图');

  // 街道/空地底色：比屋面略暗，远看形成清晰的街坊网格
  ctx.fillStyle = '#e4e2db';
  ctx.fillRect(0, 0, SIZE, SIZE);

  const cells = Math.floor(GROUND_WORLD / CELL);
  const cellPx = (CELL / GROUND_WORLD) * SIZE;

  // 街区：沿地块四周铺一圈屋面，中间留出天井
  for (let i = 0; i < cells; i += 1) {
    for (let j = 0; j < cells; j += 1) {
      const x = -GROUND_WORLD / 2 + i * CELL;
      const z = -GROUND_WORLD / 2 + j * CELL;
      const seed = i * 131 + j * 17;
      const px = toPx(x);
      const pz = toPx(z);
      // 约 1/6 的地块做公园绿地，城外因此不会只有屋顶
      // 用户反馈：城郊绿地不需要这种整块整块的绿色斑块，改成与街区同质的
      // 浅灰屋面肌理，绿地在近景由 Trees 的散生林表达。
      const park = false;
      const tone = 0.9 + hash(seed + 3) * 0.1;
      if (park) {
        const g = Math.round(146 + hash(seed + 5) * 30);
        ctx.fillStyle = `rgb(${g - 30}, ${g}, ${g - 56})`;
        ctx.fillRect(px, pz, cellPx, cellPx);
        // 绿地里的树丛暗斑，远看有层次
        ctx.fillStyle = 'rgba(96, 122, 78, 0.55)';
        const n = 4 + Math.floor(hash(seed + 11) * 4);
        for (let k = 0; k < n; k += 1) {
          const bx = px + cellPx * (0.12 + hash(seed + 13 + k) * 0.72);
          const bz = pz + cellPx * (0.12 + hash(seed + 19 + k) * 0.72);
          const r = cellPx * (0.05 + hash(seed + 23 + k) * 0.05);
          ctx.beginPath();
          ctx.arc(bx, bz, r, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        const v = Math.round(236 * tone);
        ctx.fillStyle = `rgb(${v}, ${v - 1}, ${v - 7})`;
        ctx.fillRect(px, pz, cellPx, cellPx);

        // 天井/院落：用更亮的天光色回填内部，形成围合式街坊
        const inset = cellPx * 0.3;
        const v2 = Math.round(244 - hash(seed + 9) * 12);
        ctx.fillStyle = `rgb(${v2}, ${v2}, ${v2 - 5})`;
        ctx.fillRect(px + inset, pz + inset, cellPx - inset * 2, cellPx - inset * 2);
      }
    }
  }

  // 街道留给真实 OSM 路网表达；贴图只提供街区屋面的疏密肌理，
  // 不额外画网格线，避免与真实路网叠成两套路。
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 4;
  return texture;
}
