"""狮子林程序化建模并导出 GLB。

坐标约定：Blender +X = 东，+Y = 北，+Z = 上；单位为米，原点为景点质心。
scene [x, z] → Blender (x - centroid.x, -(z - centroid.z))，
glTF export_yup=True 后 +Z→+Y、+Y→-Z，与网页场景坐标系一致。

布局（沙盘尺度）：
- 南部狭长入口院落（轮廓南端伸出的窄条）：南端留门，门厅、燕誉堂、立雪堂
- 中部偏东：不规则近矩形水池，池上折线石桥，东岸石舫，北岸小亭
- 西北：大面积太湖石假山群（多块岩体 + 二十余座嶙峋石峰 + 穿山小径）
- 北部：指柏轩，配曲廊；四周粉墙黛瓦，点植松树
"""

import json
import math
import os
import random

import bmesh
import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "shizilin.glb")
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
        """任意简单多边形拉伸。"""
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
        """硬山/两坡顶：屋脊沿 X 方向。"""
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


def edge_distance(poly, x, y):
    best = 1e9
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        dx, dy = x1 - x0, y1 - y0
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / L2))
        best = min(best, math.hypot(x - (x0 + dx * t), y - (y0 + dy * t)))
    return best


def lerp(p, q, t):
    return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)


# ---------------------------------------------------------------- 场景与材质

bpy.ops.wm.read_factory_settings(use_empty=True)

MAT_WALL = material("wall_white", hexc("e4ddcc"), 0.92)
MAT_TILE = material("tile_dark", hexc("4d545e"), 0.80)
MAT_WOOD = material("wood", hexc("7a4c33"), 0.85)
MAT_STONE = material("stone", hexc("b3ab9b"), 0.94)
MAT_WATER = material("water", hexc("2f7ea8"), 0.16, 0.05)
MAT_LEAF = material("leaf", hexc("556c48"), 0.95)
MAT_LEAF2 = material("leaf_light", hexc("6c8156"), 0.95)
MAT_ROCK = material("rock_taihu", hexc("8a8578"), 0.94)

with open(SCENE_JSON, encoding="utf-8") as f:
    geo = json.load(f)
lm = geo["landmarks"]["shizilin"]
CX, CZ = lm["centroid"]["x"], lm["centroid"]["z"]
OUTLINE = [(x - CX, -(z - CZ)) for x, z in lm["outline"]]
if abs(OUTLINE[0][0] - OUTLINE[-1][0]) < 0.01 and abs(OUTLINE[0][1] - OUTLINE[-1][1]) < 0.01:
    OUTLINE = OUTLINE[:-1]

RNG = random.Random(20261124)
BUILDINGS = []  # (cx, cy, 半宽, 半深) 供树木避让


def reserve(cx, cy, w, d):
    BUILDINGS.append((cx, cy, w / 2.0, d / 2.0))


# ---------------------------------------------------------------- 地形底板（带水池开洞）

POND = [
    (-8.0, -3.5), (4.0, -6.2), (18.0, -5.4), (26.0, 0.5), (26.0, 7.5),
    (20.0, 14.5), (8.0, 18.5), (-3.0, 16.5), (-9.0, 8.5), (-9.0, 1.5),
]

GROUND_TOP = 0.0
GROUND_BOT = -0.25
WATER_Z = -0.18


def cross_x(poly, y):
    xs = []
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        if (y0 > y) != (y1 > y):
            xs.append(x0 + (x1 - x0) * (y - y0) / (y1 - y0))
    xs.sort()
    return xs


def band_fill(b, poly, hole, z, up=True):
    """按 y 分带三角化（可挖一个洞），band 边界取所有顶点 y。"""
    ys = sorted({p[1] for p in poly})
    if hole:
        ys = sorted(set(ys) | {p[1] for p in hole})
    eps = 1e-4
    for i in range(len(ys) - 1):
        ya, yb = ys[i] + eps, ys[i + 1] - eps
        if yb - ya < 1e-5:
            continue
        xa = cross_x(poly, ya)
        xb = cross_x(poly, yb)
        for k in range(0, len(xa) - 1, 2):
            a0, a1 = xa[k], xa[k + 1]
            b0, b1 = xb[k], xb[k + 1]
            cut = None
            if hole:
                ha = cross_x(hole, ya)
                hb = cross_x(hole, yb)
                for j in range(0, len(ha) - 1, 2):
                    if a0 + 0.01 < ha[j] and ha[j + 1] < a1 - 0.01:
                        cut = (ha[j], ha[j + 1], hb[j], hb[j + 1])
                        break
            if cut:
                spans = [(a0, cut[0], b0, cut[2]), (cut[1], a1, cut[3], b1)]
            else:
                spans = [(a0, a1, b0, b1)]
            for s0a, s1a, s0b, s1b in spans:
                if up:
                    b.quad((s0a, ya, z), (s1a, ya, z), (s1b, yb, z), (s0b, yb, z))
                else:
                    b.quad((s0a, ya, z), (s0b, yb, z), (s1b, yb, z), (s1a, ya, z))


def build_ground():
    b = Builder()
    band_fill(b, OUTLINE, POND, GROUND_TOP, up=True)
    band_fill(b, OUTLINE, None, GROUND_BOT, up=False)
    n = len(OUTLINE)
    for i in range(n):
        x0, y0 = OUTLINE[i]
        x1, y1 = OUTLINE[(i + 1) % n]
        b.quad((x0, y0, GROUND_BOT), (x1, y1, GROUND_BOT), (x1, y1, GROUND_TOP), (x0, y0, GROUND_TOP))
    n = len(POND)
    for i in range(n):
        x0, y0 = POND[i]
        x1, y1 = POND[(i + 1) % n]
        b.quad((x0, y0, GROUND_BOT), (x1, y1, GROUND_BOT), (x1, y1, GROUND_TOP + 0.10), (x0, y0, GROUND_TOP + 0.10))
    b.build("ground_stone", MAT_STONE)


def pond_rim(width=0.45, top=0.10):
    """池岸压顶石 + 外沿侧壁。"""
    pcx = sum(p[0] for p in POND) / len(POND)
    pcy = sum(p[1] for p in POND) / len(POND)
    outer = []
    for x, y in POND:
        dx, dy = x - pcx, y - pcy
        d = math.hypot(dx, dy) or 1.0
        outer.append((x + dx / d * width, y + dy / d * width))
    b = Builder()
    n = len(POND)
    for i in range(n):
        j = (i + 1) % n
        xi, yi = POND[i]
        xj, yj = POND[j]
        oi, oj = outer[i], outer[j]
        b.quad((xi, yi, top), (xj, yj, top), (oj[0], oj[1], top), (oi[0], oi[1], top))
        b.quad((oi[0], oi[1], top), (oj[0], oj[1], top), (oj[0], oj[1], 0.0), (oi[0], oi[1], 0.0))
    b.build("pond_rim", MAT_ROCK)


def build_water():
    b = Builder()
    b.poly_prism(POND, GROUND_BOT, WATER_Z)
    b.build("pond_water", MAT_WATER)


build_ground()
pond_rim()
build_water()

# ---------------------------------------------------------------- 园墙与南门

WALL_H = 4.4
WALL_T = 0.7
GATE_SEG = 2  # 轮廓南端短边 (39.2,-82)->(25.7,-85.3)


def wall_run(p0, p1, height=WALL_H, thickness=WALL_T):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy)
    if length < 0.4:
        return
    ang = math.atan2(dy, dx)
    cx, cy = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2
    body = Builder()
    body.box(cx - length / 2, cx + length / 2, cy - thickness / 2, cy + thickness / 2, 0.0, height)
    body.build("garden_wall", MAT_WALL, rot=ang, pivot=(cx, cy))
    cap = Builder()
    cap.box(
        cx - length / 2 - 0.12,
        cx + length / 2 + 0.12,
        cy - thickness / 2 - 0.34,
        cy + thickness / 2 + 0.34,
        height,
        height + 0.44,
    )
    cap.build("garden_wall_cap", MAT_TILE, rot=ang, pivot=(cx, cy))


def gate(p0, p1, half_gap=2.2):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy)
    ang = math.atan2(dy, dx)
    a = lerp(p0, p1, 0.5 - half_gap / length)
    b = lerp(p0, p1, 0.5 + half_gap / length)
    wall_run(p0, a)
    wall_run(b, p1)
    cx, cy = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    ln = math.hypot(b[0] - a[0], b[1] - a[1]) + 0.5
    lintel = Builder()
    lintel.box(cx - ln / 2, cx + ln / 2, cy - WALL_T / 2, cy + WALL_T / 2, 3.1, WALL_H)
    lintel.build("gate_lintel", MAT_WALL, rot=ang, pivot=(cx, cy))
    cap = Builder()
    cap.box(cx - ln / 2 - 0.14, cx + ln / 2 + 0.14, cy - WALL_T / 2 - 0.34,
            cy + WALL_T / 2 + 0.34, WALL_H, WALL_H + 0.44)
    cap.build("gate_cap", MAT_TILE, rot=ang, pivot=(cx, cy))
    beam = Builder()
    beam.box(cx - ln / 2, cx + ln / 2, cy - WALL_T / 2 + 0.02, cy + WALL_T / 2 - 0.02, 2.9, 3.15)
    beam.build("gate_beam", MAT_WOOD, rot=ang, pivot=(cx, cy))
    sill = Builder()
    sill.box(cx - ln / 2, cx + ln / 2, cy - WALL_T / 2 - 0.2, cy + WALL_T / 2 + 0.2, 0.0, 0.22)
    sill.build("gate_sill", MAT_STONE, rot=ang, pivot=(cx, cy))


for i in range(len(OUTLINE)):
    p0, p1 = OUTLINE[i], OUTLINE[(i + 1) % len(OUTLINE)]
    if i == GATE_SEG:
        gate(p0, p1)
    else:
        wall_run(p0, p1)


# ---------------------------------------------------------------- 建筑构件


def hall(cx, cy, w, d, h, roof_h=None, face=1, roof_kind="hip", porch=True):
    """厅堂：石台基 + 粉墙 + 木裙板 + 木门 + 深色坡顶。face=1 朝北，-1 朝南。"""
    if roof_h is None:
        roof_h = min(3.2, 0.26 * h + 1.1)
    plat = Builder()
    plat.box(cx - w / 2 - 1.4, cx + w / 2 + 1.4, cy - d / 2 - 1.4, cy + d / 2 + 1.4, 0.0, 0.38)
    plat.build("hall_platform", MAT_STONE)

    body = Builder()
    body.box(cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2, 0.38, 0.38 + h)
    body.build("hall_wall", MAT_WALL)

    skirt = Builder()
    skirt.box(cx - w / 2 - 0.18, cx + w / 2 + 0.18, cy - d / 2 - 0.18, cy + d / 2 + 0.18, 0.38, 1.15)
    skirt.build("hall_skirt", MAT_WOOD)

    dy = cy + face * d / 2
    y0, y1 = (dy - 0.18, dy + 0.06) if face < 0 else (dy - 0.06, dy + 0.18)
    panel = Builder()
    panel.box(cx - w * 0.18, cx + w * 0.18, y0, y1, 0.38, h * 0.82)
    panel.build("hall_door", MAT_WOOD)
    if porch:
        cols = Builder()
        n = max(3, int(w / 4.5))
        ya, yb = (dy - 1.05, dy - 0.62) if face < 0 else (dy + 0.62, dy + 1.05)
        for k in range(n + 1):
            x = cx - w / 2 + 0.45 + (w - 0.9) * k / n
            cols.box(x - 0.21, x + 0.21, ya, yb, 0.38, h * 0.93)
        cols.build("hall_columns", MAT_WOOD)

    roof = Builder()
    if roof_kind == "hip":
        roof.hip_roof(cx - w / 2 - 1.35, cx + w / 2 + 1.35, cy - d / 2 - 1.35, cy + d / 2 + 1.35,
                      0.38 + h, roof_h, min(w + 2.7, d + 2.7) * 0.42)
    else:
        roof.gable_roof(cx - w / 2 - 1.25, cx + w / 2 + 1.25, cy - d / 2, cy + d / 2, 0.38 + h,
                        roof_h, 1.3)
    roof.build("hall_roof", MAT_TILE)

    ridge = Builder()
    ridge.box(cx - w * 0.3, cx + w * 0.3, cy - 0.32, cy + 0.32,
              0.38 + h + roof_h - 0.12, 0.38 + h + roof_h + 0.34)
    ridge.build("hall_ridge", MAT_TILE)

    reserve(cx, cy, w + 4.0, d + 4.0)


def pavilion(cx, cy, r, h=4.0, sides=6):
    base = Builder()
    base.prism(cx, cy, -0.15, 0.32, r * 1.08, r * 1.02, sides, math.pi / sides)
    base.build("pavilion_base", MAT_STONE)

    cols = Builder()
    for i in range(sides):
        a = math.pi / sides + i * math.tau / sides
        px, py = cx + math.cos(a) * r * 0.84, cy + math.sin(a) * r * 0.84
        cols.box(px - 0.19, px + 0.19, py - 0.19, py + 0.19, 0.32, h)
    cols.build("pavilion_columns", MAT_WOOD)

    rail = Builder()
    rail.prism(cx, cy, 0.32, 0.85, r * 0.92, r * 0.92, sides, math.pi / sides)
    rail.build("pavilion_rail", MAT_WOOD)

    roof = Builder()
    roof.prism(cx, cy, h, h + 1.5, r * 1.62, r * 0.48, sides, math.pi / sides)
    roof.prism(cx, cy, h + 1.5, h + 2.35, r * 0.52, 0.2, sides, math.pi / sides)
    roof.prism(cx, cy, h + 2.35, h + 2.8, 0.22, 0.07, sides, math.pi / sides)
    roof.build("pavilion_roof", MAT_TILE)
    reserve(cx, cy, r * 3.4, r * 3.4)


def corridor(x0, y0, x1, y1, width=2.8, h=3.0):
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    if length < 0.8:
        return
    ang = math.atan2(dy, dx)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    half = length / 2

    base = Builder()
    base.box(cx - half, cx + half, cy - width / 2, cy + width / 2, 0.0, 0.26)
    base.build("corridor_base", MAT_STONE, rot=ang, pivot=(cx, cy))

    wood = Builder()
    n = max(2, int(length / 3.4))
    for k in range(n + 1):
        x = cx - half + 0.35 + (length - 0.7) * k / n
        for s in (-1, 1):
            y = cy + s * (width / 2 - 0.26)
            wood.box(x - 0.16, x + 0.16, y - 0.16, y + 0.16, 0.26, h)
    for s in (-1, 1):
        y = cy + s * (width / 2 - 0.16)
        wood.box(cx - half, cx + half, y - 0.09, y + 0.09, 0.72, 0.98)
    wood.build("corridor_wood", MAT_WOOD, rot=ang, pivot=(cx, cy))

    roof = Builder()
    roof.gable_roof(cx - half - 0.32, cx + half + 0.32, cy - width / 2, cy + width / 2, h,
                    0.95, width * 0.44)
    roof.build("corridor_roof", MAT_TILE, rot=ang, pivot=(cx, cy))
    reserve(cx, cy, length + 1.4, width + 2.6)


def paved(cx, cy, w, d, z=0.09, material=MAT_ROCK):
    b = Builder()
    b.box(cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2, 0.0, z)
    b.build("garden_paving", material)


def path_strip(pts, width=2.2, top=0.08):
    for k in range(len(pts) - 1):
        x0, y0 = pts[k]
        x1, y1 = pts[k + 1]
        dx, dy = x1 - x0, y1 - y0
        ln = math.hypot(dx, dy)
        if ln < 0.5:
            continue
        ang = math.atan2(dy, dx)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        b = Builder()
        b.box(cx - ln / 2, cx + ln / 2, cy - width / 2, cy + width / 2, 0.0, top)
        b.build("garden_path", MAT_ROCK, rot=ang, pivot=(cx, cy))


# ---------------------------------------------------------------- 厅堂 / 廊 / 亭 / 桥 / 舫

# 燕誉堂（南院主厅，面北朝水）
hall(31.0, -35.0, 18.0, 9.0, 6.2, roof_h=2.9, face=1)
# 立雪堂（东院）
hall(50.0, -23.0, 13.0, 9.0, 5.8, roof_h=2.6, face=-1)
# 门厅（南端入口内）
hall(29.5, -68.0, 7.6, 6.4, 4.6, roof_h=2.1, face=1, roof_kind="gable")
# 指柏轩（北面朝山）
hall(-4.0, 50.0, 17.0, 9.0, 6.0, roof_h=2.8, face=-1)

# 北岸小亭
pavilion(16.0, 23.0, 2.8, 3.8, 6)

# 游廊：燕誉堂东接立雪堂
corridor(40.0, -33.5, 43.2, -27.5)
# 东岸曲廊：立雪堂前绕水池东、北岸至小亭
corridor(44.0, -16.0, 43.0, -5.0)
corridor(43.0, -5.0, 37.0, 6.0)
corridor(37.0, 6.0, 30.0, 14.0)
corridor(30.0, 14.0, 21.0, 20.5)
# 亭北接指柏轩
corridor(19.0, 27.0, 12.0, 33.0)
corridor(12.0, 33.0, 4.0, 41.0)
corridor(4.0, 41.0, -1.0, 45.0)


def stone_boat(cx, cy):
    """石舫：石舫体 + 木柱 + 粉墙舱 + 灰瓦顶。"""
    hull_pts = [
        (cx - 4.6, cy - 1.9), (cx + 4.2, cy - 1.7), (cx + 4.6, cy + 1.5), (cx - 4.3, cy + 1.9),
    ]
    hull = Builder()
    hull.poly_prism(hull_pts, -0.22, 0.55)
    hull.build("boat_hull", MAT_STONE)

    deck = Builder()
    deck.box(cx - 4.4, cx + 4.4, cy - 1.75, cy + 1.75, 0.55, 0.72)
    deck.build("boat_deck", MAT_ROCK)

    body = Builder()
    body.box(cx - 2.6, cx + 2.6, cy - 1.35, cy + 1.35, 0.72, 3.1)
    body.build("boat_body", MAT_WALL)

    wood = Builder()
    for k in range(5):
        x = cx - 2.6 + 5.2 * k / 4
        for s in (-1, 1):
            y = cy + s * 1.35
            wood.box(x - 0.15, x + 0.15, y - 0.16, y + 0.16, 0.72, 3.05)
    wood.box(cx - 2.75, cx + 2.75, cy - 1.42, cy + 1.42, 2.55, 3.05)
    wood.build("boat_wood", MAT_WOOD)

    roof = Builder()
    roof.gable_roof(cx - 3.1, cx + 3.1, cy - 1.35, cy + 1.35, 3.1, 1.15, 0.65)
    roof.build("boat_roof", MAT_TILE)
    reserve(cx, cy, 10.0, 5.0)


stone_boat(29.0, 2.0)


def zigzag_bridge(pts, width=1.55, top=0.62):
    b = Builder()
    for k in range(len(pts) - 1):
        x0, y0 = pts[k]
        x1, y1 = pts[k + 1]
        dx, dy = x1 - x0, y1 - y0
        ln = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / ln * width / 2, dx / ln * width / 2
        b.quad((x0 + nx, y0 + ny, top), (x1 + nx, y1 + ny, top),
               (x1 - nx, y1 - ny, top), (x0 - nx, y0 - ny, top))
        b.quad((x0 + nx, y0 + ny, top), (x0 + nx, y0 + ny, 0.18),
               (x0 - nx, y0 - ny, 0.18), (x0 - nx, y0 - ny, top))
        b.quad((x1 + nx, y1 + ny, top), (x1 + nx, y1 + ny, 0.18),
               (x1 - nx, y1 - ny, 0.18), (x1 - nx, y1 - ny, top))
    b.build("zigzag_bridge", MAT_STONE)

    for k in range(len(pts) - 1):
        x0, y0 = pts[k]
        x1, y1 = pts[k + 1]
        dx, dy = x1 - x0, y1 - y0
        ln = math.hypot(dx, dy)
        if ln < 0.6:
            continue
        ang = math.atan2(dy, dx)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        rail = Builder()
        for s in (-1, 1):
            y = cy + s * (width / 2 - 0.09)
            rail.box(cx - ln / 2, cx + ln / 2, y - 0.07, y + 0.07, top, top + 0.42)
        rail.build("bridge_rail", MAT_WOOD, rot=ang, pivot=(cx, cy))


zigzag_bridge([(2.0, -6.0), (8.0, 0.0), (4.0, 6.0), (9.0, 11.0), (11.0, 18.2)])

# ---------------------------------------------------------------- 地面铺装与小径

paved(29.0, -52.0, 7.0, 24.0, 0.10)      # 入口甬道
paved(31.0, -27.5, 16.0, 4.0, 0.09)      # 燕誉堂前月台
paved(50.0, -34.0, 13.0, 5.0, 0.09)      # 立雪堂前
paved(1.0, 40.5, 18.0, 5.0, 0.09)        # 指柏轩前

path_strip([(29.5, -84.0), (29.5, -72.0)], 4.0, 0.10)
path_strip([(27.0, -25.0), (33.0, -15.0), (33.0, -4.0)], 2.0, 0.08)
path_strip([(-11.0, 3.0), (-12.0, 9.0), (-15.0, 15.0), (-19.0, 20.0)], 1.6, 0.08)
path_strip([(-19.0, 20.0), (-17.0, 28.0), (-18.0, 36.0), (-10.0, 42.0)], 1.6, 0.08)
path_strip([(-10.0, 42.0), (-2.0, 44.0), (4.0, 42.0)], 2.0, 0.08)
path_strip([(22.0, 20.0), (14.0, 19.0), (6.0, 19.5), (-2.0, 23.0)], 1.8, 0.08)


# ---------------------------------------------------------------- 假山

MASSES = [
    (-46.0, 16.0, 9.5, 12.0, 4.8),
    (-28.0, 26.0, 9.5, 8.5, 4.2),
    (-32.0, 2.0, 8.5, 7.0, 3.4),
    (-14.0, -4.0, 6.0, 5.0, 2.6),
    (-52.0, 34.0, 7.0, 6.0, 3.6),
    (-10.0, 26.0, 6.5, 5.5, 3.0),
    (-22.0, -8.5, 7.0, 4.6, 2.4),
]


def mass_height(x, y):
    best = 0.0
    for cx, cy, rx, ry, h in MASSES:
        d2 = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2
        if d2 < 1.0:
            best = max(best, h * (1.0 - d2) ** 0.8)
    return best


def rock_mass(cx, cy, rx, ry, h, seed, seg=13, rings=5):
    """岩体：多环收分、边缘起伏的石山基座。"""
    rng = random.Random(seed)
    rows = []
    for k in range(rings):
        tt = k / rings
        scale = (1.0 - tt) ** 0.62
        z = h * (1.0 - (1.0 - tt) ** 1.35)
        row = []
        for s in range(seg):
            a = s * math.tau / seg + 0.11 * k
            bump = 1.0 + 0.17 * math.sin(3 * a + k * 1.3) + 0.10 * math.sin(5 * a + k * 0.7)
            rr = (0.86 + 0.3 * rng.random()) * bump
            row.append((cx + math.cos(a) * rx * scale * rr,
                        cy + math.sin(a) * ry * scale * rr,
                        max(z + 0.25 * math.sin(2 * a + k * 1.9) * (0.4 + 0.6 * (1 - tt)), 0.0)))
        rows.append(row)

    b = Builder()
    for k in range(rings - 1):
        A, B = rows[k], rows[k + 1]
        for s in range(seg):
            t1 = (s + 1) % seg
            b.quad(A[s], A[t1], B[t1], B[s])
    # 顶面
    top = rows[-1]
    apex = (cx + 0.6 * math.sin(seed), cy + 0.6 * math.cos(seed), h)
    for s in range(seg):
        b.tri(top[s], top[(s + 1) % seg], apex)
    # 底面封口
    bot = rows[0]
    for s in range(1, seg - 1):
        b.tri(bot[0], bot[s + 1], bot[s])
    b.build("rock_mass", MAT_ROCK)


def rock_spire(cx, cy, z0, h, r0, seed, sides=7):
    """太湖石峰：多段收放相间、横向错位的嶙峋叠石，顶部断成碎峰。"""
    rng = random.Random(seed)
    levels = [(0.00, 1.02), (0.13, 0.86), (0.27, 1.10), (0.41, 0.80),
              (0.55, 1.00), (0.68, 0.66), (0.80, 0.86), (0.90, 0.34)]
    sx = 1.0 + 0.16 * math.sin(seed * 1.3)
    sy = 1.0 + 0.16 * math.cos(seed * 0.9)
    b = Builder()
    rings = []
    px, py = cx, cy
    for i, (t, k) in enumerate(levels):
        px = cx + math.sin(t * 2.4 + seed) * r0 * 0.24
        py = cy + math.cos(t * 2.0 + seed * 0.6) * r0 * 0.22
        pts = []
        for s in range(sides):
            a = s * math.tau / sides + i * 0.21
            rr = r0 * k * (0.72 + 0.5 * rng.random())
            zz = z0 + h * t
            if i:
                zz += 0.035 * h * math.sin(a * 2.3 + i * 1.9 + seed)
            pts.append((px + math.cos(a) * rr * sx, py + math.sin(a) * rr * sy, zz))
        rings.append(pts)
    for i in range(len(rings) - 1):
        A, B = rings[i], rings[i + 1]
        for s in range(sides):
            t1 = (s + 1) % sides
            b.quad(A[s], A[t1], B[t1], B[s])
    top = rings[-1]
    apex = (px + 0.15 * r0 * math.sin(seed * 2.7), py + 0.15 * r0 * math.cos(seed * 1.7),
            z0 + h * 1.03)
    for s in range(sides):
        b.tri(top[s], top[(s + 1) % sides], apex)
    bot = rings[0]
    for s in range(1, sides - 1):
        b.tri(bot[0], bot[s + 1], bot[s])
    b.build("rock_pinnacle", MAT_ROCK)


for i, (cx, cy, rx, ry, h) in enumerate(MASSES):
    rock_mass(cx, cy, rx, ry, h, 400 + i * 17)

SPIRES = [
    # 西部主峰群（M1）：狮子林标志性的层叠湖石峰林
    (-53.0, 9.0, 9.6), (-46.5, 6.0, 12.6), (-52.5, 20.0, 9.2), (-43.0, 24.0, 11.6),
    (-39.5, 15.0, 8.6), (-48.0, 14.0, 13.4), (-41.0, 8.0, 7.6), (-55.5, 15.0, 7.8),
    # 中部（M2）
    (-33.0, 22.0, 9.8), (-25.5, 21.5, 12.2), (-31.0, 31.0, 8.4), (-22.5, 30.5, 10.2),
    (-27.0, 33.0, 7.4), (-20.0, 24.0, 7.0),
    # 南缘（M3）
    (-37.0, 0.5, 7.2), (-29.0, -1.0, 8.8), (-34.0, 7.0, 6.2), (-24.0, 5.0, 5.8),
    (-21.0, 0.5, 6.6),
    # 临水石（M4）
    (-18.0, -6.0, 5.2), (-11.0, -1.0, 6.4), (-17.5, 0.5, 4.2),
    # 西北（M5）
    (-55.0, 31.0, 7.8), (-49.0, 36.0, 6.4),
    # 池北（M6）
    (-13.5, 24.0, 5.6), (-7.0, 28.0, 6.2), (-4.0, 23.5, 4.6),
    # 散石
    (-59.0, 43.0, 6.2), (-40.0, 44.0, 5.6), (-21.0, 42.0, 4.8),
    (-60.0, 7.0, 5.4), (-39.0, -8.0, 5.4), (-24.5, -8.5, 4.8),
    (-30.0, -10.0, 6.0), (-18.0, -11.0, 5.2), (-10.5, 11.5, 3.4),
]

for i, (sx, sy, total) in enumerate(SPIRES):
    z0 = mass_height(sx, sy) * 0.82
    h = max(total - z0, 2.0)
    r0 = 0.24 * h + 0.55
    rock_spire(sx, sy, z0, h, r0, 900 + i * 13)

# 池畔散置卧石
for i, (sx, sy, rr, hh) in enumerate([(-9.5, 18.0, 2.0, 1.1), (0.5, 20.0, 1.6, 0.9),
                                     (27.0, 12.0, 1.8, 0.8), (24.0, -8.0, 1.5, 0.7)]):
    b = Builder()
    pts = []
    for s in range(7):
        a = s * math.tau / 7 + i
        rad = rr * (0.7 + 0.5 * RNG.random())
        pts.append((sx + math.cos(a) * rad, sy + math.sin(a) * rad))
    b.poly_prism(pts, 0.0, hh)
    b.build("rock_boulder", MAT_ROCK)


# ---------------------------------------------------------------- 松树 / 乔木

def tree(x, y, z0, h, r, tone=0, kind="pine"):
    trunk = Builder()
    trunk.box(x - 0.33, x + 0.33, y - 0.33, y + 0.33, z0, z0 + h * 0.55)
    trunk.build("tree_trunk", MAT_WOOD)

    leaf = Builder()
    if kind == "pine":
        leaf.prism(x, y, z0 + h * 0.30, z0 + h * 0.64, r, r * 0.62, 7)
        leaf.prism(x, y, z0 + h * 0.50, z0 + h * 0.84, r * 0.72, r * 0.38, 7)
        leaf.prism(x, y, z0 + h * 0.70, z0 + h * 1.02, r * 0.44, r * 0.07, 7)
    else:
        leaf.prism(x, y, z0 + h * 0.34, z0 + h * 0.82, r, r * 0.58, 8)
        leaf.prism(x, y, z0 + h * 0.68, z0 + h, r * 0.6, r * 0.12, 8)
    leaf.build("tree_leaf", MAT_LEAF if tone == 0 else MAT_LEAF2)


def blocked(x, y, pad=2.2):
    for bx, by, bw, bd in BUILDINGS:
        if abs(x - bx) < bw + pad and abs(y - by) < bd + pad:
            return True
    return False


def in_rock(x, y, pad=1.6):
    for cx, cy, rx, ry, h in MASSES:
        if ((x - cx) / (rx + pad)) ** 2 + ((y - cy) / (ry + pad)) ** 2 < 1.0:
            return True
    return False


PLACED = []

# 沿墙与假山外围的松树
FIXED_TREES = [
    (-64.0, 28.0, 8.6), (-66.0, 44.0, 7.8), (-56.0, 58.0, 8.2), (-40.0, 58.0, 9.0),
    (-24.0, 60.0, 8.0), (-6.0, 60.0, 8.8), (10.0, 56.0, 7.6), (20.0, 48.0, 8.4),
    (28.0, 36.0, 7.8), (34.0, 24.0, 8.2), (40.0, 12.0, 7.4), (48.0, 2.0, 8.0),
    (52.0, 14.0, 7.2), (58.0, 28.0, 8.4), (44.0, -10.0, 7.6), (58.0, -32.0, 8.2),
    (24.0, -58.0, 7.0), (34.0, -60.0, 6.6), (24.0, -78.0, 6.2), (-58.0, 4.0, 8.0),
    (-50.0, -4.0, 7.4), (6.0, 30.0, 7.2), (-66.0, 18.0, 7.6),
    (36.0, -22.0, 7.0), (54.0, -8.0, 7.8), (20.0, -22.0, 6.8), (14.0, -32.0, 6.4),
    (-62.0, -8.0, 7.2), (44.0, 28.0, 7.4), (34.0, 42.0, 7.6),
]
for tx, ty, th in FIXED_TREES:
    if not point_in_poly(OUTLINE, tx, ty) or edge_distance(OUTLINE, tx, ty) < 2.6:
        continue
    if point_in_poly(POND, tx, ty) or in_rock(tx, ty) or blocked(tx, ty):
        continue
    if any((tx - px) ** 2 + (ty - py) ** 2 < 16 for px, py in PLACED):
        continue
    PLACED.append((tx, ty))
    # 树木只作点缀：高度压在厅堂檐口以下，避免把建筑整片遮住
    tree(tx, ty, 0.0, th * 0.72, RNG.uniform(1.5, 2.1), 0 if RNG.random() < 0.7 else 1, "pine")

# 随机补植
attempts = 0
while len(PLACED) < 22 and attempts < 4000:
    attempts += 1
    x = RNG.uniform(-72.0, 64.0)
    y = RNG.uniform(-82.0, 70.0)
    if not point_in_poly(OUTLINE, x, y) or edge_distance(OUTLINE, x, y) < 3.2:
        continue
    if point_in_poly(POND, x, y):
        continue
    if in_rock(x, y, 2.4) or blocked(x, y, 2.6):
        continue
    if math.hypot(x - 29.5, y + 84.0) < 8.0:
        continue
    if any((x - px) ** 2 + (y - py) ** 2 < 26 for px, py in PLACED):
        continue
    PLACED.append((x, y))
    tree(x, y, 0.0, RNG.uniform(4.6, 6.4), RNG.uniform(1.5, 2.1),
         0 if RNG.random() < 0.6 else 1, "pine" if RNG.random() < 0.72 else "round")

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
    obj = bpy.data.objects.new(f"szl_{mat_name}", mesh)
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
for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    obj.data.calc_loop_triangles()
    tris += len(obj.data.loop_triangles)
    for v in obj.data.vertices:
        for i in range(3):
            lo[i] = min(lo[i], v.co[i])
            hi[i] = max(hi[i], v.co[i])

print(
    f"[shizilin] exported {OUT} | meshes={len([o for o in bpy.data.objects if o.type=='MESH'])} "
    f"tris={tris} trees={len(PLACED)} materials={len(bpy.data.materials)}"
)
print(f"[shizilin] bbox x={hi[0]-lo[0]:.1f} y={hi[1]-lo[1]:.1f} z={hi[2]-lo[2]:.1f} "
      f"min_z={lo[2]:.3f} max_z={hi[2]:.2f}")
