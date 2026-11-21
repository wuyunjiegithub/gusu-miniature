import { Scene } from './components/Scene';
import { Sidebar } from './components/Sidebar';
import { HUD } from './components/HUD';
import { MiniMap } from './components/MiniMap';

export default function App() {
  return (
    <div className="app">
      <Sidebar />
      <main className="viewport">
        <Scene />
        <HUD />
        <MiniMap />
      </main>
    </div>
  );
}
