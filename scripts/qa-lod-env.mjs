import puppeteer from 'puppeteer-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'],
  defaultViewport: { width: 1200, height: 800 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
const settle = (ms) => page.evaluate((t)=>new Promise(r=>setTimeout(r,t)), ms);

async function probe(name, cam, target, extra='') {
  const sep = '?';
  let url = `http://127.0.0.1:5173/${sep}cam=${cam}&target=${target}${extra ? '&'+extra : ''}`;
  await page.goto(url, { waitUntil:'networkidle2', timeout:180000 });
  await settle(8000);
  const info = await page.evaluate(() => {
    const w = window;
    const scene = w.__scene;
    const out = { hasScene: !!scene, env: scene?.environment ? 'set' : 'null', envIntensity: scene?.environmentIntensity };
    // 找到 renderOrder=2 的河面灯影 mesh 与河面灯影/外层柔光
    let reflectVisible = 'n/a', haloVisible = 'n/a', reflectCount = 0;
    if (scene) {
      scene.traverse((o) => {
        if (o.isMesh && o.renderOrder === 2) { reflectVisible = o.visible ? 'visible' : 'hidden'; reflectCount++; }
      });
    }
    out.reflectVisible = reflectVisible;
    out.reflectCount = reflectCount;
    return out;
  });
  console.log(name, JSON.stringify(info));
}

await probe('L0-panorama', '1500,1100,1500', '0,0,0');
await probe('L1-moat', '-780,240,2780', '-780,0,2460');
await probe('L2-center', '110,90,110', '0,0,0');
await browser.close();
