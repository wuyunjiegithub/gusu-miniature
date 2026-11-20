import { useEffect, useState } from 'react';
import { useProgress } from '@react-three/drei';
import { perfStats } from '../utils/perfStats';
import { useSandTable, type TimeOfDay } from '../store/useSandTable';
import { SEASON_LOOKS, SEASON_ORDER } from '../constants/seasons';

const TIME_OPTIONS: { value: TimeOfDay; label: string }[] = [
  { value: 'day', label: '白天' },
  { value: 'night', label: '夜晚' },
];

/**
 * 视口覆盖层：加载进度、昼夜/四季切换、操作提示、渲染性能（M1 验收口径）。
 * 景点菜单与详情在左侧 Sidebar。
 */
export function HUD() {
  const { progress, active } = useProgress();
  const [stats, setStats] = useState({ fps: 0, calls: 0, triangles: 0 });
  const time = useSandTable((state) => state.time);
  const season = useSandTable((state) => state.season);
  const setTime = useSandTable((state) => state.setTime);
  const setSeason = useSandTable((state) => state.setSeason);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStats({ fps: perfStats.fps, calls: perfStats.drawCalls, triangles: perfStats.triangles });
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

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

      <div className="hud-perf">
        {stats.fps} FPS · {stats.calls} draw calls ·{' '}
        {(stats.triangles / 1000).toFixed(0)}k tris
      </div>
    </div>
  );
}
