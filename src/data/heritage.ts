import type { LandmarkType } from '../types';

/**
 * 古城内文物保护单位（国保 / 省保）补充清单。
 *
 * 沙盘以古城为核心，城墙内的各级文保、控保多达四百余处，
 * 这里只收"护城河以内 + 国保 / 省保"两级、且尚未单独建模的 31 处，
 * 用程序化体块统一表达（见 components/Heritage.tsx），
 * 让它们能被侧栏检索、点击聚焦、打标签，而不必逐处 Blender 建模。
 *
 * 坐标：优先取自 OpenStreetMap（scripts/fetch-heritage.mjs 拉取的
 * data/raw/heritage.json，按 name 匹配 polygon/way/node 质心）；
 * OSM 缺失的小型宅第/园用地址反推（邻近已知文保/街巷锚点估算），
 * 对示意性体块足够，误差在街区尺度内。
 */

export type HeritageLevel = 'national' | 'provincial';

/** 渲染类别：决定 Heritage.tsx 生成的体块样式 */
export type HeritageKind =
  | 'garden' // 园林：绿地台 + 白墙黛瓦厅堂
  | 'temple' // 寺庙/文庙/祠/王府：赭红殿堂
  | 'pagoda' // 砖塔
  | 'gate' // 城门
  | 'mansion' // 宅第/会馆/府署：院落
  | 'stele' // 碑 / 峰石
  | 'school'; // 学校 / 学府

export interface HeritageLandmark {
  id: string;
  name: string;
  /** 粗略景点类型（驱动侧栏色点与标签配色） */
  type: LandmarkType;
  level: HeritageLevel;
  kind: HeritageKind;
  lon: number;
  lat: number;
  description: string;
}

export const HERITAGE_LEVEL_LABEL: Record<HeritageLevel, string> = {
  national: '国保',
  provincial: '省保',
};

export const HERITAGE_LANDMARKS: HeritageLandmark[] = [
  /* ---------------- 全国重点文物保护单位（古城内，未建模） ----------------
   * 注：太平天国忠王府不单列——其范围就在拙政园园内（现为苏州博物馆忠王府部分），
   * 单独建院会与拙政园精细模型重叠，故并入拙政园景点。
   */
  {
    id: 'suzhouwenmiao',
    name: '苏州文庙',
    type: 'temple',
    level: 'national',
    kind: 'temple',
    lon: 120.61927,
    lat: 31.29763,
    description: '苏州府学与文庙大成殿，藏《平江图》等宋代石刻，古城东南的文教中心。',
  },
  {
    id: 'huanxiushanzhuang',
    name: '环秀山庄',
    type: 'garden',
    level: 'national',
    kind: 'garden',
    lon: 120.60905,
    lat: 31.31308,
    description: '戈裕良所叠太湖石假山为冠，以假山胜景入列世界遗产。',
  },
  {
    id: 'ouyuan',
    name: '耦园',
    type: 'garden',
    level: 'national',
    kind: 'garden',
    lon: 120.63407,
    lat: 31.31827,
    description: '仓街深处的宅园，东园西宅、一宅两园，"佳偶天成"的诗意园林。',
  },
  {
    id: 'yipu',
    name: '艺圃',
    type: 'garden',
    level: 'national',
    kind: 'garden',
    lon: 120.60475,
    lat: 31.31534,
    description: '文衙弄内的小型园林，池馆相映，简练质朴，明代园林遗构。',
  },
  {
    id: 'quanjinhuiguan',
    name: '全晋会馆',
    type: 'temple',
    level: 'national',
    kind: 'temple',
    lon: 120.63134,
    lat: 31.31515,
    description: '山西商帮会馆，今为中国昆曲博物馆，戏台雕饰精美。',
  },
  {
    id: 'quyuan',
    name: '曲园（俞樾故居）',
    type: 'garden',
    level: 'national',
    kind: 'garden',
    lon: 120.6155,
    lat: 31.3115,
    description: '清末经学家俞樾故居，因园形似曲尺得名，马医科巷内的小园。',
  },
  {
    id: 'weidaoguanqianpanzhai',
    name: '卫道观前潘宅',
    type: 'monument',
    level: 'national',
    kind: 'mansion',
    lon: 120.63126,
    lat: 31.31592,
    description: '徽商潘麟兆"礼耕堂"，五路六进清代大宅，砖雕门楼堪称上品。',
  },
  {
    id: 'jiachenxiangzhuan',
    name: '甲辰巷砖塔',
    type: 'monument',
    level: 'national',
    kind: 'pagoda',
    lon: 120.63462,
    lat: 31.31044,
    description: '北宋小型砖塔，古城东南隅留存至今的宋代古塔。',
  },
  {
    id: 'dongwudaxue',
    name: '东吴大学旧址',
    type: 'modern',
    level: 'national',
    kind: 'school',
    lon: 120.63681,
    lat: 31.30765,
    description: '苏州大学天赐庄校区，近代教会大学建筑群，钟楼与红砖校舍为标志。',
  },
  {
    id: 'tianxiangxiaozhu',
    name: '天香小筑',
    type: 'garden',
    level: 'national',
    kind: 'garden',
    lon: 120.617,
    lat: 31.299,
    description: '人民路西的近代宅园，池亭花木间有中西合璧厅堂。',
  },
  {
    id: 'zhizaoshu',
    name: '织造署旧址',
    type: 'monument',
    level: 'national',
    kind: 'mansion',
    lon: 120.623,
    lat: 31.298,
    description: '清代苏州织造署所在，西花园内立"瑞云峰"，带城桥下塘的官署遗存。',
  },

  /* ---------------- 江苏省文物保护单位（古城内，未建模） ---------------- */
  {
    id: 'chenghuangmiao',
    name: '城隍庙工字殿',
    type: 'temple',
    level: 'provincial',
    kind: 'temple',
    lon: 120.61481,
    lat: 31.31338,
    description: '苏州府城隍庙，工字形大殿为明代遗构，景德路上的香火古庙。',
  },
  {
    id: 'yiyuan',
    name: '怡园',
    type: 'garden',
    level: 'provincial',
    kind: 'garden',
    lon: 120.61715,
    lat: 31.30974,
    description: '晚清顾文彬所建，集诸园之长，人民路畔的精巧园林。',
  },
  {
    id: 'wangaoci',
    name: '王鏊祠',
    type: 'temple',
    level: 'provincial',
    kind: 'temple',
    lon: 120.6098,
    lat: 31.3132,
    description: '纪念明代大学士王鏊的祠堂，景德路上，与环秀山庄相邻。',
  },
  {
    id: 'wufengyuan',
    name: '五峰园',
    type: 'garden',
    level: 'provincial',
    kind: 'garden',
    lon: 120.60556,
    lat: 31.31937,
    description: '阊门内的小园，以五座湖石峰闻名，小巧幽静。',
  },
  {
    id: 'ruiyunfeng',
    name: '瑞云峰',
    type: 'monument',
    level: 'provincial',
    kind: 'stele',
    lon: 120.623,
    lat: 31.298,
    description: '宋徽宗"花石纲"遗物，玲珑剔透的太湖名峰，立于织造署西花园。',
  },
  {
    id: 'zhangshichengbei',
    name: '张士诚纪功碑',
    type: 'monument',
    level: 'provincial',
    kind: 'stele',
    lon: 120.61558,
    lat: 31.32507,
    description: '元末吴王张士诚纪功石碑，人民路畔的元代石刻。',
  },
  {
    id: 'meishuzhuanke',
    name: '苏州美术专科学校旧址',
    type: 'modern',
    level: 'provincial',
    kind: 'school',
    lon: 120.62213,
    lat: 31.29667,
    description: '颜文樑创办的近代美专，沧浪亭后的西式校舍旧址。',
  },
  {
    id: 'xumen',
    name: '胥门',
    type: 'monument',
    level: 'provincial',
    kind: 'gate',
    lon: 120.60831,
    lat: 31.29949,
    description: '古城西门，元代水陆城门遗址，胥门路南的城墙遗存。',
  },
  {
    id: 'wenqitang',
    name: '文起堂',
    type: 'monument',
    level: 'provincial',
    kind: 'mansion',
    lon: 120.6135,
    lat: 31.3075,
    description: '干将路上的明代宅第，厅堂梁架保存较好的民居建筑。',
  },
  {
    id: 'huiyinyuan',
    name: '惠荫园',
    type: 'garden',
    level: 'provincial',
    kind: 'garden',
    lon: 120.624,
    lat: 31.315,
    description: '南显子巷内的清代园林，观前街北侧的深巷小园。',
  },
  {
    id: 'dashitouxiang',
    name: '大石头巷吴宅',
    type: 'monument',
    level: 'provincial',
    kind: 'mansion',
    lon: 120.6164,
    lat: 31.30608,
    description: '大石头巷内的清代大宅，多进院落，砖雕门楼精致。',
  },
  {
    id: 'xunfuyamen',
    name: '江苏巡抚衙门旧址',
    type: 'monument',
    level: 'provincial',
    kind: 'mansion',
    lon: 120.61774,
    lat: 31.2998,
    description: '清代江苏巡抚衙门所在，书院巷内的官署建筑群遗存。',
  },
  {
    id: 'anchashishu',
    name: '江苏按察使署旧址',
    type: 'monument',
    level: 'provincial',
    kind: 'mansion',
    lon: 120.61895,
    lat: 31.3035,
    description: '清代江苏按察使署，道前街上的官署建筑遗存。',
  },
  {
    id: 'panshien',
    name: '潘世恩宅',
    type: 'monument',
    level: 'provincial',
    kind: 'mansion',
    // OSM 的 POI 落在平江路上（偏北约 250m）；这里用状元博物馆实测坐标（钮家巷 3 号）
    lon: 120.63072,
    lat: 31.31064,
    description: '钮家巷内的清代状元潘世恩故居，多进宅院。',
  },
  {
    id: 'changyuan',
    name: '畅园',
    type: 'garden',
    level: 'provincial',
    kind: 'garden',
    lon: 120.61021,
    lat: 31.30531,
    description: '庙堂巷内的小型园林，池亭紧凑，民国时曾为茶楼。',
  },
  {
    id: 'sanmaoguanxiang',
    name: '三茅观巷沈宅',
    type: 'monument',
    level: 'provincial',
    kind: 'mansion',
    lon: 120.60816,
    lat: 31.31592,
    description: '三茅观巷内的清至民国大宅，多路多进民居。',
  },
  {
    id: 'zhirenli',
    name: '志仁里民国建筑',
    type: 'modern',
    level: 'provincial',
    kind: 'mansion',
    lon: 120.609,
    lat: 31.315,
    description: '仓桥浜的民国里弄建筑群，中西合璧的近现代民居。',
  },
  {
    id: 'aiqingtang',
    name: '蔼庆堂',
    type: 'monument',
    level: 'provincial',
    kind: 'mansion',
    lon: 120.611,
    lat: 31.318,
    description: '王洗马巷内的清代宅园（任道镕旧居），厅堂院落保存较好。',
  },
  {
    id: 'kaiyuansi',
    name: '开元寺无梁殿',
    type: 'temple',
    level: 'provincial',
    kind: 'temple',
    lon: 120.61342,
    lat: 31.29528,
    description: '开元寺无梁殿，砖砌穹顶不用梁柱，古城西南的明代古建。',
  },
  {
    id: 'taibomiao',
    name: '泰伯庙',
    type: 'temple',
    level: 'provincial',
    kind: 'temple',
    lon: 120.60517,
    lat: 31.31872,
    description: '祭祀吴国始祖泰伯的祠庙，阊门内泰伯庙桥畔。',
  },
];

export const HERITAGE_IDS = new Set(HERITAGE_LANDMARKS.map((h) => h.id));
