import { useEffect, useState } from 'react';
import { useProgress } from '@react-three/drei';
import { perfStats } from '../utils/perfStats';
import { useSandTable, type TimeOfDay } from '../store/useSandTable';
import { SEASON_LOOKS, SEASON_ORDER } from '../constants/seasons';
import { CITY_TOUR, TOUR_TOTAL_MS, TOUR_FRAME_COUNT } from '../data/tourRoutes';

const TIME_OPTIONS: { value: TimeOfDay; label: string }[] = [
  { value: 'day', label: '白天' },
  { value: 'night', label: '夜晚' },
];

const SPEEDS = [0.5, 1, 2];

const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * 视口覆盖层：加载进度、昼夜/四季切换、整体漫游控制条、操作提示、渲染性能。
 * 景点菜单与详情在左侧 Sidebar。
 */
export function HUD() {
  const { progress, active } = useProgress();
  const [stats, setStats] = useState({ fps: 0, calls: 0, triangles: 0 });
  const time = useSandTable((state) => state.time);
  const season = useSandTable((state) => state.season);
  const setTime = useSandTable((state) => state.setTime);
  const setSeason = useSandTable((state) => state.setSeason);
  const tour = useSandTable((state) => state.tour);
  const startTour = useSandTable((state) => state.startTour);
  const togglePause = useSandTable((state) => state.togglePause);
  const exitTour = useSandTable((state) => state.exitTour);
  const setTourSpeed = useSandTable((state) => state.setTourSpeed);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStats({ fps: perfStats.fps, calls: perfStats.drawCalls, triangles: perfStats.triangles });
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  // 漫游快捷键：T 开始、空格暂停/继续、Esc 退出（与 Sidebar 的 H 键守卫一致）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      const { tour: current } = useSandTable.getState();
      if (event.key === 't' || event.key === 'T') {
        event.preventDefault();
        if (!current.active) startTour(current.speed);
      } else if (event.code === 'Space' && current.active) {
        event.preventDefault();
        togglePause();
      } else if (event.key === 'Escape' && current.active) {
        event.preventDefault();
        exitTour();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [startTour, togglePause, exitTour]);

  const frame = CITY_TOUR.keyframes[tour.index];
  const shotLabel = frame?.label ?? '收束';
  const elapsedMs = tour.progress * TOUR_TOTAL_MS;

  return (
    <div className="hud">
      {active && <div className="hud-progress">正在加载资产… {progress.toFixed(0)}%</div>}

      <div className="hud-env">
        <div className="hud-seg">
          {TIME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={time === option.value ? 'on' : undefined}
              onClick={() => setTime(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="hud-seg">
          {SEASON_ORDER.map((value) => (
            <button
              key={value}
              type="button"
              className={season === value ? 'on' : undefined}
              onClick={() => setSeason(value)}
            >
              {SEASON_LOOKS[value].label}
            </button>
          ))}
        </div>
      </div>

      {/* 整体漫游控制条：底部居中，常驻（不受 H 收放影响） */}
      <div className={`hud-tour${tour.active ? ' is-active' : ''}`}>
        {!tour.active ? (
          <button type="button" className="tour-start" onClick={() => startTour(tour.speed)}>
            ▶ 整体漫游 <span className="tour-hint">{fmtTime(TOUR_TOTAL_MS)} · 电影运镜</span>
          </button>
        ) : (
          <>
            <div className="tour-head">
              <span className="tour-badge">漫游中</span>
              <span className="tour-stop">{String(Math.min(tour.index + 1, TOUR_FRAME_COUNT)).padStart(2, '0')}/{TOUR_FRAME_COUNT} · {shotLabel}</span>
              <span className="tour-clock">{fmtTime(elapsedMs)} / {fmtTime(TOUR_TOTAL_MS)}</span>
            </div>
            <div className="tour-progress"><div className="tour-progress-fill" style={{ width: `${tour.progress * 100}%` }} /></div>
            <div className="tour-controls">
              <button type="button" onClick={togglePause}>{tour.paused ? '▶ 继续' : '❚❚ 暂停'}</button>
              <div className="tour-speed">
                {SPEEDS.map((s) => (
                  <button key={s} type="button" className={tour.speed === s ? 'on' : undefined} onClick={() => setTourSpeed(s)}>{s}×</button>
                ))}
              </div>
              <button type="button" className="tour-exit" onClick={exitTour}>✕ 退出</button>
            </div>
          </>
        )}
      </div>

      <div className="hud-perf">
        {stats.fps} FPS · {stats.calls} draw calls ·{' '}
        {(stats.triangles / 1000).toFixed(0)}k tris
        <span className="hud-keys">左键旋转 · 右键平移 · 滚轮缩放 · H 收放菜单 · T 漫游 · 空格暂停 · Esc 退出</span>
      </div>
    </div>
  );
}
