import { Scene } from './components/Scene';
import { Sidebar } from './components/Sidebar';
import { HUD } from './components/HUD';
import { MiniMap } from './components/MiniMap';
import { PreviewOverlay } from './components/PreviewOverlay';
import { useSandTable } from './store/useSandTable';

export default function App() {
  const previewActive = useSandTable((state) => state.previewActive);

  return (
    <div className="app">
      {!previewActive && <Sidebar />}
      <main className={`viewport${previewActive ? ' is-preview' : ''}`}>
        <Scene />
        {!previewActive && <HUD />}
        {!previewActive && <MiniMap />}
        <PreviewOverlay />
      </main>
    </div>
  );
}
