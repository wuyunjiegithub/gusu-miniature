"""留园程序化建模并导出 GLB。

坐标约定：Blender +X = 东，+Y = 北，+Z = 上；单位为米，原点为景点质心。
glTF 导出后 +Z→+Y（up），+Y→-Z，与网页场景坐标系一致。
布局按留园真实格局做沙盘尺度压缩：中部水池居中偏北，池南涵碧山房/明瑟楼，
池北可亭，东岸曲廊；东部庭院五峰仙馆、林泉耆硕之馆、冠云楼与冠云峰；
西部土山枫林与舒啸亭；园墙沿 outline 内侧，南侧留门。
"""

import json
import math
import os
import random

import bmesh
import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "liuyuan.glb")
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


def lerp(p, q, t):
    return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)


# ---------------------------------------------------------------- 场景与材质

bpy.ops.wm.read_factory_settings(use_empty=True)

# 8 种材质：白墙 / 黛瓦 / 木 / 石 / 水 / 植被 A / 植被 B / 叠石灰
MAT_WALL = material("wall_white", hexc("f4efe4"), 0.92)
MAT_TILE = material("tile_dark", hexc("5d6672"), 0.78)
MAT_WOOD = material("wood", hexc("6b4a33"), 0.85)
MAT_STONE = material("stone", hexc("b9b3a3"), 0.94)
MAT_WATER = material("water", hexc("3f7ea6"), 0.15, 0.08)
MAT_LEAF_A = material("leaf_green", hexc("6f8f5a"), 0.95)
MAT_LEAF_B = material("leaf_light", hexc("87a26a"), 0.95)
MAT_ROCK = material("rock_limestone", hexc("cfcabf"), 0.9)

# 景点轮廓（scene 坐标 → Blender 局部坐标）
with open(SCENE_JSON, encoding="utf-8") as f:
    geo = json.load(f)
lm = geo["landmarks"]["liuyuan"]
CX, CZ = lm["centroid"]["x"], lm["centroid"]["z"]
OUTLINE = [(x - CX, -(z - CZ)) for x, z in lm["outline"]]
if abs(OUTLINE[0][0] - OUTLINE[-1][0]) < 0.01 and abs(OUTLINE[0][1] - OUTLINE[-1][1]) < 0.01:
    OUTLINE = OUTLINE[:-1]

RNG = random.Random(20261121)
BUILDINGS = []  # (cx, cy, w, d) 供树木避让


def reserve(cx, cy, w, d):
    BUILDINGS.append((cx, cy, w, d))


# ---------------------------------------------------------------- 地形与水池

# 底部地形板：按 outline 拉伸，土黄色基底
base = Builder()
base.poly_prism(OUTLINE, -0.5, 0.0)
base.build("garden_ground", MAT_STONE)

# 中部大水池（约 57m × 45m，居中略偏北）
POND = [
    (-34.0, 20.0), (-32.0, 34.0), (-26.0, 44.0), (-18.0, 50.0), (-4.0, 52.0),
    (8.0, 49.0), (18.0, 43.0), (23.0, 33.0), (22.0, 22.0), (16.0, 13.0),
    (6.0, 9.0), (-6.0, 8.0), (-20.0, 10.0), (-30.0, 13.0),
]
PCX = sum(p[0] for p in POND) / len(POND)
PCY = sum(p[1] for p in POND) / len(POND)

water = Builder()
water.poly_prism(POND, 0.06, 0.14)
water.build("pond_water", MAT_WATER)


def pond_bank(pts, width=1.6, top=0.5):
    """池岸：深灰石驳岸条（内壁 + 压顶 + 外侧）。"""
    n = len(pts)
    outer = []
    for x, y in pts:
        dx, dy = x - PCX, y - PCY
        d = math.hypot(dx, dy) or 1.0
        outer.append((x + dx / d * width, y + dy / d * width))
    b = Builder()
    for i in range(n):
        j = (i + 1) % n
        xi, yi = pts[i]
        xj, yj = pts[j]
        oi, oj = outer[i], outer[j]
        b.quad((xi, yi, top), (xj, yj, top), (xj, yj, -0.25), (xi, yi, -0.25))
        b.quad((xi, yi, top), (xj, yj, top), (oj[0], oj[1], top), (oi[0], oi[1], top))
        b.quad((oi[0], oi[1], top), (oj[0], oj[1], top), (oj[0], oj[1], -0.2), (oi[0], oi[1], -0.2))
    b.build("pond_bank", MAT_TILE)


pond_bank(POND)

# 小蓬莱岛 + 九曲桥
ISLE = [
    (-25.0, 27.0), (-22.0, 32.0), (-16.0, 33.5), (-12.0, 29.0), (-14.0, 24.5), (-21.0, 23.5),
]
isle = Builder()
isle.poly_prism(ISLE, 0.1, 0.75)
isle.build("pond_isle", MAT_LEAF_A)


def flat_bridge(pts, width=2.0, top=0.72):
    b = Builder()
    for k in range(len(pts) - 1):
        x0, y0 = pts[k]
        x1, y1 = pts[k + 1]
        dx, dy = x1 - x0, y1 - y0
        ln = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / ln * width / 2, dx / ln * width / 2
        b.quad((x0 + nx, y0 + ny, top), (x1 + nx, y1 + ny, top),
               (x1 - nx, y1 - ny, top), (x0 - nx, y0 - ny, top))
        b.quad((x0 + nx, y0 + ny, top), (x0 + nx, y0 + ny, 0.2),
               (x0 - nx, y0 - ny, 0.2), (x0 - nx, y0 - ny, top))
        b.quad((x1 + nx, y1 + ny, top), (x1 + nx, y1 + ny, 0.2),
               (x1 - nx, y1 - ny, 0.2), (x1 - nx, y1 - ny, top))
    b.build("zigzag_bridge", MAT_STONE)


flat_bridge([(-30.0, 12.5), (-24.0, 17.0), (-27.0, 21.5), (-21.0, 25.0), (-17.0, 28.5)])

# ---------------------------------------------------------------- 园墙

WALL_H = 4.5
WALL_T = 0.9
GATE_SEG = 19  # 南墙段落（索引对应数据中的 p19→p20）


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
        cx - length / 2 - 0.12,
        cx + length / 2 + 0.12,
        cy - thickness / 2 - 0.32,
        cy + thickness / 2 + 0.32,
        height,
        height + 0.42,
    )
    cap.build("garden_wall_cap", MAT_TILE, rot=ang, pivot=(cx, cy))


def gate_lintel(p0, p1, t, half_gap=3.6):
    """南门：门楣白墙 + 瓦顶 + 门槛石。"""
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy)
    ang = math.atan2(dy, dx)
    a = lerp(p0, p1, t - half_gap / length)
    b = lerp(p0, p1, t + half_gap / length)
    cx, cy = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    ln = math.hypot(b[0] - a[0], b[1] - a[1])
    lintel = Builder()
    lintel.box(cx - ln / 2, cx + ln / 2, cy - WALL_T / 2, cy + WALL_T / 2, 3.3, WALL_H)
    lintel.build("gate_lintel", MAT_WALL, rot=ang, pivot=(cx, cy))
    cap = Builder()
    cap.box(cx - ln / 2 - 0.1, cx + ln / 2 + 0.1, cy - WALL_T / 2 - 0.32,
            cy + WALL_T / 2 + 0.32, WALL_H, WALL_H + 0.42)
    cap.build("gate_cap", MAT_TILE, rot=ang, pivot=(cx, cy))
    sill = Builder()
    sill.box(cx - ln / 2, cx + ln / 2, cy - WALL_T / 2 - 0.2, cy + WALL_T / 2 + 0.2, 0.0, 0.28)
    sill.build("gate_sill", MAT_STONE, rot=ang, pivot=(cx, cy))


def outline_segments():
    n = len(OUTLINE)
    return [(OUTLINE[i], OUTLINE[(i + 1) % n], i) for i in range(n)]


for a, b, idx in outline_segments():
    if idx == GATE_SEG:
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy)
        t = (-30.0 - a[0]) / dx
        wall_run(a, lerp(a, b, t - 3.6 / length))
        wall_run(lerp(a, b, t + 3.6 / length), b)
        gate_lintel(a, b, t, 3.6)
    else:
        wall_run(a, b)

# 园墙内转角石基（增加体量感）
corner = Builder()
for i, (x, y) in enumerate(OUTLINE):
    corner.box(x - 0.75, x + 0.75, y - 0.75, y + 0.75, 0, 0.6)
corner.build("wall_footing", MAT_STONE)

# ---------------------------------------------------------------- 建筑构件


def hall(cx, cy, w, d, h, roof_h=None, z0=0.0, roof=True, door=True, face=-1):
    """厅堂：台基 + 粉墙 + 木裙板 + 灰瓦庑殿顶。face=-1 门朝南，+1 门朝北。"""
    if roof_h is None:
        roof_h = min(3.1, 0.28 * h + 1.1)
    body = Builder()
    body.box(cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2, z0, z0 + h)
    body.build("hall_wall", MAT_WALL)

    if z0 <= 0.01:
        plat = Builder()
        plat.box(cx - w / 2 - 1.1, cx + w / 2 + 1.1, cy - d / 2 - 1.1, cy + d / 2 + 1.1, 0.0, 0.35)
        plat.build("hall_platform", MAT_STONE)
        skirt = Builder()
        skirt.box(cx - w / 2 - 0.18, cx + w / 2 + 0.18, cy - d / 2 - 0.18, cy + d / 2 + 0.18, 0.35, 1.15)
        skirt.build("hall_skirt", MAT_WOOD)
    else:
        band = Builder()
        band.box(cx - w / 2 - 0.3, cx + w / 2 + 0.3, cy - d / 2 - 0.3, cy + d / 2 + 0.3, z0 - 0.3, z0 + 0.55)
        band.build("hall_band", MAT_WOOD)

    if door:
        dy = cy + face * d / 2
        y0, y1 = (dy - 0.16, dy + 0.08) if face < 0 else (dy - 0.08, dy + 0.16)
        panel = Builder()
        panel.box(cx - w * 0.17, cx + w * 0.17, y0, y1, z0 + 0.35, z0 + h * 0.8)
        panel.build("hall_door", MAT_WOOD)
        if z0 <= 0.01 and w > 12:
            # 门廊木柱
            cols = Builder()
            n = max(3, int(w / 4.2))
            ya, yb = (dy - 1.0, dy - 0.56) if face < 0 else (dy + 0.56, dy + 1.0)
            for k in range(n + 1):
                x = cx - w / 2 + 0.5 + (w - 1.0) * k / n
                cols.box(x - 0.22, x + 0.22, ya, yb, 0.35, h * 0.92)
            cols.build("hall_columns", MAT_WOOD)

    if roof:
        roof_b = Builder()
        inset = min(w + 2.6, d + 2.6) * 0.42
        roof_b.hip_roof(
            cx - w / 2 - 1.3, cx + w / 2 + 1.3, cy - d / 2 - 1.3, cy + d / 2 + 1.3,
            z0 + h, roof_h, inset,
        )
        roof_b.build("hall_roof", MAT_TILE)

    reserve(cx, cy, w + 2, d + 2)


def pavilion(cx, cy, r, h=4.0, sides=6, z0=0.0):
    """亭：石台基 + 木柱 + 攒尖瓦顶 + 宝顶。"""
    base = Builder()
    base.prism(cx, cy, z0 - 0.2, z0 + 0.3, r * 1.06, r * 1.02, sides, math.pi / sides)
    base.build("pavilion_base", MAT_STONE)

    cols = Builder()
    for i in range(sides):
        a = math.pi / sides + i * math.tau / sides
        px, py = cx + math.cos(a) * r * 0.82, cy + math.sin(a) * r * 0.82
        cols.box(px - 0.2, px + 0.2, py - 0.2, py + 0.2, z0 + 0.3, z0 + h)
    cols.build("pavilion_columns", MAT_WOOD)

    rail = Builder()
    rail.prism(cx, cy, z0 + 0.3, z0 + 0.8, r * 0.9, r * 0.9, sides, math.pi / sides)
    rail.build("pavilion_rail", MAT_WOOD)

    roof = Builder()
    roof.prism(cx, cy, z0 + h, z0 + h + 1.35, r * 1.62, r * 0.5, sides, math.pi / sides)
    roof.prism(cx, cy, z0 + h + 1.35, z0 + h + 2.15, r * 0.55, 0.2, sides, math.pi / sides)
    roof.prism(cx, cy, z0 + h + 2.15, z0 + h + 2.55, 0.22, 0.08, sides, math.pi / sides)
    roof.build("pavilion_roof", MAT_TILE)

    reserve(cx, cy, r * 1.7, r * 1.7)


def corridor(x0, y0, x1, y1, width=2.8, h=3.1, rail=True):
    """曲廊：石基 + 木柱 + 两坡瓦顶。"""
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    if length < 0.8:
        return
    ang = math.atan2(dy, dx)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    half = length / 2

    base = Builder()
    base.box(cx - half, cx + half, cy - width / 2, cy + width / 2, 0.0, 0.28)
    base.build("corridor_base", MAT_STONE, rot=ang, pivot=(cx, cy))

    wood = Builder()
    n = max(2, int(length / 3.6))
    for k in range(n + 1):
        x = cx - half + 0.35 + (length - 0.7) * k / n
        for s in (-1, 1):
            y = cy + s * (width / 2 - 0.28)
            wood.box(x - 0.17, x + 0.17, y - 0.17, y + 0.17, 0.28, h)
    if rail:
        for s in (-1, 1):
            y = cy + s * (width / 2 - 0.2)
            wood.box(cx - half, cx + half, y - 0.1, y + 0.1, 0.7, 0.95)
    wood.build("corridor_wood", MAT_WOOD, rot=ang, pivot=(cx, cy))

    roof = Builder()
    roof.gable_roof(cx - half - 0.35, cx + half + 0.35, cy - width / 2, cy + width / 2,
                    h, 1.0, width * 0.42)
    roof.build("corridor_roof", MAT_TILE, rot=ang, pivot=(cx, cy))
    reserve(cx, cy, length + 1, width + 1.5)


def paved(cx, cy, w, d, z=0.1, material=MAT_ROCK):
    b = Builder()
    b.box(cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2, 0.0, z)
    b.build("courtyard_paving", material)


# ---------------------------------------------------------------- 池南：涵碧山房 / 明瑟楼

hall(-15, 1.0, 17, 9.5, 6.4, face=1)        # 涵碧山房（面北朝水）
paved(-15, 7.0, 22, 4.0, 0.32)              # 临水月台

# 明瑟楼：两层小楼，面水
hall(7, -2.0, 10.5, 9.0, 6.2, roof=False, face=1)
hall(7, -2.0, 8.6, 7.4, 3.4, roof_h=2.5, z0=6.2, face=1)

# 池南曲廊，向东接曲廊
corridor(3.0, 4.6, 18.5, 4.2)

# ---------------------------------------------------------------- 池东：曲廊

corridor(18.5, 4.2, 26.0, 14.0)
corridor(26.0, 14.0, 23.0, 26.0)
corridor(23.0, 26.0, 30.0, 37.5)
corridor(30.0, 37.5, 37.0, 45.0)

# ---------------------------------------------------------------- 池北：可亭

pavilion(-8.0, 58.0, 3.7, 4.2, 6)

# ---------------------------------------------------------------- 东部庭院

hall(50.0, 36.0, 22.0, 12.0, 7.0)           # 五峰仙馆
hall(66.0, 16.0, 18.0, 9.0, 6.4, face=1)    # 林泉耆硕之馆（鸳鸯厅）
corridor(58.0, 28.8, 62.0, 21.0)             # 连接两馆
corridor(37.0, 45.0, 38.5, 38.5)             # 曲廊北接五峰仙馆

# 冠云楼：两层，位于庭院北侧
hall(76.0, 45.0, 13.0, 9.0, 7.2, roof=False)
hall(76.0, 45.0, 10.5, 7.0, 3.6, roof_h=2.6, z0=7.2)
paved(76.0, 45.0, 15.0, 11.0, 0.4)

# 冠云峰庭院铺地（峰居中，鸳鸯厅在南，冠云楼在北）
paved(70.0, 31.0, 26.0, 21.0, 0.12)
paved(50.0, 27.0, 22.0, 5.0, 0.12)

# 东北角补景
hall(66.0, 72.0, 12.0, 8.0, 5.8)
pavilion(40.0, 70.0, 3.0, 4.0, 6)

# 东南角院落
hall(43.0, -50.0, 11.0, 8.0, 5.4)

# ---------------------------------------------------------------- 西部土山

HILL_CX, HILL_CY, HILL_RX, HILL_RY, HILL_H = -45.0, 34.0, 20.0, 12.0, 4.2


def hill_z(x, y):
    d2 = ((x - HILL_CX) / HILL_RX) ** 2 + ((y - HILL_CY) / HILL_RY) ** 2
    if d2 >= 1.0:
        return 0.0
    return HILL_H * (1.0 - d2) ** 0.9


def build_hill(rings=6, seg=20):
    rows = []
    for k in range(1, rings + 1):
        t = k / rings
        row = []
        for s in range(seg):
            a = s * math.tau / seg
            bump = 1 + 0.07 * math.sin(3 * a + k * 0.9) + 0.04 * math.sin(5 * a + k * 2.3)
            x = HILL_CX + math.cos(a) * HILL_RX * t * bump
            y = HILL_CY + math.sin(a) * HILL_RY * t * bump
            z = HILL_H * (1 - t * t) ** 0.9 * (0.95 + 0.05 * math.sin(2 * a + k * 1.1))
            row.append((x, y, max(z, 0.0)))
        rows.append(row)
    b = Builder()
    top = (HILL_CX, HILL_CY, HILL_H)
    for s in range(seg):
        b.tri(top, rows[0][s], rows[0][(s + 1) % seg])
    for k in range(rings - 1):
        a_row, b_row = rows[k], rows[k + 1]
        for s in range(seg):
            t1 = (s + 1) % seg
            b.quad(a_row[s], a_row[t1], b_row[t1], b_row[s])
    outer = rows[-1]
    for s in range(seg):
        t1 = (s + 1) % seg
        b.quad(outer[s], outer[t1], (outer[t1][0], outer[t1][1], -0.15),
               (outer[s][0], outer[s][1], -0.15))
    b.build("west_hill", MAT_LEAF_A)


build_hill()

# 山上舒啸亭
pavilion(HILL_CX, HILL_CY + 1.0, 3.1, 3.8, 6, z0=3.9)

# 山石点缀
for px, py, r, h in [(-58.0, 26.0, 2.2, 1.6), (-33.0, 44.0, 2.0, 1.4), (-56.0, 44.0, 1.8, 1.2)]:
    b = Builder()
    pts = []
    for k in range(6):
        a = k * math.tau / 6
        rr = r * (0.7 + RNG.random() * 0.5)
        pts.append((px + math.cos(a) * rr, py + math.sin(a) * rr))
    b.poly_prism(pts, 0.0, h)
    b.build("hill_rock", MAT_ROCK)

# ---------------------------------------------------------------- 冠云峰

def peak(cx, cy, height=9.0, seed=17):
    rng = random.Random(seed)
    prof = [
        (0.00, 3.0), (1.10, 2.5), (2.20, 2.9), (3.30, 2.05), (4.45, 2.45),
        (5.60, 1.55), (6.60, 1.85), (7.60, 1.05), (8.30, 0.55), (9.00, 0.10),
    ]
    k = height / 9.0
    b = Builder()
    for i in range(len(prof) - 1):
        z0, r0 = prof[i]
        z1 = prof[i + 1][0]
        dx = 0.45 * math.sin(i * 1.9)
        dy = 0.35 * math.cos(i * 2.4)
        sides = 7
        pts = []
        for s in range(sides):
            a = s * math.tau / sides + i * 0.45
            rr = r0 * (0.72 + rng.random() * 0.5)
            pts.append((cx + dx + math.cos(a) * rr, cy + dy + math.sin(a) * rr))
        b.poly_prism(pts, z0 * k, z1 * k)
    # 底部叠石
    for i in range(3):
        a = rng.random() * math.tau
        dist = 2.6 + rng.random() * 1.4
        px, py = cx + math.cos(a) * dist, cy + math.sin(a) * dist
        r = 0.9 + rng.random() * 0.7
        pts = []
        for s in range(5):
            aa = s * math.tau / 5 + i
            rr = r * (0.7 + rng.random() * 0.5)
            pts.append((px + math.cos(aa) * rr, py + math.sin(aa) * rr))
        b.poly_prism(pts, 0.0, 0.9 + rng.random() * 1.3)
    b.build("guanyun_peak", MAT_ROCK)

    platform = Builder()
    platform.prism(cx, cy, 0.0, 0.55, 5.6, 5.2, 11, 0.2)
    platform.build("peak_platform", MAT_STONE)
    reserve(cx, cy, 12, 12)


peak(70.0, 31.0, 9.0)

# 冠云峰左右配石
for px, py, h in [(62.5, 25.5, 3.0), (77.5, 33.5, 2.4)]:
    b = Builder()
    pts = []
    for s in range(6):
        a = s * math.tau / 6 + 0.4
        rr = 1.4 + RNG.random() * 0.9
        pts.append((px + math.cos(a) * rr, py + math.sin(a) * rr))
    b.poly_prism(pts, 0.0, h)
    b.build("companion_rock", MAT_ROCK)

# ---------------------------------------------------------------- 门厅与西部院落

hall(-30.0, -66.0, 9.0, 8.0, 5.0)           # 南门门厅
hall(-40.0, -22.0, 12.0, 8.0, 5.6)          # 西部庭院厅
pavilion(-37.0, -50.0, 2.8, 3.8, 6)         # 西侧半亭
corridor(-34.0, 4.0, -40.0, 16.0)           # 西廊
corridor(-40.0, 16.0, -38.0, 26.0)

# ---------------------------------------------------------------- 园路

PATHS = [
    [(-30.0, -73.0), (-30.0, -56.0), (-27.0, -40.0), (-25.0, -24.0), (-18.0, -8.0), (-15.0, 3.0)],
    [(-36.0, 4.0), (-24.0, 4.5), (-12.0, 5.0), (0.0, 4.0), (12.0, 2.0), (20.0, -1.0)],
    [(-42.0, 54.0), (-28.0, 56.0), (-14.0, 57.0), (0.0, 54.0), (12.0, 49.0), (22.0, 44.0), (30.0, 40.0)],
    [(20.0, -2.0), (28.0, 8.0), (34.0, 20.0), (38.0, 32.0), (42.0, 44.0)],
    [(42.0, 44.0), (50.0, 56.0), (58.0, 66.0)],
    [(-34.0, 3.0), (-40.0, 16.0), (-42.0, 28.0)],
    [(-24.0, -8.0), (-34.0, -20.0), (-38.0, -34.0), (-36.0, -46.0)],
    [(43.0, -44.0), (44.0, -28.0), (40.0, -12.0)],
    [(66.0, 10.0), (70.0, 20.0), (72.0, 34.0), (72.0, 39.0)],
]


def path_strip(pts, width=2.4, top=0.09):
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


for pts in PATHS:
    path_strip(pts)

# ---------------------------------------------------------------- 树木

TREE_KINDS = ("round", "cypress", "willow")


def tree(x, y, z0, h, r, tone, kind="round"):
    trunk = Builder()
    trunk.box(x - 0.35, x + 0.35, y - 0.35, y + 0.35, z0, z0 + h * 0.5)
    trunk.build("tree_trunk", MAT_WOOD)

    leaf = Builder()
    if kind == "cypress":
        leaf.prism(x, y, z0 + h * 0.22, z0 + h * 0.62, r * 0.95, r * 0.55, 7)
        leaf.prism(x, y, z0 + h * 0.5, z0 + h * 0.85, r * 0.68, r * 0.3, 7)
        leaf.prism(x, y, z0 + h * 0.72, z0 + h * 1.02, r * 0.36, r * 0.06, 7)
    elif kind == "willow":
        leaf.prism(x, y, z0 + h * 0.4, z0 + h * 0.62, r * 1.28, r * 0.95, 9)
        leaf.prism(x, y, z0 + h * 0.55, z0 + h * 0.8, r * 0.9, r * 0.2, 9)
    else:
        leaf.prism(x, y, z0 + h * 0.3, z0 + h * 0.76, r, r * 0.58, 7)
        leaf.prism(x, y, z0 + h * 0.66, z0 + h, r * 0.62, r * 0.12, 7)
    leaf.build("tree_leaf", MAT_LEAF_B if tone else MAT_LEAF_A)


def blocked(x, y, pad=3.2):
    for bx, by, bw, bd in BUILDINGS:
        if abs(x - bx) < bw / 2 + pad and abs(y - by) < bd / 2 + pad:
            return True
    return False


placed = []

# 西部枫林（土山上，浅色叶）
maple_count = 0
while maple_count < 11 and len(placed) < 400:
    a = RNG.random() * math.tau
    d = 0.32 + RNG.random() * 0.62
    x = HILL_CX + math.cos(a) * HILL_RX * d
    y = HILL_CY + math.sin(a) * HILL_RY * d
    if math.hypot(x - HILL_CX, y - (HILL_CY + 1.0)) < 5.3:
        continue
    # 树木只作点缀：枫林拉开间距，露出土山与舒啸亭轮廓
    if any((x - px) ** 2 + (y - py) ** 2 < 22 for px, py in placed):
        continue
    placed.append((x, y))
    z0 = max(hill_z(x, y) - 0.35, -0.05)
    h = RNG.uniform(4.6, 6.2)
    tree(x, y, z0, h, RNG.uniform(1.4, 1.9), 1, "round")
    maple_count += 1

# 池岸垂柳
for x, y in [(-37.0, 24.0), (-37.0, 38.0), (-30.0, 52.0), (-10.0, 56.5),
             (8.0, 54.0), (26.0, 30.0), (-34.0, 6.0), (18.0, 7.0)]:
    placed.append((x, y))
    tree(x, y, 0.0, RNG.uniform(5.4, 6.6), RNG.uniform(1.8, 2.3), 0, "willow")

# 北 / 东侧柏树
for x, y in [(10.0, 66.0), (17.0, 73.0), (26.0, 68.0), (34.0, 64.0), (48.0, 80.0),
             (56.0, 76.0), (62.0, 84.0), (70.0, 64.0), (36.0, 88.0), (44.0, 93.0),
             (-2.0, 68.0), (8.0, 80.0)]:
    if not point_in_poly(OUTLINE, x, y):
        continue
    placed.append((x, y))
    tree(x, y, 0.0, RNG.uniform(5.4, 7.2), RNG.uniform(1.6, 2.2), 0, "cypress")

# 其余散植
attempts = 0
# 树木只作点缀：数量收紧、高度压在厅堂檐口以下，避免把建筑整片遮住
while len(placed) < 52 and attempts < 5000:
    attempts += 1
    x = RNG.uniform(-72.0, 92.0)
    y = RNG.uniform(-76.0, 101.0)
    if not point_in_poly(OUTLINE, x, y):
        continue
    if any(point_in_poly(POND, x, y) for _ in [0]):
        continue
    if any((x - px) ** 2 + (y - py) ** 2 < 28 for px, py in placed):
        continue
    if blocked(x, y):
        continue
    # 南门门洞与门厅前庭留空
    if math.hypot(x + 30.0, y + 73.0) < 10.0:
        continue
    # 土山留给枫林
    if ((x - HILL_CX) / HILL_RX) ** 2 + ((y - HILL_CY) / HILL_RY) ** 2 < 1.15:
        continue
    placed.append((x, y))
    h = RNG.uniform(4.4, 6.6)
    r = RNG.uniform(1.5, 2.2)
    kind = "cypress" if RNG.random() < 0.35 else "round"
    tree(x, y, 0.0, h, r, 1 if RNG.random() < 0.4 else 0, kind)

# 小蓬莱岛上点树
for x, y in [(-20.5, 28.0), (-16.5, 30.0)]:
    tree(x, y, 0.72, RNG.uniform(3.4, 4.2), RNG.uniform(1.2, 1.6), 0, "round")

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
    obj = bpy.data.objects.new(f"ly_{mat_name}", mesh)
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
    f"[liuyuan] exported {OUT} | meshes={len([o for o in bpy.data.objects if o.type=='MESH'])} "
    f"tris={tris} trees={len(placed)} materials={len(bpy.data.materials)}"
)
