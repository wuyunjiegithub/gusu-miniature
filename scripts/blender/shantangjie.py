"""山塘街样板段程序化建模并导出 GLB。

坐标约定：场景 1 单位 = 1 米，+X 东、-Z 北；Blender 为 +X 东、+Y 北、+Z 上。
场景 (x, z) → Blender (x - CX, -(z - CZ))，导出时 export_yup=True。
样板段取山塘街 path 起点（阊门附近）向西北约 210 m：
石板街、街北（行进方向右侧）山塘河、石驳岸与河埠头、两岸两层民居、
跨河单孔石拱桥、沿街灯笼杆与树木。
"""

import json
import math
import os
import random

import bmesh
import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "shantangjie.glb")
SCENE_JSON = os.path.join(ROOT, "src", "data", "scene-geometry.json")

RNG = random.Random(20261121)
STREET_LEN = 200.0

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
        """两坡硬山顶：屋脊沿 X 方向。"""
        ya, yb = y0 - overhang, y1 + overhang
        ym = (y0 + y1) / 2
        self.quad((x0, ya, z0), (x1, ya, z0), (x1, ym, z0 + h), (x0, ym, z0 + h))
        self.quad((x0, yb, z0), (x1, yb, z0), (x1, ym, z0 + h), (x0, ym, z0 + h))
        self.tri((x0, ya, z0), (x0, yb, z0), (x0, ym, z0 + h))
        self.tri((x1, ya, z0), (x1, yb, z0), (x1, ym, z0 + h))
        self.quad((x0, ya, z0), (x1, ya, z0), (x1, yb, z0), (x0, yb, z0))
        if ridge:
            self.ridge_cap(x0, x1, ym, z0 + h)

    def ridge_cap(self, x0, x1, ym, zr):
        """正脊压顶：两皮收分瓦条，两端脊头起翘（吻兽）。"""
        self.box(x0 - 0.14, x1 + 0.14, ym - 0.24, ym + 0.24, zr - 0.05, zr + 0.14)
        self.box(x0 - 0.02, x1 + 0.02, ym - 0.16, ym + 0.16, zr + 0.14, zr + 0.28)
        self.ridge_horn(x0 - 0.14, -1.0, ym, zr)
        self.ridge_horn(x1 + 0.14, 1.0, ym, zr)

    def ridge_horn(self, bx, out, ym, zr):
        """脊头起翘：四棱台向上外挑，远看即吻兽轮廓。"""
        tx = bx + out * 0.52
        w0, w1 = 0.22, 0.07
        zb, zt = zr - 0.02, zr + 0.42
        h0, h1 = 0.14, 0.06
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


# ---------------------------------------------------------------- 材质（共 10 种）

bpy.ops.wm.read_factory_settings(use_empty=True)

MAT_PAVE = material("pave", hexc("b6b2a7"), 0.95)          # 街面青石板
MAT_JOINT = material("joint", hexc("d3cfc3"), 0.93)        # 石板浅色接缝
MAT_WATER = material("water", hexc("3f7ea6"), 0.2, 0.05)   # 河水
MAT_STONE = material("stone", hexc("9b988e"), 0.95)        # 驳岸 / 桥 / 底板
MAT_WALL = material("wall_white", hexc("f2ede2"), 0.92)    # 白墙
MAT_TILE = material("tile", hexc("4f5863"), 0.82)          # 深灰瓦
MAT_WOOD = material("wood", hexc("6b4a33"), 0.86)          # 木装修
MAT_LEAF = material("leaf", hexc("3f5c33"), 0.96)          # 树冠
MAT_TRUNK = material("trunk", hexc("6b5640"), 0.96)        # 树干
MAT_LANTERN = material("lantern", hexc("b23a2e"), 0.7)     # 红灯笼

# ---------------------------------------------------------------- 中心线

with open(SCENE_JSON, encoding="utf-8") as f:
    GEO = json.load(f)
LM = GEO["landmarks"]["shantangjie"]
CX, CZ = LM["centroid"]["x"], LM["centroid"]["z"]
PATH = [(x - CX, -(z - CZ)) for x, z in LM["path"]]

# 从 path 起点 40m 处截取 200m：避开环城河水面，整段都落在城外地面上
START_OFFSET = 40.0


def slice_path(pts, start, length):
    """按累计里程截取子折线（1m 采样）。"""
    dense = []
    acc = 0.0
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        seg = math.hypot(b[0] - a[0], b[1] - a[1])
        steps = max(1, int(seg))
        for k in range(steps):
            t = k / steps
            dense.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, acc + seg * t))
        acc += seg
    dense.append((pts[-1][0], pts[-1][1], acc))
    return [(x, y) for x, y, s in dense if start <= s <= start + length]


PTS = slice_path(PATH, START_OFFSET, STREET_LEN)

SEGMENTS = []
CUM = [0.0]
for i in range(len(PTS) - 1):
    a, b = PTS[i], PTS[i + 1]
    d = math.hypot(b[0] - a[0], b[1] - a[1])
    SEGMENTS.append((a, b, d))
    CUM.append(CUM[-1] + d)
TOTAL = CUM[-1]


def at(s):
    """按弧长取中心线点与单位切向。"""
    s = max(0.0, min(TOTAL, s))
    for i, (a, b, d) in enumerate(SEGMENTS):
        if s <= CUM[i + 1] or i == len(SEGMENTS) - 1:
            t = (s - CUM[i]) / d if d else 0.0
            p = lerp(a, b, t)
            return p, ((b[0] - a[0]) / d, (b[1] - a[1]) / d)
    return PTS[-1], (0.0, 1.0)


def normal_of(t):
    """行进方向左侧法线（+u 为街道左侧 / 南侧）。"""
    return (-t[1], t[0])


def world(s, u, v=0.0):
    p, t = at(s)
    n = normal_of(t)
    return (p[0] + n[0] * u + t[0] * v, p[1] + n[1] * u + t[1] * v)


def obox(b, s, u0, u1, v0, v1, z0, z1):
    """沿路径局部坐标的盒子（u 左侧为正，v 纵向）。"""
    p, t = at(s)
    n = normal_of(t)

    def P(u, v, z):
        return (p[0] + n[0] * u + t[0] * v, p[1] + n[1] * u + t[1] * v, z)

    for f in (
        [(u0, v0, z0), (u1, v0, z0), (u1, v1, z0), (u0, v1, z0)],
        [(u0, v0, z1), (u1, v0, z1), (u1, v1, z1), (u0, v1, z1)],
    ):
        b.faces.append(tuple(b.V(*P(*p3)) for p3 in f))
    b.quad(P(u0, v0, z0), P(u1, v0, z0), P(u1, v0, z1), P(u0, v0, z1))
    b.quad(P(u0, v1, z0), P(u1, v1, z0), P(u1, v1, z1), P(u0, v1, z1))
    b.quad(P(u0, v0, z0), P(u0, v1, z0), P(u0, v1, z1), P(u0, v0, z1))
    b.quad(P(u1, v0, z0), P(u1, v1, z0), P(u1, v1, z1), P(u1, v0, z1))


def strip(b, s0, s1, ua, ub, zb, zt, step=2.5):
    """沿中心线延伸的矩形截面条带。"""
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

STREET_HALF = 3.0
RIVER_NEAR = -3.7     # 近岸（街侧）
RIVER_FAR = -11.7     # 对岸
SOUTH_FRONT = 5.2     # 南侧民居前沿
NORTH_FRONT = 13.6    # 河北岸民居前沿
WATER_Z = -0.55
BED_Z = -0.95
BASE_BOTTOM = -1.2
SOUTH_EDGE = 21.0
NORTH_EDGE = -22.5

base = Builder()
strip(base, 0.0, TOTAL, RIVER_NEAR, SOUTH_EDGE, BASE_BOTTOM, 0.0, step=3.0)   # 南岸陆地
strip(base, 0.0, TOTAL, NORTH_EDGE, RIVER_FAR, BASE_BOTTOM, 0.0, step=3.0)    # 北岸陆地
strip(base, 0.0, TOTAL, RIVER_FAR, RIVER_NEAR, BASE_BOTTOM, BED_Z, step=3.0)   # 河床
base.build("ground_base", MAT_STONE)

street = Builder()
strip(street, 0.0, TOTAL, -STREET_HALF, STREET_HALF, 0.0, 0.06, step=3.0)
strip(street, 0.0, TOTAL, STREET_HALF, STREET_HALF + 0.28, 0.0, 0.14, step=3.0)
strip(street, 0.0, TOTAL, -STREET_HALF - 0.28, -STREET_HALF, 0.0, 0.14, step=3.0)
street.build("street", MAT_PAVE)

# 石板接缝：横向每 3 m 一道，纵向错缝交替
joint = Builder()
row = 3.0
i = 0
while True:
    s = i * row
    if s > TOTAL - 0.4:
        break
    obox(joint, s, -STREET_HALF, STREET_HALF, -0.055, 0.055, 0.06, 0.075)
    uj = -1.5 if i % 2 == 0 else 1.5
    obox(joint, s + row / 2, uj - 0.055, uj + 0.055, -row / 2 + 0.08, row / 2 - 0.08, 0.06, 0.075)
    i += 1
joint.build("street_joint", MAT_JOINT)

water = Builder()
strip(water, 0.0, TOTAL, RIVER_FAR + 0.05, RIVER_NEAR - 0.05, -0.64, WATER_Z, step=4.0)
water.build("river", MAT_WATER)

bank = Builder()
strip(bank, 0.0, TOTAL, RIVER_NEAR - 0.5, RIVER_NEAR, BASE_BOTTOM, 0.26, step=4.0)
strip(bank, 0.0, TOTAL, RIVER_FAR, RIVER_FAR + 0.5, BASE_BOTTOM, 0.26, step=4.0)
bank.build("bank_wall", MAT_STONE)

# 河埠头：沿近岸每 45 m 一处入水石阶
steps = Builder()
for s0 in (30.0, 75.0, 150.0, 190.0):
    for k in range(4):
        obox(steps, s0, RIVER_NEAR - 0.55 * (k + 1), RIVER_NEAR - 0.55 * k, -1.4, 1.4,
             BED_Z, 0.1 - 0.14 * k)
steps.build("river_steps", MAT_STONE)


# ---------------------------------------------------------------- 沿街民居

WALL_H = 6.3
ROOF_H = 2.1


def house(s, side, w, depth):
    """沿街两层民居：白墙、黛瓦坡顶、腰檐、木格窗与排门板。"""
    front_u = SOUTH_FRONT if side > 0 else NORTH_FRONT
    u = side * (front_u + depth / 2)
    cx, cy = world(s, u)
    _, t = at(s)
    ang = math.atan2(t[1], t[0])
    x0, x1 = cx - w / 2, cx + w / 2
    y0, y1 = cy - depth / 2, cy + depth / 2
    front = y0 if side > 0 else y1
    sg = -1 if side > 0 else 1

    wall = Builder()
    wall.box(x0, x1, y0, y1, 0.0, WALL_H)
    wall.build("house_wall", MAT_WALL, rot=ang, pivot=(cx, cy))

    plinth = Builder()
    plinth.box(x0 - 0.08, x1 + 0.08, y0 - 0.08, y1 + 0.08, 0.0, 0.42)
    plinth.build("house_plinth", MAT_STONE, rot=ang, pivot=(cx, cy))

    wood = Builder()
    wood.box(x0 - 0.02, x1 + 0.02, y0 - 0.02, y1 + 0.02, 0.0, 0.72)  # 木裙板
    # 一层排门板
    da, db = min(front, front + sg * 0.14), max(front, front + sg * 0.14)
    wood.box(cx - w * 0.24, cx + w * 0.24, da, db, 0.1, 2.72)
    n_rib = max(4, int(w / 2.2))
    for k in range(n_rib + 1):
        rx = cx - w * 0.24 + (w * 0.48) * k / n_rib
        wood.box(rx - 0.055, rx + 0.055, da - 0.03, db + 0.03, 0.12, 2.68)
    # 一层两侧木格窗
    for wx in (cx - w * 0.33, cx + w * 0.33):
        wood.box(wx - 0.7, wx + 0.7, da - 0.02, db + 0.02, 1.1, 2.4)
        wood.box(wx - 0.06, wx + 0.06, da - 0.05, db + 0.04, 1.1, 2.4)
        wood.box(wx - 0.7, wx + 0.7, da - 0.05, db + 0.04, 1.72, 1.84)
    # 二层木格窗带
    for wx in (cx - w * 0.25, cx + w * 0.25):
        wood.box(wx - 0.95, wx + 0.95, da, db, 4.15, 5.55)
        wood.box(wx - 0.06, wx + 0.06, da - 0.05, db + 0.04, 4.15, 5.55)
        wood.box(wx - 0.95, wx + 0.95, da - 0.05, db + 0.04, 4.78, 4.9)
    # 腰檐与楼层木枋
    wood.box(x0 - 0.05, x1 + 0.05, min(front, front + sg * 0.55), max(front, front + sg * 0.55),
             3.3, 3.56)
    wood.box(x0 - 0.05, x1 + 0.05, da, db, 3.62, 3.84)
    wood.build("house_wood", MAT_WOOD, rot=ang, pivot=(cx, cy))

    tile = Builder()
    ya, yb = min(front + sg * 0.08, front + sg * 0.66), max(front + sg * 0.08, front + sg * 0.66)
    tile.box(x0 - 0.1, x1 + 0.1, ya, yb, 3.54, 3.66)  # 腰檐瓦
    tile.gable_roof(x0 - 0.7, x1 + 0.7, y0, y1, WALL_H, ROOF_H, 0.55)
    tile.box(x0 - 0.78, x1 + 0.78, cy - 0.17, cy + 0.17,
             WALL_H + ROOF_H - 0.12, WALL_H + ROOF_H + 0.08)
    tile.build("house_tile", MAT_TILE, rot=ang, pivot=(cx, cy))


def gap_wall(s_mid, gap, side):
    """民居之间用低院墙补齐，避免露出底板。"""
    front_u = SOUTH_FRONT if side > 0 else NORTH_FRONT
    wall = Builder()
    obox(wall, s_mid, front_u, front_u + 0.34, -gap / 2 + 0.1, gap / 2 - 0.1, 0.0, 2.6)
    wall.build("court_wall", MAT_WALL)
    cap = Builder()
    obox(cap, s_mid, front_u - 0.08, front_u + 0.42, -gap / 2 + 0.1, gap / 2 - 0.1, 2.6, 2.86)
    cap.build("court_wall_cap", MAT_TILE)


# 南侧临街一排（10 栋，前方留约 2.2 m）
south_spans = []
s = 5.0
while s < TOTAL - 6.0:
    w = RNG.uniform(16.0, 19.5)
    if s + w > TOTAL - 4.0:
        break
    house(s + w / 2, 1, w, RNG.uniform(7.5, 8.6))
    south_spans.append((s, s + w))
    s += w + RNG.uniform(1.6, 2.6)

for (a0, a1), (b0, b1) in zip(south_spans, south_spans[1:]):
    if b0 - a1 > 0.4:
        gap_wall((a1 + b0) / 2, b0 - a1, 1)

# 河北岸 6 栋，避开桥头
BRIDGE_S = 104.0
north_spans = []
s = 10.0
tries = 0
while len(north_spans) < 6 and tries < 40 and s < TOTAL - 12.0:
    tries += 1
    w = RNG.uniform(20.0, 27.0)
    if s + w > TOTAL - 6.0:
        break
    if not (s < BRIDGE_S + 11.0 and s + w > BRIDGE_S - 11.0):
        house(s + w / 2, -1, w, RNG.uniform(6.6, 7.8))
        north_spans.append((s, s + w))
        s += w + RNG.uniform(4.0, 6.0)
    else:
        s = BRIDGE_S + 11.0

for (a0, a1), (b0, b1) in zip(north_spans, north_spans[1:]):
    if b0 - a1 > 1.0:
        gap_wall((a1 + b0) / 2, b0 - a1, -1)


# ---------------------------------------------------------------- 单孔石拱桥

def stone_bridge(sb):
    """跨河单孔石拱桥：桥面两端与街道同高，中部缓拱，石栏杆。"""
    p, t = at(sb)
    n = normal_of(t)

    def P(u, v, z):
        return (p[0] + n[0] * u + t[0] * v, p[1] + n[1] * u + t[1] * v, z)

    ua, ub = -3.3, -13.4
    N = 18
    secs = []
    for i in range(N + 1):
        tt = i / N
        u = ua + (ub - ua) * tt
        secs.append((u, 0.06 + 1.12 * math.sin(math.pi * tt)))

    uc, R, H = -7.7, 3.6, 1.12

    def arc(u):
        q = 1.0 - ((u - uc) / R) ** 2
        return -0.55 + H * math.sqrt(max(0.0, q))

    deck = Builder()
    for i in range(N):
        u0, z0 = secs[i]
        u1, z1 = secs[i + 1]
        deck.quad(P(u0, -2.0, z0), P(u1, -2.0, z1), P(u1, 2.0, z1), P(u0, 2.0, z0))
        deck.quad(P(u0, -2.0, z0 - 0.42), P(u1, -2.0, z1 - 0.42),
                  P(u1, 2.0, z1 - 0.42), P(u0, 2.0, z0 - 0.42))
        for v in (-2.0, 2.0):
            deck.quad(P(u0, v, z0), P(u1, v, z1), P(u1, v, z1 - 0.42), P(u0, v, z0 - 0.42))
        # 拱券两侧的桥身立面
        mid = (u0 + u1) / 2
        for v in (-2.02, 2.02):
            if abs(mid - uc) < R - 0.05:
                deck.quad(P(u0, v, arc(u0)), P(u1, v, arc(u1)),
                          P(u1, v, z1 - 0.42), P(u0, v, z0 - 0.42))
            else:
                deck.quad(P(u0, v, -0.6), P(u1, v, -0.6),
                          P(u1, v, z1 - 0.42), P(u0, v, z0 - 0.42))
    for u, z in (secs[0], secs[-1]):
        deck.quad(P(u, -2.0, z), P(u, 2.0, z), P(u, 2.0, z - 0.42), P(u, -2.0, z - 0.42))
    deck.build("bridge", MAT_STONE)

    rail = Builder()
    for i in range(0, N + 1, 2):
        u, z = secs[i]
        for v in (-1.86, 1.86):
            obox(rail, sb, u - 0.07, u + 0.07, v - 0.07, v + 0.07, z - 0.02, z + 0.82)
    for i in range(N):
        u0, z0 = secs[i]
        u1, z1 = secs[i + 1]
        for v in (-1.86, 1.86):
            rail.quad(P(u0, v - 0.07, z0 + 0.82), P(u1, v - 0.07, z1 + 0.82),
                      P(u1, v + 0.07, z1 + 0.82), P(u0, v + 0.07, z0 + 0.82))
            rail.quad(P(u0, v + 0.07, z0 + 0.82), P(u1, v + 0.07, z1 + 0.82),
                      P(u1, v + 0.07, z1 + 0.68), P(u0, v + 0.07, z0 + 0.68))
            rail.quad(P(u0, v - 0.07, z0 + 0.82), P(u1, v - 0.07, z1 + 0.82),
                      P(u1, v - 0.07, z1 + 0.68), P(u0, v - 0.07, z0 + 0.68))
    rail.build("bridge_rail", MAT_STONE)


stone_bridge(BRIDGE_S)


# ---------------------------------------------------------------- 树木与灯笼杆

def tree(s, u, h, r):
    x, y = world(s, u)
    trunk = Builder()
    trunk.box(x - 0.26, x + 0.26, y - 0.26, y + 0.26, 0.0, h * 0.38)
    trunk.build("tree_trunk", MAT_TRUNK)
    leaf = Builder()
    leaf.prism(x, y, h * 0.3, h * 0.72, r, r * 0.72, 7)
    leaf.prism(x, y, h * 0.66, h * 0.96, r * 0.74, 0.35, 7)
    leaf.build("tree_leaf", MAT_LEAF)


for s, u in ((22.0, 3.85), (54.0, 3.9), (86.0, 3.85), (146.0, 3.9), (176.0, 3.85)):
    tree(s, u, RNG.uniform(5.8, 6.8), RNG.uniform(1.05, 1.3))
for s, u in ((30.0, -12.35), (64.0, -12.4), (96.0, -12.3), (124.0, -12.35),
             (164.0, -12.4), (196.0, -12.3)):
    tree(s, u, RNG.uniform(6.0, 7.2), RNG.uniform(1.1, 1.4))


def lantern(s, u=4.15):
    x, y = world(s, 3.62)
    pole = Builder()
    obox(pole, s, u - 0.09, u + 0.09, -0.09, 0.09, 0.0, 4.3)
    obox(pole, s, 3.55, u + 0.05, -0.06, 0.06, 4.02, 4.16)
    pole.build("lantern_pole", MAT_WOOD)
    lamp = Builder()
    lamp.prism(x, y, 3.12, 3.92, 0.32, 0.32, 8, 0.0)
    lamp.prism(x, y, 3.92, 4.1, 0.3, 0.1, 8, 0.0)
    lamp.prism(x, y, 2.96, 3.12, 0.1, 0.26, 8, 0.0)
    lamp.build("lantern", MAT_LANTERN)


for s in (8.0, 33.0, 58.0, 83.0, 108.0, 133.0, 158.0, 183.0):
    lantern(s)


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
    obj = bpy.data.objects.new(f"stj_{mat_name}", mesh)
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
xs, ys, zs = [], [], []
for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    obj.data.calc_loop_triangles()
    tris += len(obj.data.loop_triangles)
    for corner in obj.bound_box:
        xs.append(corner[0])
        ys.append(corner[1])
        zs.append(corner[2])

print(
    f"[shantangjie] exported {OUT} | meshes={len([o for o in bpy.data.objects if o.type == 'MESH'])} "
    f"tris={tris} materials={len(MERGED)} total_len={TOTAL:.1f}m "
    f"houses_south={len(south_spans)} houses_north={len(north_spans)}"
)
print(
    f"[shantangjie] local bbox x=[{min(xs):.1f},{max(xs):.1f}] "
    f"y=[{min(ys):.1f},{max(ys):.1f}] z=[{min(zs):.1f},{max(zs):.1f}]"
)
