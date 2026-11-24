import { useProgress } from '@react-three/drei';
import { useSandTable, type TimeOfDay } from '../store/useSandTable';
import { SEASON_LOOKS, SEASON_ORDER } from '../constants/seasons';

const TIME_OPTIONS: { value: TimeOfDay; label: string }[] = [
  { value: 'day', label: '白天' },
  { value: 'night', label: '夜晚' },
];

/**
 * 视口覆盖层：加载进度、昼夜/四季切换、操作提示、渲染性能。
 * 景点菜单与详情在左侧 Sidebar。
 */
export function HUD() {
  const { progress, active } = useProgress();
  const time = useSandTable((state) => state.time);
  const season = useSandTable((state) => state.season);
  const setTime = useSandTable((state) => state.setTime);
  const setSeason = useSandTable((state) => state.setSeason);

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

      <button
        type="button"
        className="hud-export"
        title="预览并导出 60 秒 MP4（R）"
        onClick={() => window.dispatchEvent(new Event('preview:export'))}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <rect x="1" y="3.2" width="9.6" height="9.6" rx="1.4" />
          <path d="M11.4 7.2 15 4.6v6.8l-3.6-2.6z" />
        </svg>
        导出 MP4
      </button>
    </div>
  );
}
