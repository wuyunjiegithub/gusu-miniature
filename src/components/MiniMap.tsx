import { useEffect, useMemo, useRef, useState } from 'react';
import { LANDMARKS } from '../data/landmarks';
import { HERITAGE_LANDMARKS } from '../data/heritage';
import { sceneGeometry } from '../data/sceneGeometry';
import { LANDMARK_TYPE_COLORS } from '../constants/palette';
import { useSandTable } from '../store/useSandTable';
import { cameraPose } from '../utils/cameraPose';
import { filterLandmarks } from '../utils/filterLandmarks';
import { perfStats } from '../utils/perfStats';
import type { LocalPoint2 } from '../types';

/**
 * 2D 小地图：城轮廓 + 水系 + 景点点位 + 当前视点。
 * - 纯 SVG，无新依赖；坐标直接用世界米制，z 取反让北在上。
 * - 景点点位复用筛选态，与侧栏/3D 标签一致；点击复用 select() 触发相机飞行。
 * - "视点圈"由 rAF 直接改 SVG 属性，不写 store、不触发 React 重渲染。
 *
 * 提供"古城 / 全域"两档视图：全域覆盖 ±WORLD_LIMIT 以容纳寒山寺、虎丘塔。
 */
const SIZE = 200; // SVG 视口边长（px）
const WORLD_LIMIT = 5800;

type ViewMode = 'city' | 'world';

/** 生成 SVG <path> 的 d 属性（注意不是 points——points 只接受纯坐标对）。 */
const path = (pts: LocalPoint2[]) =>
  pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${-p[1]}`).join(' ') + ' Z';
const line = (pts: LocalPoint2[]) =>
  pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${-p[1]}`).join(' ');

const fmtMeters = (meters: number) =>
  Math.abs(meters) >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${meters.toFixed(0)} m`;

const getScale = (metersPerPixel: number) => {
  if (!(metersPerPixel > 0)) return { meters: 0, width: 80 };
  const raw = metersPerPixel * 80;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const factor = normalized >= 5 ? 5 : normalized >= 2 ? 2 : normalized >= 1 ? 1 : 0.5;
  const meters = factor * magnitude;
  return { meters, width: meters / metersPerPixel };
};

export function MiniMap() {
  const [mode, setMode] = useState<ViewMode>('city');
  const [collapsed, setCollapsed] = useState(false);
  const selectedId = useSandTable((state) => state.selectedId);
  const select = useSandTable((state) => state.select);
  const filters = useSandTable((state) => state.filters);
  const [stats, setStats] = useState({ fps: 0, calls: 0, triangles: 0 });
  const viewRef = useRef<SVGGElement>(null);
  const compassRef = useRef<HTMLDivElement>(null);
  const coordsRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<HTMLDivElement>(null);
  const scaleLabelRef = useRef<HTMLSpanElement>(null);

  const levelById = useMemo(
    () => new Map(HERITAGE_LANDMARKS.map((h) => [h.id, h.level])),
    [],
  );
  const visible = useMemo(
    () => filterLandmarks(LANDMARKS, filters, levelById),
    [filters, levelById],
  );

  // viewBox 由模式决定：古城贴合轮廓包围盒，全域固定到 ±WORLD_LIMIT。
  const viewBox = useMemo(() => {
    if (mode === 'world') return `${-WORLD_LIMIT} ${-WORLD_LIMIT} ${WORLD_LIMIT * 2} ${WORLD_LIMIT * 2}`;
    const ring = sceneGeometry.cityOutline;
    const xs = ring.map((p) => p[0]);
    const zs = ring.map((p) => p[1]);
    const minX = Math.min(...xs) - 180;
    const maxX = Math.max(...xs) + 180;
    const minZ = Math.min(...zs) - 180;
    const maxZ = Math.max(...zs) + 180;
    // 保持正方形视口，居中
    const span = Math.max(maxX - minX, maxZ - minZ);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    return `${cx - span / 2} ${-(cz + span / 2)} ${span} ${span}`;
  }, [mode]);

  // 视点指示器：rAF 直接改 transform，避免每帧 React 重渲染。
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const g = viewRef.current;
      if (g) {
        const r = Math.max(60, Math.min(700, cameraPose.distance * 0.12));
        g.setAttribute('transform', `translate(${cameraPose.x} ${-cameraPose.z})`);
        const ring = g.querySelector('circle');
        if (ring) ring.setAttribute('r', String(r));
      }
      if (compassRef.current) compassRef.current.style.transform = `rotate(${-cameraPose.heading}deg)`;
      if (coordsRef.current) coordsRef.current.textContent = `E ${fmtMeters(cameraPose.x)} · N ${fmtMeters(-cameraPose.z)}`;
      const scale = getScale(cameraPose.metersPerPixel);
      if (scaleRef.current) scaleRef.current.style.width = `${scale.width}px`;
      if (scaleLabelRef.current) scaleLabelRef.current.textContent = fmtMeters(scale.meters);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStats({ fps: perfStats.fps, calls: perfStats.drawCalls, triangles: perfStats.triangles });
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  if (collapsed) {
    return (
      <button
        type="button"
        className="minimap minimap-collapsed"
        onClick={() => setCollapsed(false)}
        title="展开小地图"
        aria-label="展开小地图"
      >
        ◫
      </button>
    );
  }

  return (
    <div className="minimap">
      <div className="minimap-bar">
        <strong>古城导览</strong>
        <div className="minimap-actions">
          <button
            type="button"
            className={mode === 'city' ? 'on' : ''}
            onClick={() => setMode('city')}
            title="古城视图"
          >
            古城
          </button>
          <button
            type="button"
            className={mode === 'world' ? 'on' : ''}
            onClick={() => setMode('world')}
            title="全域视图"
          >
            全域
          </button>
          <button type="button" onClick={() => setCollapsed(true)} title="收起小地图">
            ×
          </button>
        </div>
      </div>
      <svg
        className="minimap-svg"
        viewBox={viewBox}
        width={SIZE}
        height={SIZE}
        role="img"
        aria-label="古城小地图"
      >
        <rect
          x={mode === 'world' ? -WORLD_LIMIT : viewBox.split(' ')[0]}
          width={mode === 'world' ? WORLD_LIMIT * 2 : Number(viewBox.split(' ')[2])}
          height={mode === 'world' ? WORLD_LIMIT * 2 : Number(viewBox.split(' ')[3])}
          y={mode === 'world' ? -WORLD_LIMIT : Number(viewBox.split(' ')[1])}
          fill="#0c1420"
        />
        {/* 城外水系（山塘河等） */}
        {(sceneGeometry.outerWaterways ?? []).map((linePts, i) => (
          <path
            key={`ow-${i}`}
            d={line(linePts)}
            fill="none"
            stroke="#2f5a73"
            strokeWidth={mode === 'world' ? 55 : 26}
            strokeLinecap="round"
          />
        ))}
        {/* 城内水系 */}
        {sceneGeometry.waterways.map((linePts, i) => (
          <path
            key={`w-${i}`}
            d={line(linePts)}
            fill="none"
            stroke="#3d7c9c"
            strokeWidth={mode === 'world' ? 30 : 16}
            strokeLinecap="round"
          />
        ))}
        {/* 城轮廓 */}
        <path
          d={path(sceneGeometry.cityOutline)}
          fill="rgba(201,168,106,0.07)"
          stroke="#c9a86a"
          strokeWidth={mode === 'world' ? 28 : 12}
          strokeLinejoin="round"
        />
        {/* 景点标记 */}
        {visible.map((lm) => {
          const geo = sceneGeometry.landmarks[lm.id];
          if (!geo) return null;
          const r = lm.priority === 'P0' ? (mode === 'world' ? 90 : 38) : mode === 'world' ? 55 : 24;
          const active = selectedId === lm.id;
          return (
            <circle
              key={lm.id}
              cx={geo.centroid.x}
              cy={-geo.centroid.z}
              r={active ? r * 1.7 : r}
              fill={LANDMARK_TYPE_COLORS[lm.type]}
              stroke={active ? '#fff' : 'rgba(255,255,255,0.35)'}
              strokeWidth={active ? (mode === 'world' ? 26 : 10) : mode === 'world' ? 10 : 4}
              className="minimap-marker"
              onClick={() => select(lm.id)}
            >
              <title>{lm.name}</title>
            </circle>
          );
        })}
        {/* 当前视点（rAF 更新 transform） */}
        <g ref={viewRef} className="minimap-view">
          <circle r={120} fill="rgba(232,230,224,0.06)" stroke="#e8e6e0" strokeWidth={6} />
          <circle r={16} fill="#e8e6e0" />
        </g>
      </svg>
      <div className="minimap-legend">
        <span><i style={{ background: '#c9a86a' }} />古城</span>
        <span><i style={{ background: '#3d7c9c' }} />水系</span>
        <span>点击光点聚焦</span>
      </div>
      <div className="minimap-info">
        <div className="hud-location">
          <div className="hud-compass" aria-label="指南针">
            <div ref={compassRef} className="hud-compass-dial">
              <span className="north">N</span><span className="east">E</span>
              <span className="south">S</span><span className="west">W</span><i />
            </div>
            <b />
          </div>
          <div className="hud-position">
            <div ref={coordsRef}>E 0 m · N 0 m</div>
            <div className="hud-scale-wrap">
              <span ref={scaleLabelRef}>0 m</span>
              <div ref={scaleRef} className="hud-scale" />
            </div>
          </div>
        </div>
        <div className="minimap-perf">{stats.fps} FPS · {stats.calls} draw calls · {(stats.triangles / 1000).toFixed(0)}k tris</div>
        <div className="hud-keys">左键旋转 · 右键平移 · 滚轮缩放<br />H 收放菜单 · 点击景点聚焦</div>
      </div>
    </div>
  );
}
