import type { LandmarkPriority, LandmarkType } from '../types';

/**
 * 古城外地标补充（真实数据）。
 *
 * 沙盘以古城为中心、半径约 5.9km，能落进来的城外名胜有限。
 * 这里只收"在范围内 + 脚下确有地形或水面承托"的几处；
 * 范围外或缺少水系的（宝带桥、觅渡桥、枫桥等）见文件末尾清单。
 */
export interface ExtraLandmark {
  id: string;
  name: string;
  type: LandmarkType;
  priority: LandmarkPriority;
  worldHeritage: boolean;
  description: string;
  /** 真实经纬度 */
  lon: number;
  lat: number;
  /** 直接指定场景坐标（跨河桥必须按水面几何定位，不能用经纬度近似） */
  at?: [number, number];
  /** 模型类型：由 ProceduralLandmarks 逐类生成 */
  kind: 'pagoda' | 'arch-bridge';
  /** 类型参数 */
  spec: Record<string, number>;
  /** 占地半径（0 = 不放石台，模型自带底座） */
  padRadius: number;
}

export const EXTRA_LANDMARKS: ExtraLandmark[] = [
  {
    id: 'huqiuta',
    name: '虎丘塔',
    type: 'monument',
    priority: 'P1',
    worldHeritage: false,
    description:
      '云岩寺塔，五代后周始建，七层八角砖塔，向西北倾斜约 2.5°，被称作"中国比萨斜塔"。塔立虎丘山顶，是古城西北天际线的锚点。',
    lon: 120.5725,
    lat: 31.3378,
    kind: 'pagoda',
    spec: {
      tiers: 7,
      baseRadius: 7.4,
      taper: 0.9,
      tierHeight: 4.5,
      eaveOverhang: 1.6,
      lean: 0.045,
      // 虎丘山体峰顶世界高度约 -2 + 88
      baseY: 85,
    },
    padRadius: 0,
  },
];

/**
 * 已核过、但这轮**没有建**的城外名胜，以及原因：
 *
 * - 宝带桥（120.6294, 31.2497）：距古城中心 6.9km，已在沙盘陆地圆盘（r=5.9km）之外，落进来会悬空。
 * - 觅渡桥（120.6291, 31.2887）：位置在范围内，但跨的是京杭运河外段，
 *   场景里没有这条水系（`outerWaterways` 只有山塘河），硬建就是"桥架在旱地上"。
 * - 枫桥 / 江村桥（120.5654, 31.3200 / 120.5643, 31.3212）：同上，缺上塘河。
 * - 瑞光塔：已含在 `panmen.glb` 里（模型高 40.4m，与真高 43.2m 相当），不重复建。
 * - 玄妙观三清殿：已含在 `guanqianjie.glb` 的街道样板段东端。
 * - 东方之门 / 金鸡湖（园区）：距中心 7.5km 以上，超出沙盘范围。
 */
export const EXTRA_LANDMARKS_NOTE = '见 extraLandmarks.ts 末尾清单';
