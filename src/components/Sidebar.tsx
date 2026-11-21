import { useEffect, useMemo, useState } from 'react';
import { LANDMARK_TYPE_LABEL, LANDMARKS } from '../data/landmarks';
import { HERITAGE_LANDMARKS, HERITAGE_LEVEL_LABEL } from '../data/heritage';
import { LANDMARK_TYPE_COLORS } from '../constants/palette';
import { useSandTable } from '../store/useSandTable';
import { filterLandmarks, hasActiveFilters } from '../utils/filterLandmarks';
import type { LandmarkPriority, LandmarkType } from '../types';

const PRIORITY_LABEL: Record<LandmarkPriority, string> = {
  P0: '核心景点',
  P1: '重点景点',
  P2: '延伸景点',
  P3: '文保单位',
};

const PRIORITY_ORDER: LandmarkPriority[] = ['P0', 'P1', 'P2', 'P3'];

const TYPE_ORDER: LandmarkType[] = ['garden', 'district', 'monument', 'modern', 'temple'];

/** 文保 id → 保护级别，用于列表小标签与"国保/省保"筛选 */
const HERITAGE_LEVEL = new Map(HERITAGE_LANDMARKS.map((h) => [h.id, h.level]));

/**
 * 左侧菜单：按优先级分组列出景点，支持搜索与多维筛选（名称/类型/优先级/文保等级/世遗）。
 * 点击条目选中景点 → 相机聚焦（FR-09）；列表、3D 标签、小地图共享同一筛选态。
 *
 * 收放：按 H 键或点右上角的按钮。H 键在输入框聚焦时不触发（见下方守卫）。
 */
export function Sidebar() {
  const selectedId = useSandTable((state) => state.selectedId);
  const lod = useSandTable((state) => state.lod);
  const select = useSandTable((state) => state.select);
  const filters = useSandTable((state) => state.filters);
  const setFilter = useSandTable((state) => state.setFilter);
  const resetFilters = useSandTable((state) => state.resetFilters);
  const [open, setOpen] = useState(true);
  const [showFilters, setShowFilters] = useState(false);

  // 筛选列表一次算出，三处（列表/标签/小地图）各自消费同一份 store 条件
  const visible = useMemo(
    () => filterLandmarks(LANDMARKS, filters, HERITAGE_LEVEL),
    [filters],
  );
  const active = hasActiveFilters(filters);
  const selected = LANDMARKS.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      if (event.key === 'h' || event.key === 'H') {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <aside className={`sidebar${open ? '' : ' is-collapsed'}`} aria-hidden={!open}>
        <header className="sidebar-header">
          <div className="sidebar-title">
            <h1>姑苏古城数字沙盘</h1>
            <span className="sidebar-lod">视角层级 {lod}</span>
          </div>
          <button
            type="button"
            className="sidebar-collapse"
            onClick={() => setOpen(false)}
            title="隐藏菜单（H）"
            aria-label="隐藏菜单"
          >
            ‹
          </button>
        </header>

        {/* 搜索框：名称/描述实时匹配 */}
        <div className="sidebar-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={filters.query}
            onChange={(e) => setFilter('query', e.target.value)}
            placeholder="搜索景点、园林、文保…"
            aria-label="搜索景点"
          />
          {filters.query && (
            <button type="button" onClick={() => setFilter('query', '')} aria-label="清除搜索">
              ×
            </button>
          )}
        </div>

        {/* 筛选器：默认折叠，避免占满列表 */}
        <div className="sidebar-filter-toggle">
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
          >
            {showFilters ? '▴ 收起筛选' : '▾ 筛选'}
            {active && <span className="filter-badge">生效中</span>}
          </button>
          {active && (
            <button type="button" className="filter-reset" onClick={resetFilters}>
              清除
            </button>
          )}
        </div>
        {showFilters && (
          <div className="sidebar-filters">
            <div className="filter-row">
              <span className="filter-label">类型</span>
              <div className="filter-chips">
                <button
                  type="button"
                  className={filters.type === null ? 'on' : ''}
                  onClick={() => setFilter('type', null)}
                >
                  全部
                </button>
                {TYPE_ORDER.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={filters.type === t ? 'on' : ''}
                    onClick={() => setFilter('type', filters.type === t ? null : t)}
                  >
                    {LANDMARK_TYPE_LABEL[t]}
                  </button>
                ))}
              </div>
            </div>
            <div className="filter-row">
              <span className="filter-label">级别</span>
              <div className="filter-chips">
                <button
                  type="button"
                  className={filters.priority === null ? 'on' : ''}
                  onClick={() => setFilter('priority', null)}
                >
                  全部
                </button>
                {PRIORITY_ORDER.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={filters.priority === p ? 'on' : ''}
                    onClick={() => setFilter('priority', filters.priority === p ? null : p)}
                  >
                    {PRIORITY_LABEL[p]}
                  </button>
                ))}
              </div>
            </div>
            <div className="filter-row">
              <span className="filter-label">文保</span>
              <div className="filter-chips">
                {([null, 'national', 'provincial'] as const).map((lv) => (
                  <button
                    key={lv ?? 'all'}
                    type="button"
                    className={filters.heritageLevel === lv ? 'on' : ''}
                    onClick={() => setFilter('heritageLevel', lv)}
                  >
                    {lv === null ? '不限' : HERITAGE_LEVEL_LABEL[lv]}
                  </button>
                ))}
                <button
                  type="button"
                  className={filters.worldHeritageOnly ? 'on' : ''}
                  onClick={() => setFilter('worldHeritageOnly', !filters.worldHeritageOnly)}
                >
                  仅世遗
                </button>
              </div>
            </div>
          </div>
        )}

        <nav className="sidebar-nav">
          {PRIORITY_ORDER.map((priority) => {
            const group = visible.filter((item) => item.priority === priority);
            if (group.length === 0) return null;
            return (
              <section key={priority} className="sidebar-group">
                <h2 className="sidebar-group-title">
                  {PRIORITY_LABEL[priority]}
                  <span className="group-count">{group.length}</span>
                </h2>
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
                          {HERITAGE_LEVEL.has(landmark.id) && (
                            <em>{HERITAGE_LEVEL_LABEL[HERITAGE_LEVEL.get(landmark.id)!]}</em>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {visible.length === 0 && (
            <p className="sidebar-empty">没有匹配的景点，试试清除筛选。</p>
          )}
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

      {!open && (
        <button
          type="button"
          className="sidebar-expand"
          onClick={() => setOpen(true)}
          title="显示菜单（H）"
          aria-label="显示菜单"
        >
          ☰<span>景点</span>
        </button>
      )}
    </>
  );
}
