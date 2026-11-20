"""沧浪亭程序化建模并导出 GLB。

坐标约定：Blender +X = 东，+Y = 北，+Z = 上；单位为米，原点为景点质心。
scene [x, z] → Blender (x - centroid.x, -(z - centroid.z))；
glTF export_yup=True 后 +Z→+Y、+Y→-Z，与网页场景一致。

沧浪亭最独特之处是「水面在园外、山在园内」：北墙外侧一条带状水面，
复廊漏窗墙沿水布置，园内中部土山上立方形四角亭（沧浪亭本亭）。
"""

import json
import math
import os
import random

import bmesh
import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "canglangting.glb")
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
            r0, r1 = (xa, ym, z0 + h), (xb, ym, z0 + h)
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
        """两坡顶：屋脊沿 X 方向。"""
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
        return self


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


def in_rect(r, x, y):
    return r[0] <= x <= r[1] and r[2] <= y <= r[3]


# ---------------------------------------------------------------- 场景与材质

bpy.ops.wm.read_factory_settings(use_empty=True)

MAT_WALL = material("wall", hexc("e4ddcc"), 0.94)      # 粉墙
MAT_TILE = material("tile", hexc("4d545e"), 0.84)      # 瓦顶 / 漏窗框
MAT_WOOD = material("wood", hexc("7a4c33"), 0.86)      # 木柱 / 门窗 / 树干
MAT_STONE = material("stone", hexc("b3ab9b"), 0.94)     # 铺地 / 台基 / 驳岸
MAT_WATER = material("water", hexc("2f7ea8"), 0.16, 0.05)
MAT_LEAF = material("leaf", hexc("556c48"), 0.95)      # 树冠
MAT_EARTH = material("earth", hexc("9d8660"), 0.96)     # 土山
MAT_ROCK = material("rock", hexc("a9a294"), 0.92)      # 假山石

# 景点轮廓：仅用于核对设计范围（底板取轮廓内接矩形）
with open(SCENE_JSON, encoding="utf-8") as f:
    geo = json.load(f)
lm = geo["landmarks"]["canglangting"]
CX, CZ = lm["centroid"]["x"], lm["centroid"]["z"]
OUTLINE = [(x - CX, -(z - CZ)) for x, z in lm["outline"]]
if abs(OUTLINE[0][0] - OUTLINE[-1][0]) < 0.01 and abs(OUTLINE[0][1] - OUTLINE[-1][1]) < 0.01:
    OUTLINE = OUTLINE[:-1]
OXS = [p[0] for p in OUTLINE]
OYS = [p[1] for p in OUTLINE]

RNG = random.Random(20261122)
BLOCKED = []   # (x0, x1, y0, y1) 建筑 / 走廊占地


def reserve(cx, cy, w, d):
    BLOCKED.append((cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2))


# ---------------------------------------------------------------- 地形底板
# 覆盖轮廓内接矩形（约 57×70 m），向西北、东北各补一条临水台地，
# 形成 L 形台面：北侧 y∈[20,33] 的带状场地用于复廊、面水轩与临水铺地。

BASE = [
    (-25.0, -36.0), (32.0, -36.0), (32.0, 26.0), (50.0, 26.0),
    (50.0, 33.0), (-52.0, 33.0), (-52.0, 20.0), (-25.0, 20.0),
]

GROUND = [
    (-25.0, 32.0, -36.0, -18.0),
    (-25.0, -22.0, -18.0, -5.0),   # 水池西侧
    (10.0, 19.0, -18.0, -5.0),     # 两水之间的半岛
    (27.0, 32.0, -18.0, -5.0),     # 水池东侧
    (-25.0, 19.0, -5.0, 6.0),
    (27.0, 32.0, -5.0, 6.0),
    (-25.0, 32.0, 6.0, 20.0),
    (-52.0, 32.0, 20.0, 26.0),
    (-52.0, 32.0, 26.0, 33.0),
    (32.0, 50.0, 26.0, 33.0),
]
for gx0, gx1, gy0, gy1 in GROUND:
    g = Builder()
    g.box(gx0, gx1, gy0, gy1, -0.25, 0.0)
    g.build("garden_ground", MAT_STONE)

# 水面（低于地面 0.16 m）
PONDS = [(-22.0, 10.0, -18.0, -5.0), (19.0, 27.0, -18.0, 6.0)]
water = Builder()
for px0, px1, py0, py1 in PONDS:
    water.box(px0 + 0.04, px1 - 0.04, py0 + 0.04, py1 - 0.04, -0.25, -0.16)
water.build("pond_water", MAT_WATER)

# 池岸压顶石（跨在水陆交界上，遮挡底板接缝）
for px0, px1, py0, py1 in PONDS:
    bank = Builder()
    bank.box(px0 - 0.55, px1 + 0.55, py1 - 0.05, py1 + 0.55, -0.25, 0.10)
    bank.box(px0 - 0.55, px1 + 0.55, py0 - 0.55, py0 + 0.05, -0.25, 0.10)
    bank.box(px0 - 0.55, px0 + 0.05, py0, py1, -0.25, 0.10)
    bank.box(px1 - 0.05, px1 + 0.55, py0, py1, -0.25, 0.10)
    bank.build("pond_bank", MAT_STONE)

# ---------------------------------------------------------------- 园外北侧水面
# 北墙外侧（y > 33）一条带状水面，配临水石岸与码头。

WL_Y0, WL_Y1 = 34.1, 45.6
quay = Builder()
quay.box(-48.0, 46.0, 33.4, 34.3, -0.25, 0.06)
quay.box(-48.0, 46.0, 45.6, 47.2, -0.25, 0.08)
quay.box(-48.0, -47.4, 34.2, 45.6, -0.25, 0.06)
quay.box(45.4, 46.0, 34.2, 45.6, -0.25, 0.06)
quay.build("water_bank", MAT_STONE)

canal = Builder()
canal.box(-47.6, 45.6, WL_Y0, WL_Y1, -0.25, -0.16)
canal.build("outer_water", MAT_WATER)

# ---------------------------------------------------------------- 园墙
# 北侧为复廊漏窗墙，其余三面为粉墙。

WALL_H = 4.0
WALL_T = 0.75


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
    cap.box(cx - length / 2 - 0.12, cx + length / 2 + 0.12,
            cy - thickness / 2 - 0.3, cy + thickness / 2 + 0.3,
            height, height + 0.42)
    cap.build("garden_wall_cap", MAT_TILE, rot=ang, pivot=(cx, cy))


for i in range(len(BASE)):
    if i == 4:      # 北边由复廊取代
        continue
    wall_run(BASE[i], BASE[(i + 1) % len(BASE)])

footing = Builder()
for bx, by in BASE:
    footing.box(bx - 0.7, bx + 0.7, by - 0.7, by + 0.7, 0.0, 0.55)
footing.build("wall_footing", MAT_STONE)

# ---------------------------------------------------------------- 复廊漏窗墙

def leaky_wall(x0, x1, y, height=4.35, t=0.9, bay=3.2, open_w=1.85):
    """沿 X 的漏窗墙：下段墙裙 + 上段墙身 + 规律洞口 + 十字窗棂。"""
    n = max(1, int(round((x1 - x0) / bay)))
    w = (x1 - x0) / n
    zlo, zhi = 1.45, 3.15

    base = Builder()
    base.box(x0, x1, y - t / 2, y + t / 2, 0.0, zlo)
    base.build("garden_wall", MAT_WALL)

    top = Builder()
    top.box(x0, x1, y - t / 2, y + t / 2, zhi, height)
    top.build("garden_wall", MAT_WALL)

    piers = Builder()
    frames = Builder()
    cursor = x0
    for i in range(n):
        cx = x0 + (i + 0.5) * w
        o0, o1 = cx - open_w / 2, cx + open_w / 2
        if o0 > cursor + 0.02:
            piers.box(cursor, o0, y - t / 2, y + t / 2, zlo, zhi)
        cursor = o1
        zm = (zlo + zhi) / 2
        frames.box(o0, o1, y - 0.09, y + 0.09, zm - 0.05, zm + 0.05)
        frames.box(cx - 0.05, cx + 0.05, y - 0.09, y + 0.09, zlo, zhi)
    if cursor < x1 - 0.02:
        piers.box(cursor, x1, y - t / 2, y + t / 2, zlo, zhi)
    piers.build("garden_wall", MAT_WALL)
    frames.build("window_frame", MAT_TILE)

    cap = Builder()
    cap.box(x0 - 0.1, x1 + 0.1, y - t / 2 - 0.3, y + t / 2 + 0.3, height, height + 0.45)
    cap.build("garden_wall_cap", MAT_TILE)


def veranda(x0, x1, y_wall, depth=1.8, h=3.45):
    """漏窗墙内侧的廊：木柱 + 额枋 + 单坡瓦顶。"""
    n = max(1, int(round((x1 - x0) / 3.2)))
    cols = Builder()
    for k in range(n + 1):
        x = x0 + (x1 - x0) * k / n
        cols.box(x - 0.16, x + 0.16, y_wall - depth + 0.1, y_wall - depth + 0.42, 0.0, h)
    cols.build("veranda_column", MAT_WOOD)

    beam = Builder()
    beam.box(x0, x1, y_wall - depth + 0.05, y_wall - depth + 0.45, h - 0.34, h)
    beam.build("veranda_beam", MAT_WOOD)

    roof = Builder()
    roof.gable_roof(x0 - 0.2, x1 + 0.2, y_wall - depth, y_wall - 0.42, h, 0.72, 0.1, ridge=False)
    roof.build("veranda_roof", MAT_TILE)
    reserve((x0 + x1) / 2, y_wall - depth / 2, x1 - x0, depth + 0.6)


WALL_N = 33.0
GATE0, GATE1 = -9.6, -3.2
leaky_wall(-52.0, GATE0, WALL_N)
leaky_wall(GATE1, 50.0, WALL_N)
veranda(-52.0, GATE0, WALL_N)
veranda(GATE1, 50.0, WALL_N)

# 门洞上方门楣 + 瓦顶
lintel = Builder()
lintel.box(GATE0, GATE1, WALL_N - 0.45, WALL_N + 0.45, 3.3, 4.35)
lintel.build("gate_lintel", MAT_WALL)
lintel_cap = Builder()
lintel_cap.box(GATE0 - 0.1, GATE1 + 0.1, WALL_N - 0.75, WALL_N + 0.75, 4.35, 4.8)
lintel_cap.build("garden_wall_cap", MAT_TILE)

# 入口码头：石平台 + 入水石阶
dock = Builder()
dock.box(-10.5, -2.3, WALL_N + 0.4, 36.5, -0.25, 0.12)
for k in range(3):
    dock.box(-9.6, -3.2, 36.5 + k * 0.5, 37.0 + k * 0.5, -0.25, 0.02 - k * 0.11)
dock.build("landing_dock", MAT_STONE)

# ---------------------------------------------------------------- 单体构件


def hall(cx, cy, w, d, h, roof_h=2.6, face=-1):
    """厅堂：石台基 + 粉墙 + 木裙板 + 檐柱 + 灰瓦歇山顶。face=+1 门朝北。"""
    plat = Builder()
    plat.box(cx - w / 2 - 1.2, cx + w / 2 + 1.2, cy - d / 2 - 1.2, cy + d / 2 + 1.2, 0.0, 0.4)
    plat.build("hall_platform", MAT_STONE)

    body = Builder()
    body.box(cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2, 0.4, 0.4 + h)
    body.build("hall_wall", MAT_WALL)

    skirt = Builder()
    skirt.box(cx - w / 2 - 0.16, cx + w / 2 + 0.16, cy - d / 2 - 0.16, cy + d / 2 + 0.16, 0.4, 1.15)
    skirt.build("hall_skirt", MAT_WOOD)

    dy = cy + face * d / 2
    y0, y1 = (dy - 0.2, dy + 0.06) if face < 0 else (dy - 0.06, dy + 0.2)
    doors = Builder()
    n = max(3, int(w / 5.0))
    for i in range(n):
        dx = cx - w / 2 + (i + 0.5) * w / n
        wd = w / n * 0.62
        doors.box(dx - wd / 2, dx + wd / 2, y0, y1, 0.5, 0.4 + h * 0.8)
    doors.build("hall_door", MAT_WOOD)

    cols = Builder()
    n = max(3, int(w / 4.5))
    ya, yb = (dy - 1.0, dy - 0.58) if face < 0 else (dy + 0.58, dy + 1.0)
    for k in range(n + 1):
        x = cx - w / 2 + 0.6 + (w - 1.2) * k / n
        cols.box(x - 0.2, x + 0.2, ya, yb, 0.4, 0.4 + h * 0.94)
    cols.build("hall_column", MAT_WOOD)

    inset = min(w, d) * 0.36
    zt = 0.4 + h
    roof = Builder()
    roof.hip_roof(cx - w / 2 - 1.5, cx + w / 2 + 1.5, cy - d / 2 - 1.5, cy + d / 2 + 1.5,
                  zt, roof_h, inset)
    roof.build("hall_roof", MAT_TILE)

    xa, xb = cx - w / 2 - 1.5 + inset, cx + w / 2 + 1.5 - inset
    if xb - xa > 0.4:
        ridge = Builder()
        ridge.box(xa, xb, cy - 0.35, cy + 0.35, zt + roof_h - 0.1, zt + roof_h + 0.35)
        ridge.build("hall_ridge", MAT_TILE)

    reserve(cx, cy, w + 3.0, d + 3.0)


def corridor(x0, y0, x1, y1, width=2.6, h=3.1):
    """沿墙游廊：石基 + 木柱 + 两坡瓦顶。"""
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
        y = cy + s * (width / 2 - 0.18)
        wood.box(cx - half, cx + half, y - 0.09, y + 0.09, 0.72, 0.98)
    wood.build("corridor_wood", MAT_WOOD, rot=ang, pivot=(cx, cy))

    roof = Builder()
    roof.gable_roof(cx - half - 0.4, cx + half + 0.4, cy - width / 2, cy + width / 2,
                    h, 0.95, width * 0.4)
    roof.build("corridor_roof", MAT_TILE, rot=ang, pivot=(cx, cy))
    reserve(cx, cy, length + 1.0, width + 1.2)


def square_pavilion(cx, cy, half, z0, h=3.2, roof_h=2.4):
    """方形四角亭：石台基 + 四根木柱 + 美人靠 + 深色歇山瓦顶。"""
    plat = Builder()
    plat.box(cx - half - 0.8, cx + half + 0.8, cy - half - 0.8, cy + half + 0.8, z0, z0 + 0.45)
    plat.build("pavilion_platform", MAT_STONE)

    col = Builder()
    for sx in (-1, 1):
        for sy in (-1, 1):
            px, py = cx + sx * (half - 0.25), cy + sy * (half - 0.25)
            col.box(px - 0.22, px + 0.22, py - 0.22, py + 0.22, z0 + 0.45, z0 + 0.45 + h)
    col.build("pavilion_column", MAT_WOOD)

    zt = z0 + 0.45 + h
    beam = Builder()
    beam.box(cx - half + 0.04, cx + half - 0.04, cy - half + 0.02, cy - half + 0.32, zt - 0.55, zt)
    beam.box(cx - half + 0.04, cx + half - 0.04, cy + half - 0.32, cy + half - 0.02, zt - 0.55, zt)
    beam.box(cx - half + 0.02, cx - half + 0.32, cy - half + 0.04, cy + half - 0.04, zt - 0.55, zt)
    beam.box(cx + half - 0.32, cx + half - 0.02, cy - half + 0.04, cy + half - 0.04, zt - 0.55, zt)
    beam.build("pavilion_beam", MAT_WOOD)

    bench = Builder()
    for sy in (-1, 1):
        bench.box(cx - half + 0.2, cx + half - 0.2, cy + sy * (half - 0.3) - 0.07,
                  cy + sy * (half - 0.3) + 0.07, z0 + 0.45, z0 + 0.95)
    for sx in (-1, 1):
        bench.box(cx + sx * (half - 0.3) - 0.07, cx + sx * (half - 0.3) + 0.07,
                  cy - half + 0.2, cy + half - 0.2, z0 + 0.45, z0 + 0.95)
    bench.build("pavilion_bench", MAT_WOOD)

    inset = min(1.9, half * 0.56)
    roof = Builder()
    roof.hip_roof(cx - half - 1.0, cx + half + 1.0, cy - half - 1.0, cy + half + 1.0,
                  zt, roof_h, inset)
    roof.build("pavilion_roof", MAT_TILE)

    ridge = Builder()
    ridge.box(cx - half - 1.0 + inset, cx + half + 1.0 - inset, cy - 0.28, cy + 0.28,
              zt + roof_h - 0.08, zt + roof_h + 0.3)
    ridge.build("pavilion_ridge", MAT_TILE)
    reserve(cx, cy, half * 2 + 2.4, half * 2 + 2.4)


def hex_pavilion(cx, cy, r, h=3.6, z0=0.0):
    """六角临水小亭。"""
    base = Builder()
    base.prism(cx, cy, z0 - 0.15, z0 + 0.3, r * 1.12, r * 1.06, 6, math.pi / 6)
    base.build("hex_pavilion_base", MAT_STONE)

    cols = Builder()
    for i in range(6):
        a = math.pi / 6 + i * math.tau / 6
        px, py = cx + math.cos(a) * r * 0.84, cy + math.sin(a) * r * 0.84
        cols.box(px - 0.17, px + 0.17, py - 0.17, py + 0.17, z0 + 0.3, z0 + h)
    cols.build("hex_pavilion_column", MAT_WOOD)

    rail = Builder()
    rail.prism(cx, cy, z0 + 0.3, z0 + 0.85, r * 0.92, r * 0.92, 6, math.pi / 6)
    rail.build("hex_pavilion_rail", MAT_WOOD)

    roof = Builder()
    roof.prism(cx, cy, z0 + h, z0 + h + 1.3, r * 1.7, r * 0.55, 6, math.pi / 6)
    roof.prism(cx, cy, z0 + h + 1.3, z0 + h + 2.0, r * 0.6, 0.18, 6, math.pi / 6)
    roof.prism(cx, cy, z0 + h + 2.0, z0 + h + 2.4, 0.2, 0.07, 6, math.pi / 6)
    roof.build("hex_pavilion_roof", MAT_TILE)
    reserve(cx, cy, r * 2 + 1.6, r * 2 + 1.6)


# ---------------------------------------------------------------- 园内建筑

hall(2.0, -26.0, 22.0, 11.0, 6.4, 3.0, face=1)      # 明道堂（面北朝山）
hall(23.5, -27.0, 10.0, 8.0, 5.4, 2.4, face=1)      # 翠玲珑
hall(-32.0, 26.5, 13.0, 6.5, 5.6, 2.3, face=1)      # 面水轩（临园外水面）
hex_pavilion(44.0, 29.0, 3.1, 3.6)                  # 东北临水小亭

corridor(-22.2, -34.4, -22.2, 16.0, width=2.6)      # 西墙游廊
corridor(-22.2, -34.4, 14.0, -34.4, width=2.4)      # 南墙游廊
corridor(14.2, -26.0, 17.9, -26.0, width=2.4)       # 明道堂 → 翠玲珑

# ---------------------------------------------------------------- 土山与沧浪亭

HILL_CX, HILL_CY = -2.0, 10.0
HILL_RX, HILL_RY, HILL_H = 17.0, 12.5, 4.75


def hill_z(x, y):
    d2 = ((x - HILL_CX) / HILL_RX) ** 2 + ((y - HILL_CY) / HILL_RY) ** 2
    if d2 >= 1.0:
        return 0.0
    return HILL_H * (1.0 - d2) ** 0.9


def build_hill(rings=7, seg=26):
    rows = []
    for k in range(1, rings + 1):
        t = k / rings
        row = []
        for s in range(seg):
            a = s * math.tau / seg
            bump = 1 + 0.06 * math.sin(3 * a + k * 0.9) + 0.035 * math.sin(5 * a + k * 2.1)
            x = HILL_CX + math.cos(a) * HILL_RX * t * bump
            y = HILL_CY + math.sin(a) * HILL_RY * t * bump
            z = HILL_H * (1 - t * t) ** 0.9 * (0.96 + 0.04 * math.sin(2 * a + k))
            row.append((x, y, max(z, 0.0)))
        rows.append(row)
    b = Builder()
    top = (HILL_CX, HILL_CY, HILL_H)
    for s in range(seg):
        b.tri(top, rows[0][s], rows[0][(s + 1) % seg])
    for k in range(rings - 1):
        row_a, row_b = rows[k], rows[k + 1]
        for s in range(seg):
            t1 = (s + 1) % seg
            b.quad(row_a[s], row_a[t1], row_b[t1], row_b[s])
    outer = rows[-1]
    for s in range(seg):
        t1 = (s + 1) % seg
        b.quad(outer[s], outer[t1], (outer[t1][0], outer[t1][1], -0.2),
               (outer[s][0], outer[s][1], -0.2))
    b.build("earth_hill", MAT_EARTH)


build_hill()
square_pavilion(HILL_CX, HILL_CY + 1.0, 3.3, 4.42, h=3.2, roof_h=2.8)

# ---------------------------------------------------------------- 曲桥

def flat_bridge(pts, width=1.8, top=0.12):
    b = Builder()
    for k in range(len(pts) - 1):
        x0, y0 = pts[k]
        x1, y1 = pts[k + 1]
        dx, dy = x1 - x0, y1 - y0
        ln = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / ln * width / 2, dx / ln * width / 2
        b.quad((x0 + nx, y0 + ny, top), (x1 + nx, y1 + ny, top),
               (x1 - nx, y1 - ny, top), (x0 - nx, y0 - ny, top))
        b.quad((x0 + nx, y0 + ny, top), (x0 + nx, y0 + ny, 0.02),
               (x0 - nx, y0 - ny, 0.02), (x0 - nx, y0 - ny, top))
        b.quad((x1 + nx, y1 + ny, top), (x1 + nx, y1 + ny, 0.02),
               (x1 - nx, y1 - ny, 0.02), (x1 - nx, y1 - ny, top))
    b.build("zigzag_bridge", MAT_STONE)


flat_bridge([(-16.5, -5.2), (-12.6, -8.4), (-16.2, -11.8), (-12.8, -15.2), (-15.0, -18.2)])

# 小石板桥：跨东侧水面，接半岛
flat_bridge([(20.5, -3.0), (25.5, -3.0)], width=1.6, top=0.12)

# ---------------------------------------------------------------- 假山石


def rock(cx, cy, r, h, seed, z0=0.0):
    rng = random.Random(seed)
    b = Builder()
    for k in range(3):
        rr = r * (1.0 - k * 0.26)
        pts = []
        for s in range(6):
            a = s * math.tau / 6 + k * 0.5 + rng.random() * 0.2
            pts.append((cx + math.cos(a) * rr * (0.75 + rng.random() * 0.45),
                        cy + math.sin(a) * rr * (0.75 + rng.random() * 0.45)))
        z1 = z0 + h * (k + 1) / 3
        b.poly_prism(pts, z0 if k == 0 else z1 - 0.02, z1)
    b.build("rockery", MAT_ROCK)


for i, (rx, ry, rr, rh) in enumerate([
    (-21.2, -4.4, 1.5, 1.7), (9.2, -4.6, 1.3, 1.5),
    (-21.4, -18.2, 1.6, 1.9), (9.4, -18.2, 1.2, 1.4),
    (18.3, -17.4, 1.4, 1.7), (27.6, -2.4, 1.2, 1.3),
    (18.4, 5.4, 1.3, 1.6), (-17.0, -1.6, 1.7, 2.1),
]):
    rock(rx, ry, rr, rh, 3100 + i)

# 土山南麓叠石
for i, (rx, ry, rr, rh) in enumerate([(-14.0, -1.0, 1.9, 2.3), (-10.6, -2.2, 1.4, 1.6),
                                      (6.0, -1.4, 1.6, 2.0), (17.5, 9.0, 1.5, 1.8)]):
    z0 = max(hill_z(rx, ry) - 0.2, 0.0)
    rock(rx, ry, rr, rh, 3300 + i, z0)

# ---------------------------------------------------------------- 树木
# 古樟 / 古松：树冠明显大于普通园林，体现古木参天。


def tree(x, y, z0, h, r, sides=9):
    trunk = Builder()
    trunk.box(x - 0.5, x + 0.5, y - 0.5, y + 0.5, z0, z0 + h * 0.55)
    trunk.build("tree_trunk", MAT_WOOD)

    leaf = Builder()
    leaf.prism(x, y, z0 + h * 0.2, z0 + h * 0.6, r, r * 0.96, sides)
    leaf.prism(x, y, z0 + h * 0.54, z0 + h * 0.86, r * 0.92, r * 0.6, sides)
    leaf.prism(x, y, z0 + h * 0.8, z0 + h * 1.02, r * 0.6, r * 0.14, sides)
    leaf.build("tree_leaf", MAT_LEAF)


def plant(x, y, h, r, z0=0.0):
    for px0, px1, py0, py1 in PONDS:
        if in_rect((px0 - 1.0, px1 + 1.0, py0 - 1.0, py1 + 1.0), x, y):
            print(f"[canglangting] tree skipped in pond: {x},{y}")
            return
    for bx0, bx1, by0, by1 in BLOCKED:
        if in_rect((bx0 - 0.6, bx1 + 0.6, by0 - 0.6, by1 + 0.6), x, y):
            print(f"[canglangting] tree skipped in building: {x},{y}")
            return
    if not point_in_poly(BASE, x, y):
        print(f"[canglangting] tree skipped outside base: {x},{y}")
        return
    # 树木只作点缀：高度压在亭榭檐口以下，冠幅同步收敛，避免遮住厅堂与复廊
    tree(x, y, z0, min(h * 0.72, 6.6), min(r * 0.84, 2.6))


BIG_TREES = [
    (-18.0, 24.5, 13.5, 4.4), (-7.0, 25.5, 13.0, 4.0), (-20.0, 28.0, 12.5, 4.0),
    (-43.5, 28.5, 13.0, 4.4), (-46.0, 22.5, 12.0, 4.0),
    (15.0, -11.0, 13.0, 4.2), (29.5, 1.0, 13.5, 4.4), (37.0, 28.6, 12.0, 4.0),
    (-17.0, -24.0, 14.0, 4.0), (-49.0, 28.5, 11.0, 3.6),
]
for tx, ty, th, tr in BIG_TREES:
    plant(tx, ty, th, tr)

MID_TREES = [
    (10.5, -3.0, 8.5, 2.6), (14.0, 17.5, 9.0, 2.6), (-16.5, 16.0, 9.0, 2.7),
    (31.0, 22.5, 8.0, 2.0), (-49.0, 21.5, 8.5, 2.3), (48.6, 28.0, 8.0, 2.2),
]
for tx, ty, th, tr in MID_TREES:
    plant(tx, ty, th, tr, z0=max(hill_z(tx, ty) - 0.3, 0.0))

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
    obj = bpy.data.objects.new(f"clt_{mat_name}", mesh)
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
lo = [1e9, 1e9, 1e9]
hi = [-1e9, -1e9, -1e9]
for obj in meshes:
    obj.data.calc_loop_triangles()
    tris += len(obj.data.loop_triangles)
    for v in obj.data.vertices:
        wx, wy, wz = obj.matrix_world @ v.co
        lo = [min(lo[0], wx), min(lo[1], wy), min(lo[2], wz)]
        hi = [max(hi[0], wx), max(hi[1], wy), max(hi[2], wz)]

print(
    f"[canglangting] exported {OUT} | meshes={len(meshes)} tris={tris} "
    f"bbox=({hi[0] - lo[0]:.1f} x {hi[1] - lo[1]:.1f} x {hi[2] - lo[2]:.1f} m) "
    f"x[{lo[0]:.1f},{hi[0]:.1f}] y[{lo[1]:.1f},{hi[1]:.1f}] z[{lo[2]:.2f},{hi[2]:.1f}] "
    f"min_z={lo[2]:.2f} filesize={os.path.getsize(OUT) / 1024:.0f}KB"
)
print(f"[canglangting] outline local bbox x[{min(OXS):.1f},{max(OXS):.1f}] y[{min(OYS):.1f},{max(OYS):.1f}]")
