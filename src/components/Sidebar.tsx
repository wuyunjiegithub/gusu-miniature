import { useEffect, useMemo, useState } from 'react';
import { LANDMARK_TYPE_LABEL, LANDMARKS } from '../data/landmarks';
import { HERITAGE_LANDMARKS, HERITAGE_LEVEL_LABEL } from '../data/heritage';
import { LANDMARK_TYPE_COLORS } from '../constants/palette';
import { useSandTable } from '../store/useSandTable';
import { filterLandmarks, hasActiveFilters } from '../utils/filterLandmarks';
import type { Landmark, LandmarkType } from '../types';

const TYPE_ORDER: LandmarkType[] = ['garden', 'district', 'monument', 'modern', 'temple'];

const CATEGORY_ORDER = [
  'classical-garden',
  'historic-district',
  'tower-gate',
  'temple-shrine',
  'culture-celebrity',
  'modern-architecture',
] as const;

type LandmarkCategory = (typeof CATEGORY_ORDER)[number];

const CATEGORY_LABEL: Record<LandmarkCategory, string> = {
  'classical-garden': '古典园林',
  'historic-district': '历史街区',
  'tower-gate': '古塔城门',
  'temple-shrine': '寺庙祠观',
  'culture-celebrity': '文博名人',
  'modern-architecture': '近现代建筑',
};

const HERITAGE_LEVEL = new Map(HERITAGE_LANDMARKS.map((h) => [h.id, h.level]));
const HERITAGE_KIND = new Map(HERITAGE_LANDMARKS.map((h) => [h.id, h.kind]));
const TOWER_GATE_IDS = new Set(['panmen', 'shuangta', 'beisita', 'huqiuta']);
const CULTURE_IDS = new Set(['suzhou-museum', 'tangyinci']);

function getCategory(landmark: Landmark): LandmarkCategory {
  const kind = HERITAGE_KIND.get(landmark.id);
  if (kind === 'garden') return 'classical-garden';
  if (kind === 'pagoda' || kind === 'gate') return 'tower-gate';
  if (kind === 'temple') return 'temple-shrine';
  if (kind === 'mansion' || kind === 'stele') return 'culture-celebrity';
  if (kind === 'school') return 'modern-architecture';
  if (TOWER_GATE_IDS.has(landmark.id)) return 'tower-gate';
  if (CULTURE_IDS.has(landmark.id)) return 'culture-celebrity';
  if (landmark.type === 'garden') return 'classical-garden';
  if (landmark.type === 'district') return 'historic-district';
  if (landmark.type === 'temple') return 'temple-shrine';
  if (landmark.type === 'modern') return 'modern-architecture';
  return 'culture-celebrity';
}

/**
 * 左侧菜单：按游览属性分组列出景点，支持搜索与多维筛选（名称/类型/文保等级/世遗）。
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
          {CATEGORY_ORDER.map((category) => {
            const group = visible.filter((item) => getCategory(item) === category);
            if (group.length === 0) return null;
            return (
              <section key={category} className="sidebar-group">
                <h2 className="sidebar-group-title">
                  {CATEGORY_LABEL[category]}
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
                <span>{CATEGORY_LABEL[getCategory(selected)]}</span>
                <span>{LANDMARK_TYPE_LABEL[selected.type]}</span>
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
