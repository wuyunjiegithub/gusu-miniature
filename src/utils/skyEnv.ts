import * as THREE from 'three';
import type { Season } from '../constants/seasons';

/**
 * 天空反射贴图（等距圆柱投影）。
 *
 * 冰面需要"反光"才有质感，但场景里没有 HDR 环境资源。
 * 这里用一张竖向渐变的画布当作 environment，只挂在水/冰材质上：
 * 镜面冰面反射天光后自然泛白、泛蓝，不必引入外部素材。
 */
const SKY_TINT: Record<Season, [string, string, string]> = {
  spring: ['#a8c8de', '#e8f2f7', '#6f7d6a'],
  summer: ['#9dc4e2', '#e6f1f8', '#5f7360'],
  autumn: ['#b9c6cf', '#eef0ea', '#7d7460'],
  winter: ['#c6d9e8', '#f4f8fb', '#b6c3c9'],
};

const cache = new Map<Season, THREE.Texture>();

export function getSkyReflection(season: Season): THREE.Texture {
  const hit = cache.get(season);
  if (hit) return hit;

  const [top, mid, bottom] = SKY_TINT[season];
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, top);
    grad.addColorStop(0.46, mid);
    grad.addColorStop(0.54, mid);
    grad.addColorStop(1, bottom);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 256);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  cache.set(season, texture);
  return texture;
}
