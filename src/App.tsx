import { Scene } from './components/Scene';
import { Sidebar } from './components/Sidebar';
import { HUD } from './components/HUD';

export default function App() {
  return (
    <div className="app">
      <Sidebar />
      <main className="viewport">
        <Scene />
        <HUD />
      </main>
    </div>
  );
}
