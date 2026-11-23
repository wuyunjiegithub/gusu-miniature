import { create } from 'zustand';
import type { LodLevel } from '../types';
import type { Season } from '../constants/seasons';
import { EMPTY_FILTERS, type LandmarkFilters } from '../utils/filterLandmarks';

export type TimeOfDay = 'day' | 'night';

interface SandTableState {
  /** 当前选中的景点 id；null 表示全景状态 */
  selectedId: string | null;
  /** 当前 LOD 层级（由相机距离驱动，见 FR-11） */
  lod: LodLevel;
  time: TimeOfDay;
  season: Season;
  /** 景点筛选条件（侧栏列表 / 3D 标签 / 小地图共享，见交互 FR） */
  filters: LandmarkFilters;
  /** 全屏电影预览：进行中隐藏侧栏/小地图/HUD，相机交给 TourPreview 独占 */
  previewActive: boolean;
  /** 预览当前段落题字 */
  previewCaption: string;
  select: (id: string | null) => void;
  setLod: (lod: LodLevel) => void;
  setTime: (time: TimeOfDay) => void;
  setSeason: (season: Season) => void;
  /** 更新单个筛选项 */
  setFilter: <K extends keyof LandmarkFilters>(key: K, value: LandmarkFilters[K]) => void;
  /** 清空全部筛选条件 */
  resetFilters: () => void;
  startPreview: () => void;
  exitPreview: () => void;
  setPreviewCaption: (caption: string) => void;
}

/** 沙盘全局状态：选中态、LOD、昼夜/四季、景点筛选、电影预览 */
export const useSandTable = create<SandTableState>((set) => ({
  selectedId: null,
  lod: 'L0',
  time: 'day',
  season: 'spring',
  filters: { ...EMPTY_FILTERS },
  previewActive: false,
  previewCaption: '',
  select: (id) => set({ selectedId: id }),
  setLod: (lod) => set({ lod }),
  setTime: (time) => set({ time }),
  setSeason: (season) => set({ season }),
  setFilter: (key, value) =>
    set((state) => ({ filters: { ...state.filters, [key]: value } })),
  resetFilters: () => set({ filters: { ...EMPTY_FILTERS } }),
  startPreview: () => set({ previewActive: true, previewCaption: '', selectedId: null }),
  exitPreview: () => set({ previewActive: false, previewCaption: '' }),
  setPreviewCaption: (caption) => set({ previewCaption: caption }),
}));
