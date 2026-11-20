import { create } from 'zustand';
import type { LodLevel } from '../types';
import type { Season } from '../constants/seasons';

export type TimeOfDay = 'day' | 'night';

interface SandTableState {
  /** 当前选中的景点 id；null 表示全景状态 */
  selectedId: string | null;
  /** 当前 LOD 层级（由相机距离驱动，见 FR-11） */
  lod: LodLevel;
  time: TimeOfDay;
  season: Season;
  select: (id: string | null) => void;
  setLod: (lod: LodLevel) => void;
  setTime: (time: TimeOfDay) => void;
  setSeason: (season: Season) => void;
}

/** 沙盘全局状态：选中态、LOD 与昼夜/四季 */
export const useSandTable = create<SandTableState>((set) => ({
  selectedId: null,
  lod: 'L0',
  time: 'day',
  season: 'spring',
  select: (id) => set({ selectedId: id }),
  setLod: (lod) => set({ lod }),
  setTime: (time) => set({ time }),
  setSeason: (season) => set({ season }),
}));
