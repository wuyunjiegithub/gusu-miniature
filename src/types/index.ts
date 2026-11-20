export type LandmarkPriority = 'P0' | 'P1' | 'P2';

export type LandmarkType = 'garden' | 'district' | 'monument' | 'modern' | 'temple';

export type LodLevel = 'L0' | 'L1' | 'L2';

export interface Landmark {
  id: string;
  name: string;
  type: LandmarkType;
  priority: LandmarkPriority;
  worldHeritage: boolean;
  description: string;
}

/** 局部米制坐标 [x, z]，+x=东，-z=北（见 constants/geo.ts） */
export type LocalPoint2 = [number, number];

export interface LandmarkGeometry {
  /** 面状景点轮廓（闭合环） */
  outline?: LocalPoint2[];
  /** 街道型景点折线 */
  path?: LocalPoint2[];
  centroid: { x: number; z: number };
}

/** 统一坐标系的场景几何数据（scripts/build-scene-data.mjs 产出） */
export interface SceneGeometry {
  meta: {
    source: string;
    license: string;
    origin: { lon: number; lat: number };
    unit: string;
    note: string;
  };
  cityOutline: LocalPoint2[];
  waterways: LocalPoint2[][];
  /** 城外水道（山塘河等），渲染高度低于城内河道 */
  outerWaterways?: LocalPoint2[][];
  landmarks: Record<string, LandmarkGeometry>;
}
