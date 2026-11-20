/** 四季（替代原天气系统）：只改变天光、植被、地色、水色与冬雪，不动城的格局 */
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export interface BlossomSpec {
  /** 开花树所占比例 */
  ratio: number;
  color: string;
}

export interface SeasonLook {
  label: string;
  /** 城内台面（街巷之间的青石板铺地） */
  ground: string;
  /** 城外陆地基准面 */
  land: string;
  /** 河湖水面（冬季为冰面） */
  water: string;
  /** 园林绿地底衬 */
  lawn: string;
  /** 山体山脚色 */
  hillLow: string;
  /** 山体山脊色 */
  hillHigh: string;
  /** 树冠色板 */
  crowns: string[];
  /** 花树（仅春季） */
  blossom?: BlossomSpec;
  /** 冬季保留树冠的常绿树比例；0 表示全部落叶 */
  evergreen: number;
  /** 冬季河湖结冰：水面转为冰面、停止流动 */
  frozen: boolean;
}

/**
 * 四季取色：
 * 春 = 嫩绿初发，夏 = 郁郁葱葱的浓绿，
 * 秋 = 枫红、柿橙、银杏黄，冬 = 白茫茫雪原与结冰的河。
 * 建筑本体仍是白墙黛瓦，季节差异主要由环境与植被承担。
 */
export const SEASON_LOOKS: Record<Season, SeasonLook> = {
  spring: {
    label: '春',
    // 城内为青石板铺地，不再用草地；绿色留给树冠与园林
    ground: '#949a92',
    // 城外以城市建成区为主：中性灰调（贴图会再乘城市街区肌理）
    land: '#a5a6a2',
    water: '#3f97ad',
    lawn: '#6fa856',
    hillLow: '#3f6b39',
    hillHigh: '#7e9077',
    crowns: ['#6fa84f', '#7cb85a', '#5c9a45', '#8cc46a'],
    blossom: { ratio: 0.08, color: '#efc3cf' },
    evergreen: 0,
    frozen: false,
  },
  summer: {
    label: '夏',
    ground: '#8f958d',
    land: '#a2a3a0',
    water: '#2f7fa5',
    lawn: '#4f8f42',
    hillLow: '#315c33',
    hillHigh: '#6f8068',
    crowns: ['#2f6631', '#3a7a38', '#28572b', '#458a40'],
    evergreen: 0,
    frozen: false,
  },
  autumn: {
    label: '秋',
    ground: '#99948a',
    land: '#a5a5a1',
    water: '#3e6f74',
    lawn: '#9a9a45',
    hillLow: '#5c6238',
    hillHigh: '#9a8f6e',
    // 枫红为主，柿子橙与银杏黄点缀
    crowns: ['#b8432f', '#c9642f', '#d99a33', '#e0b53c', '#a8503a'],
    evergreen: 0,
    frozen: false,
  },
  winter: {
    label: '冬',
    // 雪只落在屋顶与树梢：街巷石板保持干净，路面也不铺雪
    ground: '#9ba1a6',
    land: '#a8aeb3',
    water: '#cfe2ec',
    lawn: '#9fa795',
    hillLow: '#9aa5a8',
    hillHigh: '#e9eef2',
    crowns: ['#3f5340', '#4a5f49'],
    // 冬日绝大部分落叶，只留极少数常绿
    evergreen: 0.12,
    frozen: true,
  },
};

/** HUD 上的四季按钮顺序 */
export const SEASON_ORDER: Season[] = ['spring', 'summer', 'autumn', 'winter'];
