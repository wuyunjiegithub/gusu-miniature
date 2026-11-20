/**
 * 古城空间基准（开发流程 阶段1 锁定）
 * 场景单位：1 单位 = 1 米；原点取古城几何中心
 */

/** 古城几何中心（场景原点） */
export const CITY_ORIGIN = { lon: 120.621, lat: 31.311 } as const;

/** 古城边界（中研院 GIS 苏州城图 bounds，与护城河以内范围基本吻合） */
export const CITY_BOUNDS = {
  west: 120.5979,
  east: 120.6447,
  south: 31.2868,
  north: 31.3345,
} as const;

/** 底座厚度（米），呈现实体沙盘台观感 */
export const BASE_THICKNESS = 24;

/** LOD 距离阈值（米），见需求文档 FR-11 */
export const LOD_THRESHOLDS = {
  /** 相机距离 > 该值 → L0 全景 */
  L0_MIN: 800,
  /** 相机距离 < 该值 → L2 近景 */
  L2_MAX: 200,
} as const;

/** 轨道控制限制，与 L2 / L0 切换阈值对应 */
export const CAMERA_LIMITS = {
  minDistance: 120,
  maxDistance: 8000,
  /**
   * 限制俯仰角，防止镜头穿到地面以下：
   * 距离最近 120m 时相机高度仍 >= 120 * cos(70°) ≈ 41m，始终高于底座顶面（y=0）。
   */
  maxPolarAngle: Math.PI / 2 - 0.35,
} as const;

/** 全景默认机位（"返回全景"的目标状态），需覆盖 3.6km 城市范围 */
export const PANORAMA_VIEW = {
  position: { x: 1500, y: 1100, z: 1500 },
  target: { x: 0, y: 0, z: 0 },
} as const;
