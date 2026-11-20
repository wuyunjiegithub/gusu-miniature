import raw from './scene-geometry.json';
import type { SceneGeometry } from '../types';

/**
 * 场景几何唯一数据源（OSM 派生，局部米制坐标）。
 * 由 scripts/build-scene-data.mjs 生成，勿手工编辑。
 */
export const sceneGeometry = raw as unknown as SceneGeometry;
