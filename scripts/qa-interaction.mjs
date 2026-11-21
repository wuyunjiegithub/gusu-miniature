/**
 * 交互回归探针：搜索 / 筛选 / 小地图。node scripts/qa-interaction.mjs [baseUrl]
 */
import puppeteer from 'puppeteer-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.argv[2] ?? 'http://127.0.0.1:5173/';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0,200)));
await page.goto(BASE, { waitUntil:'networkidle2', timeout:180000 });
await page.evaluate(()=>new Promise(r=>setTimeout(r,7000)));

const out = {};
// 基线条目数
out.itemsBefore = await page.$$eval('.sidebar-item', els=>els.length);
out.minimapExists = await page.$('.minimap-svg') !== null;
out.markerCount = await page.$$eval('.minimap-marker', els=>els.length);

// 搜索"拙政园"
await page.type('.sidebar-search input', '拙政园');
await page.evaluate(()=>new Promise(r=>setTimeout(r,600)));
out.itemsAfterSearch = await page.$$eval('.sidebar-item', els=>els.length);
out.searchNames = await page.$$eval('.sidebar-item .sidebar-item-name', els=>els.map(e=>e.textContent));
out.markersAfterSearch = await page.$$eval('.minimap-marker', els=>els.length);
out.labelsAfterSearch = await page.$$eval('.landmark-label', els=>els.length);

// 清空搜索
await page.click('.sidebar-search button');
await page.evaluate(()=>new Promise(r=>setTimeout(r,400)));
out.itemsAfterClear = await page.$$eval('.sidebar-item', els=>els.length);

// 展开筛选，点"世遗"级别筛选
await page.click('.sidebar-filter-toggle > button');
await page.evaluate(()=>new Promise(r=>setTimeout(r,300)));
out.filtersVisible = await page.$('.sidebar-filters') !== null;
// 点"仅世遗"
const clicked = await page.evaluate(()=>{
  const b=[...document.querySelectorAll('.filter-chips button')].find(x=>x.textContent==='仅世遗');
  if(b){b.click();return true;} return false;
});
await page.evaluate(()=>new Promise(r=>setTimeout(r,500)));
out.worldHeritageClicked = clicked;
out.itemsAfterWorldHeritage = await page.$$eval('.sidebar-item', els=>els.length);

// 小地图视图切换
await page.evaluate(()=>{
  const b=[...document.querySelectorAll('.minimap-actions button')].find(x=>x.textContent==='全域');
  if(b) b.click();
});
await page.evaluate(()=>new Promise(r=>setTimeout(r,300)));
out.viewBoxAfterWorld = await page.$eval('.minimap-svg', el=>el.getAttribute('viewBox'));

// 小地图点击一个标记触发聚焦
await page.evaluate(()=>{
  const m=document.querySelector('.minimap-marker');
  if(m) m.dispatchEvent(new MouseEvent('click',{bubbles:true}));
});
await page.evaluate(()=>new Promise(r=>setTimeout(r,1500)));
out.detailAfterMarkerClick = await page.$eval('.sidebar-detail h3', el=>el.textContent).catch(()=>null);

console.log(JSON.stringify(out,null,2));
await browser.close();
