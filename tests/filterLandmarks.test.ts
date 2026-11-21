import { describe, expect, it } from 'vitest';
import {
  filterLandmarks,
  hasActiveFilters,
  EMPTY_FILTERS,
  type LandmarkFilters,
} from '../src/utils/filterLandmarks';
import type { Landmark } from '../src/types';

const lm = (id: string, name: string, overrides: Partial<Landmark> = {}): Landmark => ({
  id,
  name,
  type: 'garden',
  priority: 'P1',
  worldHeritage: false,
  description: '',
  ...overrides,
});

const ALL: Landmark[] = [
  lm('a', '拙政园', { priority: 'P0', worldHeritage: true, description: '古典园林' }),
  lm('b', '留园', { type: 'garden', priority: 'P1' }),
  lm('c', '寒山寺', { type: 'temple', priority: 'P2', description: '千年古刹' }),
  lm('d', '苏州博物馆', { type: 'modern', priority: 'P3', description: '毗邻拙政园' }),
];

const f = (overrides: Partial<LandmarkFilters>): LandmarkFilters => ({
  ...EMPTY_FILTERS,
  ...overrides,
});

describe('hasActiveFilters', () => {
  it('空条件返回 false', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });
  it('任一条件（含空白搜索串之外）返回 true', () => {
    expect(hasActiveFilters(f({ query: '   ' }))).toBe(false);
    expect(hasActiveFilters(f({ query: '园林' }))).toBe(true);
    expect(hasActiveFilters(f({ worldHeritageOnly: true }))).toBe(true);
  });
});

describe('filterLandmarks', () => {
  it('空条件返回全部', () => {
    expect(filterLandmarks(ALL, EMPTY_FILTERS).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('搜索匹配名称与描述，大小写/空格不敏感', () => {
    expect(filterLandmarks(ALL, f({ query: '拙政园' })).map((x) => x.id)).toEqual(['a', 'd']);
    expect(filterLandmarks(ALL, f({ query: '  古刹 ' })).map((x) => x.id)).toEqual(['c']);
  });

  it('类型 / 优先级 / 世遗为 AND 关系', () => {
    expect(filterLandmarks(ALL, f({ type: 'temple' })).map((x) => x.id)).toEqual(['c']);
    expect(filterLandmarks(ALL, f({ priority: 'P0' })).map((x) => x.id)).toEqual(['a']);
    expect(filterLandmarks(ALL, f({ worldHeritageOnly: true })).map((x) => x.id)).toEqual(['a']);
    expect(
      filterLandmarks(ALL, f({ type: 'garden', worldHeritageOnly: true })).map((x) => x.id),
    ).toEqual(['a']);
    expect(
      filterLandmarks(ALL, f({ type: 'temple', priority: 'P0' })).map((x) => x.id),
    ).toEqual([]);
  });

  it('文保等级筛选依赖传入的 level map', () => {
    const levels = new Map<string, 'national' | 'provincial'>([
      ['a', 'national'],
      ['c', 'provincial'],
    ]);
    expect(filterLandmarks(ALL, f({ heritageLevel: 'national' }), levels).map((x) => x.id)).toEqual(['a']);
    expect(filterLandmarks(ALL, f({ heritageLevel: 'provincial' }), levels).map((x) => x.id)).toEqual(['c']);
    // 不传 map 时该条件无匹配
    expect(filterLandmarks(ALL, f({ heritageLevel: 'national' })).length).toBe(0);
  });
});
