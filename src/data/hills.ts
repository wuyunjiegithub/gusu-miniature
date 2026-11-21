import raw from './hills.json';

/** 苏州城外山丘（公开大致经纬度；高度为艺术化放大值，非精确高程） */
export interface HillSpec {
  name: string;
  lon: number;
  lat: number;
  /** 山体避让半径（米）：建筑、树木、道路一律让开这个圆 */
  radius: number;
  /** 艺术化高度（米） */
  height: number;
  color: string;
}

// 沙盘以寒山寺为西界（约 5.8km），只保留这个范围内的近山；
// 灵岩山、七子山、阳山、上方山都在 6km 以外，已移除。
export const HILLS: HillSpec[] = raw as HillSpec[];

/** 山体可见占地：长轴 / 短轴（以 radius 为单位）与朝向，供几何生成使用 */
export const HILL_SHAPE: Record<string, { rx: number; rz: number; rot: number }> = {
  // 虎丘：西南—东北向的矮丘，顶上有云岩寺塔
  虎丘: { rx: 0.95, rz: 0.7, rot: -0.25 },
  // 狮子山：南北向拉长的一道小山脊，主峰偏北、南侧逐级跌落
  狮子山: { rx: 1.0, rz: 0.52, rot: 0.16 },
};
