"""石路商圈程序化建模并导出 GLB。

坐标约定：Blender +X = 东，+Y = 北，+Z = 上；单位为米，原点为景点质心。
scene [x, z] → Blender (x - centroid.x, -(z - centroid.z))，
glTF export_yup=True 后 +Z→+Y、+Y→-Z，与网页场景一致。

布局：南北向石路步行街（stone 铺装）贯穿地块，两侧为 3–6 层白墙黛瓦商业
体块，街口设石牌坊；街区后侧点缀三栋 35–48 m 的现代玻璃塔楼形成天际线，
沿街少量灯笼、店招与行道树。地形底板按 outline 拉伸并下探到水面以下，
沿上塘河切出通航带、两岸铺装重拼，河道交给场景真实水面，桥上铺街。
建筑落在 z = 0 以上的铺装上。
"""

import json
import math
import os
import random

import bmesh
import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "shilu.glb")
SCENE_JSON = os.path.join(ROOT, "src", "data", "scene-geometry.json")

STREET_HALF = 13.0     # 步行街半宽
WALK = 4.0             # 人行道宽度
FRONT = STREET_HALF + WALK
Y_SOUTH = -218.0
Y_NORTH = 132.0


# ---------------------------------------------------------------- 基础工具

MERGED = {}


class Builder:
    """共享顶点的网格构造器，按材质合并输出。"""

    def __init__(self):
        self.verts = []
        self.faces = []
        self.cache = {}

    def V(self, x, y, z):
        key = (round(x, 4), round(y, 4), round(z, 4))
        idx = self.cache.get(key)
        if idx is None:
            idx = len(self.verts)
            self.verts.append(key)
            self.cache[key] = idx
        return idx

    def quad(self, a, b, c, d):
        self.faces.append((self.V(*a), self.V(*b), self.V(*c), self.V(*d)))

    def tri(self, a, b, c):
        self.faces.append((self.V(*a), self.V(*b), self.V(*c)))

    def box(self, x0, x1, y0, y1, z0, z1):
        self.quad((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1))
        self.quad((x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1))
        self.quad((x0, y0, z0), (x0, y1, z0), (x0, y1, z1), (x0, y0, z1))
        self.quad((x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1))
        self.quad((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0))
        self.quad((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))

    def prism(self, cx, cy, z0, z1, r0, r1, sides=8, phase=math.pi / 8):
        """正多棱柱 / 锥台。"""
        bot = []
        top = []
        for i in range(sides):
            a = phase + i * 2 * math.pi / sides
            bot.append((cx + math.cos(a) * r0, cy + math.sin(a) * r0, z0))
            top.append((cx + math.cos(a) * r1, cy + math.sin(a) * r1, z1))
        for i in range(sides):
            j = (i + 1) % sides
            self.quad(bot[i], bot[j], top[j], top[i])
        for i in range(1, sides - 1):
            self.tri(bot[0], bot[i], bot[i + 1])
            self.tri(top[0], top[i], top[i + 1])

    def poly_prism(self, pts, z0, z1):
        n = len(pts)
        for i in range(n):
            j = (i + 1) % n
            x0, y0 = pts[i]
            x1, y1 = pts[j]
            self.quad((x0, y0, z0), (x1, y1, z0), (x1, y1, z1), (x0, y0, z1))
        self.faces.append(tuple(self.V(x, y, z1) for x, y in pts))
        self.faces.append(tuple(self.V(x, y, z0) for x, y in reversed(pts)))

    def gable_roof(self, x0, x1, y0, y1, z0, h, overhang=0.0, ridge=True):
        """硬山 / 两坡顶：屋脊沿 X 方向。"""
        ya, yb = y0 - overhang, y1 + overhang
        ym = (y0 + y1) / 2
        self.quad((x0, ya, z0), (x1, ya, z0), (x1, ym, z0 + h), (x0, ym, z0 + h))
        self.quad((x0, yb, z0), (x1, yb, z0), (x1, ym, z0 + h), (x0, ym, z0 + h))
        self.tri((x0, ya, z0), (x0, yb, z0), (x0, ym, z0 + h))
        self.tri((x1, ya, z0), (x1, yb, z0), (x1, ym, z0 + h))
        self.quad((x0, ya, z0), (x1, ya, z0), (x1, yb, z0), (x0, yb, z0))
        if ridge:
            self.ridge_cap(x0, x1, ym, z0 + h, max(0.3, min(1.25, h * 0.34)))

    def ridge_cap(self, xa, xb, ym, zr, scale=1.0):
        t = 0.28 * scale
        self.box(xa - t, xb + t, ym - t * 1.05, ym + t * 1.05,
                 zr - 0.08 * scale, zr + 0.24 * scale)
        self.box(xa, xb, ym - t * 0.7, ym + t * 0.7,
                 zr + 0.24 * scale, zr + 0.46 * scale)
        self.ridge_horn(xa - t, -1.0, ym, zr + 0.1 * scale, scale)
        self.ridge_horn(xb + t, 1.0, ym, zr + 0.1 * scale, scale)

    def ridge_horn(self, bx, out, ym, zr, scale=1.0):
        tx = bx + out * 0.6 * scale
        w0, w1 = 0.26 * scale, 0.08 * scale
        zb, zt = zr - 0.04 * scale, zr + 0.5 * scale
        h0, h1 = 0.18 * scale, 0.08 * scale
        self.quad((bx, ym - w0, zb), (bx, ym - w0, zb + h0),
                  (tx, ym - w1, zt + h1), (tx, ym - w1, zt))
        self.quad((bx, ym + w0, zb), (tx, ym + w1, zt),
                  (tx, ym + w1, zt + h1), (bx, ym + w0, zb + h0))
        self.quad((bx, ym - w0, zb + h0), (bx, ym + w0, zb + h0),
                  (tx, ym + w1, zt + h1), (tx, ym - w1, zt + h1))
        self.quad((bx, ym - w0, zb), (tx, ym - w1, zt),
                  (tx, ym + w1, zt), (bx, ym + w0, zb))
        self.quad((bx, ym - w0, zb), (bx, ym + w0, zb),
                  (bx, ym + w0, zb + h0), (bx, ym - w0, zb + h0))
        self.quad((tx, ym - w1, zt), (tx, ym + w1, zt),
                  (tx, ym + w1, zt + h1), (tx, ym - w1, zt + h1))

    def build(self, name, material, rot=0.0, pivot=(0.0, 0.0), pos=None):
        """按材质合并；rot 绕 pivot 旋转，pos 为整体平移（局部坐标构件摆放）。
        顶点落盘前统一乘 SCALE：模型整体水平等比缩小，竖向标高保持不变。"""
        entry = MERGED.setdefault(material.name, [material, [], []])
        offset = len(entry[1])
        ox, oy = pos if pos else (0.0, 0.0)
        if rot:
            c, s = math.cos(rot), math.sin(rot)
            px, py = pivot
            verts = []
            for x, y, z in self.verts:
                dx, dy = x - px, y - py
                verts.append(
                    (
                        SCALE * (ox + px + dx * c - dy * s),
                        SCALE * (oy + py + dx * s + dy * c),
                        z,
                    )
                )
        else:
            verts = [(SCALE * (x + ox), SCALE * (y + oy), z) for x, y, z in self.verts]
        entry[1].extend(verts)
        entry[2].extend(tuple(i + offset for i in face) for face in self.faces)
        return None


def material(name, color, roughness=0.9, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


def hexc(value):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) / 255 for i in (0, 2, 4))


def point_in_poly(poly, x, y):
    inside = False
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / (y1 - y0) + x0:
            inside = not inside
    return inside


# ---------------------------------------------------------------- 场景与材质

bpy.ops.wm.read_factory_settings(use_empty=True)

MAT_WALL = material("wall_white", hexc("f0ebdf"), 0.92)       # 白墙
MAT_WALL2 = material("wall_beige", hexc("e1d4b9"), 0.92)      # 米色墙
MAT_TILE = material("tile", hexc("4d5560"), 0.82)             # 黛瓦 / 坡顶
MAT_WOOD = material("wood", hexc("6b4a33"), 0.86)             # 木构 / 门窗框
MAT_STONE = material("stone", hexc("b3ab9b"), 0.95)           # 铺地 / 石作
MAT_PAVE = material("pave", hexc("9d9c96"), 0.95)             # 底板
MAT_LEAF = material("leaf", hexc("4c6a45"), 0.95)             # 树冠
MAT_LANTERN = material("lantern", hexc("c0402c"), 0.9)        # 灯笼
MAT_SIGN = material("lantern_sign", hexc("8f2f22"), 0.9)      # 店招
MAT_GLASS = material("glass", hexc("5d7381"), 0.35, 0.15)     # 现代幕墙玻璃
MAT_GLASS_TRIM = material("glass_trim", hexc("a3a9a8"), 0.6, 0.2)
MAT_MODERN = material("wall_modern", hexc("d5d0c4"), 0.9)
MAT_WINDOW = material("window_glass", hexc("465a63"), 0.35, 0.1)

with open(SCENE_JSON, encoding="utf-8") as f:
    geo = json.load(f)
lm = geo["landmarks"]["shilu"]
CX, CZ = lm["centroid"]["x"], lm["centroid"]["z"]
OUTLINE = [(x - CX, -(z - CZ)) for x, z in lm["outline"]]
if abs(OUTLINE[0][0] - OUTLINE[-1][0]) < 0.01 and abs(OUTLINE[0][1] - OUTLINE[-1][1]) < 0.01:
    OUTLINE = OUTLINE[:-1]

RNG = random.Random(20261121)
BLOCKS = []  # (cx, cy, half_w, half_d) 供种树避让


def reserve(cx, cy, hw, hd):
    BLOCKS.append((cx, cy, hw, hd))


# ---------------------------------------------------------------- 河道通航带
# 上塘河从外城河分出后斜穿地块西北角，原先整块底板压在水面上。
# 沿河道切出 RIVER_EDGE*2 宽的通航带：底板与铺装按两岸重拼，河上架上桥，
# 河面交给 WaterSystem 的真实水面（SHANTANG_Y），模型不再遮挡。
RIVER_HALF = 13.0                  # 与 SHANGTANG_HALF 一致
RIVER_CLEAR = 1.2                  # 岸线退让
RIVER_EDGE = RIVER_HALF + RIVER_CLEAR
BASE_BOTTOM = -2.6                 # 底板下探到水面（世界 -1.3）以下，河岸不露空腔

# 模型整体水平等比缩放：底板与街块一起缩到 0.92，南/东边缘不再压住沿边马路
# （实测与最近支路净距 11m、主干道 1.6m）。竖向不缩：底板下探深度、桥面与街面
# 标高都保持真实值，河岸不会露出空腔。切河判定用缩放后的世界坐标，河道仍与
# 场景真实水面完全对齐，跨河桥也继续盖住通航带。
SCALE = 0.92


def _to_local(line):
    return [(x - CX, -(z - CZ)) for x, z in line]


_RIVER = max(
    (_to_local(line) for line in geo.get("outerWaterways", [])),
    key=lambda pts: sum(1 for p in pts if point_in_poly(OUTLINE, *p)),
    default=None,
)
if not _RIVER:
    raise RuntimeError("[shilu] scene-geometry.json 缺少上塘河")
RA, RB = _RIVER[0], _RIVER[1]
_RLEN = math.hypot(RB[0] - RA[0], RB[1] - RA[1])
RU = ((RB[0] - RA[0]) / _RLEN, (RB[1] - RA[1]) / _RLEN)
RN = (-RU[1], RU[0])


def river_sd(x, y):
    """到河道中心线的有符号距离（世界坐标）。"""
    return (x - RA[0]) * RN[0] + (y - RA[1]) * RN[1]


def river_s(x, y):
    """沿河道方向的投影，0 为河道起点（外城河侧，世界坐标）。"""
    return (x - RA[0]) * RU[0] + (y - RA[1]) * RU[1]


def river_sd_local(x, y):
    """模型局部（导出前未缩放）坐标 → 世界坐标后再求河道距离。"""
    return river_sd(x * SCALE, y * SCALE)


def river_s_local(x, y):
    return river_s(x * SCALE, y * SCALE)


def clip_keep(poly, f):
    """Sutherland–Hodgman：保留 f(x, y) >= 0 的一侧。"""
    out = []
    n = len(poly)
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % n]
        fa, fb = f(ax, ay), f(bx, by)
        if fa >= 0:
            out.append((ax, ay))
        if (fa >= 0) != (fb >= 0):
            t = fa / (fa - fb)
            out.append((ax + (bx - ax) * t, ay + (by - ay) * t))
    return out


def bank_pieces(poly):
    """多边形沿河道切成两岸，另保留河道起点以东的小块陆地。"""
    head = clip_keep(poly, lambda x, y: -river_s_local(x, y))
    head = clip_keep(head, lambda x, y: RIVER_EDGE - river_sd_local(x, y))
    head = clip_keep(head, lambda x, y: RIVER_EDGE + river_sd_local(x, y))
    main = clip_keep(poly, lambda x, y: river_sd_local(x, y) - RIVER_EDGE)
    north = clip_keep(poly, lambda x, y: -river_sd_local(x, y) - RIVER_EDGE)
    return [p for p in (main, north, head) if len(p) >= 3]


def hits_river(cx, cy, hw, hd):
    """轴对齐矩形（半宽 hw/hd）是否压到通航带。"""
    vals = [river_sd_local(cx + sx * hw, cy + sy * hd) for sx in (-1, 1) for sy in (-1, 1)]
    return min(vals) < RIVER_EDGE and max(vals) > -RIVER_EDGE


def banked_slab(builder, x0, x1, y0, y1, z0, z1):
    """矩形铺装按河道切开，两岸各自成体。"""
    for piece in bank_pieces([(x0, y0), (x1, y0), (x1, y1), (x0, y1)]):
        builder.poly_prism(piece, z0, z1)


# ---------------------------------------------------------------- 地形底板与街面

base = Builder()
for piece in bank_pieces(OUTLINE):
    base.poly_prism(piece, BASE_BOTTOM, 0.0)
base.build("shilu_base", MAT_PAVE)

# 步行街主街面
walk = Builder()
banked_slab(walk, -STREET_HALF, STREET_HALF, Y_SOUTH, Y_NORTH, 0.0, 0.08)
walk.build("street_pave", MAT_STONE)

# 中央石材分隔带
median = Builder()
banked_slab(median, -1.2, 1.2, Y_SOUTH, Y_NORTH, 0.08, 0.11)
median.build("street_median", MAT_STONE)

# 两侧人行道 + 路缘石
sidewalk = Builder()
curb = Builder()
for sx in (-1, 1):
    x0, x1 = sx * STREET_HALF, sx * (STREET_HALF + WALK)
    banked_slab(sidewalk, min(x0, x1), max(x0, x1), Y_SOUTH, Y_NORTH, 0.0, 0.16)
    banked_slab(
        curb,
        min(sx * (STREET_HALF - 0.1), sx * (STREET_HALF + 0.2)),
        max(sx * (STREET_HALF - 0.1), sx * (STREET_HALF + 0.2)),
        Y_SOUTH,
        Y_NORTH,
        0.0,
        0.24,
    )
sidewalk.build("street_sidewalk", MAT_STONE)
curb.build("street_curb", MAT_STONE)

# 横向街巷（中段），连通两侧街区
cross = Builder()
cross.box(-140.0, 130.0, -64.0, -42.0, 0.0, 0.07)
cross.build("cross_street", MAT_STONE)

# 南入口广场与北端小广场
plaza = Builder()
plaza.box(-60.0, 20.0, -236.0, Y_SOUTH, 0.0, 0.06)
plaza.box(-40.0, 40.0, Y_NORTH, 136.0, 0.0, 0.06)
plaza.build("street_plaza", MAT_STONE)

# 河道横穿步行街：切开的街面用一座宽桥接起来，桥面与人行道齐平。
# 桥体随模型缩到 0.92，但通航带是真实宽度、且斜切到西岸 y≈76，
# 所以源尺寸留到 36~86，缩放后（33~79）仍完整盖住两岸切边。
bridge = Builder()
bridge.box(-17.4, 17.4, 36.0, 86.0, 0.0, 0.42)
for sx in (-1, 1):
    x = sx * 16.3
    bridge.box(x - 0.24, x + 0.24, 36.0, 86.0, 0.42, 1.3)
bridge.build("street_bridge", MAT_STONE)


# ---------------------------------------------------------------- 沿街商业体块


def shop(cx, cy, w, d, h, rot, storeys, wall_mat, gable=True):
    """局部 x = 面阔，-y = 临街面；rot/pos 把局部坐标摆到世界。"""
    # street_row/back 均以 rot=±90° 摆放：局部面阔 w 落到世界 y，进深 d 落到世界 x
    if hits_river(cx, cy, d / 2, w / 2):
        return
    body = Builder()
    body.box(-w / 2, w / 2, -d / 2, d / 2, 0.12, h)
    body.build("shop_wall", wall_mat, rot=rot, pos=(cx, cy))

    plinth = Builder()
    plinth.box(-w / 2 - 0.1, w / 2 + 0.1, -d / 2 - 0.25, d / 2, 0.12, 0.75)
    plinth.build("shop_plinth", MAT_STONE, rot=rot, pos=(cx, cy))

    # 底层店面玻璃
    glass = Builder()
    glass.box(-w / 2 + 0.7, w / 2 - 0.7, -d / 2 - 0.3, -d / 2 + 0.12, 0.75, 3.9)
    glass.build("shop_glass", MAT_WINDOW, rot=rot, pos=(cx, cy))

    mull = Builder()
    n_m = max(3, int(w / 3.2))
    for i in range(n_m + 1):
        x = -w / 2 + 0.7 + (w - 1.4) * i / n_m
        mull.box(x - 0.11, x + 0.11, -d / 2 - 0.42, -d / 2 + 0.16, 0.75, 3.9)
    mull.build("shop_mullion", MAT_WOOD, rot=rot, pos=(cx, cy))

    # 店招带
    sign = Builder()
    sign.box(-w / 2 + 0.5, w / 2 - 0.5, -d / 2 - 0.52, -d / 2 + 0.1, 4.05, 4.9)
    sign.build("shop_sign", MAT_SIGN, rot=rot, pos=(cx, cy))

    # 上层窗带（连续玻璃 + 竖向木分隔）
    win = Builder()
    frames = Builder()
    top = h - 0.9
    rows = max(1, storeys - 1)
    for k in range(rows):
        zc = 5.5 + (top - 5.5) * (k + 0.5) / rows
        win.box(-w / 2 + 1.0, w / 2 - 1.0, -d / 2 - 0.2, -d / 2 + 0.06,
                zc - 0.8, zc + 0.8)
        for i in range(n_m + 1):
            x = -w / 2 + 1.0 + (w - 2.0) * i / n_m
            frames.box(x - 0.08, x + 0.08, -d / 2 - 0.3, -d / 2 + 0.1,
                       zc - 0.8, zc + 0.8)
        frames.box(-w / 2 + 1.0, w / 2 - 1.0, -d / 2 - 0.32, -d / 2 + 0.1,
                   zc - 0.9, zc - 0.72)
    win.build("shop_window", MAT_WINDOW, rot=rot, pos=(cx, cy))
    frames.build("shop_frame", MAT_WOOD, rot=rot, pos=(cx, cy))

    # 檐口
    eave = Builder()
    eave.box(-w / 2 - 0.35, w / 2 + 0.35, -d / 2 - 0.55, d / 2 + 0.2, h, h + 0.4)
    eave.build("shop_eave", MAT_TILE, rot=rot, pos=(cx, cy))

    if gable:
        roof = Builder()
        roof.gable_roof(-w / 2 - 0.3, w / 2 + 0.3, -d / 2 - 0.5, d / 2 + 0.2,
                        h + 0.4, 2.3, 0.4)
        roof.build("shop_roof", MAT_TILE, rot=rot, pos=(cx, cy))

        ridge = Builder()
        ridge.box(-w / 2 - 0.3, w / 2 + 0.3, -0.3, 0.3, h + 2.7, h + 3.0)
        ridge.build("shop_ridge", MAT_TILE, rot=rot, pos=(cx, cy))
    else:
        # 平顶 + 女儿墙
        deck = Builder()
        deck.box(-w / 2, w / 2, -d / 2, d / 2, h, h + 0.3)
        deck.build("shop_flat_roof", MAT_TILE, rot=rot, pos=(cx, cy))

        parapet = Builder()
        parapet.box(-w / 2 - 0.1, w / 2 + 0.1, -d / 2 - 0.1, -d / 2 + 0.25, h + 0.3, h + 1.2)
        parapet.box(-w / 2 - 0.1, w / 2 + 0.1, d / 2 - 0.25, d / 2 + 0.1, h + 0.3, h + 1.2)
        parapet.box(-w / 2 - 0.1, -w / 2 + 0.25, -d / 2, d / 2, h + 0.3, h + 1.2)
        parapet.box(w / 2 - 0.25, w / 2 + 0.1, -d / 2, d / 2, h + 0.3, h + 1.2)
        parapet.build("shop_parapet", MAT_STONE, rot=rot, pos=(cx, cy))

    reserve(cx, cy, max(w, d) / 2, max(w, d) / 2)


def street_row(sign, y0, y1):
    y = y0
    while y < y1 - 10.0:
        w = RNG.uniform(18.0, 30.0)
        if y + w > y1:
            w = y1 - y
        if w < 9.0:
            break
        d = RNG.uniform(22.0, 30.0)
        storeys = RNG.choice([3, 3, 4, 4, 5, 6])
        h = 4.2 + (storeys - 1) * 3.15
        cx = sign * (FRONT + d / 2)
        cy = y + w / 2
        rot = math.pi / 2 if sign < 0 else -math.pi / 2
        wall_mat = MAT_WALL if RNG.random() < 0.68 else MAT_WALL2
        shop(cx, cy, w - 1.6, d, h, rot, storeys, wall_mat, gable=RNG.random() < 0.78)
        y += w + RNG.uniform(3.0, 6.5)


street_row(-1, -212.0, -64.0)
street_row(-1, -42.0, 118.0)
street_row(1, -212.0, -64.0)
street_row(1, -42.0, 118.0)

# 街区后侧的二层界面
BACK = [
    (-72.0, -150.0, 30.0, 24.0, 16.0, 4),
    (-74.0, 22.0, 28.0, 26.0, 18.0, 5),
    (-72.0, 112.0, 26.0, 22.0, 14.0, 4),
    (-60.0, -212.0, 26.0, 22.0, 12.0, 3),
    (-100.0, -80.0, 30.0, 24.0, 15.0, 4),
    (-106.0, 30.0, 26.0, 22.0, 13.0, 3),
    (-95.0, -230.0, 26.0, 22.0, 12.0, 3),
    (72.0, -18.0, 30.0, 26.0, 15.0, 4),
    (74.0, 78.0, 26.0, 24.0, 17.0, 5),
    (66.0, 118.0, 24.0, 22.0, 13.0, 4),
    (106.0, -88.0, 28.0, 24.0, 16.0, 4),
    (108.0, 20.0, 24.0, 22.0, 14.0, 3),
    (100.0, 130.0, 22.0, 20.0, 12.0, 3),
]
for bx, by, bw, bd, bh, bs in BACK:
    rot = math.pi / 2 if bx < 0 else -math.pi / 2
    shop(bx, by, bw, bd, bh, rot, bs, MAT_WALL if RNG.random() < 0.5 else MAT_WALL2,
         gable=RNG.random() < 0.7)


# ---------------------------------------------------------------- 现代塔楼


def tower(cx, cy, w, d, h):
    podium = Builder()
    podium.box(cx - w / 2 - 2.0, cx + w / 2 + 2.0, cy - d / 2 - 2.0,
               cy + d / 2 + 2.0, 0.0, 5.5)
    podium.build("tower_podium", MAT_MODERN)

    body = Builder()
    body.box(cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2, 5.5, h)
    body.build("tower_glass", MAT_GLASS)

    bands = Builder()
    z = 5.5
    while z < h - 1.0:
        bands.box(cx - w / 2 - 0.22, cx + w / 2 + 0.22, cy - d / 2 - 0.22,
                  cy + d / 2 + 0.22, z, z + 0.4)
        z += 4.4
    bands.build("tower_band", MAT_GLASS_TRIM)

    crown = Builder()
    crown.box(cx - w / 2 + 1.0, cx + w / 2 - 1.0, cy - d / 2 + 1.0,
              cy + d / 2 - 1.0, h, h + 2.6)
    crown.box(cx - 1.2, cx + 1.2, cy - 1.2, cy + 1.2, h + 2.6, h + 4.2)
    crown.build("tower_crown", MAT_GLASS_TRIM)

    reserve(cx, cy, w / 2 + 2.0, d / 2 + 2.0)


tower(-131.0, 58.0, 26.0, 26.0, 40.0)
tower(76.0, -112.0, 24.0, 24.0, 36.0)
tower(-82.0, -184.0, 22.0, 22.0, 44.0)


# ---------------------------------------------------------------- 南入口石牌坊


def paifang(cx, cy):
    col = Builder()
    for sx in (-1, 1):
        col.box(cx + sx * 10.5 - 0.45, cx + sx * 10.5 + 0.45,
                cy - 0.45, cy + 0.45, 0.0, 6.8)
    col.build("pf_column", MAT_STONE)

    beam = Builder()
    beam.box(cx - 11.2, cx + 11.2, cy - 0.55, cy + 0.55, 5.0, 5.8)
    beam.box(cx - 11.2, cx + 11.2, cy - 0.4, cy + 0.4, 6.1, 6.6)
    beam.build("pf_beam", MAT_STONE)

    plaque = Builder()
    plaque.box(cx - 2.4, cx + 2.4, cy - 0.68, cy - 0.45, 5.9, 6.9)
    plaque.build("pf_plaque", MAT_SIGN)

    roof = Builder()
    roof.gable_roof(cx - 11.8, cx + 11.8, cy - 1.9, cy + 1.9, 6.8, 1.9)
    roof.build("pf_roof", MAT_TILE)

    ridge = Builder()
    ridge.box(cx - 11.8, cx + 11.8, cy - 0.3, cy + 0.3, 8.6, 8.9)
    ridge.build("pf_ridge", MAT_TILE)

    reserve(cx, cy, 12.0, 2.0)


paifang(0.0, -221.0)


# ---------------------------------------------------------------- 行道树与灯笼


def tree(x, y, h, r):
    if abs(river_sd_local(x, y)) < RIVER_EDGE + r:
        return
    trunk = Builder()
    trunk.box(x - 0.32, x + 0.32, y - 0.32, y + 0.32, 0.16, h * 0.44)
    trunk.build("tree_trunk", MAT_WOOD)

    leaf = Builder()
    leaf.prism(x, y, h * 0.34, h * 0.8, r, r * 0.64, 7)
    leaf.prism(x, y, h * 0.68, h, r * 0.68, r * 0.16, 7)
    leaf.build("tree_leaf", MAT_LEAF)

    reserve(x, y, r, r)


def lantern_pole(x, y):
    if abs(river_sd_local(x, y)) < RIVER_EDGE + 1.0:
        return
    pole = Builder()
    pole.box(x - 0.14, x + 0.14, y - 0.14, y + 0.14, 0.16, 5.2)
    pole.box(x - 0.9, x + 0.9, y - 0.1, y + 0.1, 4.95, 5.15)
    pole.build("lantern_pole", MAT_WOOD)

    lamp = Builder()
    for dx in (-0.68, 0.68):
        lamp.prism(x + dx, y, 4.25, 4.95, 0.34, 0.34, 8)
        lamp.prism(x + dx, y, 3.98, 4.25, 0.12, 0.3, 8)
        lamp.prism(x + dx, y, 4.95, 5.1, 0.24, 0.1, 8)
    lamp.build("lantern_lamp", MAT_LANTERN)

    reserve(x, y, 1.0, 1.0)


TREE_Y = [-200.0, -164.0, -128.0, -92.0, -20.0, 16.0, 52.0, 88.0, 124.0]
for i, ty in enumerate(TREE_Y):
    sx = -1 if i % 2 == 0 else 1
    tree(sx * 15.2, ty, RNG.uniform(6.5, 8.5), RNG.uniform(2.2, 2.8))

LANTERN_Y = [-182.0, -146.0, -110.0, -38.0, 34.0, 70.0, 106.0]
for i, ly in enumerate(LANTERN_Y):
    sx = 1 if i % 2 == 0 else -1
    lantern_pole(sx * 14.5, ly)


# ---------------------------------------------------------------- 合并输出

for mat_name, (mat, verts, faces) in MERGED.items():
    mesh = bpy.data.meshes.new(mat_name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.update()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    for poly in mesh.polygons:
        poly.use_smooth = False
    obj = bpy.data.objects.new(f"shilu_{mat_name}", mesh)
    obj.data.materials.append(mat)
    bpy.context.collection.objects.link(obj)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_apply=True,
    export_yup=True,
    use_selection=False,
)

meshes = [o for o in bpy.data.objects if o.type == "MESH"]
tris = 0
for obj in meshes:
    obj.data.calc_loop_triangles()
    tris += len(obj.data.loop_triangles)

mins = [1e9, 1e9, 1e9]
maxs = [-1e9, -1e9, -1e9]
for obj in meshes:
    for v in obj.data.vertices:
        for i in range(3):
            mins[i] = min(mins[i], v.co[i])
            maxs[i] = max(maxs[i], v.co[i])
size = [maxs[i] - mins[i] for i in range(3)]
print(
    f"[shilu] exported {OUT} | meshes={len(meshes)} tris={tris} "
    f"bbox=({size[0]:.1f} x {size[1]:.1f} x {size[2]:.1f}) "
    f"minz={mins[2]:.3f} maxz={maxs[2]:.3f} "
    f"size_kb={os.path.getsize(OUT) / 1024:.1f}"
)
