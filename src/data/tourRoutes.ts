import { sceneGeometry } from './sceneGeometry';

/**
 * 电影级整体漫游路线（关键帧运镜版）。
 *
 * 不是"逐个景点预览"，而是一条有镜头语言的连续运镜：
 *   ① 高空全景环绕（establishing）→ ② 俯冲进古城（dive）
 *   → ③ 城乡结合部旋转展示（orbit）→ ④ 逐景点流畅跳转（fly-by）
 *   → ⑤ 拉远收束（pullback）
 *
 * 每个关键帧 = 一个相机位姿（position + target）+ 到达该帧的时长 + 缓动。
 * TourController 用全局时钟在相邻帧间插值（Catmull-Rom 风格的平滑 lerp），
 * 全程一条时间线，镜头不会在站点间"卡顿跳切"。
 */

/** 相机关键帧：时钟推进到本帧时刻时，相机应处于 pose */
export interface TourKeyframe {
  /** 相机世界坐标 */
  pos: [number, number, number];
  /** 注视点世界坐标 */
  target: [number, number, number];
  /** 从上一帧飞到本帧的时长（毫秒） */
  ms: number;
  /** 缓动类型（默认 smooth） */
  ease?: 'smooth' | 'linear' | 'easeOut' | 'easeIn';
  /** HUD 字幕：当前镜头在拍什么 */
  label: string;
  /** 到达后是否短暂停留（毫秒，写入本帧尾部） */
  holdMs?: number;
}

export interface TourRoute {
  id: string;
  name: string;
  keyframes: TourKeyframe[];
}

type Vec3 = [number, number, number];

/** 景点质心（x,z），缺失时回退到 0 */
function centerOf(id: string): { x: number; z: number } {
  return sceneGeometry.landmarks[id]?.centroid ?? { x: 0, z: 0 };
}

/** 围绕某中心的环绕机位：angle 用弧度，radius 水平半径，y 高度 */
function orbit(cx: number, cz: number, radius: number, y: number, angle: number): { pos: Vec3; target: Vec3 } {
  return {
    pos: [cx + Math.cos(angle) * radius, y, cz + Math.sin(angle) * radius],
    target: [cx, 8, cz],
  };
}

/** 景点俯视机位：dist 水平距离、h 高度（dir 控制来向，默认东南方） */
function landmarkView(
  id: string,
  dist: number,
  h: number,
  dir = Math.PI * 0.25,
  targetY = 8,
): { pos: Vec3; target: Vec3 } {
  const c = centerOf(id);
  return {
    pos: [c.x + Math.cos(dir) * dist, h, c.z + Math.sin(dir) * dist],
    target: [c.x, targetY, c.z],
  };
}

/**
 * 编排路线。全部用相对场景的绝对坐标，集中在函数里生成，便于整体调时长。
 * 时长档：总长约 2 分钟（1~3 分钟中段），HUD 另有 0.5×/1×/2× 倍速。
 */
function buildRoute(): TourRoute {
  const kf: TourKeyframe[] = [];
  const add = (
    pose: { pos: Vec3; target: Vec3 },
    ms: number,
    label: string,
    ease: TourKeyframe['ease'] = 'smooth',
    holdMs?: number,
  ) => kf.push({ ...pose, ms, label, ease, holdMs });

  // 城心（古城轮廓大致中心）
  const CX = 0;
  const CZ = 0;

  // ── ① 高空全景环绕：从西南高空俯瞰全城，绕行 1/4 圈 ──
  add(orbit(CX, CZ, 4200, 3600, Math.PI * 0.75), 0, '姑苏古城 · 全景', 'linear', 900);
  add(orbit(CX, CZ, 4000, 3200, Math.PI * 0.95), 4200, '千年城垣');
  add(orbit(CX, CZ, 3800, 2800, Math.PI * 1.15), 3800, '水陆双棋盘');

  // ── ② 俯冲进古城：从高空沿西南方向俯冲，越过城墙落向盘门腹地 ──
  add(orbit(CX, CZ, 2600, 1750, Math.PI * 1.05), 3600, '俯冲 · 逼近城垣', 'easeIn');
  add(landmarkView('panmen', 900, 620, Math.PI * 0.85), 3200, '盘门 · 水陆城门', 'easeIn', 700);

  // ── ③ 盘门旋转展示：绕景区转 90°，从城门转到瑞光塔侧 ──
  const pm = centerOf('panmen');
  add(orbit(pm.x, pm.z + 180, 620, 300, Math.PI * 0.85), 2600, '瑞光塔 · 盘门三景');
  add(orbit(pm.x, pm.z + 180, 560, 260, Math.PI * 0.45), 2800, '吴门桥 · 古运河');

  // ── ④ 逐景点流畅跳转（低空飞行串联，非静态预览）──
  add(landmarkView('canglangting', 360, 190, Math.PI * 0.2), 4200, '沧浪亭', 'smooth', 500);
  add(landmarkView('wangshiyuan', 340, 180, Math.PI * 0.7), 3600, '网师园');
  add(landmarkView('shuangta', 330, 200, Math.PI * 1.1), 3200, '双塔');
  add(landmarkView('guanqianjie', 520, 280, Math.PI * 0.3), 3400, '观前街');
  add(landmarkView('pingjiang', 480, 260, Math.PI * 0.75), 3200, '平江历史街区');
  add(landmarkView('suzhou-museum', 420, 240, Math.PI * 0.25), 3200, '苏州博物馆');
  add(landmarkView('zhuozhengyuan', 620, 330, Math.PI * 0.15), 3600, '拙政园', 'smooth', 800);
  add(landmarkView('shizilin', 380, 200, Math.PI * 0.6), 3000, '狮子林');
  add(landmarkView('beisita', 560, 380, Math.PI * 1.2), 3400, '北寺塔');
  add(landmarkView('taohuawu', 520, 320, Math.PI * 0.9), 3600, '桃花坞');
  add(landmarkView('shantangjie', 620, 300, Math.PI * 0.35), 4200, '山塘街 · 七里山塘');
  add(landmarkView('liuyuan', 460, 260, Math.PI * 0.2), 4200, '留园', 'smooth', 600);
  add(landmarkView('hanshansi', 620, 420, Math.PI * 0.75), 5600, '寒山寺 · 枫桥夜泊');

  // ── ⑤ 拉远收束：从城外高空缓缓拉回，全城入画 ──
  add(landmarkView('huqiuta', 1100, 900, Math.PI * 0.5), 5200, '虎丘 · 云岩寺塔', 'smooth', 700);
  add(orbit(CX, CZ, 3200, 2400, Math.PI * 1.35), 5200, '古城西北天际线');
  add(orbit(CX, CZ, 4200, 3400, Math.PI * 1.6), 4600, '姑苏古城 · 全景收束', 'easeOut', 1200);

  return { id: 'gusu-cinematic', name: '姑苏古城 · 电影漫游', keyframes: kf };
}

export const CITY_TOUR: TourRoute = buildRoute();

/** 每帧起始累计时间（毫秒） */
export const KF_START: number[] = (() => {
  const acc: number[] = [];
  let t = 0;
  for (const f of CITY_TOUR.keyframes) {
    acc.push(t);
    t += f.ms + (f.holdMs ?? 0);
  }
  return acc;
})();

/** 全程标称时长（毫秒，1× 倍速下） */
export const TOUR_TOTAL_MS = KF_START.length
  ? KF_START[KF_START.length - 1] + CITY_TOUR.keyframes.at(-1)!.ms + (CITY_TOUR.keyframes.at(-1)!.holdMs ?? 0)
  : 0;

/** 关键帧总数（HUD 显示用） */
export const TOUR_FRAME_COUNT = CITY_TOUR.keyframes.length;
