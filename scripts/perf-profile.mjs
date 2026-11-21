/**
 * 首屏主线程 CPU 采样：node scripts/perf-profile.mjs [url] [秒数]
 * 用 CDP Profiler 抓采样，按自身耗时排序，定位卡顿函数。
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173/';
const SECONDS = Number(process.argv[3] ?? 20);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
const client = await page.createCDPSession();

await client.send('Profiler.enable');
await client.send('Profiler.setSamplingInterval', { interval: 200 });
await client.send('Profiler.start');

await page.goto(BASE, { waitUntil: 'load', timeout: 300000 });
await new Promise((r) => setTimeout(r, SECONDS * 1000));

const { profile } = await client.send('Profiler.stop');
await browser.close();

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
profile.nodes.forEach((n) => (n.children ?? []).forEach((c) => parent.set(c, n.id)));

// 自底向上拼调用栈名
const stackName = (id) => {
  const parts = [];
  let cur = id;
  let guard = 0;
  while (cur !== undefined && guard < 6) {
    const n = byId.get(cur);
    if (!n) break;
    const f = n.callFrame;
    const name = f.functionName || '(anonymous)';
    const url = (f.url || '').split('/').pop()?.split('?')[0] ?? '';
    parts.unshift(url ? `${name}@${url}` : name);
    cur = parent.get(cur);
    guard += 1;
  }
  return parts.join(' <- ');
};

const counts = new Map();
for (const id of profile.samples ?? []) {
  const key = stackName(id);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const total = profile.samples.length;
const intervalMs = profile.samples.length ? (profile.endTime - profile.startTime) / 1000 / profile.samples.length : 0;
console.log(`采样 ${total} 个，总时长约 ${((profile.endTime - profile.startTime) / 1e6).toFixed(1)}s，单样本 ≈ ${intervalMs.toFixed(2)}ms`);

// 叶子帧（自耗）前十
const self = new Map();
for (const id of profile.samples ?? []) {
  const n = byId.get(id);
  if (!n) continue;
  const f = n.callFrame;
  const key = `${f.functionName || '(anonymous)'}@${(f.url || '').split('/').pop()?.split('?')[0] || '?'}`;
  self.set(key, (self.get(key) ?? 0) + 1);
}
console.log('\n=== 自身耗时 TOP 20 ===');
[...self.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)
  .forEach(([k, v]) => {
    const ms = v * intervalMs;
    console.log(`${String(Math.round(ms)).padStart(7)}ms  ${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`);
  });

console.log('\n=== 调用栈 TOP 12 ===');
[...counts.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .forEach(([k, v]) => {
    console.log(`${String(Math.round(v * intervalMs)).padStart(7)}ms  ${k.slice(0, 220)}`);
  });
