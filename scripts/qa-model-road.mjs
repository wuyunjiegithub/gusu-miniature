/**
 * 精细模型压路探针（QA）：node scripts/qa-model-road.mjs [baseUrl]
 *
 * 背景：景点轮廓按路网削过，但 GLB 模型自己按真实尺寸建，外墙可能仍压在马路上。
 * LandmarkModel 会按"模型水平包络 + 路网净距"做等比缩放，本脚本验证结果：
 * 逐处取模型顶点（抽样）投影到 xz，查距最近路缘的净距；
 * 净距 < -0.05m 视为压路（FAIL），并打印每处的缩放系数与最紧净距。
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] ?? 'http://127.0.0.1:5173/';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  defaultViewport: { width: 1400, height: 900 },
  protocolTimeout: 600000,
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 180000 });
await page.evaluate(() => new Promise((r) => setTimeout(r, 12000)));

const report = await page.evaluate(async () => {
  const { getRoadClearance } = await import('/src/utils/roadClearance.ts');
  const roads = await (await fetch('/data/roads.json')).json();
  const clearance = getRoadClearance(roads);
  const scene = window.__scene;
  if (!scene) return { error: 'no __scene' };

  const rows = [];

  // 街景型景点的模型就是街面，压路是设计意图，不参与判定
  const STREET_IDS = new Set(['pingjiang', 'guanqianjie', 'shantangjie', 'shilu', 'taohuawu']);
  scene.traverse((g) => {
    if (!g.name?.startsWith('landmark-')) return;
    const id = g.name.slice('landmark-'.length);
    if (STREET_IDS.has(id)) return;
    g.updateMatrixWorld(true);
    let minClear = Infinity;
    let samples = 0;
    let worst = null;
    g.traverse((o) => {
      if (!o.isMesh) return;
      const attr = o.geometry?.getAttribute?.('position');
      if (!attr) return;
      const e = o.matrixWorld.elements;
      const arr = attr.array;
      const stride = Math.max(1, Math.floor(attr.count / 4000));
      for (let i = 0; i < attr.count; i += stride) {
        const px = arr[i * 3];
        const pz = arr[i * 3 + 2];
        // 只需 xz：world.x = e0*px + e4*py + e8*pz + e12
        const x = e[0] * px + e[4] * arr[i * 3 + 1] + e[8] * pz + e[12];
        const z = e[2] * px + e[6] * arr[i * 3 + 1] + e[10] * pz + e[14];
        const c = clearance(x, z);
        samples += 1;
        if (c < minClear) {
          minClear = c;
          worst = [Math.round(x * 10) / 10, Math.round(z * 10) / 10];
        }
      }
    });
    rows.push({
      id,
      scale: Number((g.userData?.landmarkScale ?? 1).toFixed(3)),
      minClear: Number(minClear.toFixed(2)),
      samples,
      worst,
    });
  });
  rows.sort((a, b) => a.minClear - b.minClear);
  return { rows };
});

await browser.close();

if (report.error) {
  console.error(`[qa-model-road] ${report.error}`);
  process.exit(1);
}

console.log('模型'.padEnd(18), '缩放'.padStart(6), '最紧净距(m)'.padStart(12), '压路最深点');
for (const r of report.rows) {
  console.log(
    r.id.padEnd(18),
    String(r.scale).padStart(6),
    String(r.minClear).padStart(12),
    r.worst ? `(${r.worst[0]}, ${r.worst[1]})` : '-',
  );
}
const bad = report.rows.filter((r) => r.minClear < -0.05);
console.log(
  `\n[qa-model-road] 模型 ${report.rows.length} 处，压路 ${bad.length} 处 ` +
    `${bad.length ? `(${bad.map((b) => b.id).join(', ')})` : ''} → ${bad.length ? 'FAIL' : 'PASS'}`,
);
if (bad.length) process.exitCode = 1;
