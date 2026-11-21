import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useSandTable, type Season, type TimeOfDay } from './store/useSandTable';
import './styles.css';

/**
 * 环境预设（仅开发环境）：`?time=night&season=winter`。
 * 夜景、冬天这类整屏观感的改动必须能截到图核对，靠手点按钮没法自动化复核。
 */
if (import.meta.env.DEV) {
  const params = new URLSearchParams(window.location.search);
  const time = params.get('time');
  if (time === 'day' || time === 'night') {
    useSandTable.getState().setTime(time as TimeOfDay);
  }
  const season = params.get('season');
  if (season === 'spring' || season === 'summer' || season === 'autumn' || season === 'winter') {
    useSandTable.getState().setSeason(season as Season);
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
