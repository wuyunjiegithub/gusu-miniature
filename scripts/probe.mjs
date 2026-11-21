/**
 * 反查场景对象：node scripts/probe.mjs baseUrl minX,maxX,minZ,maxZ
 * 列出世界包围盒与该矩形相交的 mesh，以及它所属的父级链。
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173/';
const box = (process.argv[3] ?? '-900,-650,2400,2620').split(',').map(Number);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  defaultViewport: { width: 1200, height: 800 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
await page.goto(`${BASE}?cam=-776,200,2950&target=-776,10,2340`, {
  waitUntil: 'networkidle2',
  timeout: 180000,
});
await page.evaluate((t) => new Promise((r) => setTimeout(r, t)), 9000);

const result = await page.evaluate((b) => {
  const scene = window.__scene;
  if (!scene) return { error: 'no __scene' };
  const THREE_Box = scene.children[0]?.constructor;
  const out = [];
  const [minX, maxX, minZ, maxZ] = b;
  scene.updateMatrixWorld(true);
  scene.traverse((obj) => {
    if (!obj.isMesh && !obj.isPoints && !obj.isLine) return;
    const geo = obj.geometry;
    if (!geo) return;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox.clone();
    bb.applyMatrix4(obj.matrixWorld);
    if (bb.max.x < minX || bb.min.x > maxX || bb.max.z < minZ || bb.min.z > maxZ) return;
    const chain = [];
    let p = obj;
    while (p && p !== scene) {
      chain.push(p.name || p.type);
      p = p.parent;
    }
    out.push({
      chain: chain.reverse().join(' > '),
      type: obj.type,
      count: obj.count ?? null,
      box: [
        +bb.min.x.toFixed(1),
        +bb.max.x.toFixed(1),
        +bb.min.y.toFixed(1),
        +bb.max.y.toFixed(1),
        +bb.min.z.toFixed(1),
        +bb.max.z.toFixed(1),
      ],
      material: obj.material?.type ?? null,
      color: obj.material?.color ? '#' + obj.material.color.getHexString() : null,
      tris: geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3,
    });
  });
  return { count: out.length, items: out };
}, box);

if (result.error) console.log(result.error);
else {
  console.log(`命中 ${result.count} 个对象 (${result.items.length} 条)`);
  for (const it of result.items) {
    console.log(
      `${it.type}${it.count !== null ? `[${it.count}]` : ''} tris=${Math.round(it.tris)} ${it.color ?? ''} ${it.material ?? ''}\n   bbox ${it.box.join(', ')}\n   ${it.chain}`,
    );
  }
}

await browser.close();
