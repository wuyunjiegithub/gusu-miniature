/** 苏州城外山丘（公开大致经纬度；高度为艺术化放大值，非精确高程） */
export interface HillSpec {
  name: string;
  lon: number;
  lat: number;
  /** 山体半径（米） */
  radius: number;
  /** 艺术化高度（米） */
  height: number;
  color: string;
}

// 沙盘以寒山寺为西界（约 5.8km），只保留这个范围内的近山；
// 灵岩山、七子山、阳山、上方山都在 6km 以外，已移除。
export const HILLS: HillSpec[] = [
  { name: '虎丘', lon: 120.5725, lat: 31.3378, radius: 420, height: 88, color: '#4f6249' },
  { name: '狮子山', lon: 120.567, lat: 31.305, radius: 700, height: 188, color: '#4a5c47' },
];
