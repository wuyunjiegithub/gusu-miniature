import type { Landmark, LandmarkPriority, LandmarkType } from '../types';

/** 景点筛选条件。搜索、类型、优先级、文保等级、世遗可叠加（AND）。 */
export interface LandmarkFilters {
  query: string;
  type: LandmarkType | null;
  priority: LandmarkPriority | null;
  heritageLevel: 'national' | 'provincial' | null;
  worldHeritageOnly: boolean;
}

export const EMPTY_FILTERS: LandmarkFilters = {
  query: '',
  type: null,
  priority: null,
  heritageLevel: null,
  worldHeritageOnly: false,
};

/** 是否有任一筛选条件生效（用于展示"清除筛选"按钮）。 */
export function hasActiveFilters(f: LandmarkFilters): boolean {
  return Boolean(
    f.query.trim() || f.type || f.priority || f.heritageLevel || f.worldHeritageOnly,
  );
}

/**
 * 按筛选条件过滤景点列表（纯函数，便于单测）。
 * 搜索匹配名称与描述，大小写/首尾空格不敏感；其余维度为 AND 关系。
 * @param levelById 文保 id → 保护级别；不传时"文保等级"筛选退化为无匹配。
 */
export function filterLandmarks(
  landmarks: readonly Landmark[],
  f: LandmarkFilters,
  levelById?: ReadonlyMap<string, 'national' | 'provincial'>,
): Landmark[] {
  const q = f.query.trim().toLowerCase();
  return landmarks.filter((lm) => {
    if (q && !`${lm.name} ${lm.description}`.toLowerCase().includes(q)) return false;
    if (f.type && lm.type !== f.type) return false;
    if (f.priority && lm.priority !== f.priority) return false;
    if (f.worldHeritageOnly && !lm.worldHeritage) return false;
    if (f.heritageLevel) {
      if (!levelById || levelById.get(lm.id) !== f.heritageLevel) return false;
    }
    return true;
  });
}
