/**
 * 盘门景区腹地填充探针：校验院落/水池/点景树已生成，且零压水道/塔/轮廓外。
 * 用法: node scripts/qa-panmen-compound.mjs [baseUrl]
 * 数据部分从布局模块读（esbuild 转译），渲染部分从 window.__scene 读 mesh。
 */
import puppeteer from 'puppeteer-core';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] ?? 'http://127.0.0.1:5173/';
const ROOT = new URL('../', import.meta.url);

// 用 esbuild 转译纯数据布局模块，注入真实 sceneGeometry
const esbuild = require('esbuild');
const sg = JSON.parse(await readFile(new URL('src/data/scene-geometry.json', ROOT), 'utf8'));
const trimmed = sg.landmarks.panmen.outline.map(([x, z]) => [x, Math.min(z, 2392)]);
const tmp = new URL('.tmp-qa-pc/', ROOT);
const { mkdir, writeFile } = await import('node:fs/promises');
await mkdir(tmp, { recursive: true });
await writeFile(new URL('sg.mjs', tmp), `export const sceneGeometry=${JSON.stringify({ landmarks: { panmen: { outline: trimmed } } })};`);
esbuild.buildSync({
  entryPoints: [fileURLToPath(new URL('src/data/panmenCompound.ts', ROOT))],
  bundle: true,
  format: 'esm',
  outfile: fileURLToPath(new URL('pc.mjs', tmp)),
  external: ['./sceneGeometry'],
});
let code = await readFile(new URL('pc.mjs', tmp), 'utf8');
code = code.replace(/from ['"][^'"]*sceneGeometry['"]/, "from './sg.mjs'");
await writeFile(new URL('pc2.mjs', tmp), code);
const layout = (await import(new URL('pc2.mjs?t=' + Date.now(), tmp).href)).PANMEN_COMPOUND;

const { pointInRing } = await import(new URL('pc2.mjs?t=' + (Date.now() + 1), tmp).href);

// 数据层校验
const inRing = (x, z) => pointInRing(trimmed, x, z);
const gateBlocked = (x, z) => Math.abs(x + 777) < 9 && z > 2230 && z < 2470;
const towerBlocked = (x, z) => Math.hypot(x + 722, z - 2400) < 16;
const badHouses = layout.houses.filter((h) => !inRing(h.x, h.z) || gateBlocked(h.x, h.z) || towerBlocked(h.x, h.z));
const badTrees = layout.trees.filter((t) => !inRing(t.x, t.z) || gateBlocked(t.x, t.z) || towerBlocked(t.x, t.z));

// 渲染层校验
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  defaultViewport: { width: 1000, height: 700 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 180000 });
await page.evaluate(() => new Promise((r) => setTimeout(r, 7000)));
const meshes = await page.evaluate(() => {
  const s = window.__scene;
  if (!s) return null;
  const names = [];
  s.traverse((o) => { if (o.name?.startsWith('panmen-')) names.push({ name: o.name, verts: o.geometry?.attributes?.position?.count ?? 0 }); });
  return names;
});
await browser.close();

const has = (n) => meshes?.some((m) => m.name === n && m.verts > 0) ?? false;
const out = {
  ponds: layout.ponds.length,
  houses: layout.houses.length,
  trees: layout.trees.length,
  badHouses: badHouses.length,
  badTrees: badTrees.length,
  meshWalls: has('panmen-compound-walls'),
  meshRoofs: has('panmen-compound-roofs'),
  meshPonds: has('panmen-ponds'),
  meshTrees: has('panmen-trees-trunk'),
  errors: errs,
};
console.log(JSON.stringify(out, null, 2));
const pass =
  out.ponds >= 3 && out.houses >= 40 && out.trees >= 50 &&
  out.badHouses === 0 && out.badTrees === 0 &&
  out.meshWalls && out.meshRoofs && out.meshPonds && out.meshTrees &&
  errs.length === 0;
process.exitCode = pass ? 0 : 1;
if (!pass) console.error('❌ 盘门填充校验失败');
else console.log('✅ 盘门填充校验通过');
