import { create } from 'zustand';
import type { LodLevel } from '../types';
import type { Season } from '../constants/seasons';
import { EMPTY_FILTERS, type LandmarkFilters } from '../utils/filterLandmarks';

export type TimeOfDay = 'day' | 'night';

/** 整体漫游运行状态（TourController 消费，HUD 控制） */
export interface TourState {
  active: boolean;
  paused: boolean;
  index: number;
  speed: number;
  /** 当前段进度 0~1（每若干帧写一次，供 HUD 进度条显示） */
  progress: number;
}

const EMPTY_TOUR: TourState = { active: false, paused: false, index: 0, speed: 1, progress: 0 };

interface SandTableState {
  /** 当前选中的景点 id；null 表示全景状态 */
  selectedId: string | null;
  /** 当前 LOD 层级（由相机距离驱动，见 FR-11） */
  lod: LodLevel;
  time: TimeOfDay;
  season: Season;
  /** 景点筛选条件（侧栏列表 / 3D 标签 / 小地图共享，见交互 FR） */
  filters: LandmarkFilters;
  /** 整体漫游状态 */
  tour: TourState;
  select: (id: string | null) => void;
  setLod: (lod: LodLevel) => void;
  setTime: (time: TimeOfDay) => void;
  setSeason: (season: Season) => void;
  /** 更新单个筛选项 */
  setFilter: <K extends keyof LandmarkFilters>(key: K, value: LandmarkFilters[K]) => void;
  /** 清空全部筛选条件 */
  resetFilters: () => void;
  startTour: (speed?: number) => void;
  pauseTour: () => void;
  resumeTour: () => void;
  togglePause: () => void;
  exitTour: () => void;
  setTourIndex: (index: number) => void;
  setTourSpeed: (speed: number) => void;
  setTourProgress: (progress: number) => void;
}

/** 沙盘全局状态：选中态、LOD、昼夜/四季、景点筛选、漫游 */
export const useSandTable = create<SandTableState>((set, get) => ({
  selectedId: null,
  lod: 'L0',
  time: 'day',
  season: 'spring',
  filters: { ...EMPTY_FILTERS },
  tour: { ...EMPTY_TOUR },
  select: (id) => {
    // 任何景点选择（侧栏/标签/小地图）都中断漫游，避免相机被两个写入者争抢
    if (get().tour.active) get().exitTour();
    set({ selectedId: id });
  },
  setLod: (lod) => set({ lod }),
  setTime: (time) => set({ time }),
  setSeason: (season) => set({ season }),
  setFilter: (key, value) =>
    set((state) => ({ filters: { ...state.filters, [key]: value } })),
  resetFilters: () => set({ filters: { ...EMPTY_FILTERS } }),
  startTour: (speed = 1) =>
    set({ tour: { ...EMPTY_TOUR, active: true, speed }, selectedId: null }),
  pauseTour: () => set((state) => ({ tour: { ...state.tour, paused: true } })),
  resumeTour: () => set((state) => ({ tour: { ...state.tour, paused: false } })),
  togglePause: () => set((state) => ({ tour: { ...state.tour, paused: !state.tour.paused } })),
  exitTour: () => set({ tour: { ...EMPTY_TOUR }, selectedId: null }),
  setTourIndex: (index) => set((state) => ({ tour: { ...state.tour, index, progress: 0 } })),
  setTourSpeed: (speed) => set((state) => ({ tour: { ...state.tour, speed } })),
  setTourProgress: (progress) => set((state) => ({ tour: { ...state.tour, progress } })),
}));
