import { LANDMARK_TYPE_LABEL, LANDMARKS } from '../data/landmarks';
import { LANDMARK_TYPE_COLORS } from '../constants/palette';
import { useSandTable } from '../store/useSandTable';
import type { LandmarkPriority } from '../types';

const PRIORITY_LABEL: Record<LandmarkPriority, string> = {
  P0: '核心景点',
  P1: '重点景点',
  P2: '延伸景点',
};

const PRIORITY_ORDER: LandmarkPriority[] = ['P0', 'P1', 'P2'];

/**
 * 左侧菜单：按优先级分组列出主要景点（数据顺序即优先级顺序，见 FR-05）。
 * 点击条目选中景点 → 相机聚焦（FR-09）；条目高亮与场景中的选中态同源。
 */
export function Sidebar() {
  const selectedId = useSandTable((state) => state.selectedId);
  const lod = useSandTable((state) => state.lod);
  const select = useSandTable((state) => state.select);

  const selected = LANDMARKS.find((item) => item.id === selectedId) ?? null;

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <h1>姑苏古城数字沙盘</h1>
        <span className="sidebar-lod">视角层级 {lod}</span>
      </header>

      <nav className="sidebar-nav">
        {PRIORITY_ORDER.map((priority) => {
          const group = LANDMARKS.filter((item) => item.priority === priority);
          if (group.length === 0) return null;
          return (
            <section key={priority} className="sidebar-group">
              <h2 className="sidebar-group-title">{PRIORITY_LABEL[priority]}</h2>
              <ul>
                {group.map((landmark) => (
                  <li key={landmark.id}>
                    <button
                      type="button"
                      className={`sidebar-item${selectedId === landmark.id ? ' is-active' : ''}`}
                      onClick={() => select(landmark.id)}
                    >
                      <span className="sidebar-item-name">{landmark.name}</span>
                      <span className="sidebar-item-meta">
                        <i
                          className="sidebar-type-dot"
                          style={{ background: LANDMARK_TYPE_COLORS[landmark.type] }}
                        />
                        {LANDMARK_TYPE_LABEL[landmark.type]}
                        {landmark.worldHeritage && <em>世遗</em>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </nav>

      <footer className="sidebar-footer">
        {selected ? (
          <div className="sidebar-detail">
            <h3>{selected.name}</h3>
            <p className="sidebar-tags">
              <span>{LANDMARK_TYPE_LABEL[selected.type]}</span>
              <span>{selected.priority}</span>
              {selected.worldHeritage && <span>世界遗产</span>}
            </p>
            <p className="sidebar-desc">{selected.description}</p>
            <button type="button" onClick={() => select(null)}>
              返回全景
            </button>
          </div>
        ) : (
          <p className="sidebar-tip">点击景点名称即可聚焦沙盘中的对应位置</p>
        )}
      </footer>
    </aside>
  );
}
