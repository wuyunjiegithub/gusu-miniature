"""平江路历史街区样板段程序化建模并导出 GLB。

坐标约定：Blender +X = 东，+Y = 北，+Z = 上；单位为米，原点为
scene-geometry.json 中 pingjiang.centroid（870.4, -319.5）。
场景坐标 [x, z] → Blender (x - CX, -(z - CZ))；导出时 export_yup=True，
与网页场景坐标系一致。

样板段取 pingjiang.path 中段（点 5 → 点 8 方向）约 185 m：
青石板步行街、西侧平江河、两岸石驳岸与河埠头、两侧两层民居、
跨河单孔石拱桥、沿河柳树/香樟与灯笼杆。
"""

import json
import math
import os
import random

import bmesh
import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "pingjiang.glb")
SCENE_JSON = os.path.join(ROOT, "src", "data", "scene-geometry.json")

RNG = random.Random(20261120)

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

    def gable_roof(self, x0, x1, y0, y1, z0, h, overhang=0.0, ridge=True):
        """两坡顶：屋脊沿 X 方向，脊端起翘。"""
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

    def build(self, name, material, rot=0.0, pivot=(0.0, 0.0)):
        entry = MERGED.setdefault(material.name, [material, [], []])
        offset = len(entry[1])
        if rot:
            c, s = math.cos(rot), math.sin(rot)
            px, py = pivot
            verts = []
            for x, y, z in self.verts:
                dx, dy = x - px, y - py
                verts.append((px + dx * c - dy * s, py + dx * s + dy * c, z))
        else:
            verts = self.verts
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


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


# ---------------------------------------------------------------- 场景与材质

bpy.ops.wm.read_factory_settings(use_empty=True)

MAT_STONE = material("stone", hexc("b5b2a8"), 0.95)
MAT_WATER = material("water", hexc("3f7ea6"), 0.22, 0.1)
MAT_WALL = material("wall_white", hexc("f4efe4"), 0.93)
MAT_TILE = material("tile", hexc("5d6672"), 0.82)
MAT_WOOD = material("wood", hexc("6b4a33"), 0.86)
MAT_LEAF = material("leaf", hexc("4d6b3c"), 0.95)
MAT_TRUNK = material("trunk", hexc("5a4632"), 0.95)
MAT_LANTERN = material("lantern", hexc("b23a2e"), 0.7)

# ---------------------------------------------------------------- 样板段中心线

with open(SCENE_JSON, encoding="utf-8") as f:
    geo = json.load(f)
lm = geo["landmarks"]["pingjiang"]
CX, CZ = lm["centroid"]["x"], lm["centroid"]["z"]
PATH = [(x - CX, -(z - CZ)) for x, z in lm["path"]]

# 取 path[5] → path[8] 方向的连续折线；在 path[7] 之后再截 43 m，总长约 185.6 m
PTS = [PATH[5], PATH[6], PATH[7]]
last = PATH[7]
nxt = PATH[8]
seg_len = math.hypot(nxt[0] - last[0], nxt[1] - last[1])
PTS.append(lerp(last, nxt, 43.0 / seg_len))

SEGMENTS = []
CUM = [0.0]
for i in range(len(PTS) - 1):
    a, b = PTS[i], PTS[i + 1]
    d = math.hypot(b[0] - a[0], b[1] - a[1])
    SEGMENTS.append((a, b, d))
    CUM.append(CUM[-1] + d)
TOTAL = CUM[-1]


def at(s):
    """按弧长取样中心线点与切向。"""
    s = max(0.0, min(TOTAL, s))
    for i, (a, b, d) in enumerate(SEGMENTS):
        if s <= CUM[i + 1] or i == len(SEGMENTS) - 1:
            t = (s - CUM[i]) / d if d else 0.0
            p = lerp(a, b, t)
            dn = ((b[0] - a[0]) / d, (b[1] - a[1]) / d)
            return p, dn
    return PTS[-1], (0.0, 1.0)


def normal_of(t):
    """切向左侧（东侧）法线。"""
    return (-t[1], t[0])


def world(s, u, v=0.0):
    """中心线弧长 s、横向偏 u（+东）、纵向偏 v 的世界坐标。"""
    p, t = at(s)
    n = normal_of(t)
    return (p[0] + n[0] * u + t[0] * v, p[1] + n[1] * u + t[1] * v)


def obox(b, s, u0, u1, v0, v1, z0, z1):
    """沿路径局部坐标的盒子（u 横向 +东，v 纵向）。"""
    p, t = at(s)
    n = normal_of(t)

    def P(u, v, z):
        return (p[0] + n[0] * u + t[0] * v, p[1] + n[1] * u + t[1] * v, z)

    face = [
        (P(u0, v0, z0), P(u1, v0, z0), P(u1, v1, z0), P(u0, v1, z0)),
        (P(u0, v0, z1), P(u1, v0, z1), P(u1, v1, z1), P(u0, v1, z1)),
    ]
    for f in face:
        b.faces.append(tuple(b.V(*p3) for p3 in f))
    b.quad(P(u0, v0, z0), P(u1, v0, z0), P(u1, v0, z1), P(u0, v0, z1))
    b.quad(P(u0, v1, z0), P(u1, v1, z0), P(u1, v1, z1), P(u0, v1, z1))
    b.quad(P(u0, v0, z0), P(u0, v1, z0), P(u0, v1, z1), P(u0, v0, z1))
    b.quad(P(u1, v0, z0), P(u1, v1, z0), P(u1, v1, z1), P(u1, v0, z1))


def strip(b, s0, s1, ua, ub, zb, zt, step=2.5):
    """沿中心线延伸的条带体（截面为矩形）。"""
    n = max(2, int(math.ceil((s1 - s0) / step)))
    secs = []
    for i in range(n + 1):
        s = s0 + (s1 - s0) * i / n
        p, t = at(s)
        nx, ny = normal_of(t)
        secs.append(
            [
                (p[0] + nx * ua, p[1] + ny * ua, zb),
                (p[0] + nx * ua, p[1] + ny * ua, zt),
                (p[0] + nx * ub, p[1] + ny * ub, zt),
                (p[0] + nx * ub, p[1] + ny * ub, zb),
            ]
        )
    for k in range(n):
        a, c = secs[k], secs[k + 1]
        for i in range(4):
            j = (i + 1) % 4
            b.quad(a[i], a[j], c[j], c[i])
    b.faces.append(tuple(b.V(*v) for v in secs[0]))
    b.faces.append(tuple(b.V(*v) for v in reversed(secs[-1])))


# ---------------------------------------------------------------- 底板 / 街 / 河

STREET_HALF = 3.0          # 步行街半宽（总宽 6 m）
BANK_NEAR = -8.5           # 平江河东岸（临街一侧）
BANK_FAR = -15.5           # 平江河西岸
WATER_Z = 0.02

base = Builder()
strip(base, 0.0, TOTAL, 14.0, BANK_NEAR, -0.5, 0.0)      # 街道东侧底板
strip(base, 0.0, TOTAL, BANK_FAR, -20.5, -0.5, 0.0)      # 河西南岸底板
strip(base, 0.0, TOTAL, BANK_NEAR, BANK_FAR, -0.5, -0.42)  # 河床
base.build("ground_base", MAT_STONE)

street = Builder()
strip(street, 0.0, TOTAL, STREET_HALF, -STREET_HALF, 0.0, 0.05, step=3.0)
strip(street, 0.0, TOTAL, STREET_HALF + 0.22, STREET_HALF, 0.0, 0.16, step=3.0)
strip(street, 0.0, TOTAL, -STREET_HALF, -STREET_HALF - 0.22, 0.0, 0.16, step=3.0)
street.build("street", MAT_STONE)

water = Builder()
strip(water, 0.0, TOTAL, BANK_NEAR - 0.15, BANK_FAR + 0.15, -0.45, WATER_Z, step=4.0)
water.build("river", MAT_WATER)

bank = Builder()
strip(bank, 0.0, TOTAL, BANK_NEAR, BANK_NEAR - 0.45, -0.5, 0.32, step=4.0)
strip(bank, 0.0, TOTAL, BANK_FAR, BANK_FAR + 0.45, -0.5, 0.32, step=4.0)
bank.build("bank", MAT_STONE)

# 河埠头：每 40 m 左右一处入水石阶（近岸）
STEP_STATIONS = [23.0, 54.0, 101.0, 147.0]
steps = Builder()
for s in STEP_STATIONS:
    for i in range(4):
        u0 = BANK_NEAR - 0.55 * (i + 1)
        u1 = BANK_NEAR - 0.55 * i
        obox(steps, s, u0, u1, -1.3, 1.3, -0.5, 0.05 - 0.1 * i)
    obox(steps, s, BANK_NEAR - 2.6, BANK_NEAR - 2.2, -1.5, 1.5, -0.5, 0.42)  # 驳岸石
steps.build("river_steps", MAT_STONE)


# ---------------------------------------------------------------- 沿街民居

FRONT = 5.5   # 民居前沿距街道中心线
HOUSE_H = 6.4
EAVES = 6.4


def gable_end(b_wall, x, zbase, bands):
    """山墙墙体分段（顶部另由瓦压顶覆盖）。"""
    for ya, yb, top in bands:
        b_wall.box(x - 0.17, x + 0.17, ya, yb, zbase, top)


def house(s, side, w, depth=8.0, matou=False, guanyin=False, awning=False, river_rail=False):
    u = side * (FRONT + depth / 2)
    cx, cy = world(s, u)
    _, t = at(s)
    ang = math.atan2(t[1], t[0])
    x0, x1 = cx - w / 2, cx + w / 2
    y0, y1 = cy - depth / 2, cy + depth / 2
    front = y0 if side > 0 else y1
    back = y1 if side > 0 else y0
    sg = -1 if side > 0 else 1

    wall = Builder()
    wall.box(x0, x1, y0, y1, 0.0, HOUSE_H)
    if matou:
        tops = [EAVES + 1.95, EAVES + 2.3, EAVES + 2.6, EAVES + 2.3, EAVES + 1.95]
    elif guanyin:
        tops = [EAVES + 1.55, EAVES + 1.95, EAVES + 2.45, EAVES + 1.95, EAVES + 1.55]
    else:
        tops = None
    if tops:
        bands = [
            (cy - depth * 0.5, cy - depth * 0.34, tops[0]),
            (cy - depth * 0.34, cy - depth * 0.14, tops[1]),
            (cy - depth * 0.14, cy + depth * 0.14, tops[2]),
            (cy + depth * 0.14, cy + depth * 0.34, tops[3]),
            (cy + depth * 0.34, cy + depth * 0.5, tops[4]),
        ]
        for xe in (x0 - 0.17, x1 + 0.17):
            gable_end(wall, xe, EAVES - 0.6, bands)
    wall.build("house_wall", MAT_WALL, rot=ang, pivot=(cx, cy))

    if tops:
        cap = Builder()
        for xe in (x0 - 0.17, x1 + 0.17):
            for ya, yb, top in bands:
                cap.box(xe - 0.24, xe + 0.24, ya - 0.06, yb + 0.06, top, top + 0.16)
        cap.build("house_gable_cap", MAT_TILE, rot=ang, pivot=(cx, cy))

    wood = Builder()
    wood.box(x0 - 0.06, x1 + 0.06, y0 - 0.06, y1 + 0.06, 0.0, 0.78)  # 木裙板
    # 街面木门与窗
    wood.box(cx - 0.8, cx + 0.8, min(front, front + sg * 0.14), max(front, front + sg * 0.14), 0.06, 2.65)
    for wx in (cx - w * 0.32, cx + w * 0.32):
        wood.box(wx - 0.65, wx + 0.65, min(front, front + sg * 0.1), max(front, front + sg * 0.1), 1.15, 2.45)
    # 二层木窗带
    for wx in (cx - w * 0.26, cx + w * 0.26):
        wood.box(wx - 0.95, wx + 0.95, min(front, front + sg * 0.1), max(front, front + sg * 0.1), 4.0, 5.35)
    # 腰檐 / 楼层木枋
    wood.box(x0 - 0.05, x1 + 0.05, min(front, front + sg * 0.16), max(front, front + sg * 0.16), 3.3, 3.62)
    if river_rail:
        wood.box(x0 + 0.25, x1 - 0.25, min(back, back - sg * 0.1), max(back, back - sg * 0.1), 0.85, 0.98)
        for wx in (x0 + 0.4, (x0 + x1) / 2, x1 - 0.4):
            wood.box(wx - 0.07, wx + 0.07, min(back, back - sg * 0.12), max(back, back - sg * 0.12), 0.05, 0.9)
    if awning:
        ax0, ax1 = x0 + 0.25, x1 - 0.25
        fy = front
        oy = front + sg * 1.9
        top0, top1 = 3.55, 3.05
        wood.quad((ax0, fy, top0), (ax1, fy, top0), (ax1, oy, top1), (ax0, oy, top1))
        wood.quad((ax0, fy, top0 - 0.12), (ax1, fy, top0 - 0.12), (ax1, oy, top1 - 0.12), (ax0, oy, top1 - 0.12))
        wood.quad((ax0, fy, top0), (ax1, fy, top0), (ax1, fy, top0 - 0.12), (ax0, fy, top0 - 0.12))
        wood.quad((ax0, oy, top1), (ax1, oy, top1), (ax1, oy, top1 - 0.12), (ax0, oy, top1 - 0.12))
        wood.quad((ax0, fy, top0), (ax0, oy, top1), (ax0, oy, top1 - 0.12), (ax0, fy, top0 - 0.12))
        wood.quad((ax1, fy, top0), (ax1, oy, top1), (ax1, oy, top1 - 0.12), (ax1, fy, top0 - 0.12))
        for px in (ax0 + 0.15, ax1 - 0.15):
            wood.box(px - 0.09, px + 0.09, oy - 0.09, oy + 0.09, 0.05, top1)
    if side < 0:
        # 河房：临水木柱落在河面
        for px in (cx - w / 3, cx + w / 3):
            wood.box(px - 0.12, px + 0.12, y0 + 0.15, y0 + 0.39, -0.4, 0.05)
    wood.build("house_wood", MAT_WOOD, rot=ang, pivot=(cx, cy))

    roof = Builder()
    roof.gable_roof(x0 - 0.35, x1 + 0.35, y0, y1, HOUSE_H, 1.9, 0.55)
    roof.box(x0 - 0.45, x1 + 0.45, cy - 0.16, cy + 0.16, HOUSE_H + 1.78, HOUSE_H + 1.96)
    roof.build("house_roof", MAT_TILE, rot=ang, pivot=(cx, cy))


def court_wall(s, s0, s1, side, height=2.7):
    """院落围墙，填补民居之间的空档。"""
    length = s1 - s0
    if length < 0.8:
        return
    mid = (s0 + s1) / 2
    ua, ub = (FRONT, FRONT + 0.32) if side > 0 else (-FRONT - 0.32, -FRONT)
    b = Builder()
    obox(b, mid, ua, ub, -length / 2, length / 2, 0.0, height)
    b.build("court_wall", MAT_WALL)
    b = Builder()
    obox(b, mid, ua - 0.1, ub + 0.1, -length / 2 - 0.08, length / 2 + 0.08, height, height + 0.3)
    b.build("court_wall_cap", MAT_TILE)


# ---------------------------------------------------------------- 石拱桥

BRIDGE_S = 92.0


def stone_bridge(sb):
    p, t = at(sb)
    n = normal_of(t)

    def P(u, v, z):
        return (p[0] + n[0] * u + t[0] * v, p[1] + n[1] * u + t[1] * v, z)

    u0, u1 = -3.0, -20.0
    N = 14
    secs = []
    for i in range(N + 1):
        tt = i / N
        u = u0 + (u1 - u0) * tt
        z = 0.05 + 2.2 * math.sin(math.pi * tt)
        secs.append((u, z))

    deck = Builder()
    for i in range(N):
        ua, za = secs[i]
        ub, zb = secs[i + 1]
        deck.quad(P(ua, -1.5, za), P(ub, -1.5, zb), P(ub, 1.5, zb), P(ua, 1.5, za))
        deck.quad(P(ua, -1.5, za - 0.35), P(ub, -1.5, zb - 0.35), P(ub, 1.5, zb - 0.35), P(ua, 1.5, za - 0.35))
        for v in (-1.5, 1.5):
            deck.quad(P(ua, v, za), P(ub, v, zb), P(ub, v, zb - 0.35), P(ua, v, za - 0.35))
    for u, z in (secs[0], secs[-1]):
        deck.quad(P(u, -1.5, z), P(u, 1.5, z), P(u, 1.5, z - 0.35), P(u, -1.5, z - 0.35))

    # 桥台侧墙（拱券之外的桥身立面）
    au = -11.45
    for i in range(N):
        ua, za = secs[i]
        ub, zb = secs[i + 1]
        if abs((ua + ub) / 2 - au) <= 2.75:
            continue
        for v in (-1.52, 1.52):
            deck.quad(P(ua, v, za - 0.35), P(ub, v, zb - 0.35), P(ub, v, -0.45), P(ua, v, -0.45))

    # 拱券石圈（半椭圆拱）
    R_OUT, R_IN, ACZ = 2.9, 2.5, 0.05
    H_OUT, H_IN = 1.85, 1.45
    steps_n = 8
    for k in range(steps_n):
        a0 = math.pi * k / steps_n
        a1 = math.pi * (k + 1) / steps_n
        for v in (-1.52, 1.52):
            deck.quad(
                P(au - math.cos(a0) * R_OUT, v, ACZ + math.sin(a0) * H_OUT),
                P(au - math.cos(a1) * R_OUT, v, ACZ + math.sin(a1) * H_OUT),
                P(au - math.cos(a1) * R_IN, v, ACZ + math.sin(a1) * H_IN),
                P(au - math.cos(a0) * R_IN, v, ACZ + math.sin(a0) * H_IN),
            )
    deck.build("bridge", MAT_STONE)

    rail = Builder()
    for u, z in secs:
        for v in (-1.36, 1.36):
            obox(rail, sb, u - 0.09, u + 0.09, v - 0.09, v + 0.09, z - 0.02, z + 0.82)
    for i in range(N):
        ua, za = secs[i]
        ub, zb = secs[i + 1]
        for v in (-1.36, 1.36):
            rail.quad(P(ua, v - 0.07, za + 0.82), P(ub, v - 0.07, zb + 0.82),
                      P(ub, v + 0.07, zb + 0.82), P(ua, v + 0.07, za + 0.82))
            rail.quad(P(ua, v - 0.07, za + 0.7), P(ub, v - 0.07, zb + 0.7),
                      P(ub, v + 0.07, zb + 0.7), P(ua, v + 0.07, za + 0.7))
    rail.build("bridge_rail", MAT_WOOD)


stone_bridge(BRIDGE_S)


# ---------------------------------------------------------------- 沿街布局

east_slots = [8.43 + i * 16.87 for i in range(11)]
west_slots = [7.73 + i * 15.47 for i in range(12)]
west_house_idx = [0, 2, 4, 5, 7, 8, 10, 11]

east_spans = []
for i, sc in enumerate(east_slots):
    w = RNG.uniform(7.6, 11.2)
    house(sc, 1, w, 8.0, matou=(i % 3 == 0), guanyin=(i % 4 == 2))
    east_spans.append((sc - w / 2, sc + w / 2))

west_spans = []
for j, i in enumerate(west_house_idx):
    sc = west_slots[i]
    depth = 3.4
    w = RNG.uniform(7.0, 10.4)
    if i == 5:
        w = min(w, 8.0)
    house(sc, -1, w, depth, matou=(j % 3 == 1), guanyin=(j % 4 == 3),
          awning=(j in (1, 4, 6)), river_rail=True)
    west_spans.append((sc - w / 2, sc + w / 2))


def west_blocked(a, b):
    for s in STEP_STATIONS:
        if a < s + 1.7 and b > s - 1.7:
            return True
    if a < BRIDGE_S + 4.2 and b > BRIDGE_S - 4.2:
        return True
    return False


def fill_wall_gaps(spans, side):
    cursor = 0.0
    for a, b in spans:
        if side < 0:
            if not west_blocked(cursor, a):
                court_wall((cursor + a) / 2, cursor, a, side)
        else:
            court_wall((cursor + a) / 2, cursor, a, side)
        cursor = b
    if side > 0:
        court_wall((cursor + TOTAL) / 2, cursor, TOTAL, side)


fill_wall_gaps(east_spans, 1)
fill_wall_gaps(west_spans, -1)


# ---------------------------------------------------------------- 树木与灯笼


def willow(s, u):
    x, y = world(s, u)
    trunk = Builder()
    trunk.box(x - 0.22, x + 0.22, y - 0.22, y + 0.22, 0.0, 2.8)
    trunk.build("tree_trunk", MAT_TRUNK)
    leaf = Builder()
    leaf.prism(x, y, 2.3, 5.2, 2.1, 1.65, 7)
    leaf.prism(x, y, 4.6, 6.6, 1.5, 0.35, 7)
    for k in range(7):
        a = k * math.tau / 7
        px = x + math.cos(a) * 1.55
        py = y + math.sin(a) * 1.55
        leaf.box(px - 0.14, px + 0.14, py - 0.14, py + 0.14, 2.0, 4.9)
    leaf.build("tree_leaf", MAT_LEAF)


def camphor(s, u):
    x, y = world(s, u)
    trunk = Builder()
    trunk.box(x - 0.32, x + 0.32, y - 0.32, y + 0.32, 0.0, 3.4)
    trunk.build("tree_trunk", MAT_TRUNK)
    leaf = Builder()
    leaf.prism(x, y, 3.0, 6.8, 2.9, 2.3, 8)
    leaf.prism(x, y, 6.0, 8.2, 1.9, 0.5, 8)
    leaf.build("tree_leaf", MAT_LEAF)


TREE_STATIONS = [10.5, 18.0, 34.0, 45.0, 64.0, 72.0, 114.0, 128.0, 138.0, 160.0, 173.0, 180.0]
for k, s in enumerate(TREE_STATIONS):
    if k % 4 == 3:
        camphor(s, -4.3)
    else:
        willow(s, -4.3)

LANTERN_STATIONS = [14.0, 75.0, 130.0]
for s in LANTERN_STATIONS:
    x, y = world(s, 4.1)
    pole = Builder()
    pole.box(x - 0.09, x + 0.09, y - 0.09, y + 0.09, 0.0, 3.6)
    pole.build("lantern_pole", MAT_WOOD)
    lamp = Builder()
    lamp.prism(x, y, 2.75, 3.55, 0.34, 0.34, 8, 0.0)
    lamp.prism(x, y, 3.55, 3.75, 0.34, 0.1, 8, 0.0)
    lamp.build("lantern", MAT_LANTERN)


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
    obj = bpy.data.objects.new(f"pj_{mat_name}", mesh)
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

p_start, _ = at(0.0)
p_end, _ = at(TOTAL)
print(
    f"[pingjiang] exported {OUT} | meshes={len([o for o in bpy.data.objects if o.type == 'MESH'])} "
    f"tris={tris} materials={len(MERGED)} total_len={TOTAL:.1f}m"
)
print(
    f"[pingjiang] scene start=({p_start[0] + CX:.1f},{-(p_start[1]) + CZ:.1f}) "
    f"end=({p_end[0] + CX:.1f},{-(p_end[1]) + CZ:.1f}) "
    f"houses={len(east_spans) + len(west_spans)}"
)
