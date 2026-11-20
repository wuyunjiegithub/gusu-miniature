"""拙政园程序化建模并导出 GLB（东、中、西三园布局）。

坐标约定：Blender +X = 东，+Y = 北，+Z = 上；单位为米，原点为景点质心。
glTF 导出后 +Z→+Y（up），+Y→-Z，与网页场景坐标系一致。
园墙、水面与建筑位置依据拙政园平面关系做了沙盘尺度的艺术化压缩。
"""

import json
import math
import os
import random

import bmesh
import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "zhuozhengyuan.glb")
SCENE_JSON = os.path.join(ROOT, "src", "data", "scene-geometry.json")


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
        """任意简单多边形拉伸（园墙、水面、岛屿、底板）。"""
        n = len(pts)
        for i in range(n):
            j = (i + 1) % n
            x0, y0 = pts[i]
            x1, y1 = pts[j]
            self.quad((x0, y0, z0), (x1, y1, z0), (x1, y1, z1), (x0, y0, z1))
        self.faces.append(tuple(self.V(x, y, z1) for x, y in pts))
        self.faces.append(tuple(self.V(x, y, z0) for x, y in reversed(pts)))

    def hip_roof(self, x0, x1, y0, y1, z0, h, inset, ridge=True, upturn=True):
        """庑殿顶：矩形檐口 + 正脊，带正脊压顶与四角起翘。"""
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
        # 底封口，保证法线方向稳定
        self.quad(b0, b1, b2, b3)
        scale = max(0.45, min(1.3, h / 2.8))
        if ridge and has_ridge:
            self.ridge_cap(xa, xb, ym, z0 + h, scale)
        if upturn:
            for c, out in (((x0, y0), (-1, -1)), ((x1, y0), (1, -1)),
                           ((x1, y1), (1, 1)), ((x0, y1), (-1, 1))):
                self.corner_upturn(c, out, z0, 1.0 * scale, 0.7 * scale, 0.34 * max(0.6, scale))

    def gable_roof(self, x0, x1, y0, y1, z0, h, overhang=0.0, ridge=True):
        """硬山/两坡顶：屋脊沿 X 方向，脊头起翘。"""
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
        """正脊压顶 + 两端吻兽，园林建筑取轻巧尺度。"""
        t = 0.24 * scale
        self.box(xa - t, xb + t, ym - t * 1.05, ym + t * 1.05, zr - 0.06, zr + 0.2 * scale)
        self.box(xa, xb, ym - t * 0.7, ym + t * 0.7, zr + 0.2 * scale, zr + 0.4 * scale)
        self.ridge_horn(xa - t, -1.0, ym, zr + 0.08 * scale, scale)
        self.ridge_horn(xb + t, 1.0, ym, zr + 0.08 * scale, scale)

    def ridge_horn(self, bx, out, ym, zr, scale=1.0):
        """脊端起翘的吻兽轮廓。"""
        tx = bx + out * 0.52 * scale
        w0, w1 = 0.2 * scale, 0.06 * scale
        zb, zt = zr - 0.03, zr + 0.45 * scale
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

    def corner_upturn(self, c, out, z, length=1.0, rise=0.75, w=0.34):
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

MAT_WALL = material("wall_white", hexc("e6e0d2"), 0.92)
MAT_TILE = material("tile", hexc("3b424c"), 0.8)
MAT_WOOD = material("wood", hexc("5d3c2e"), 0.85)
MAT_STONE = material("stone", hexc("a9a294"), 0.94)
MAT_WATER = material("water", hexc("31505a"), 0.22, 0.15)
MAT_GROUND = material("ground", hexc("7c8769"), 0.95)
MAT_ISLAND = material("island", hexc("71835c"), 0.95)
MAT_LEAF_A = material("leaf_a", hexc("556c48"), 0.95)
MAT_LEAF_B = material("leaf_b", hexc("475d3f"), 0.95)
MAT_TRUNK = material("trunk", hexc("6b5640"), 0.95)
MAT_ROCK = material("rock", hexc("8a8577"), 0.96)

# 景点轮廓（scene 坐标 → Blender 局部坐标）
with open(SCENE_JSON, encoding="utf-8") as f:
    geo = json.load(f)
lm = geo["landmarks"]["zhuozhengyuan"]
CX, CZ = lm["centroid"]["x"], lm["centroid"]["z"]
OUTLINE = [(x - CX, -(z - CZ)) for x, z in lm["outline"]]
if abs(OUTLINE[0][0] - OUTLINE[-1][0]) < 0.01 and abs(OUTLINE[0][1] - OUTLINE[-1][1]) < 0.01:
    OUTLINE = OUTLINE[:-1]

# ---------------------------------------------------------------- 地形与水系

# 底板：园墙范围内的"园地"（下探 0.5 m 埋入景点底座，避免与底座顶面共面）
base = Builder()
base.poly_prism(OUTLINE, -0.5, 0.0)
base.build("garden_ground", MAT_GROUND)

# 中园主水面（占全园三分之一，横长带三座岛）
POND_MAIN = [
    (-40, 30), (-34, 55), (-24, 75), (-10, 95), (14, 108), (42, 112), (68, 102),
    (86, 82), (92, 58), (84, 38), (66, 22), (42, 14), (16, 18), (0, 26), (-20, 24),
]
POND_WEST = [
    (-111, 42), (-104, 50), (-92, 53), (-82, 49), (-80, 40), (-86, 32), (-100, 31), (-109, 35),
]
POND_EAST = [
    (124, 60), (128, 72), (140, 78), (156, 77), (170, 70), (176, 60), (168, 50), (152, 46), (134, 49),
]
PONDS = [POND_MAIN, POND_WEST, POND_EAST]

water = Builder()
for pond in PONDS:
    water.poly_prism(pond, 0.04, 0.1)
water.build("pond_water", MAT_WATER)

# 湖中岛屿
ISLANDS = [
    [(4, 66), (6, 80), (18, 92), (34, 94), (44, 84), (42, 70), (28, 62), (12, 60)],
    [(-3, 37), (3, 41), (9, 37), (5, 32)],
    [(52, 92), (58, 101), (68, 102), (72, 93), (66, 86), (56, 86)],
]
island = Builder()
for i in ISLANDS:
    island.poly_prism(i, 0.1, 0.24)
island.build("pond_islands", MAT_ISLAND)

# ---------------------------------------------------------------- 园墙

WALL_H = 4.6
WALL_T = 0.9


def wall_run(p0, p1, height=WALL_H, thickness=WALL_T):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy)
    if length < 0.4:
        return
    ang = math.atan2(dy, dx)
    cx, cy = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2
    body = Builder()
    body.box(cx - length / 2, cx + length / 2, cy - thickness / 2, cy + thickness / 2, 0, height)
    body.build("garden_wall", MAT_WALL, rot=ang, pivot=(cx, cy))
    cap = Builder()
    cap.box(
        cx - length / 2 - 0.15,
        cx + length / 2 + 0.15,
        cy - thickness / 2 - 0.35,
        cy + thickness / 2 + 0.35,
        height,
        height + 0.45,
    )
    cap.build("garden_wall_cap", MAT_TILE, rot=ang, pivot=(cx, cy))


for i in range(len(OUTLINE)):
    wall_run(OUTLINE[i], OUTLINE[(i + 1) % len(OUTLINE)])

# 东/中/西园分隔墙：x=-60（别有洞天）与 x=106（通幽），各留一道洞门
for x_div, (y0, y1), gap in [
    (-60.0, (18.0, 82.0), (46.0, 54.0)),
    (106.0, (10.0, 146.0), (72.0, 80.0)),
]:
    wall_run((x_div, y0), (x_div, gap[0]))
    wall_run((x_div, gap[1]), (x_div, y1))
    # 洞门上方的门楣墙
    lintel = Builder()
    lintel.box(x_div - 0.45, x_div + 0.45, gap[0], gap[1], 3.6, WALL_H)
    lintel.build("gate_lintel", MAT_WALL)
    lintel = Builder()
    lintel.box(x_div - 0.8, x_div + 0.8, gap[0] - 0.35, gap[1] + 0.35, WALL_H, WALL_H + 0.45)
    lintel.build("gate_lintel_cap", MAT_TILE)

# ---------------------------------------------------------------- 建筑构件

BUILDINGS = []  # (cx, cy, w, d) 供树木避让


def hall(cx, cy, w, d, h, roof_h=None, z0=0.0, roof=True):
    """厅堂：粉墙 + 木裙板 + 灰瓦庑殿顶。"""
    if roof_h is None:
        roof_h = min(3.2, 0.28 * h + 1.2)
    body = Builder()
    body.box(cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2, z0, z0 + h)
    body.build("hall_wall", MAT_WALL)

    skirt = Builder()
    skirt.box(cx - w / 2 - 0.25, cx + w / 2 + 0.25, cy - d / 2 - 0.25, cy + d / 2 + 0.25, z0, z0 + 0.9)
    skirt.build("hall_skirt", MAT_WOOD)

    if roof:
        roof_b = Builder()
        inset = min(w + 2.6, d + 2.6) * 0.42
        roof_b.hip_roof(
            cx - w / 2 - 1.3, cx + w / 2 + 1.3, cy - d / 2 - 1.3, cy + d / 2 + 1.3, z0 + h, roof_h, inset
        )
        roof_b.build("hall_roof", MAT_TILE)

    BUILDINGS.append((cx, cy, w + 2, d + 2))


def pavilion(cx, cy, r, h=4.2, sides=6, z0=0.0):
    """亭：多边形亭身 + 攒尖顶 + 宝顶。"""
    body = Builder()
    body.prism(cx, cy, z0, z0 + h, r * 0.86, r * 0.82, sides, math.pi / sides)
    body.build("pavilion_body", MAT_WALL)

    seat = Builder()
    seat.prism(cx, cy, z0, z0 + 0.7, r * 0.92, r * 0.92, sides, math.pi / sides)
    seat.build("pavilion_base", MAT_WOOD)

    roof = Builder()
    roof.prism(cx, cy, z0 + h - 0.2, z0 + h + 2.0, r * 1.6, 0.32, sides, math.pi / sides)
    roof.prism(cx, cy, z0 + h + 2.0, z0 + h + 2.6, 0.3, 0.12, sides, math.pi / sides)
    roof.build("pavilion_roof", MAT_TILE)

    BUILDINGS.append((cx, cy, r * 1.6, r * 1.6))


def corridor(x0, y0, x1, y1, width=2.6, h_body=1.0, h_roof=3.3):
    """游廊 / 廊桥：矮墙 + 两坡顶。"""
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    ang = math.atan2(dy, dx)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2

    body = Builder()
    body.box(cx - length / 2, cx + length / 2, cy - width / 2, cy + width / 2, 0, h_body)
    body.build("corridor_wall", MAT_WALL, rot=ang, pivot=(cx, cy))

    roof = Builder()
    roof.gable_roof(cx - length / 2, cx + length / 2, cy - width / 2, cy + width / 2, h_roof, 1.05, width * 0.45)
    roof.build("corridor_roof", MAT_TILE, rot=ang, pivot=(cx, cy))

    BUILDINGS.append((cx, cy, length * 0.5, width + 2))


def bridge(x0, y0, x1, y1, width=3.0):
    """廊桥：桥上带顶，桥身石砌。"""
    corridor(x0, y0, x1, y1, width, 1.6, 3.9)
    length = math.hypot(x1 - x0, y1 - y0)
    ang = math.atan2(y1 - y0, x1 - x0)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    arch = Builder()
    arch.poly_prism(
        [
            (cx - length / 2, cy - width / 2),
            (cx + length / 2, cy - width / 2),
            (cx + length / 2, cy + width / 2),
            (cx - length / 2, cy + width / 2),
        ],
        0.0,
        1.6,
    )
    arch.build("bridge_body", MAT_STONE, rot=ang, pivot=(cx, cy))


# ---------------------------------------------------------------- 中园

hall(-6, 12, 18, 10, 6.6)                       # 远香堂
hall(12, 9, 10, 7, 5.6)                         # 倚玉轩
hall(30, 10, 15, 6, 5.4)                        # 香洲（船厅）
hall(34, 10, 6, 4.2, 7.6)                       # 香洲后舱
pavilion(2, 42, 3.4, 4.2)                       # 荷风四面亭
pavilion(24, 79, 4.2, 4.8, 6)                   # 雪香云蔚亭（岛）
pavilion(61, 95, 3.2, 4.2)                      # 待霜亭（岛）
hall(8, 128, 16, 10, 7.2, roof=False)           # 见山楼（下层）
hall(8, 128, 12, 7, 3.2, z0=7.2, roof_h=2.8)    # 见山楼（上层）
bridge(72, 95, 86, 95, 3.0)                     # 待霜亭岛 → 东岸廊桥

corridor(-52, 28, -40, 50)                      # 中园西廊
corridor(97, 38, 97, 80)                        # 中园东廊

# ---------------------------------------------------------------- 西园

hall(-100, 62, 18, 11, 6.6)                     # 卅六鸳鸯馆
hall(-113, 28, 10, 8, 5.8)                      # 留听阁
pavilion(-77, 41, 3.2, 4.2)                     # 与谁同坐轩
pavilion(-96, 13, 2.8, 4.0, 8)                  # 塔影亭

# 波形廊（折线三段，沿西园水池东岸）
corridor(-70, 26, -63, 34)
corridor(-63, 34, -70, 42)
corridor(-70, 42, -63, 50)

# ---------------------------------------------------------------- 东园

hall(150, 20, 18, 10, 6.6)                      # 兰雪堂
hall(184, 58, 9, 9, 5.6)                        # 芙蓉榭
hall(138, 120, 22, 11, 6.6)                     # 秫香馆
pavilion(168, 88, 4.0, 4.8)                     # 天泉亭
pavilion(118, 92, 3.0, 4.2)                     # 涵青亭
corridor(112, 46, 112, 74)                      # 东园水廊

# ---------------------------------------------------------------- 假山

RNG = random.Random(20261120)


def rockery(cx, cy, spread, count, scale=1.0):
    for i in range(count):
        a = RNG.random() * math.tau
        dist = RNG.random() * spread
        x = cx + math.cos(a) * dist
        y = cy + math.sin(a) * dist * 0.7
        r = (1.2 + RNG.random() * 2.0) * scale
        h = (1.4 + RNG.random() * 2.4) * scale
        pts = []
        sides = 6
        for k in range(sides):
            ang = k * math.tau / sides
            rr = r * (0.72 + RNG.random() * 0.5)
            pts.append((x + math.cos(ang) * rr, y + math.sin(ang) * rr))
        b = Builder()
        b.poly_prism(pts, 0.0, h)
        b.build("rockery", MAT_ROCK)
        b = Builder()
        pts2 = [(x + (px - x) * 0.55, y + (py - y) * 0.55) for px, py in pts]
        b.poly_prism(pts2, h, h + 1.2 * scale)
        b.build("rockery", MAT_ROCK)


rockery(28, 86, 14, 7, 1.1)      # 雪香云蔚亭周边土山
rockery(2, 126, 12, 5, 0.9)      # 见山楼前
rockery(56, 96, 8, 3, 0.8)       # 待霜亭岛

# ---------------------------------------------------------------- 园路

PATHS = [
    (-2.6, 2.6, -6, 12),        # 南入口 → 远香堂
    (-56, 96, 4, 8),            # 中部横路
    (4, 12, 112, 126),          # 见山楼前
    (-60, -52, 20, 48),         # 别有洞天前
    (104, 112, 70, 84),         # 通幽门前
    (150, 170, 92, 96),         # 天泉亭前
]
path = Builder()
for x0, x1, y0, y1 in PATHS:
    path.box(x0, x1, y0, y1, 0.0, 0.06)
path.build("garden_path", MAT_STONE)

# ---------------------------------------------------------------- 树木

LEAF_MATS = [MAT_LEAF_A, MAT_LEAF_B]


def tree(x, y, h, r, tone):
    trunk = Builder()
    trunk.box(x - 0.35, x + 0.35, y - 0.35, y + 0.35, 0.0, h * 0.45)
    trunk.build("tree_trunk", MAT_TRUNK)

    leaf = Builder()
    leaf.prism(x, y, h * 0.3, h * 0.78, r, r * 0.55, 7)
    leaf.prism(x, y, h * 0.68, h, r * 0.6, r * 0.14, 7)
    leaf.build("tree_leaf", LEAF_MATS[tone])


placed = []
attempts = 0
# 树木只作点缀：数量收紧、高度压在厅堂檐口以下，避免把建筑整片遮住
while len(placed) < 100 and attempts < 6000:
    attempts += 1
    x = RNG.uniform(-146, 210)
    y = RNG.uniform(-60, 164)
    if not point_in_poly(OUTLINE, x, y):
        continue
    if any(point_in_poly(p, x, y) for p in PONDS):
        continue
    if any(abs(x - bx) < bw / 2 + 7.0 and abs(y - by) < bd / 2 + 7.0 for bx, by, bw, bd in BUILDINGS):
        continue
    if any((x - px) ** 2 + (y - py) ** 2 < 30 for px, py in placed):
        continue
    placed.append((x, y))
    h = RNG.uniform(4.6, 6.8)
    r = RNG.uniform(1.6, 2.3)
    tree(x, y, h, r, 0 if RNG.random() < 0.6 else 1)

# 岛上补种
for ix, iy in [(16, 84), (30, 84), (38, 76), (24, 68), (58, 96), (66, 94)]:
    tree(ix, iy, RNG.uniform(4.4, 6.2), RNG.uniform(1.5, 2.2), 0 if RNG.random() < 0.5 else 1)

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
    obj = bpy.data.objects.new(f"zzy_{mat_name}", mesh)
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
print(
    f"[zhuozhengyuan] exported {OUT} | meshes={len([o for o in bpy.data.objects if o.type=='MESH'])} "
    f"tris={tris} trees={len(placed)}"
)
