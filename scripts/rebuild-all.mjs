/**
 * 数据管线统一编排入口
 * ============================================================
 * 把分散的 fetch-* / build-* / qa-* 脚本按依赖顺序串成一条可重复的构建流水线，
 * 这是"从零复现"的可执行契约（此前各脚本只靠末尾 console 提示串接，无契约）。
 *
 * 用法:
 *   node scripts/rebuild-all.mjs                 # 全流程 = fetch + build + qa
 *   node scripts/rebuild-all.mjs fetch           # 只抓取 OSM 原始数据
 *   node scripts/rebuild-all.mjs build           # 只加工（需已有 data/raw）
 *   node scripts/rebuild-all.mjs qa              # 只跑数据门禁（需已有生成物）
 *   node scripts/rebuild-all.mjs all             # 同默认
 *   node scripts/rebuild-all.mjs build --dry-run # 只打印将要执行的命令，不执行
 *   node scripts/rebuild-all.mjs build --keep-going # 某步失败时不中断后续步骤
 *
 * 退出码：任一步失败（非 keep-going）→ 1；全部成功 → 0。
 * 每步计时并在结尾打印汇总，便于定位瓶颈。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

const args = process.argv.slice(2);
const STAGE = args.find((a) => ['fetch', 'build', 'qa', 'all'].includes(a)) ?? 'all';
const DRY_RUN = args.includes('--dry-run');
const KEEP_GOING = args.includes('--keep-going');

/* ---------------- 流水线定义（顺序即依赖顺序） ---------------- */

/** 抓取阶段：从 Overpass 拉取 OSM 原始数据到 data/raw/ */
const FETCH = [
  { script: 'fetch-osm-data.mjs', desc: '水系4分块+合并 / 景点面 / 街道 / 寒山寺' },
  { script: 'fetch-buildings.mjs', desc: '古城建筑 3×3 分块（约 1.7 万栋）' },
  { script: 'fetch-roads.mjs', desc: '古城道路 3×3 分块' },
  { script: 'fetch-greater-roads.mjs', desc: '城外 14km 主次干路 3×3 分块' },
  { script: 'fetch-greater-streets.mjs', desc: '城外 5.2km 居住区街巷 3×3 分块' },
  { script: 'fetch-outer-ring.mjs', desc: '城外 2–3km 四条建筑条带' },
  { script: 'fetch-extra-landmarks.mjs', desc: '补充景点（含唐寅祠/桃花坞）' },
  { script: 'fetch-transit.mjs', desc: '地铁线路关系 + 车站节点' },
  { script: 'fetch-heritage.mjs', desc: '文保候选 POI（historic/heritage/name）' },
];

/** 加工阶段：data/raw → public/data + src/data。顺序不可乱。 */
const BUILD = [
  { script: 'build-scene-data.mjs', desc: 'OSM 水系/景点 → scene-geometry.json + 轮廓 PNG' },
  { script: 'build-roads.mjs', desc: '路网分级/裁剪/接续 → roads.json（依赖 scene-geometry）' },
  {
    script: 'build-heritage-footprints.ts',
    runtime: 'vite-node',
    desc: '文保院落按路网避让求解 → heritage-footprints.json（依赖 roads）',
  },
  {
    script: 'measure-model-bounds.mjs',
    desc: 'GLB 包围盒 → model-bounds.json（依赖 Blender 手工步骤）',
    optional: true,
    // 该脚本读 process.env.TEMP/glb_bbox.json，由 scripts/blender/measure_bounds.py 产出。
    // 无此文件时 build-buildings.mjs 会静默降级，故编排器显式跳过并告警。
    when: () => {
      const p = path.join(process.env.TEMP || '/tmp', 'glb_bbox.json');
      if (!existsSync(p)) {
        console.log(`  [skip-optional] measure-model-bounds: 缺少 ${p}`);
        console.log('    → 运行 scripts/blender/measure_bounds.py 产出后再跑，build-buildings 会降级为默认占地。');
        return false;
      }
      return true;
    },
  },
  { script: 'build-buildings.mjs', desc: '建筑轮廓+补白 → buildings.json（依赖 scene-geometry/roads/model-bounds）' },
  { script: 'build-transit.mjs', desc: '地铁关系 → transit.json' },
];

/** 校验阶段：数据门禁。check-manifest 先跑，防止空数据让下游门禁假通过。 */
const QA = [
  { script: 'check-manifest.mjs', desc: '原始数据与生成物的存在性 + 规模校验' },
  { script: 'check-landmark-overlap.mjs', desc: '背景建筑压景点轮廓' },
  { script: 'qa-geometry.mjs', desc: '断头路 / 压路 / 道路入水 / 建筑入水' },
  { script: 'qa-road-sanity.mjs', desc: '道路合理性体检（完整性/压路/穿模，城内城外分组）' },
  { script: 'qa-bridges.mjs', desc: '桥位复算（三类桥位完整性）' },
  { script: 'qa-moat.mjs', desc: '道路/建筑进护城河' },
  { script: 'qa-waterfield.mjs', desc: '水域场/环内索引与朴素实现逐点等价' },
  {
    script: 'qa-water-road.ts',
    desc: '路 × 水自洽：水中长段必须被桥面覆盖（河不能被路面压断）',
    runtime: 'vite-node',
  },
];

const PIPELINES = { fetch: FETCH, build: BUILD, qa: QA };
const selected = STAGE === 'all' ? ['fetch', 'build', 'qa'] : [STAGE];

/* ---------------- 执行 ---------------- */

console.log('='.repeat(64));
console.log(`数据管线重建  阶段=${STAGE}  模式=${DRY_RUN ? 'dry-run' : 'execute'}`);
console.log(`根目录=${ROOT}`);
console.log('='.repeat(64));

const results = [];
let failed = 0;

for (const stage of selected) {
  const steps = PIPELINES[stage];
  console.log(`\n──── 阶段 ${stage.toUpperCase()} (${steps.length} 步) ────`);
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const seq = `[${stage}/${i + 1}/${steps.length}]`;
    if (step.optional && step.when && !step.when()) {
      results.push({ stage, script: step.script, status: 'skipped' });
      continue;
    }
    const args =
      step.runtime === 'vite-node'
        ? [path.join(ROOT, 'node_modules/vite-node/vite-node.mjs'), `scripts/${step.script}`]
        : [`scripts/${step.script}`];
    const cmd = `${NODE} ${args.join(' ')}`;
    console.log(`\n${seq} ${step.desc}`);
    console.log(`  $ ${cmd}`);
    if (DRY_RUN) {
      results.push({ stage, script: step.script, status: 'dry-run' });
      continue;
    }
    const t0 = Date.now();
    const r = spawnSync(NODE, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.error) {
      console.error(`${seq} ❌ 启动失败: ${r.error.message}`);
      failed += 1;
      if (!KEEP_GOING) break;
      results.push({ stage, script: step.script, status: 'fail', secs });
      continue;
    }
    if (r.status !== 0) {
      console.error(`${seq} ❌ ${step.script} 退出码 ${r.status} (${secs}s)`);
      failed += 1;
      if (!KEEP_GOING) break;
      results.push({ stage, script: step.script, status: 'fail', secs });
    } else {
      console.log(`${seq} ✅ ${step.script} 完成 (${secs}s)`);
      results.push({ stage, script: step.script, status: 'ok', secs });
    }
  }
  if (failed && !KEEP_GOING) break;
}

/* ---------------- 汇总 ---------------- */
console.log('\n' + '='.repeat(64));
console.log('流水线汇总');
console.log('='.repeat(64));
for (const r of results) {
  const mark = { ok: '✅', fail: '❌', skipped: '⏭️', 'dry-run': '🧪' }[r.status] ?? '?';
  const secs = r.secs ? ` (${r.secs}s)` : '';
  console.log(`  ${mark} [${r.stage}] ${r.script}${secs}`);
}
const ok = results.filter((r) => r.status === 'ok').length;
const skipped = results.filter((r) => r.status === 'skipped').length;
if (DRY_RUN) {
  const pending = results.filter((r) => r.status === 'dry-run').length;
  console.log(`\n🧪 dry-run：${pending} 步待执行、${skipped} 步将跳过（未实际运行）。`);
} else if (failed) {
  console.error(`\n❌ 流水线失败 ${failed} 步，成功 ${ok} 步，跳过 ${skipped} 步。`);
  process.exitCode = 1;
} else {
  console.log(`\n✅ 流水线成功 ${ok} 步，跳过 ${skipped} 步（可选项）。`);
}
