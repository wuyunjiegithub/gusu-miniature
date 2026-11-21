import { describe, it, expect } from 'vitest';
import { HERITAGE_LANDMARKS, type HeritageKind } from '../src/data/heritage';
import {
  HERITAGE_MODELS,
  getHeritageModelSpec,
  idSeed,
  makeRng,
  type HeritageArchetype,
} from '../src/data/heritageModels';

describe('文保精细建模规格完整性', () => {
  const VALID: HeritageArchetype[] = [
    'garden',
    'temple',
    'residence',
    'pagoda',
    'gate',
    'rock',
    'academy',
  ];

  it('31 处文保都有专属建模规格', () => {
    expect(HERITAGE_LANDMARKS.length).toBe(31);
    for (const h of HERITAGE_LANDMARKS) {
      expect(HERITAGE_MODELS[h.id], `缺少规格: ${h.id}`).toBeDefined();
    }
    expect(Object.keys(HERITAGE_MODELS).length).toBe(HERITAGE_LANDMARKS.length);
  });

  it('每处规格的建筑原型合法、朝向与占地合理', () => {
    for (const [id, spec] of Object.entries(HERITAGE_MODELS)) {
      expect(VALID, `非法原型: ${id}`).toContain(spec.archetype);
      expect(Number.isFinite(spec.rot), `朝向非法: ${id}`).toBe(true);
      expect(Math.abs(spec.rot) <= Math.PI, `朝向过大: ${id}`).toBe(true);
      expect(spec.radius, `占地缺失: ${id}`).toBeGreaterThan(0);
      expect(spec.radius!, `占地过大: ${id}`).toBeLessThanOrEqual(24);
    }
  });

  it('园林占多数且都带水面/亭/厅，符合拙政园式读图', () => {
    const gardens = Object.values(HERITAGE_MODELS).filter((s) => s.archetype === 'garden');
    expect(gardens.length).toBeGreaterThanOrEqual(8);
    for (const g of gardens) {
      expect(g.halls, '园林应有厅堂').toBeGreaterThanOrEqual(1);
      expect(g.pavilions, '园林应有亭').toBeGreaterThanOrEqual(1);
    }
    // 至少一处以假山为主景（环秀山庄）
    expect(gardens.some((g) => g.rockery === 2)).toBe(true);
  });

  it('七种建筑原型全部覆盖', () => {
    const kinds = new Set(Object.values(HERITAGE_MODELS).map((s) => s.archetype));
    for (const k of VALID) expect(kinds, `未使用原型: ${k}`).toContain(k);
  });

  it('特色构件都落到具体文保', () => {
    const all = Object.values(HERITAGE_MODELS);
    expect(all.some((s) => s.paifang)).toBe(true); // 牌坊
    expect(all.some((s) => s.operaStage)).toBe(true); // 戏台（全晋会馆）
    expect(all.some((s) => s.bellTower)).toBe(true); // 钟楼（东吴大学）
    expect(all.some((s) => s.brickHall)).toBe(true); // 无梁殿（开元寺）
    expect(all.some((s) => s.stele)).toBe(true); // 碑刻（张士诚纪功碑）
    expect(all.some((s) => s.archetype === 'pagoda')).toBe(true); // 砖塔
  });

  it('建筑朝向有微差，同类不雷同', () => {
    const rots = Object.values(HERITAGE_MODELS).map((s) => s.rot);
    expect(new Set(rots).size).toBeGreaterThan(20);
  });
});

describe('建模规格兜底', () => {
  it('未知 id 按类别推断原型，不会退化为空', () => {
    const cases: Array<[string, HeritageKind, HeritageArchetype]> = [
      ['x-garden', 'garden', 'garden'],
      ['x-temple', 'temple', 'temple'],
      ['x-pagoda', 'pagoda', 'pagoda'],
      ['x-gate', 'gate', 'gate'],
      ['x-mansion', 'mansion', 'residence'],
      ['x-stele', 'stele', 'rock'],
      ['x-school', 'school', 'academy'],
    ];
    for (const [id, kind, archetype] of cases) {
      expect(getHeritageModelSpec(id, kind).archetype).toBe(archetype);
    }
  });
});

describe('确定性随机种子', () => {
  it('同一 id 种子一致、不同 id 种子不同', () => {
    expect(idSeed('ouyuan')).toBe(idSeed('ouyuan'));
    expect(idSeed('ouyuan')).not.toBe(idSeed('yiyuan'));
  });

  it('同种子产生一致序列，序列落在 [0,1)', () => {
    const a = makeRng(idSeed('huanxiushanzhuang'));
    const b = makeRng(idSeed('huanxiushanzhuang'));
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
