/**
 * 数据 QA 门禁：把"只打印"的校验脚本升级为"数据坏了就报红"的构建门禁。
 *
 * 设计原则：只对灾难性退化报红，不对已知可接受瑕疵误判。
 *   - 基线里本就存在的瑕疵（断头路、压路、panmen 单处重叠）不设硬门禁，只记录。
 *   - 真正代表"数据损坏"的指标（文件缺失、规模骤降、算法不等价、桥位消失、
 *     建筑大规模入水）才设阈值。
 *
 * 用法：
 *   import { gate, report } from './lib/qa-gate.mjs';
 *   gate('桥位总数', sites.length, { min: 10 });
 *   report('qa-bridges'); // 末尾调用，任一 gate 失败则 process.exitCode = 1
 */

const checks = [];

/**
 * 登记一项门禁断言。
 * @param {string} name 指标名
 * @param {number} value 实测值
 * @param {{min?: number, max?: number, expect?: number, note?: string}} rule 阈值
 */
export function gate(name, value, rule = {}) {
  const { min, max, expect, note } = rule;
  let ok = true;
  const violations = [];
  if (min !== undefined && value < min) {
    ok = false;
    violations.push(`${value} < 下限 ${min}`);
  }
  if (max !== undefined && value > max) {
    ok = false;
    violations.push(`${value} > 上限 ${max}`);
  }
  if (expect !== undefined && value !== expect) {
    ok = false;
    violations.push(`${value} ≠ 期望 ${expect}`);
  }
  checks.push({ name, value, ok, violations, note });
  return ok;
}

/**
 * 汇总所有门禁项，设置 process.exitCode，并打印可读报告。
 * @param {string} script 脚本名（用于报告标题）
 */
export function report(script = 'qa') {
  const failed = checks.filter((c) => !c.ok);
  const line = '[QA-GATE]';
  console.log(`\n${line} ${script}: ${checks.length - failed.length}/${checks.length} 项通过`);
  for (const c of checks) {
    const tag = c.ok ? 'PASS' : 'FAIL';
    const detail = c.violations.length ? ` (${c.violations.join('; ')})` : '';
    const note = c.note ? ` — ${c.note}` : '';
    console.log(`${line} [${tag}] ${c.name}=${c.value}${detail}${note}`);
  }
  if (failed.length) {
    console.error(`${line} ❌ ${script} 有 ${failed.length} 项门禁未通过，数据视为损坏。`);
    process.exitCode = 1;
  } else {
    console.log(`${line} ✅ ${script} 数据门禁全部通过。`);
  }
  return failed.length === 0;
}
