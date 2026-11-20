import type { Landmark } from '../types';

/** 墙体调色板（暖白民居，提高沙盘可读性） */
export const WALL_COLORS = ['#f4efe4', '#eee8db', '#e6e0d2', '#dcd6c8', '#f8f4ea'];

/** 坡顶调色板（深灰瓦，与白墙拉开明度差） */
export const ROOF_COLORS = ['#5d6672', '#525b67', '#67707c', '#576069', '#616a76'];

/** 景点类型配色：园林绿、街区暖砖、地标金、现代青灰、寺观赭红 */
export const LANDMARK_TYPE_COLORS: Record<Landmark['type'], string> = {
  garden: '#5f9a52',
  district: '#c08a63',
  monument: '#c9a86a',
  modern: '#7f9bb3',
  temple: '#b0713d',
};
