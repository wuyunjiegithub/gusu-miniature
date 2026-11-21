import raw from './heritage-footprints.json';
import type { LocalPoint2 } from '../types';

/**
 * 文保院落占地（由 scripts/build-heritage-footprints.ts 求解并固化）。
 *
 * OSM 的文物 POI 质心往往落在街边/路面上，直接用原质心按半径铺院落就会
 * "宅第造在马路上"。这份数据给出每处实际可用的院落中心与半宽，
 * 渲染、标签、相机与建筑剔除全部以它为准，保证模型、标签、空地三者对得上。
 */
export interface HeritageFootprint {
  x: number;
  z: number;
  r: number;
  /** 已被更精细的模型（如拙政园 GLB）完整表现，本层不再建模 */
  hidden?: boolean;
}

export const HERITAGE_FOOTPRINTS = (raw as { sites: Record<string, HeritageFootprint> }).sites;

/** 文保的视觉锚点：有求解结果用院落中心，否则退回 OSM 质心 */
export function heritageAnchor(id: string, fallback: LocalPoint2): LocalPoint2 {
  const fp = HERITAGE_FOOTPRINTS[id];
  if (!fp || fp.hidden) return fallback;
  return [fp.x, fp.z];
}
