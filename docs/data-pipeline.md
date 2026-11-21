# 姑苏古城数字沙盘 · 数据管线复现手册

| 项目 | 内容 |
| :--- | :--- |
| 版本 | v1.0 |
| 日期 | 2026-11-21 |
| 关联文档 | [开发流程](./development-process.md)、[需求文档](./requirements.md) |

本文是**数据管线的可执行契约**：定义七类数据（建筑 / 路网 / 水系 / 城墙城门 / 桥 / 树 / 地铁）从 OSM 原始抓取到前端消费的端到端链路，以及如何从零一键重建。开发流程文档讲"怎么设计"，本文讲"怎么重跑"。

---

## 1. 一键复现（推荐的入口）

数据管线已由 `scripts/rebuild-all.mjs` 统一编排，**顺序即依赖顺序**，无需手工记忆各脚本先后：

```bash
npm install                 # 首次：安装依赖（含 sharp / puppeteer-core）

npm run data:all            # 全流程：抓取 → 加工 → 数据门禁
npm run data:fetch          # 只抓取 OSM 原始数据到 data/raw/
npm run data:build          # 只加工（要求 data/raw/ 已就绪）
npm run data:qa             # 只跑数据门禁（要求生成物已就绪）

# 调试用
node scripts/rebuild-all.mjs build --dry-run      # 只打印将执行的命令
node scripts/rebuild-all.mjs build --keep-going   # 某步失败不中断后续
```

**退出码**：任一必需步骤失败（非 `--keep-going`）→ 1；全部通过 → 0。可直接用作 CI 门禁。

### 依赖顺序（编排器已固化）

```
FETCH (9 步)                       BUILD (5 步)                       QA (6 步)
─────────────────                  ─────────────────                  ─────────────────
fetch-osm-data        ─┐          build-scene-data   ─┐             check-manifest
  (水系4分块+合并)      │            (scene-geometry)   │               (存在性+规模)
fetch-buildings       │          build-roads        ─┤             check-landmark-overlap
fetch-roads           │            (roads.json)       │             qa-geometry
fetch-greater-roads   ├─► data/raw ├─ measure-model-* [可选] ─► public/ qa-bridges
fetch-greater-streets │            build-buildings    │  +src/    qa-moat
fetch-outer-ring      │            (buildings.json)   │             qa-waterfield
fetch-extra-landmarks │          build-transit       ─┘
fetch-transit         │
fetch-heritage       ─┘
```

> `build-buildings` 依赖 `scene-geometry.json` + `roads.json` + `model-bounds.json`，顺序不可乱；编排器已按此排列。

---

## 2. 七类数据端到端链路

| 数据类 | 抓取脚本 | 原始数据 | 加工脚本 | 生成物 | 前端消费 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **建筑（2.5万）** | `fetch-buildings` + `fetch-outer-ring` | `buildings-{r}-{c}.json`×9 + `buildings-ring-*.json`×4 | `build-buildings` | `public/data/buildings.json` | `useBuildings` → `BuildingField` / `Outskirts` |
| **路网** | `fetch-roads` + `fetch-greater-roads` + `fetch-greater-streets` | `roads-*` / `greater-roads-*` / `streets-*` ×27 | `build-roads` | `public/data/roads.json` | `useRoads` → `Roads` / `RoadMarkings` / `Trees` |
| **水系** | `fetch-osm-data` | `waterways-{sw,se,nw,ne}.json` → 合并 `waterways.json` | `build-scene-data` | `scene-geometry.json` 的 `cityOutline` / `waterways` / `outerWaterways` | `WaterSystem` / `waterField` |
| **城墙 / 城门** | 城轮廓来自水系（护城河环）；城门坐标为策展数据 | `cityOutline` + `src/data/cityGates.ts` | `build-scene-data` + 运行时投影 | `CityWall` / `CityGates` 程序化生成 | `CityWall.tsx` / `CityGates.tsx` |
| **桥** | 无中间产物，运行时算"道路×水面"交点 | `roads.json` + `scene-geometry.json` | 运行时 `computeBridgeSites` | 内存几何 | `CanalBridges.tsx`（`qa-bridges` 复算校验） |
| **树** | 无中间产物，运行时程序化撒点 | `scene-geometry` + `roads.json` + `hills.json` | 运行时 `Trees.tsx` | 内存实例 | `Trees.tsx` |
| **地铁** | `fetch-transit` | `transit.json` | `build-transit` | `public/data/transit.json` | `useTransit` → `Transit.tsx` |

**注意**：城墙城门 / 桥 / 树三类的"数据"部分是程序化生成或策展常量，不是 OSM 抓取产物；它们的"可复现"由**确定性算法 + 上游数据门禁**保证，而非原始数据文件。

---

## 3. 数据门禁（坏数据会报红）

所有 QA 脚本通过 `scripts/lib/qa-gate.mjs` 设阈值，任一失败 `process.exitCode = 1`。设计原则：**只对灾难性退化报红，不对已知可接受瑕疵误判**。

| 脚本 | 硬门禁（报红） | 已知可接受基线（不报红） |
| :--- | :--- | :--- |
| `check-manifest` | 34 个原始数据文件齐全；建筑原始 ≥8000；水系 ≥100 way；文保 ≥500 POI；建筑实例 ≥22000（压路避让修复后基线≈23400） | — |
| `qa-road-sanity` | 路网折线 ≥4000；建筑压路数 = 0（城内城外分组）；道路穿地标/贴城墙/断头统计 | — |
| `check-landmark-overlap` | 重叠建筑 ≤5；含轮廓景点 ≥10 | panmen 单处重叠（基线=1） |
| `qa-geometry` | 建筑入水 ≤8；涉水路段 ≤120；道路段 ≥3000；建筑 ≥20000 | 断头路 177、压路 2520（已知肌理瑕疵） |
| `qa-bridges` | 桥位总数 ≥10；三类桥位 moat≥4 / canal≥1 / shantang≥2 | 跳过 dup=13 / long=1 |
| `qa-moat` | 建筑总数 ≥20000；护城河内建筑 ≤2 | 道路涉水 0.14%、压路 2515 |
| `qa-waterfield` | 采样点 ≥30万；水域场/环内索引不一致 **必须 =0** | — |

`qa-waterfield` 是最关键的算法门禁：网格索引一旦偏移，表现为"桥消失 / 路灯插进河里"，肉眼极难发现，必须在数据层逐点比对朴素实现。

---

## 4. Overpass 抓取纪律

统一由 `scripts/lib/overpass.mjs` 发请求，具备：

- **4 个 endpoint 轮换**：`overpass-api.de` / `lz4` / `z` / `kumi.systems`；
- **重试 + 退避**：默认 retries=3、timeout=120s，逐 endpoint 失败继续，全失败才抛错；
- **分块**：禁止整城一次拉取。建筑 / 路网按 3×3 分块，水系按 4 分块，城外道路 / 街巷各 3×3。

**断点续传**：多数 fetch 脚本对"已存在文件"自动 `[skip]`，重跑不会重复请求。例外：`fetch-transit` / `fetch-heritage` / `fetch-outer-ring` 每次覆盖重抓（原始数据小，可接受）。

**超时路块补抓**：单个路块若反复 406，用 `fetch-road-tile.mjs <row> <col>` 把它拆成 2×2 子块补抓后合并（不在标准流水线内，按需执行）。

### 两处历史断链（已修复）

1. **`extra-taohuawu.json`**：`build-scene-data` 依赖它产出"唐寅祠 / 桃花坞"两处景点，但过去没有抓取脚本 → 从零复现会永久丢失这两处。现已在 `fetch-extra-landmarks.mjs` 补抓。
2. **`waterways.json`**：合并文件过去来源不明（无脚本产出）。现由 `fetch-osm-data.mjs` 在抓取 4 分块后自动去重合并产出。

---

## 5. 手工环节（不在一键流水线内）

以下环节需人工介入，编排器会正确跳过并把它们标为可选：

### 5.1 景点精模 GLB（18 处）

`scripts/blender/*.py` 逐个手工执行，产出 `public/models/*.glb`。这是建模工作，不是数据抓取；数据管线只负责为它生成 `scene-geometry.json` 里的景点轮廓参考。

### 5.2 模型占地测量

`measure-model-bounds.mjs` 依赖 `scripts/blender/measure_bounds.py` 产出、并写到系统临时目录的文件：

- Windows：`%TEMP%\glb_bbox.json`
- 该文件不存在时，编排器打印 `[skip-optional]` 并跳过，`build-buildings.mjs` 降级为默认占地矩形（不影响整体构建）。

要精确控制建筑避让景点时，先跑 Blender 测量脚本产出 `glb_bbox.json`，再重跑 `npm run data:build`。

### 5.3 策展型数据（源码即数据，有意为之）

下列文件是人工维护的常量，**不是**生成物，因此不需要复现脚本——它们的可复现性由纳入版本控制保证：

- `src/data/cityGates.ts`：9 座城门经纬度与类型；
- `src/data/cityGates.ts` / `hills.ts` / `outerCity.ts`：城门 / 山体 / 城外环带参数；
- `src/data/heritage.ts`：31 处文保的名称 / 等级 / 类型 / 描述（坐标由 `fetch-heritage` 抓取的 `heritage.json` 锚定，部分 OSM 缺失项用邻近地物估算）；
- `src/data/landmarks.ts` / `extraLandmarks.ts`：景点表与精模挂载参数。

> 复现纪律：这些文件必须与生成物一同纳入 git。clone 后若缺失，流水线会因 `check-manifest` / 前端 import 报错而失败。

---

## 6. 常量单一来源

原点 `{120.621, 31.311}`、水体宽度（canal 15 / moat inner 4.6 / outer 120 / shantang 13）等常量在多个脚本与 QA 中重复出现。修改时需同步：

- `src/constants/geo.ts`（前端）
- `build-roads.mjs` / `build-buildings.mjs` / `build-scene-data.mjs` / `build-transit.mjs`（加工）
- `qa-geometry.mjs` / `qa-bridges.mjs` / `qa-moat.mjs` / `qa-waterfield.mjs`（门禁）

`qa-waterfield.mjs` 的逐点等价比对会在这些常量不同步时立即报红，是常量漂移的护栏。

---

## 7. 复现验收清单

从零复现完成、可视为"数据管线 100%"的标准：

- [ ] `npm run data:all` 退出码 0，`fetch` 9 步 + `build` 5 步 + `qa` 6 步全绿；
- [ ] `check-manifest` 报告 12/12 项通过，34 个原始数据文件齐全；
- [ ] `buildings.json` 场景实例约 2.5 万（历史基线 25,506，因 Overpass 分块边界浮点差异重跑后在 25,200±500 波动均属正常）；`roads.json` 主干 3,135 / 次干 1,491；`transit.json` 9 线；
- [ ] `qa-waterfield` 两类索引不一致均为 0；
- [ ] `npm run build` 通过（tsc + vite build）；
- [ ] 前端加载后核心景点、城墙、桥、地铁可见（用 `scripts/qa-shot.mjs` / `shoot.mjs` 截图核对）。
