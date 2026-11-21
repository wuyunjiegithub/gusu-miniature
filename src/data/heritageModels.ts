import type { HeritageKind } from './heritage';

/**
 * 文保单位精细建模规格。
 *
 * 31 处文保不再用统一的 box 体块，而是按"建筑原型 + 特征开关"程序化生成
 * 有辨识度的建筑群（见 components/Heritage.tsx）。本文件只描述"建什么"，
 * 具体几何与材质在渲染层按季节生成。
 *
 * 每处都给出 rot（朝向微差）与专属特征，配合由 id 派生的确定性随机种子，
 * 让同类文保（如多个园林、多进宅第）彼此不雷同。
 */

export type HeritageArchetype =
  | 'garden' // 园林：园墙 + 水池 + 厅堂 + 亭 + 游廊 + 假山 + 树
  | 'temple' // 寺/庙/文庙/祠/会馆/王府：中轴多进殿宇 + 院墙
  | 'residence' // 宅第/官署：多进院落 + 厢房 + 门楼
  | 'pagoda' // 砖塔
  | 'gate' // 城门 + 城楼
  | 'rock' // 太湖石峰 / 碑刻
  | 'academy'; // 近代学堂：西式校舍 + 钟楼

export interface HeritageModelSpec {
  archetype: HeritageArchetype;
  /** 绕 Y 轴朝向（弧度）。传统建筑大体朝南，取 ±0.3 内微差；园林变化略大 */
  rot: number;
  /** 占地半宽（米）；缺省由 archetype 取默认值，且受 outline 半径约束 */
  radius?: number;
  /** 中轴院落进数（temple / residence） */
  courts?: number;
  /** 主殿 / 厅堂数量 */
  halls?: number;
  /** 亭子数量（园林 / 宅园） */
  pavilions?: number;
  /** 是否有水池（园林 / 宅园 / 文庙泮池） */
  pond?: boolean;
  /** 假山强度：0 无、1 点缀、2 主景 */
  rockery?: 0 | 1 | 2;
  /** 牌坊 / 棂星门 / 照壁 */
  paifang?: boolean;
  /** 戏台（会馆） */
  operaStage?: boolean;
  /** 西式钟楼（教会大学） */
  bellTower?: boolean;
  /** 西式建筑做法（民国里弄 / 教会校舍 / 中西合璧厅堂） */
  western?: boolean;
  /** 砖砌无梁殿（不用木构屋顶） */
  brickHall?: boolean;
  /** 石碑而非湖石峰（rock 原型） */
  stele?: boolean;
  /** 塔层数（pagoda） */
  tiers?: number;
}

/** 各地标专属规格。键与 HERITAGE_LANDMARKS 的 id 一一对应。 */
export const HERITAGE_MODELS: Record<string, HeritageModelSpec> = {
  /* ---------------- 全国重点 ---------------- */
  suzhouwenmiao: { archetype: 'temple', rot: -0.04, radius: 23, courts: 2, halls: 3, paifang: true, pond: true },
  huanxiushanzhuang: { archetype: 'garden', rot: 0.22, radius: 21, halls: 2, pavilions: 2, pond: true, rockery: 2 },
  ouyuan: { archetype: 'garden', rot: -0.18, radius: 23, halls: 3, pavilions: 3, pond: true, rockery: 1 },
  yipu: { archetype: 'garden', rot: 0.12, radius: 20, halls: 2, pavilions: 2, pond: true, rockery: 1 },
  quanjinhuiguan: { archetype: 'temple', rot: 0.03, radius: 22, courts: 2, halls: 2, paifang: true, operaStage: true },
  quyuan: { archetype: 'garden', rot: -0.26, radius: 16, halls: 2, pavilions: 1, pond: true, rockery: 1 },
  weidaoguanqianpanzhai: { archetype: 'residence', rot: 0.06, radius: 19, courts: 3, halls: 3 },
  jiachenxiangzhuan: { archetype: 'pagoda', rot: 0, radius: 11, tiers: 5 },
  dongwudaxue: { archetype: 'academy', rot: -0.1, radius: 23, halls: 3, bellTower: true, western: true },
  tianxiangxiaozhu: { archetype: 'garden', rot: 0.16, radius: 19, halls: 2, pavilions: 2, pond: true, western: true },
  zhizaoshu: { archetype: 'residence', rot: -0.07, radius: 20, courts: 2, halls: 3, pond: true, rockery: 2 },

  /* ---------------- 江苏省保 ---------------- */
  chenghuangmiao: { archetype: 'temple', rot: 0.02, radius: 21, courts: 2, halls: 2, paifang: true },
  yiyuan: { archetype: 'garden', rot: -0.2, radius: 22, halls: 2, pavilions: 3, pond: true, rockery: 1 },
  wangaoci: { archetype: 'temple', rot: 0.09, radius: 17, courts: 1, halls: 2, paifang: true },
  wufengyuan: { archetype: 'garden', rot: 0.3, radius: 17, halls: 1, pavilions: 1, pond: false, rockery: 2 },
  ruiyunfeng: { archetype: 'rock', rot: 0.4, radius: 10, stele: false },
  zhangshichengbei: { archetype: 'rock', rot: -0.15, radius: 9, stele: true },
  meishuzhuanke: { archetype: 'academy', rot: 0.14, radius: 19, halls: 2, western: true },
  xumen: { archetype: 'gate', rot: 0.08, radius: 12 },
  wenqitang: { archetype: 'residence', rot: -0.05, radius: 17, courts: 2, halls: 2 },
  huiyinyuan: { archetype: 'garden', rot: 0.24, radius: 20, halls: 2, pavilions: 2, pond: true, rockery: 1 },
  dashitouxiang: { archetype: 'residence', rot: -0.11, radius: 19, courts: 3, halls: 3 },
  xunfuyamen: { archetype: 'residence', rot: 0.04, radius: 20, courts: 2, halls: 3, paifang: true },
  anchashishu: { archetype: 'residence', rot: -0.08, radius: 19, courts: 2, halls: 3 },
  panshien: { archetype: 'residence', rot: 0.07, radius: 18, courts: 3, halls: 3 },
  changyuan: { archetype: 'garden', rot: -0.28, radius: 18, halls: 2, pavilions: 2, pond: true, rockery: 1 },
  sanmaoguanxiang: { archetype: 'residence', rot: 0.13, radius: 19, courts: 3, halls: 3 },
  zhirenli: { archetype: 'residence', rot: -0.03, radius: 18, courts: 1, halls: 3, western: true },
  aiqingtang: { archetype: 'garden', rot: 0.19, radius: 20, halls: 3, pavilions: 2, pond: true, rockery: 1 },
  kaiyuansi: { archetype: 'temple', rot: -0.06, radius: 18, courts: 1, halls: 2, brickHall: true },
  taibomiao: { archetype: 'temple', rot: 0.05, radius: 19, courts: 2, halls: 3, paifang: true },
};

/** 无规格时的兜底（按类别推断），保证新增文保也能被建模而不是退化成空地 */
export function getHeritageModelSpec(id: string, kind: HeritageKind): HeritageModelSpec {
  const spec = HERITAGE_MODELS[id];
  if (spec) return spec;
  const base: Record<HeritageKind, HeritageModelSpec> = {
    garden: { archetype: 'garden', rot: 0, halls: 2, pavilions: 2, pond: true, rockery: 1 },
    temple: { archetype: 'temple', rot: 0, courts: 1, halls: 2 },
    pagoda: { archetype: 'pagoda', rot: 0, tiers: 5 },
    gate: { archetype: 'gate', rot: 0 },
    mansion: { archetype: 'residence', rot: 0, courts: 2, halls: 2 },
    stele: { archetype: 'rock', rot: 0, stele: true },
    school: { archetype: 'academy', rot: 0, halls: 2 },
  };
  return base[kind];
}

/**
 * 由 id 派生的确定性随机种子（FNV-1a 变体）。
 * 用于亭/树/假山的抖动摆放：同一 id 每次渲染完全一致，不同 id 彼此不同。
 */
export function idSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 线性同余伪随机，配合 idSeed 生成 [0,1) 序列 */
export function makeRng(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
