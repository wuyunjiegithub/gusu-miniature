import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type GateMod = typeof import('../scripts/lib/qa-gate.mjs');

describe('qa-gate 数据门禁', () => {
  const originalExitCode = process.exitCode;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules(); // 每个用例重新加载，隔离模块级 checks 数组
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('gate 的 min/max/expect 判定正确', async () => {
    const { gate } = (await import('../scripts/lib/qa-gate.mjs')) as GateMod;
    expect(gate('>=下限', 10, { min: 5 })).toBe(true);
    expect(gate('<下限', 3, { min: 5 })).toBe(false);
    expect(gate('<=上限', 3, { max: 5 })).toBe(true);
    expect(gate('>上限', 8, { max: 5 })).toBe(false);
    expect(gate('等于', 5, { expect: 5 })).toBe(true);
    expect(gate('不等于', 6, { expect: 5 })).toBe(false);
  });

  it('report 全通过时返回 true 且不改 exitCode', async () => {
    const { gate, report } = (await import('../scripts/lib/qa-gate.mjs')) as GateMod;
    gate('a', 10, { min: 5 });
    gate('b', 1, { expect: 1 });
    expect(report('ok-script')).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('report 有失败时返回 false 并置 exitCode=1', async () => {
    const { gate, report } = (await import('../scripts/lib/qa-gate.mjs')) as GateMod;
    gate('好数据', 3, { max: 5 });
    gate('坏数据', 999, { max: 5, note: '测试数据' });
    expect(report('fail-script')).toBe(false);
    expect(process.exitCode).toBe(1);
    const combined = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(combined).toContain('1/2');
  });

  it('report 打印 FAIL 明细', async () => {
    const { gate, report } = (await import('../scripts/lib/qa-gate.mjs')) as GateMod;
    gate('桥位总数', 2, { min: 10 });
    report('qa-bridges');
    const lines = logSpy.mock.calls.flat().map(String).join('\n');
    expect(lines).toContain('[FAIL] 桥位总数=2');
    expect(lines).toContain('下限 10');
  });
});
