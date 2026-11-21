# 姑苏古城数字沙盘

基于 OpenStreetMap 数据的苏州古城 3D 数字沙盘。约 14.2 km² 的古城肌理、2.5 万栋建筑、护城河水系、城墙城门、桥、地铁网络与 50 处景点（含 31 处国保/省保文保单位），可在浏览器中自由漫游、按四季昼夜切换、聚焦任意景点。

技术栈：React 18 + Three.js 0.169 + @react-three/fiber / drei + Vite 5 + TypeScript 5.6 + zustand。

---

## 快速开始

```bash
# 环境：Node.js ≥ 20.11（脚本用到 import.meta.dirname），推荐 Node 22
npm ci                # 安装依赖（CI 可复现）
npm run dev           # 开发服务器 http://127.0.0.1:5173
npm run build         # 类型检查 + 生产构建（输出 dist/）
npm run preview       # 预览生产构建 http://127.0.0.1:4173
```

> **Windows 本地注意**：若机器装有 DLP 加密软件（如 E-SafeNet），`node_modules` 中的 `.d.ts` 可能被加密成二进制，导致 `npm run build` 的 `tsc` 阶段报 `TS1490 File appears to be binary`。这与源码无关；此时用 `npx vite build` 跳过 tsc 即可完成构建。CI 使用全新安装的 `node_modules`，不受影响。

---

## 功能

- **手动漫游**：左键旋转、右键平移、滚轮缩放；`H` 键收放侧栏；点空白返回全景。
- **整体漫游（电影级运镜）**：底部控制条「▶ 整体漫游」启动约 1 分 30 秒的连续镜头，不是逐景点静态预览，而是完整镜头语言：高空全景环绕 → **俯冲**进古城 → 绕盘门**旋转**切角度（水陆城门/瑞光塔/吴门桥）→ 低空逐景点流畅跳转（Catmull-Rom 平滑插值）→ 拉远收束全城。`T` 开始、`空格` 暂停/继续、`Esc` 退出，支持 0.5×/1×/2× 倍速与字幕。用户拖动/点击画面即中断并交还相机控制。
- **盘门景区填充**：盘门三景后方的城内腹地（原为空地）已程序化填满 69 处白墙黛瓦院落、4 片水池与 139 棵点景树，避让水门水道与瑞光塔，与四周民居肌理衔接（`src/data/panmenCompound.ts` 可单测）。
- **文保精细建模**：31 处国保/省保不再是统一占位体块，而是按拙政园那种读图层级程序化生成有辨识度的建筑群——园林（园墙/水池/厅堂/攒尖亭/游廊/太湖石假山/点景树）、中轴殿宇（牌坊/山门/重檐大殿/配殿/戏台/泮池）、多进宅第、楼阁式砖塔、城门城楼、太湖石峰/碑刻、近代红砖校舍与钟楼共 7 种原型；每处朝向与布景由 id 派生的确定性种子决定，同类不雷同。全部按材质合并（约 14 个 draw call、12 万顶点），四季换色。规格见 `src/data/heritageModels.ts`，几何见 `src/components/Heritage.tsx`。建筑生成阶段已按这些占地轮廓剔除脚下民居，文保独立凸显不被淹没。
- **车道标线远近都看得见**：标线全在路面着色器里画（1300km 路网不新增几何）。此前抗锯齿宽度上限放到 0.16（横断面归一化），远处一条边线被摊成 4m 宽的渐变、不透明度被稀释到几乎为零，于是"必须拉近才看得到线"；同时斑马线贴片 `DECAL_Y=1.36` 低于主干道路面 `MAJOR_ROAD_Y=1.38`，整组斑马线一直埋在路面下。现在：上限收到 0.05、边线加宽到 0.016、虚线周期 12m→8m，远处只轻微降对比（保底 62%）并把高频虚线单独淡出（`dashFade`）以消除摩尔纹；`DECAL_Y` 抬到 1.44。
- **景区石台不压马路**：OSM 景点轮廓与路网是两套独立数据，轮廓顶点会伸进相邻路面（拙政园东侧/南侧最深侵入 11m），石台拉伸后盖住马路与标线。两层处理：① 按真实路面半宽（主路 13m / 支路 5.5m）迭代把侵入顶点退到路缘外（`src/utils/trimOutline.ts`）；② **石台顶面压到支路路面（1.2m）以下**（`CITY_PAD_TOP=1.1`），这样即使有街道横穿景区轮廓（石路步行街、山塘街、园内小路），路网也永远渲染在石台之上。`node scripts/qa-pad-road.mjs [url] [景点id]` 校验。
- **河与路必须自洽**：OSM 里河与沿河街常是两条平行折线，中心距小于"河半宽 + 路半宽"（13+13m），整条路泡在水里，俯视就是"河被路面压断"；城外的上塘河过去还是运行期手写的直线，直接穿过留园、路网脚本又看不到它。现在：① 上塘河并入 `scene-geometry.json`，从留园北墙外 30m 绕过；② `build-roads.mjs` 对"沿河并行 >60m"的段沿法线推到岸外（保持折线连续，不切断），跨河短段留给桥；③ 桥分两种形态——城内河道水面高于路面 → 石拱桥，城外水面远低于路面 → **平桥**（桥面压到路面下 2cm，由路面含车道线铺过，只露栏板与下到河床的桥墩），不再有"浅色桥带横盖马路"；④ 立交匝道（`*_link`）按支路 11m 渲染、首尾重合的闭合环路剔除，锐角三角/黑色尖刺消失。`npm run qa:water-road` 逐段校验"水中长段必须被桥面覆盖"。
- **园路不再当马路画**：OSM 里园林/寺庙/校园内部的 `service`/`pedestrian` 巷道原本按 5.5m 路面渲染，成了横穿拙政园、狮子林、沧浪亭的黑带（也是石台被啃出缺口的原因）。`build-roads.mjs` 现在剔除"60% 以上采样点落在景点轮廓内、且长度 <320m"的折线，同时保留贴着景区走的外围街道。
- **精细模型自动避让马路**：削轮廓只处理了"画出来的石台"，模型外墙仍按真实尺寸压在路面上（拙政园最典型：模型中心比多边形质心偏 30~50m，整块往东南挤出去）。`LandmarkModel` 现在按"模型水平包络 + 路网净距"求解落位：先把模型包围盒中心对齐裁剪后的石台中心（`maxShift` 80m），能靠平移解决就不缩；仍压路才等比缩小，直到每个方向的最外点都退到路缘外 1.2m（下限 0.55）。街景型景点（平江路/观前街/山塘街/石路/桃花坞）本身即街面，不参与。`node scripts/qa-model-road.mjs [url]` 逐顶点复核，当前 11 处面状模型 0 处压路（最紧 1.19m）。
- **文保院落按路网落位**：文保的 OSM POI 质心常常落在街边甚至路面上，直接按半径画院落就是"宅第造在马路上"（潘世恩宅），彼此相邻的还会互相压住。`scripts/build-heritage-footprints.ts` 按路网净距求解每处院落的中心与半宽——原址放不下就把院落挪进街区内部、缩到放得下，落在已有精细 GLB 景点范围内的（张士诚纪功碑在北寺塔内）不再重复建模——结果固化为 `src/data/heritage-footprints.json`，渲染、标签、相机与 `build-buildings.mjs` 的民居剔除全部以它为准。
- **盘门城墙沿轮廓连续**：盘门段城墙原来是一段直墙加固定旋转角，在轮廓折角处切进城内 18m、两端各短 30~50m，视觉上墙在水面中凭空截断。现在改用 `arcBetween()` 取出与 `CityWall` 留口**同里程**的那段轮廓折线，逐点生成墙体与垛口，端点严格重合；`node scripts/qa-citywall.mjs` 沿整圈城墙每 2m 打射线验证无缺口（7695 点 / 0 缺口）。
- **景点聚焦**：侧栏 / 3D 标签 / 小地图光点任一处点击，相机平滑飞向景点。
- **搜索与筛选**：侧栏支持名称/描述搜索；按类型、优先级、文保等级（国保/省保）、世遗多维筛选；列表、3D 标签、小地图三处同步。
- **小地图**：左下角 2D 导览，显示城轮廓、水系、景点与当前视点，支持"古城 / 全域"两档视图。
- **昼夜与四季**：HUD 切换 day/night 与春夏秋冬，影响光照、天空反射、植被与积雪。
- **LOD 三级**：近/中/远景差异化渲染细节层（斑马线、灯影等）。

调试参数（仅开发环境）：`?time=night&season=winter`、`?cam=x,y,z&target=x,y,z`、`?hide=roads,banks`、`?mark=1`。

---

## 目录结构

```
src/
  components/     场景与 UI 组件（Scene / Sidebar / HUD / MiniMap / LandmarkModel 等）
  data/           景点 / 文保 / 文保建模规格 / 场景几何数据（由 scripts 产出或人工维护）
  hooks/          数据加载 hooks（useBuildings / useRoads / useTransit）
  utils/          纯函数（geo / filterLandmarks / qa 相关几何 / waterField 等）
  store/          zustand 全局状态
  constants/      坐标基准、调色板、季节配置
scripts/
  lib/            Overpass 客户端、QA 门禁工具
  fetch-*.mjs     OSM 原始数据抓取
  build-*.mjs     原始数据 → 场景数据加工
  rebuild-all.mjs 数据管线统一编排入口
  qa-*.mjs        数据门禁与浏览器探针
  perf-*.mjs      性能诊断（需本机 Chrome）
tests/            单元测试（Vitest，纯函数）
docs/             需求 / 技术方案 / 开发流程 / 数据管线手册
public/data/      前端消费的生成物（buildings / roads / transit）
public/models/    景点 GLB 精模
data/raw/         OSM 原始抓取数据（入库，是数据门禁可复现的前提）
```

---

## 数据管线

七类数据（建筑 / 路网 / 水系 / 城墙城门 / 桥 / 树 / 地铁）从 OSM 抓取到前端消费的全流程由 `scripts/rebuild-all.mjs` 统一编排，顺序即依赖顺序：

```bash
npm run data:all      # 从零复现：抓取 → 加工 → 数据门禁
npm run data:fetch    # 只抓取 OSM 原始数据
npm run data:build    # 只加工（要求 data/raw/ 就绪）
npm run data:qa       # 只跑数据门禁（要求生成物就绪）
```

完整链路、门禁阈值、Overpass 分块纪律、手工环节（景点 GLB 由 Blender 产出）见 [数据管线复现手册](./docs/data-pipeline.md)。

---

## 测试与质量门禁

```bash
npm test              # 单元测试（Vitest，25 个用例，覆盖坐标/几何/筛选/门禁纯函数）
npm run test:watch    # 监听模式
npm run typecheck     # tsc 类型检查
npm run data:qa       # 数据门禁（6 项，坏数据退出码非 0）
```

- **CI**（`.github/workflows/ci.yml`）：push/PR 到 main 时跑 `npm ci → npm run build → npm test → npm run data:qa`，上传 `dist/` 产物。CI 不跑网络抓取（Overpass）与浏览器探针（需本机 Chrome）。
- **单测**：全部是无 DOM / 无渲染依赖的纯函数，node 环境即可，快且稳。
- **数据门禁**：`qa-gate.mjs` 提供 `gate()` / `report()`，只对灾难性退化报红（文件缺失、索引不等价、桥位消失、建筑压路 >0 等），已知可接受瑕疵（断头路 177、节点重叠 1）不误判。
- **道路合理性体检**：`qa-road-sanity.mjs`（已纳入 `data:qa`）按城内/城外分组检查路网完整性、建筑压路（阈值 0）、道路入水、穿地标、贴城墙、断头路。

浏览器探针（需本机安装 Chrome，脚本默认路径 `C:/Program Files/Google/Chrome/Application/chrome.exe`）：

```bash
node scripts/qa-heritage.mjs     # 文保单位渲染与侧栏
node scripts/qa-lod-env.mjs      # 天空反射 / LOD 门控
node scripts/qa-interaction.mjs  # 搜索 / 筛选 / 小地图
node scripts/qa-tree-road.mjs       # 树上路校验（读取运行时树位，阈值 0）
node scripts/qa-road-sanity.mjs     # 道路体检：完整性/压路/入水/穿模/断头，按内外城分组
node scripts/qa-panmen-compound.mjs # 盘门填充：院落/水池/树数量与零穿模校验
node scripts/qa-tour.mjs            # 电影漫游：高空→俯冲→旋转→跳转、暂停/倍速/快捷键/中断
node scripts/qa-model-road.mjs    # 精细模型压路（逐顶点净距，阈值 0）
vite-node scripts/qa-water-road.ts # 路 × 水自洽（水中长段必须有桥面覆盖）
node scripts/qa-shot.mjs         # 截图复核
```

---

## 性能

- 生产构建经 Vite `manualChunks` 分为 4 块：`vendor-three`（约 792 kB / gzip 207 kB）、`vendor-react`（146 kB）、`vendor-r3f`（99 kB）、`index` 业务代码（178 kB）。分包价值在于长缓存：three/react 稳定，业务代码改动时用户无需重下整个包。
- 渲染指标（HUD 实时显示）：全景约 170 draw calls / 212k tris。
- 性能诊断：`node scripts/perf-boot.mjs`（首屏启动页时序）、`perf-load.mjs`（加载与长任务）、`perf-profile.mjs`（CPU 采样），均需本机 Chrome。

---

## 文档索引

- [需求文档](./docs/requirements.md)
- [技术方案原始稿](./docs/gusu-miniature.md)
- [开发流程](./docs/development-process.md)
- [数据管线复现手册](./docs/data-pipeline.md)

---

## 常见问题

- **首屏启动页**：`index.html` 的静态启动页用于覆盖首帧几何计算期间的主线程锁死；数据到位并出图两帧后自动淡出。
- **LOD 阈值**：`src/constants/geo.ts` 定义 L0/L1/L2 的相机距离阈值；斑马线从 L1 中景起就显示（路口没有斑马线时远处道路像光板带），灯杆/灯头这类近景细节仍留在 L2。
- **WebGL / SwiftShader**：无独显环境可用 `--use-gl=angle --use-angle=swiftshader` 软件渲染（探针脚本已内置）。
