"""桃花坞大街沿街样板段程序化建模并导出 GLB。

坐标约定：Blender +X = 东，+Y = 北，+Z = 上；单位米，原点 = 桃花坞片区质心
(-1195.7, -1181.6)。场景坐标 [x, z] → Blender (x - CX, -(z - CZ))；
glTF export_yup=True，与网页场景坐标系一致。

样板段严格取 scene path 的 5 个点（全长约 221.5 m）：
14 m 石板街（条石分缝 + 条石路缘 + 石阶）、两侧连续街墙式二/三层民居商铺
（排门板、木格窗、腰檐、瓦垄、硬山起伏山墙）、跨街砖木牌坊 2 座、
院墙门楼、灯笼杆、街心树池，沿街成排桃花。

底板沿走廊 ±20 m、z 从 -1.25 到 0，顶面与网页 baseY=1.25 的街面齐平。
"""

import json
import math
import os
import random

import bmesh
import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "taohuawu.glb")
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
        """两坡顶：屋脊沿 X 方向，脊头起翘。"""
        ya, yb = y0 - overhang, y1 + overhang
        ym = (y0 + y1) / 2
        self.quad((x0, ya, z0), (x1, ya, z0), (x1, ym, z0 + h), (x0, ym, z0 + h))
        self.quad((x0, yb, z0), (x1, yb, z0), (x1, ym, z0 + h), (x0, ym, z0 + h))
        self.tri((x0, ya, z0), (x0, yb, z0), (x0, ym, z0 + h))
        self.tri((x1, ya, z0), (x1, yb, z0), (x1, ym, z0 + h))
        self.quad((x0, ya, z0), (x1, ya, z0), (x1, yb, z0), (x0, yb, z0))
        if ridge:
            self.ridge_cap(x0, x1, ym, z0 + h, max(0.4, min(1.0, h / 2.2)))

    def ridge_cap(self, xa, xb, ym, zr, scale=1.0):
        """正脊压顶 + 两端吻兽，民居尺度较殿宇轻巧。"""
        t = 0.24 * scale
        self.box(xa - t, xb + t, ym - t * 1.05, ym + t * 1.05, zr - 0.06, zr + 0.2 * scale)
        self.box(xa, xb, ym - t * 0.7, ym + t * 0.7, zr + 0.2 * scale, zr + 0.4 * scale)
        self.ridge_horn(xa - t, -1.0, ym, zr + 0.08 * scale, scale)
        self.ridge_horn(xb + t, 1.0, ym, zr + 0.08 * scale, scale)

    def ridge_horn(self, bx, out, ym, zr, scale=1.0):
        """脊端起翘的吻兽轮廓。"""
        tx = bx + out * 0.5 * scale
        w0, w1 = 0.2 * scale, 0.06 * scale
        zb, zt = zr - 0.03, zr + 0.42 * scale
        h0, h1 = 0.14 * scale, 0.06 * scale
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

    def build(self, name, material, rot=0.0, pos=(0.0, 0.0)):
        entry = MERGED.setdefault(material.name, [material, [], []])
        offset = len(entry[1])
        ox, oy = pos
        if rot:
            c, s = math.cos(rot), math.sin(rot)
            verts = [
                (ox + x * c - y * s, oy + x * s + y * c, z) for x, y, z in self.verts
            ]
        else:
            verts = [(ox + x, oy + y, z) for x, y, z in self.verts]
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

MAT_WALL = material("wall", hexc("e4ddcc"), 0.94)
MAT_TILE = material("tile", hexc("4d545e"), 0.82)
MAT_WOOD = material("wood", hexc("7a4c33"), 0.86)
MAT_STONE = material("stone", hexc("b3ab9b"), 0.95)
MAT_LEAF = material("leaf", hexc("556c48"), 0.95)
MAT_BLOSSOM = material("blossom", hexc("c98a9c"), 0.9)

with open(SCENE_JSON, encoding="utf-8") as f:
    geo = json.load(f)
lm = geo["landmarks"]["taohuawu"]
CX, CZ = lm["centroid"]["x"], lm["centroid"]["z"]

# 任务指定的 5 点（scene 坐标）→ Blender 局部 (x-cx, -(z-cz))
SAMPLE = [
    (-1102.2, -1197.9),
    (-1168.4, -1189.9),
    (-1184.2, -1190.7),
    (-1195.7, -1181.6),
    (-1315.5, -1148.2),
]
PTS = [(x - CX, -(z - CZ)) for x, z in SAMPLE]

SEGMENTS = []
CUM = [0.0]
for i in range(len(PTS) - 1):
    a, b = PTS[i], PTS[i + 1]
    d = math.hypot(b[0] - a[0], b[1] - a[1])
    SEGMENTS.append((a, b, d))
    CUM.append(CUM[-1] + d)
TOTAL = CUM[-1]


def at(s):
    s = max(0.0, min(TOTAL, s))
    for i, (a, b, d) in enumerate(SEGMENTS):
        if s <= CUM[i + 1] or i == len(SEGMENTS) - 1:
            t = (s - CUM[i]) / d if d else 0.0
            return lerp(a, b, t), ((b[0] - a[0]) / d, (b[1] - a[1]) / d)
    return PTS[-1], (0.0, 1.0)


def normal_of(t):
    return (-t[1], t[0])


def world(s, u):
    p, t = at(s)
    n = normal_of(t)
    return (p[0] + n[0] * u, p[1] + n[1] * u)


def obox(b, s, u0, u1, v0, v1, z0, z1):
    p, t = at(s)
    n = normal_of(t)

    def P(u, v, z):
        return (p[0] + n[0] * u + t[0] * v, p[1] + n[1] * u + t[1] * v, z)

    b.quad(P(u0, v0, z0), P(u1, v0, z0), P(u1, v0, z1), P(u0, v0, z1))
    b.quad(P(u0, v1, z0), P(u1, v1, z0), P(u1, v1, z1), P(u0, v1, z1))
    b.quad(P(u0, v0, z0), P(u0, v1, z0), P(u0, v1, z1), P(u0, v0, z1))
    b.quad(P(u1, v0, z0), P(u1, v1, z0), P(u1, v1, z1), P(u1, v0, z1))
    b.quad(P(u0, v0, z0), P(u1, v0, z0), P(u1, v1, z0), P(u0, v1, z0))
    b.quad(P(u0, v0, z1), P(u1, v0, z1), P(u1, v1, z1), P(u0, v1, z1))


def strip(b, s0, s1, ua, ub, zb, zt, step=3.0):
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


# ---------------------------------------------------------------- 底板 / 街面

STREET_HALF = 7.0
CURB = 0.24
FRONT = 7.6
BASE_HALF = 20.0
STREET_Z = 0.05

base = Builder()
strip(base, -2.0, TOTAL + 2.0, -BASE_HALF, BASE_HALF, -1.25, 0.0, step=10.0)
base.build("ground_base", MAT_STONE)

street = Builder()
strip(street, 0.0, TOTAL, -STREET_HALF, STREET_HALF, 0.0, STREET_Z, step=3.5)
# 两侧条石路缘
strip(street, 0.0, TOTAL, STREET_HALF - CURB, STREET_HALF, 0.0, 0.2, step=6.0)
strip(street, 0.0, TOTAL, -STREET_HALF, -STREET_HALF + CURB, 0.0, 0.2, step=6.0)
# 条石铺装纵缝
strip(street, 0.0, TOTAL, -0.05, 0.05, STREET_Z, STREET_Z + 0.028, step=8.0)
# 条石铺装横缝
s_joint = 3.0
while s_joint < TOTAL - 1.0:
    obox(street, s_joint, -6.9, 6.9, -0.045, 0.045, STREET_Z, STREET_Z + 0.028)
    s_joint += 10.0
street.build("street_pave", MAT_STONE)


# ---------------------------------------------------------------- 民居商铺

def roof_rib(b, x, y0, z0, y1, z1, hw=0.055, t=0.05):
    """屋面上沿坡向的瓦垄窄条。"""
    dy, dz = y1 - y0, z1 - z0
    L = math.hypot(dy, dz)
    if dy > 0:
        ny, nz = -dz / L, dy / L
    else:
        ny, nz = dz / L, -dy / L
    base = [(x - hw, y0, z0), (x + hw, y0, z0), (x + hw, y1, z1), (x - hw, y1, z1)]
    top = [(px, py + ny * t, pz + nz * t) for px, py, pz in base]
    b.quad(top[0], top[1], top[2], top[3])
    for i in range(4):
        j = (i + 1) % 4
        b.quad(base[i], base[j], top[j], top[i])


def building(s_mid, side, w, depth, storeys, idx):
    """沿街民居商铺：局部 x = 面阔，-y = 临街面。"""
    p, t = at(s_mid)
    n = normal_of(t)
    ang = math.atan2(t[1], t[0]) + (0.0 if side > 0 else math.pi)
    pos = (
        p[0] + n[0] * side * (FRONT + depth / 2),
        p[1] + n[1] * side * (FRONT + depth / 2),
    )
    front, back = -depth / 2, depth / 2
    ym = 0.0

    H = RNG.uniform(7.4, 8.0) if storeys == 2 else RNG.uniform(9.7, 10.3)
    rh = 1.9 if storeys == 2 else 2.0
    bays = max(3, min(5, int(round(w / 5.2))))
    bw = w / bays
    shop = idx % 4 != 3

    wall = Builder()
    wall.box(-w / 2, w / 2, front, back, 0.0, H)
    wall.build("house_wall", MAT_WALL, rot=ang, pos=pos)

    # 硬山起伏山墙 + 瓦压顶
    wall = Builder()
    cap = Builder()
    bands = [(front, front + depth * 0.35, H + 1.5),
             (front + depth * 0.35, back - depth * 0.35, H + 2.1),
             (back - depth * 0.35, back, H + 1.5)]
    for xe in (-w / 2 - 0.17, w / 2 + 0.17):
        for ya, yb, top in bands:
            wall.box(xe - 0.17, xe + 0.17, ya, yb, H - 0.9, top)
            cap.box(xe - 0.25, xe + 0.25, ya - 0.07, yb + 0.07, top, top + 0.14)
    wall.build("house_gable", MAT_WALL, rot=ang, pos=pos)
    cap.build("house_gable_cap", MAT_TILE, rot=ang, pos=pos)

    stone = Builder()
    stone.box(-w / 2 - 0.08, w / 2 + 0.08, front - 0.14, back, 0.0, 0.5)
    stone.box(-w / 2 + 0.4, w / 2 - 0.4, front - 0.4, front - 0.14, 0.0, 0.2)
    stone.build("house_stone", MAT_STONE, rot=ang, pos=pos)

    wood = Builder()
    pane = Builder()
    wood.box(-w / 2 + 0.03, w / 2 - 0.03, front - 0.06, front + 0.05, 0.5, 0.85)

    # 一层按开间划分：排门板 / 板门 + 木格窗
    for i in range(bays):
        xc = -w / 2 + (i + 0.5) * bw
        if shop:
            wood.box(xc - bw / 2 + 0.3, xc + bw / 2 - 0.3,
                     front - 0.1, front + 0.04, 0.55, 3.15)
            for k in (-0.28, 0.28):
                rx = xc + bw * k
                wood.box(rx - 0.05, rx + 0.05, front - 0.16, front - 0.09, 0.55, 3.15)
        else:
            wood.box(xc - 0.75, xc + 0.75, front - 0.1, front + 0.04, 0.55, 2.95)
            wood.box(xc - 0.05, xc + 0.05, front - 0.14, front - 0.08, 0.55, 2.95)
            wx = xc + bw * 0.27
            wood.box(wx - 0.78, wx + 0.78, front - 0.12, front + 0.04, 1.15, 2.6)
            pane.box(wx - 0.64, wx + 0.64, front - 0.18, front - 0.1, 1.28, 2.47)

    # 开间木柱（竖向分割，避免大片空白墙）
    for i in range(1, bays):
        xc = -w / 2 + i * bw
        wood.box(xc - 0.09, xc + 0.09, front - 0.14, front + 0.02, 0.55, 3.4)

    # 楼层木枋
    wood.box(-w / 2 + 0.05, w / 2 - 0.05, front - 0.08, front + 0.03, 3.3, 3.5)

    # 腰檐（瓦）与檐口木枋
    eave = Builder()
    eave.gable_roof(-w / 2 - 0.1, w / 2 + 0.1, front - 0.85, front + 0.05, 3.5, 0.42)
    eave.build("house_eave", MAT_TILE, rot=ang, pos=pos)
    wood.box(-w / 2 + 0.02, w / 2 - 0.02, front - 0.92, front - 0.83, 3.38, 3.52)

    # 二层 / 三层木格窗（每开间一扇）
    rows = storeys - 1
    for row in range(rows):
        z0 = 4.4 + row * 2.45
        for i in range(bays):
            xc = -w / 2 + (i + 0.5) * bw
            wood.box(xc - 1.15, xc + 1.15, front - 0.14, front + 0.04, z0, z0 + 1.55)
            pane.box(xc - 1.0, xc + 1.0, front - 0.2, front - 0.11, z0 + 0.13, z0 + 1.42)
            wood.box(xc - 0.05, xc + 0.05, front - 0.23, front - 0.18, z0 + 0.13, z0 + 1.42)

    # 背立面木枋与两扇小窗，避免大面积空白
    wood.box(-w / 2 + 0.4, w / 2 - 0.4, back - 0.05, back + 0.08, 3.3, 3.5)
    for wx in (-w * 0.22, w * 0.22):
        pane.box(wx - 0.7, wx + 0.7, back - 0.02, back + 0.07, 4.6, 5.9)

    # 匾额 / 招幌
    wood.box(-min(2.6, w * 0.22), min(2.6, w * 0.22), front - 0.36, front - 0.2, 3.58, 4.12)
    if idx % 5 == 0:
        wood.box(-0.06, 0.06, front - 1.35, front - 0.02, 4.5, 4.64)
        wood.box(-0.05, 0.05, front - 1.3, front - 1.1, 2.9, 4.5)
    wood.build("house_wood", MAT_WOOD, rot=ang, pos=pos)
    pane.build("house_window_pane", MAT_TILE, rot=ang, pos=pos)

    roof = Builder()
    roof.gable_roof(-w / 2 - 0.5, w / 2 + 0.5, front, back, H, rh, 0.45)
    roof.box(-w / 2 - 0.58, w / 2 + 0.58, -0.17, 0.17, H + rh - 0.16, H + rh + 0.16)
    roof.box(-w / 2 - 0.5, w / 2 + 0.5, front - 0.52, front - 0.42, H - 0.12, H + 0.02)
    n_rib = max(3, int(w / 7.0))
    for i in range(n_rib):
        rx = -w / 2 + w * (i + 0.5) / n_rib
        roof_rib(roof, rx, front - 0.45, H, ym, H + rh)
    roof.build("house_roof", MAT_TILE, rot=ang, pos=pos)

    return s_mid - w / 2, s_mid + w / 2


# 连续街墙：每侧 8 栋，巷口仅 1.2~1.8 m
SPANS = {1: [], -1: []}
HOUSE_ID = 0
DETAIL = {1: 0, -1: 0}
for side in (1, -1):
    n_h = 8
    s_start, s_end = 16.0, TOTAL - 16.0
    gaps = [RNG.uniform(1.2, 1.8) for _ in range(n_h - 1)]
    weights = [RNG.uniform(0.9, 1.1) for _ in range(n_h)]
    remain = (s_end - s_start) - sum(gaps)
    scale = remain / sum(weights)
    widths = [wt * scale for wt in weights]
    cursor = s_start
    for i in range(n_h):
        w = widths[i]
        depth = RNG.uniform(9.0, 11.5)
        storeys = 3 if i in (3, 6) else 2
        a, b = building(cursor + w / 2, side, w, depth, storeys, HOUSE_ID)
        SPANS[side].append((a, b))
        HOUSE_ID += 1
        cursor = b + (gaps[i] if i < n_h - 1 else 0.0)


# ---------------------------------------------------------------- 巷口 / 院墙 / 门楼

def court_wall(s0, s1, side):
    length = s1 - s0
    if length < 1.0:
        return None
    mid = (s0 + s1) / 2
    ua, ub = (FRONT, FRONT + 0.4) if side > 0 else (-FRONT - 0.4, -FRONT)
    b = Builder()
    obox(b, mid, ua, ub, -length / 2, length / 2, 0.0, 2.75)
    b.build("court_wall", MAT_WALL)
    b = Builder()
    obox(b, mid, ua - 0.12, ub + 0.12, -length / 2 - 0.09, length / 2 + 0.09, 2.75, 3.06)
    b.build("court_wall_cap", MAT_TILE)
    return mid


def gatehouse(s, side):
    p, t = at(s)
    n = normal_of(t)
    ang = math.atan2(t[1], t[0])
    pos = (
        p[0] + n[0] * side * (FRONT + 0.55),
        p[1] + n[1] * side * (FRONT + 0.55),
    )
    front, back = -0.65, 0.65

    wall = Builder()
    wall.box(-1.75, 1.75, front, back, 0.0, 3.35)
    wall.build("gate_wall", MAT_WALL, rot=ang, pos=pos)

    stone = Builder()
    stone.box(-1.9, 1.9, front - 0.14, back, 0.0, 0.42)
    stone.box(-1.1, 1.1, front - 0.55, front - 0.14, 0.0, 0.2)
    stone.build("gate_stone", MAT_STONE, rot=ang, pos=pos)

    wood = Builder()
    wood.box(-1.0, 1.0, front - 0.12, front + 0.04, 0.42, 2.55)
    wood.box(-0.05, 0.05, front - 0.16, front - 0.1, 0.42, 2.55)
    wood.box(-1.2, 1.2, front - 0.24, front + 0.02, 2.55, 2.9)
    wood.build("gate_wood", MAT_WOOD, rot=ang, pos=pos)

    roof = Builder()
    roof.gable_roof(-2.15, 2.15, front - 0.25, back + 0.25, 3.35, 0.95, 0.4)
    roof.box(-2.25, 2.25, -0.12, 0.12, 4.16, 4.36)
    roof.build("gate_roof", MAT_TILE, rot=ang, pos=pos)


for side in (1, -1):
    spans = sorted(SPANS[side])
    court_wall(6.0, spans[0][0], side)
    court_wall(spans[-1][1], TOTAL - 6.0, side)
    gatehouse((6.0 + spans[0][0]) / 2, side)

# 巷口木门（退进 2.4 m，增强街墙连续感）
for side in (1, -1):
    spans = sorted(SPANS[side])
    for a, b in zip(spans, spans[1:]):
        gap = b[0] - a[1]
        if gap > 0.8:
            wg = Builder()
            obox(wg, (a[1] + b[0]) / 2, side * (FRONT + 2.2), side * (FRONT + 2.32),
                 -gap / 2, gap / 2, 0.0, 2.5)
            wg.build("alley_gate", MAT_WOOD)


# ---------------------------------------------------------------- 牌坊

def paifang(s):
    p, t = at(s)
    ang = math.atan2(t[1], t[0]) + math.pi / 2
    pos = (p[0], p[1])

    stone = Builder()
    for x in (-6.3, -2.3, 2.3, 6.3):
        stone.box(x - 0.72, x + 0.72, -0.72, 0.72, 0.0, 0.85)
    stone.build("pf_pedestal", MAT_STONE, rot=ang, pos=pos)

    wall = Builder()
    for x in (-6.3, -2.3, 2.3, 6.3):
        top = 6.55 if abs(x) < 3 else 5.95
        wall.box(x - 0.4, x + 0.4, -0.4, 0.4, 0.85, top)
    wall.build("pf_pillar", MAT_WALL, rot=ang, pos=pos)

    wood = Builder()
    wood.box(-6.7, 6.7, -0.46, 0.46, 5.0, 5.42)
    wood.box(-6.7, -1.9, -0.38, 0.38, 5.42, 5.78)
    wood.box(1.9, 6.7, -0.38, 0.38, 5.42, 5.78)
    wood.box(-1.9, 1.9, -0.62, -0.44, 5.5, 6.5)
    wood.build("pf_beam", MAT_WOOD, rot=ang, pos=pos)

    roof = Builder()
    roof.gable_roof(-7.15, -2.15, -1.85, 1.85, 5.78, 1.05)
    roof.gable_roof(2.15, 7.15, -1.85, 1.85, 5.78, 1.05)
    roof.gable_roof(-3.0, 3.0, -2.2, 2.2, 6.55, 1.3)
    roof.gable_roof(-1.9, 1.9, -1.5, 1.5, 7.85, 0.8)
    roof.box(-1.9, 1.9, -0.2, 0.2, 8.6, 8.82)
    roof.build("pf_roof", MAT_TILE, rot=ang, pos=pos)


PAIFANG_S = [13.0, TOTAL - 13.0]
for ps in PAIFANG_S:
    paifang(ps)


# ---------------------------------------------------------------- 桃树 / 树池 / 灯笼


def peach_tree(x, y, scale=1.0):
    trunk = Builder()
    trunk.box(x - 0.18 * scale, x + 0.18 * scale, y - 0.18 * scale,
              y + 0.18 * scale, 0.0, 2.7 * scale)
    trunk.box(x - 0.07, x + 0.07, y - 0.55 * scale, y + 0.55 * scale, 2.2, 2.36)
    trunk.build("tree_trunk", MAT_WOOD)

    leaf = Builder()
    leaf.prism(x, y, 2.15 * scale, 3.25 * scale, 1.7 * scale, 1.5 * scale, 7)
    leaf.build("tree_leaf", MAT_LEAF)

    blossom = Builder()
    blossom.prism(x, y, 2.75 * scale, 5.0 * scale, 1.7 * scale, 0.35, 7)
    for k in range(2):
        a = k * math.pi + 0.9
        bx = x + math.cos(a) * 0.95 * scale
        by = y + math.sin(a) * 0.95 * scale
        blossom.prism(bx, by, 3.55 * scale, 4.65 * scale, 0.72 * scale, 0.16, 6)
    blossom.build("tree_blossom", MAT_BLOSSOM)


def lantern_pole(s, side):
    x, y = world(s, side * 6.75)
    wood = Builder()
    wood.box(x - 0.1, x + 0.1, y - 0.1, y + 0.1, 0.0, 4.7)
    wood.box(x - 0.75, x + 0.75, y - 0.05, y + 0.05, 4.5, 4.64)
    wood.box(x - 0.28, x + 0.28, y - 0.28, y + 0.28, 3.25, 3.35)
    wood.build("lantern_pole", MAT_WOOD)

    paper = Builder()
    paper.prism(x, y, 3.35, 4.45, 0.29, 0.22, 6, 0.0)
    paper.build("lantern_paper", MAT_WALL)


PLANTER_S = [48.0, 112.0, 176.0]
TREE_STATIONS = []
s = 9.0
while s < TOTAL - 4.0:
    TREE_STATIONS.append(s)
    s += 8.6

TREE_COUNT = 0
for k, ts in enumerate(TREE_STATIONS):
    side = 1 if k % 2 == 0 else -1
    if any(abs(ts - ps) < 6.5 for ps in PAIFANG_S):
        continue
    if any(abs(ts - p) < 4.0 for p in PLANTER_S):
        continue
    x, y = world(ts, side * 5.65)
    peach_tree(x, y, RNG.uniform(0.95, 1.05))
    TREE_COUNT += 1

# 街心树池 / 花坛
for ps in PLANTER_S:
    x, y = world(ps, 0.0)
    b = Builder()
    b.box(x - 1.35, x + 1.35, y - 1.35, y - 1.05, 0.05, 0.45)
    b.box(x - 1.35, x + 1.35, y + 1.05, y + 1.35, 0.05, 0.45)
    b.box(x - 1.35, x - 1.05, y - 1.05, y + 1.05, 0.05, 0.45)
    b.box(x + 1.05, x + 1.35, y - 1.05, y + 1.05, 0.05, 0.45)
    b.box(x - 1.05, x + 1.05, y - 1.05, y + 1.05, 0.05, 0.3)
    b.build("planter", MAT_STONE)
    peach_tree(x, y, 1.02)
    TREE_COUNT += 1

for i, s in enumerate((30.5, 64.9, 99.3, 133.7, 168.1, 193.9)):
    if any(abs(s - ps) < 4.0 for ps in PAIFANG_S):
        continue
    if any(abs(s - ts) < 2.6 for ts in TREE_STATIONS):
        continue
    lantern_pole(s, 1 if i % 2 == 0 else -1)


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
    obj = bpy.data.objects.new(f"thw_{mat_name}", mesh)
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
lo = [1e9, 1e9, 1e9]
hi = [-1e9, -1e9, -1e9]
meshes = 0
for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    meshes += 1
    obj.data.calc_loop_triangles()
    tris += len(obj.data.loop_triangles)
    for v in obj.data.vertices:
        for i in range(3):
            lo[i] = min(lo[i], v.co[i])
            hi[i] = max(hi[i], v.co[i])

print(
    f"[taohuawu] exported {OUT} | meshes={meshes} tris={tris} mats={len(MERGED)} "
    f"len={TOTAL:.1f}m houses={sum(len(v) for v in SPANS.values())} trees={TREE_COUNT} "
    f"size={os.path.getsize(OUT) / 1024:.1f}KB"
)
print(
    f"[taohuawu] bbox x[{lo[0]:.1f},{hi[0]:.1f}] y[{lo[1]:.1f},{hi[1]:.1f}] "
    f"z[{lo[2]:.2f},{hi[2]:.1f}] street_z={STREET_Z}"
)
