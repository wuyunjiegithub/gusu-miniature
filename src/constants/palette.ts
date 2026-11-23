import type { Landmark } from '../types';

/** 墙体调色板（暖白民居，提高沙盘可读性） */
export const WALL_COLORS = ['#f4efe4', '#eee8db', '#e6e0d2', '#dcd6c8', '#f8f4ea'];

/** 坡顶调色板（深灰瓦，与白墙拉开明度差） */
export const ROOF_COLORS = ['#5d6672', '#525b67', '#67707c', '#576069', '#616a76'];

/** 古城粉墙：石灰粉刷的暖白，色差压小，近看才分得出各家 */
export const CLASSIC_WALL_COLORS = ['#f2ecdf', '#ece5d6', '#e5dece', '#efe9dc', '#e8e1d2'];

/** 古城小青瓦：冷灰偏青，比现代屋面板更暗更闷 */
export const CLASSIC_ROOF_COLORS = ['#474f58', '#414951', '#4e565f', '#3d454d', '#4a525b'];

/** 城外现代立面：浅灰混凝土、暖白涂料、蓝灰金属板 */
export const MODERN_WALL_COLORS = [
  '#dcdee0', '#e4e5e6', '#cdd2d6', '#d5d9dc', '#c3c9cf', '#b8c0c7',
];

/** 现代平屋面 / 女儿墙压顶：中性灰，和粉墙形成时代差异 */
export const MODERN_ROOF_COLORS = ['#7c838a', '#878d93', '#727a80', '#90969b'];

/** 景点类型配色：园林绿、街区暖砖、地标金、现代青灰、寺观赭红 */
export const LANDMARK_TYPE_COLORS: Record<Landmark['type'], string> = {
  garden: '#5f9a52',
  district: '#c08a63',
  monument: '#c9a86a',
  modern: '#7f9bb3',
  temple: '#b0713d',
};
