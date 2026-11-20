"""观前街样板段程序化建模并导出 GLB。

坐标约定：Blender +X = 东，+Y = 北，+Z = 上；单位米，原点为样板段中心（scene 质心）。
scene 坐标 [x, z] → Blender (x - cx, -(z - cz))；导出 glTF export_yup=True。
街段取 scene path 中段约 180 m，沿折线切向布置青石板街面、两侧商铺与牌坊。
"""

import json
import math
import os
import random

import bmesh
import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "guanqianjie.glb")
SCENE_JSON = os.path.join(ROOT, "src", "data", "scene-geometry.json")

STREET_LEN = 180.0      # 样板段长度（米）
STREET_HALF = 9.0       # 步行街半宽
SIDEWALK = 2.0          # 街沿人行带宽度
BUILD_OFFSET = STREET_HALF + SIDEWALK


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
        """任意简单多边形拉伸（底板、街面）。"""
        n = len(pts)
        for i in range(n):
            j = (i + 1) % n
            x0, y0 = pts[i]
            x1, y1 = pts[j]
            self.quad((x0, y0, z0), (x1, y1, z0), (x1, y1, z1), (x0, y0, z1))
        self.faces.append(tuple(self.V(x, y, z1) for x, y in pts))
        self.faces.append(tuple(self.V(x, y, z0) for x, y in reversed(pts)))

    def hip_roof(self, x0, x1, y0, y1, z0, h, inset, ridge=True, upturn=True):
        """庑殿顶：矩形檐口 + 正脊，脊端吻兽与四角起翘。"""
        xa, xb = x0 + inset, x1 - inset
        ym = (y0 + y1) / 2
        b0, b1 = (x0, y0, z0), (x1, y0, z0)
        b2, b3 = (x1, y1, z0), (x0, y1, z0)
        has_ridge = xb - xa >= 0.2
        if not has_ridge:
            xm = (x0 + x1) / 2
            r = (xm, ym, z0 + h)
            self.tri(b0, b1, r)
            self.tri(b1, b2, r)
            self.tri(b2, b3, r)
            self.tri(b3, b0, r)
        else:
            r0 = (xa, ym, z0 + h)
            r1 = (xb, ym, z0 + h)
            self.quad(b0, b1, r1, r0)
            self.quad(b2, b3, r0, r1)
            self.tri(b1, b2, r1)
            self.tri(b3, b0, r0)
        self.quad(b0, b1, b2, b3)
        if ridge and has_ridge:
            self.ridge_cap(xa, xb, ym, z0 + h, max(0.4, min(1.5, h * 0.34)))
        if upturn:
            for c, out in (((x0, y0), (-1, -1)), ((x1, y0), (1, -1)),
                           ((x1, y1), (1, 1)), ((x0, y1), (-1, 1))):
                self.corner_upturn(c, out, z0)

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
        """正脊压顶 + 两端脊头起翘，尺度随屋脊高度收放。"""
        t = 0.28 * scale
        self.box(xa - t, xb + t, ym - t * 1.05, ym + t * 1.05,
                 zr - 0.08 * scale, zr + 0.24 * scale)
        self.box(xa, xb, ym - t * 0.7, ym + t * 0.7,
                 zr + 0.24 * scale, zr + 0.46 * scale)
        self.ridge_horn(xa - t, -1.0, ym, zr + 0.1 * scale, scale)
        self.ridge_horn(xb + t, 1.0, ym, zr + 0.1 * scale, scale)

    def ridge_horn(self, bx, out, ym, zr, scale=1.0):
        """脊头起翘的吻兽轮廓：四棱台向外上挑。"""
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

    def corner_upturn(self, c, out, z, length=0.75, rise=0.55, w=0.3):
        """屋角起翘：自檐角向外上挑的尖翘（江南屋面标志性轮廓）。"""
        ox, oy = out
        n = math.hypot(ox, oy) or 1.0
        ox, oy = ox / n, oy / n
        px, py = -oy, ox
        bx, by = c[0] + ox * 0.05, c[1] + oy * 0.05
        p0 = (bx - px * w, by - py * w, z - 0.06)
        p1 = (bx + px * w, by + py * w, z - 0.06)
        p2 = (bx + px * w * 0.55, by + py * w * 0.55, z + 0.16)
        p3 = (bx - px * w * 0.55, by - py * w * 0.55, z + 0.16)
        tip = (bx + ox * length, by + oy * length, z + rise)
        self.quad(p0, p1, p2, p3)
        self.tri(p0, p1, tip)
        self.tri(p1, p2, tip)
        self.tri(p2, p3, tip)
        self.tri(p3, p0, tip)

    def build(self, name, material, rot=0.0, pivot=(0.0, 0.0), pos=None):
        """按材质合并；rot 绕 pivot 旋转，pos 为整体平移（用于局部坐标构件摆放）。"""
        entry = MERGED.setdefault(material.name, [material, [], []])
        offset = len(entry[1])
        ox, oy = pos if pos else (0.0, 0.0)
        if rot:
            c, s = math.cos(rot), math.sin(rot)
            px, py = pivot
            verts = []
            for x, y, z in self.verts:
                dx, dy = x - px, y - py
                verts.append((ox + px + dx * c - dy * s, oy + py + dx * s + dy * c, z))
        else:
            verts = [(x + ox, y + oy, z) for x, y, z in self.verts]
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


# ---------------------------------------------------------------- 材质

bpy.ops.wm.read_factory_settings(use_empty=True)

MAT_WALL = material("wall_white", hexc("f4efe4"), 0.92)      # 白墙
MAT_TILE = material("tile", hexc("5d6672"), 0.82)            # 黛瓦
MAT_WOOD = material("wood", hexc("6b4a33"), 0.85)            # 木排门 / 廊柱
MAT_STONE = material("stone", hexc("b9b5a9"), 0.94)          # 牌坊灰白石
MAT_PAVE = material("pave", hexc("9d9c96"), 0.95)            # 青石板 / 底板
MAT_RED = material("red", hexc("a03a2b"), 0.9)               # 朱红墙 / 灯笼
MAT_TRUNK = material("trunk", hexc("6b5640"), 0.95)
MAT_LEAF = material("leaf", hexc("4c6a45"), 0.95)

# ---------------------------------------------------------------- 路径采样

with open(SCENE_JSON, encoding="utf-8") as f:
    GEO = json.load(f)
LM = GEO["landmarks"]["guanqianjie"]
CX, CZ = LM["centroid"]["x"], LM["centroid"]["z"]
PATH = [(x - CX, -(z - CZ)) for x, z in LM["path"]]

# 累计弧长
SEG = []
_total = 0.0
for i in range(len(PATH) - 1):
    (x0, y0), (x1, y1) = PATH[i], PATH[i + 1]
    seg_len = math.hypot(x1 - x0, y1 - y0)
    SEG.append((_total, seg_len, x0, y0, (x1 - x0) / seg_len, (y1 - y0) / seg_len))
    _total += seg_len
TOTAL_LEN = _total


def point_at(s):
    """按弧长取路径上的点与切向、左法向。"""
    s = max(0.0, min(TOTAL_LEN - 1e-6, s))
    for s0, seg_len, x0, y0, tx, ty in SEG:
        if s <= s0 + seg_len:
            d = s - s0
            return (x0 + tx * d, y0 + ty * d, tx, ty)
    s0, seg_len, x0, y0, tx, ty = SEG[-1]
    return (x0 + tx * seg_len, y0 + ty * seg_len, tx, ty)


def offset_point(s, lateral):
    """沿左法向偏移（正=左）。"""
    x, y, tx, ty = point_at(s)
    return (x - ty * lateral, y + tx * lateral)


S0 = (TOTAL_LEN - STREET_LEN) / 2      # 样板段起点弧长
# 以离原点（场景质心）最近的路径点为街段中点，使原点落在街段中央
_center_s = min(
    (i * 1.0 for i in range(int(TOTAL_LEN) + 1)),
    key=lambda s: point_at(s)[0] ** 2 + point_at(s)[1] ** 2,
)
S0 = max(0.0, min(TOTAL_LEN - STREET_LEN, _center_s - STREET_LEN / 2))
YAW = math.atan2(point_at(S0 + STREET_LEN / 2)[3], point_at(S0 + STREET_LEN / 2)[2])

print(f"[guanqianjie] path_len={TOTAL_LEN:.1f} segment={S0:.1f}..{S0 + STREET_LEN:.1f} "
      f"yaw={math.degrees(YAW):.1f}deg")

# ---------------------------------------------------------------- 地面与街面

BASE_HALF = 42.0
STEP = 3.0


def band_polygon(half, s0=S0, s1=S0 + STREET_LEN, step=STEP):
    """沿街段生成带状多边形（左沿正向 + 右沿反向）。"""
    left, right = [], []
    s = s0
    while s < s1:
        left.append(offset_point(s, half))
        right.append(offset_point(s, -half))
        s += step
    left.append(offset_point(s1, half))
    right.append(offset_point(s1, -half))
    return left + right[::-1]


base = Builder()
base.poly_prism(band_polygon(BASE_HALF), -0.5, 0.0)
base.build("ground_base", MAT_PAVE)

# 青石板步行街：宽 18 m，略高 0.05
walk = Builder()
walk.poly_prism(band_polygon(STREET_HALF), 0.0, 0.05)
walk.build("street_pave", MAT_STONE)

# 街沿：抬高的石板人行带 + 收边
curb = Builder()
for side in (1, -1):
    pts_a = [offset_point(s, side * STREET_HALF) for s in
             [S0 + i * STEP for i in range(int(STREET_LEN / STEP) + 1)]]
    pts_b = [offset_point(s, side * (STREET_HALF + SIDEWALK)) for s in
             [S0 + i * STEP for i in range(int(STREET_LEN / STEP) + 1)]]
    poly = pts_a + pts_b[::-1]
    curb.poly_prism(poly, 0.0, 0.16)
    # 收边石
    for i in range(len(pts_a) - 1):
        (x0, y0), (x1, y1) = pts_a[i], pts_a[i + 1]
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy)
        ang = math.atan2(dy, dx)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        b = Builder()
        b.box(cx - L / 2 - 0.02, cx + L / 2 + 0.02, cy - 0.22, cy + 0.22, 0.0, 0.22)
        b.build("curb_stone", MAT_STONE, rot=ang, pivot=(cx, cy))
curb.build("sidewalk", MAT_STONE)

# ---------------------------------------------------------------- 两侧商铺

RNG = random.Random(20261120)


def shop(s_mid, width, depth, side, height, rows):
    """沿街商铺：局部 x=面阔，-y=临街面。"""
    x0, y0, tx, ty = point_at(s_mid)
    if side > 0:
        ang = math.atan2(ty, tx)
        pos = (x0 - ty * (BUILD_OFFSET + depth / 2), y0 + tx * (BUILD_OFFSET + depth / 2))
    else:
        ang = math.atan2(ty, tx) + math.pi
        pos = (x0 + ty * (BUILD_OFFSET + depth / 2), y0 - tx * (BUILD_OFFSET + depth / 2))
    w, d = width, depth
    front = -d / 2

    body = Builder()
    body.box(-w / 2, w / 2, front, d / 2, 0.16, height)
    body.build("shop_wall", MAT_WALL, rot=ang, pos=pos)

    plinth = Builder()
    plinth.box(-w / 2 - 0.08, w / 2 + 0.08, front - 0.2, d / 2, 0.16, 0.62)
    plinth.build("shop_plinth", MAT_STONE, rot=ang, pos=pos)

    # 木排门（一层）
    door = Builder()
    door.box(-w / 2 + 0.15, w / 2 - 0.15, front - 0.32, front + 0.15, 0.62, 3.7)
    door.build("shop_door", MAT_WOOD, rot=ang, pos=pos)

    ribs = Builder()
    n_rib = max(4, int(w / 2.4))
    for i in range(1, n_rib):
        cx = -w / 2 + 0.15 + (w - 0.3) * i / n_rib
        ribs.box(cx - 0.12, cx + 0.12, front - 0.52, front - 0.28, 0.62, 3.7)
    ribs.build("shop_ribs", MAT_WOOD, rot=ang, pos=pos)

    # 骑楼廊柱 + 廊檐
    col = Builder()
    n_col = 3 if w > 10 else 2
    for i in range(n_col):
        cx = -w / 2 + 1.1 + (w - 2.2) * i / max(1, n_col - 1)
        col.box(cx - 0.21, cx + 0.21, front - 1.5, front - 1.08, 0.16, 4.1)
    col.build("shop_column", MAT_WOOD, rot=ang, pos=pos)

    lintel = Builder()
    lintel.box(-w / 2, w / 2, front - 1.65, front - 0.95, 4.1, 4.55)
    lintel.build("shop_lintel", MAT_WOOD, rot=ang, pos=pos)

    eave = Builder()
    eave.gable_roof(-w / 2 - 0.15, w / 2 + 0.15, front - 1.95, front, 4.55, 0.6, ridge=False)
    eave.build("shop_eave", MAT_TILE, rot=ang, pos=pos)

    # 二层窗棂（简化：木框 + 深色窗芯）
    win = Builder()
    n_win = max(2, int((w - 2.0) / 3.0))
    for row in range(rows):
        z0 = 4.95 + row * 2.45
        for i in range(n_win):
            cx = -w / 2 + 1.2 + (w - 2.4) * (i + 0.5) / n_win
            win.box(cx - 0.88, cx + 0.88, front - 0.16, front + 0.06, z0, z0 + 1.6)
    win.build("shop_window_frame", MAT_WOOD, rot=ang, pos=pos)

    pane = Builder()
    for row in range(rows):
        z0 = 4.95 + row * 2.45
        for i in range(n_win):
            cx = -w / 2 + 1.2 + (w - 2.4) * (i + 0.5) / n_win
            pane.box(cx - 0.7, cx + 0.7, front - 0.26, front - 0.1, z0 + 0.18, z0 + 1.42)
    pane.build("shop_window_pane", MAT_TILE, rot=ang, pos=pos)

    # 屋顶
    roof = Builder()
    roof.gable_roof(-w / 2 - 0.7, w / 2 + 0.7, front, d / 2, height, 2.6, 0.95)
    roof.build("shop_roof", MAT_TILE, rot=ang, pos=pos)

    ridge = Builder()
    ridge.box(-w / 2 - 0.7, w / 2 + 0.7, -0.3, 0.3, height + 2.6, height + 2.86)
    ridge.build("shop_ridge", MAT_TILE, rot=ang, pos=pos)

    # 匾额
    plaque = Builder()
    plaque.box(-min(3.0, w * 0.32), min(3.0, w * 0.32), front - 0.42, front - 0.2, 3.75, 4.28)
    plaque.build("shop_plaque", MAT_WOOD, rot=ang, pos=pos)


def street_row(side):
    widths = [RNG.uniform(9.0, 15.0) for _ in range(8)]
    gaps = [RNG.uniform(1.5, 3.0) for _ in range(7)]
    span = sum(widths) + sum(gaps)
    s = (STREET_LEN - span) / 2
    for i, w in enumerate(widths):
        d = RNG.uniform(10.0, 14.0)
        storeys = 3 if RNG.random() < 0.45 else 2
        h = RNG.uniform(9.0, 10.4) if storeys == 3 else RNG.uniform(7.2, 8.4)
        rows = 2 if storeys == 3 else 1
        shop(S0 + s + w / 2, w, d, side, h, rows)
        s += w
        if i < len(gaps):
            s += gaps[i]


street_row(1)
street_row(-1)

# ---------------------------------------------------------------- 牌坊

def paifang(s, lateral=0.0):
    """四柱三间、三重檐牌坊，高约 9 m，跨街而立。"""
    x0, y0, tx, ty = point_at(s)
    ang = math.atan2(ty, tx) + math.pi / 2
    pos = (x0 - ty * lateral, y0 + tx * lateral)

    col = Builder()
    for x in (-7.4, -2.5, 2.5, 7.4):
        top = 6.4 if abs(x) < 3 else 5.6
        col.box(x - 0.42, x + 0.42, -0.42, 0.42, 0.0, top)
    col.build("pf_column", MAT_STONE, rot=ang, pos=pos)

    pedestal = Builder()
    for x in (-7.4, -2.5, 2.5, 7.4):
        pedestal.box(x - 0.75, x + 0.75, -0.75, 0.75, 0.0, 0.9)
    pedestal.build("pf_pedestal", MAT_STONE, rot=ang, pos=pos)

    beam = Builder()
    beam.box(-8.5, 8.5, -0.5, 0.5, 4.4, 5.1)
    beam.box(-8.5, -2.1, -0.4, 0.4, 5.1, 5.55)
    beam.box(2.1, 8.5, -0.4, 0.4, 5.1, 5.55)
    beam.build("pf_beam", MAT_STONE, rot=ang, pos=pos)

    # 匾额
    plaque = Builder()
    plaque.box(-1.9, 1.9, -0.62, -0.42, 5.15, 6.15)
    plaque.build("pf_plaque", MAT_RED, rot=ang, pos=pos)

    # 三重檐
    roof = Builder()
    roof.gable_roof(-8.9, -2.1, -1.9, 1.9, 5.55, 1.15)
    roof.gable_roof(2.1, 8.9, -1.9, 1.9, 5.55, 1.15)
    roof.gable_roof(-3.1, 3.1, -2.3, 2.3, 6.4, 1.4)
    roof.gable_roof(-1.9, 1.9, -1.5, 1.5, 7.8, 0.9)
    roof.build("pf_roof", MAT_TILE, rot=ang, pos=pos)

    ridge = Builder()
    ridge.box(-1.9, 1.9, -0.28, 0.28, 8.7, 9.0)
    ridge.build("pf_ridge", MAT_TILE, rot=ang, pos=pos)


paifang(S0 + 7.0)
paifang(S0 + STREET_LEN - 7.0)

# ---------------------------------------------------------------- 玄妙观山门（识别点）

def temple_gate():
    """街口之外正对街道的山门体块：面阔 24 m、歇山顶、朱红墙。"""
    x0, y0, tx, ty = point_at(S0 + STREET_LEN)
    ang = math.atan2(ty, tx)
    pos = (x0, y0)

    # 街口前庭：从街段末端延伸到山门
    apron = Builder()
    apron.box(-1.0, 31.0, -12.5, 12.5, -0.5, 0.04)
    apron.build("tm_apron", MAT_STONE, rot=ang, pos=pos)

    ang = ang + math.pi / 2
    pos = (x0 + tx * 30, y0 + ty * 30)

    plinth = Builder()
    plinth.box(-14.0, 14.0, -9.5, 9.5, -0.5, 1.0)
    plinth.build("tm_plinth", MAT_STONE, rot=ang, pos=pos)

    body = Builder()
    body.box(-12.0, 12.0, -6.5, 6.5, 1.0, 7.6)
    body.build("tm_wall", MAT_RED, rot=ang, pos=pos)

    door = Builder()
    door.box(-2.6, 2.6, -6.9, -6.3, 1.0, 4.9)
    door.box(-9.6, -5.4, -6.9, -6.3, 1.0, 4.4)
    door.box(5.4, 9.6, -6.9, -6.3, 1.0, 4.4)
    door.build("tm_door", MAT_WOOD, rot=ang, pos=pos)

    eave = Builder()
    eave.box(-12.6, 12.6, -7.1, 7.1, 7.6, 7.95)
    eave.build("tm_eave", MAT_TILE, rot=ang, pos=pos)

    roof = Builder()
    roof.hip_roof(-14.2, 14.2, -8.6, 8.6, 7.7, 3.2, 7.0)
    roof.build("tm_roof", MAT_TILE, rot=ang, pos=pos)

    ridge = Builder()
    ridge.box(-7.2, 7.2, -0.35, 0.35, 10.9, 11.3)
    ridge.build("tm_ridge", MAT_TILE, rot=ang, pos=pos)


temple_gate()

# ---------------------------------------------------------------- 行道树与灯笼杆

def tree(x, y, h, r):
    trunk = Builder()
    trunk.box(x - 0.32, x + 0.32, y - 0.32, y + 0.32, 0.16, h * 0.42)
    trunk.build("tree_trunk", MAT_TRUNK)
    leaf = Builder()
    leaf.prism(x, y, h * 0.34, h * 0.8, r, r * 0.6, 7)
    leaf.prism(x, y, h * 0.7, h, r * 0.66, r * 0.16, 7)
    leaf.build("tree_leaf", MAT_LEAF)


def lantern_pole(s, side):
    x, y, tx, ty = point_at(s)
    lateral = side * (STREET_HALF + 1.0)
    px, py = x - ty * lateral, y + tx * lateral
    ang = math.atan2(ty, tx)

    pole = Builder()
    pole.box(px - 0.14, px + 0.14, py - 0.14, py + 0.14, 0.16, 5.4)
    pole.box(px - 0.9, px + 0.9, py - 0.1, py + 0.1, 5.15, 5.35)
    pole.build("lantern_pole", MAT_WOOD, rot=ang, pivot=(px, py))

    lamp = Builder()
    for dx in (-0.68, 0.68):
        cx, cy = px, py + dx
        lamp.prism(cx, cy, 4.45, 5.15, 0.34, 0.34, 8)
        lamp.prism(cx, cy, 4.18, 4.45, 0.12, 0.3, 8)
        lamp.prism(cx, cy, 5.15, 5.3, 0.24, 0.1, 8)
    lamp.build("lantern_lamp", MAT_RED, rot=ang, pivot=(px, py))


for i in range(8):
    s = S0 + 12.0 + i * 22.0
    side = 1 if i % 2 == 0 else -1
    if i % 2 == 0:
        lateral = side * (STREET_HALF + 1.0)
        xl, yl, txl, tyl = point_at(s)
        tx_, ty_ = xl - tyl * lateral, yl + txl * lateral
        tree(tx_, ty_, RNG.uniform(7.0, 9.0), RNG.uniform(2.4, 3.2))
    else:
        lantern_pole(s, side)

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
    obj = bpy.data.objects.new(f"gqj_{mat_name}", mesh)
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

tris = 0
for obj in bpy.data.objects:
    if obj.type == "MESH":
        obj.data.calc_loop_triangles()
        tris += len(obj.data.loop_triangles)

p_start = point_at(S0)
p_end = point_at(S0 + STREET_LEN)
print(
    f"[guanqianjie] exported {OUT} | meshes={len([o for o in bpy.data.objects if o.type=='MESH'])} "
    f"tris={tris} mats={len(MERGED)}"
)
print(
    f"[guanqianjie] scene start=({p_start[0] + CX:.1f}, {-p_start[1] + CZ:.1f}) "
    f"end=({p_end[0] + CX:.1f}, {-p_end[1] + CZ:.1f})"
)
