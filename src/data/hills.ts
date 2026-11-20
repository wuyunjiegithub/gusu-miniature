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

export const HILLS: HillSpec[] = [
  { name: '虎丘', lon: 120.5725, lat: 31.3378, radius: 420, height: 88, color: '#4f6249' },
  { name: '狮子山', lon: 120.567, lat: 31.305, radius: 700, height: 188, color: '#4a5c47' },
  { name: '上方山', lon: 120.585, lat: 31.266, radius: 800, height: 163, color: '#465845' },
  { name: '灵岩山', lon: 120.547, lat: 31.28, radius: 900, height: 250, color: '#415242' },
  { name: '七子山', lon: 120.563, lat: 31.243, radius: 950, height: 150, color: '#445643' },
  { name: '阳山', lon: 120.53, lat: 31.372, radius: 1150, height: 180, color: '#4b5d48' },
];
