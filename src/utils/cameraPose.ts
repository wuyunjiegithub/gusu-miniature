/**
 * 相机位姿共享（小地图用）。
 *
 * 小地图需要在 Canvas 外的 DOM 层画一个"当前视点"指示器，若每帧写 zustand
 * 会触发 React 重渲染。这里用一个可变对象由 Canvas 内每帧写入、小地图用
 * rAF 读取并直接改 SVG 属性（不触发 React 更新），与 perfStats 同范式。
 *
 * 坐标为场景局部米制 [x, z]，+x=东，-z=北。
 */
export const cameraPose = {
  x: 0,
  y: 0,
  z: 0,
  /** 相机到注视点的三维距离（米） */
  distance: 0,
  /** 水平朝向：正北为 0°，顺时针递增 */
  heading: 0,
  /** 注视点深度处每个 CSS 像素对应的米数 */
  metersPerPixel: 0,
};
