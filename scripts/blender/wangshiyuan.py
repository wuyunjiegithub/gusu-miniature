"""网师园程序化建模并导出 GLB。

坐标约定：Blender +X = 东，+Y = 北，+Z = 上；单位为米，原点为景点质心。
scene [x, z] → Blender (x - centroid.x, -(z - centroid.z))，
glTF export_yup=True 后 +Z→+Y、+Y→-Z，与网页场景一致。

网师园是苏州最小的宅园，"以少胜多、精致小巧"：
南侧宅院（轿厅、大厅）临街，北侧园林以彩霞池为中心，
池南濯缨水阁、池西月到风来亭、西南看松读画轩，
西侧殿春簃独立小院（冷泉亭、花木、石桌石凳），
环池游廊以漏窗矮墙表现，东北角竹外一枝轩与五峰书屋。
底板 -0.25~0 m，水面低于地面 0.16 m。
"""

import json
import math
import os
import random

import bmesh
import bpy
import mathutils
from mathutils.geometry import tessellate_polygon

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "wangshiyuan.glb")
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
        """任意简单多边形拉伸（底板、水面、墙体）。"""
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
        self.quad(b0, b1, b2, b3)
        scale = max(0.45, min(1.3, h / 2.8))
        if ridge and has_ridge:
            self.ridge_cap(xa, xb, ym, z0 + h, scale)
        if upturn:
            for c, out in (((x0, y0), (-1, -1)), ((x1, y0), (1, -1)),
                           ((x1, y1), (1, 1)), ((x0, y1), (-1, 1))):
                self.corner_upturn(c, out, z0, 1.0 * scale, 0.7 * scale, 0.34 * max(0.6, scale))

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


def inset_poly(poly, dist):
    """沿顶点法线把多边形向内收 dist（用于底板避开景点底座边缘）。"""
    n = len(poly)
    out = []
    for i in range(n):
        px, py = poly[(i - 1) % n]
        cx, cy = poly[i]
        nx, ny = poly[(i + 1) % n]
        ex0, ey0 = cx - px, cy - py
        ex1, ey1 = nx - cx, ny - cy
        l0 = math.hypot(ex0, ey0) or 1.0
        l1 = math.hypot(ex1, ey1) or 1.0
        # 逆时针多边形的内法线为左法线
        n0 = (-ey0 / l0, ex0 / l0)
        n1 = (-ey1 / l1, ex1 / l1)
        mx, my = n0[0] + n1[0], n0[1] + n1[1]
        ml = math.hypot(mx, my) or 1.0
        mx, my = mx / ml, my / ml
        cos_h = max(0.4, mx * n0[0] + my * n0[1])
        out.append((cx + mx * dist / cos_h, cy + my * dist / cos_h))
    return out


# ---------------------------------------------------------------- 场景与材质

bpy.ops.wm.read_factory_settings(use_empty=True)

MAT_WALL = material("wall", hexc("e4ddcc"), 0.94)
MAT_TILE = material("tile", hexc("4d545e"), 0.82)
MAT_WOOD = material("wood", hexc("7a4c33"), 0.86)
MAT_STONE = material("stone", hexc("b3ab9b"), 0.95)
MAT_LEAF = material("leaf", hexc("556c48"), 0.95)
MAT_WATER = material("water", hexc("2f7ea8"), 0.18, 0.05)

with open(SCENE_JSON, encoding="utf-8") as f:
    geo = json.load(f)
lm = geo["landmarks"]["wangshiyuan"]
CX, CZ = lm["centroid"]["x"], lm["centroid"]["z"]
OUTLINE = [(x - CX, -(z - CZ)) for x, z in lm["outline"]]
if abs(OUTLINE[0][0] - OUTLINE[-1][0]) < 0.01 and abs(OUTLINE[0][1] - OUTLINE[-1][1]) < 0.01:
    OUTLINE = OUTLINE[:-1]

RNG = random.Random(20261120)
BUILDINGS = []

Z_TOP = 0.0      # 铺地 / 台基顶面
Z_BASE = -0.25   # 底板下缘（网页置于 1.85 时正好落在 1.6 m 底座上）
Z_WATER = -0.16  # 水面低于铺地 0.16 m


def reserve(cx, cy, w, d):
    BUILDINGS.append((cx, cy, w, d))


# ---------------------------------------------------------------- 地形底板（彩霞池开洞）

# 彩霞池：近方形，约 25 × 20 m，岸线略作折转
POND = [
    (-12.2, 1.4), (-10.8, 7.2), (-12.5, 13.4), (-9.2, 19.3), (-2.8, 20.7),
    (4.8, 20.4), (10.8, 17.4), (12.9, 11.2), (12.5, 4.6), (9.6, -1.2),
    (3.2, -2.8), (-3.4, -2.5), (-8.8, -2.2),
]
PCX = sum(p[0] for p in POND) / len(POND)
PCY = sum(p[1] for p in POND) / len(POND)

# 底板用内收轮廓，避免与网页景点底座的侧面咬边
BASE_POLY = inset_poly(OUTLINE, 0.6)

# 顶面：轮廓多边形 + 水池洞（偶数填充规则，两者反向）
outer_v = [mathutils.Vector((x, y, Z_TOP)) for x, y in BASE_POLY]
hole_v = [mathutils.Vector((x, y, Z_TOP)) for x, y in reversed(POND)]
tess_v = outer_v + hole_v
ground = Builder()
for a, b, c in tessellate_polygon([outer_v, hole_v]):
    ground.tri(
        (tess_v[a].x, tess_v[a].y, Z_TOP),
        (tess_v[b].x, tess_v[b].y, Z_TOP),
        (tess_v[c].x, tess_v[c].y, Z_TOP),
    )
for i in range(len(BASE_POLY)):
    j = (i + 1) % len(BASE_POLY)
    x0, y0 = BASE_POLY[i]
    x1, y1 = BASE_POLY[j]
    ground.quad((x0, y0, Z_BASE), (x1, y1, Z_BASE), (x1, y1, Z_TOP), (x0, y0, Z_TOP))
# 池壁
for i in range(len(POND)):
    j = (i + 1) % len(POND)
    x0, y0 = POND[i]
    x1, y1 = POND[j]
    ground.quad((x0, y0, Z_BASE), (x1, y1, Z_BASE), (x1, y1, Z_TOP), (x0, y0, Z_TOP))
ground.build("ground_pave", MAT_STONE)

# 水面（略收边，避免与池壁共面）
water = Builder()
WATER_POLY = [(x + (PCX - x) * 0.012, y + (PCY - y) * 0.012) for x, y in POND]
water.poly_prism(WATER_POLY, Z_WATER - 0.04, Z_WATER)
water.build("pond_water", MAT_WATER)

# 池岸压顶石：略高于铺地并向池内挑出，避免共面闪面
BANK_TOP = Z_TOP + 0.035
bank = Builder()
for i in range(len(POND)):
    j = (i + 1) % len(POND)
    x0, y0 = POND[i]
    x1, y1 = POND[j]
    ix0, iy0 = x0 + (PCX - x0) * 0.01, y0 + (PCY - y0) * 0.01
    ix1, iy1 = x1 + (PCX - x1) * 0.01, y1 + (PCY - y1) * 0.01
    dx, dy = x1 - x0, y1 - y0
    ln = math.hypot(dx, dy) or 1.0
    nx, ny = -dy / ln * 0.5, dx / ln * 0.5
    bank.quad((ix0, iy0, BANK_TOP), (ix1, iy1, BANK_TOP),
              (x1 + nx, y1 + ny, BANK_TOP), (x0 + nx, y0 + ny, BANK_TOP))
    bank.quad((ix0, iy0, BANK_TOP), (ix1, iy1, BANK_TOP),
              (ix1, iy1, Z_TOP - 0.04), (ix0, iy0, Z_TOP - 0.04))
    bank.quad((x0 + nx, y0 + ny, BANK_TOP), (x1 + nx, y1 + ny, BANK_TOP),
              (x1 + nx, y1 + ny, Z_TOP - 0.04), (x0 + nx, y0 + ny, Z_TOP - 0.04))
bank.build("pond_bank", MAT_STONE)

# ---------------------------------------------------------------- 园墙（粉墙黛瓦）

WALL_H = 3.6
WALL_T = 0.6


def wall_run(p0, p1, height=WALL_H, thickness=WALL_T):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy)
    if length < 0.4:
        return
    ang = math.atan2(dy, dx)
    cx, cy = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2
    body = Builder()
    body.box(cx - length / 2, cx + length / 2, cy - thickness / 2, cy + thickness / 2,
             Z_TOP, Z_TOP + height)
    body.build("garden_wall", MAT_WALL, rot=ang, pivot=(cx, cy))
    cap = Builder()
    cap.box(
        cx - length / 2 - 0.12,
        cx + length / 2 + 0.12,
        cy - thickness / 2 - 0.3,
        cy + thickness / 2 + 0.3,
        Z_TOP + height,
        Z_TOP + height + 0.38,
    )
    cap.build("garden_wall_cap", MAT_TILE, rot=ang, pivot=(cx, cy))


def wall_gap(p0, p1, a, b):
    """在 p0→p1 上取 a~b 米处留门洞，返回洞口两侧点。"""
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    ln = math.hypot(dx, dy)
    ux, uy = dx / ln, dy / ln
    return ((p0[0] + ux * a, p0[1] + uy * a), (p0[0] + ux * b, p0[1] + uy * b))


# 南墙（outline 13→14 段）留正门（对准轿厅）；其余沿轮廓闭合
SOUTH_DOOR = None
for i in range(len(OUTLINE)):
    p0, p1 = OUTLINE[i], OUTLINE[(i + 1) % len(OUTLINE)]
    seg_len = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
    if i == 13:
        t = (7.8 - 4.5) / 26.6
        a, b = wall_gap(p0, p1, t * seg_len - 3.6, t * seg_len + 3.6)
        SOUTH_DOOR = (a, b)
        wall_run(p0, a)
        wall_run(b, p1)
    else:
        wall_run(p0, p1)


def door_head(a, b, h=3.4):
    """门洞上方的门楣与瓦顶。"""
    dx, dy = b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dx, dy)
    ang = math.atan2(dy, dx)
    cx, cy = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    body = Builder()
    body.box(cx - ln / 2, cx + ln / 2, cy - WALL_T / 2, cy + WALL_T / 2,
             Z_TOP + h, Z_TOP + WALL_H)
    body.build("door_head", MAT_WALL, rot=ang, pivot=(cx, cy))
    cap = Builder()
    cap.box(cx - ln / 2 - 0.15, cx + ln / 2 + 0.15, cy - WALL_T / 2 - 0.32,
            cy + WALL_T / 2 + 0.32, Z_TOP + WALL_H, Z_TOP + WALL_H + 0.42)
    cap.build("door_head_cap", MAT_TILE, rot=ang, pivot=(cx, cy))
    sill = Builder()
    sill.box(cx - ln / 2, cx + ln / 2, cy - WALL_T / 2 - 0.18, cy + WALL_T / 2 + 0.18,
             Z_TOP, Z_TOP + 0.22)
    sill.build("door_sill", MAT_STONE, rot=ang, pivot=(cx, cy))


door_head(*SOUTH_DOOR)


# ---------------------------------------------------------------- 建筑构件


def hall(cx, cy, w, d, h, roof_h=None, z0=Z_TOP, face=-1, door=True, plinth=0.3, roof=True):
    """厅堂：石台基 + 粉墙 + 木裙板 / 门窗 + 灰瓦屋顶。face=-1 门朝南。"""
    if roof_h is None:
        roof_h = min(2.7, 0.3 * h + 0.7)

    plat = Builder()
    plat.box(cx - w / 2 - 0.7, cx + w / 2 + 0.7, cy - d / 2 - 0.7, cy + d / 2 + 0.7,
             z0 - 0.02, z0 + plinth)
    plat.build("hall_platform", MAT_STONE)

    body = Builder()
    body.box(cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2, z0 + plinth, z0 + plinth + h)
    body.build("hall_wall", MAT_WALL)

    skirt = Builder()
    skirt.box(cx - w / 2 - 0.1, cx + w / 2 + 0.1, cy - d / 2 - 0.1, cy + d / 2 + 0.1,
              z0 + plinth, z0 + plinth + 0.8)
    skirt.build("hall_skirt", MAT_WOOD)

    if door:
        yf = cy + face * d / 2
        y0, y1 = (yf - 0.14, yf + 0.06) if face < 0 else (yf - 0.06, yf + 0.14)
        panel = Builder()
        panel.box(cx - w * 0.17, cx + w * 0.17, y0, y1, z0 + plinth, z0 + plinth + h * 0.8)
        panel.build("hall_door", MAT_WOOD)
        wins = Builder()
        for s in (-1, 1):
            wx = cx + s * w * 0.33
            wins.box(wx - w * 0.11, wx + w * 0.11, y0, y1,
                     z0 + plinth + 0.95, z0 + plinth + h * 0.72)
        wins.build("hall_window", MAT_WOOD)

    rb = Builder()
    inset = min(w, d) * 0.42
    if roof:
        rb.hip_roof(cx - w / 2 - 1.0, cx + w / 2 + 1.0, cy - d / 2 - 1.0, cy + d / 2 + 1.0,
                    z0 + plinth + h, roof_h, inset)
        rb.build("hall_roof", MAT_TILE)
        if w >= d * 1.35:
            ridge = Builder()
            zr = z0 + plinth + h + roof_h
            ridge.box(cx - w / 2 - 1.0 + inset, cx + w / 2 + 1.0 - inset, cy - 0.2, cy + 0.2,
                      zr - 0.08, zr + 0.26)
            ridge.build("hall_ridge", MAT_TILE)
    reserve(cx, cy, w + 3.0, d + 3.0)


def tower(cx, cy, w, d, h1, h2, face=-1, z0=Z_TOP, plinth=0.35):
    """两层楼阁：下层厅堂 + 腰檐 + 收进的上层 + 歇山顶。"""
    hall(cx, cy, w, d, h1, z0=z0, face=face, plinth=plinth, roof=False)
    z1 = z0 + plinth + h1

    up = Builder()
    up.box(cx - w * 0.39, cx + w * 0.39, cy - d * 0.39, cy + d * 0.39, z1 - 0.12, z1 + h2)
    up.build("upper_wall", MAT_WALL)

    eave = Builder()
    eave.hip_roof(cx - w / 2 - 0.8, cx + w / 2 + 0.8, cy - d / 2 - 0.8, cy + d / 2 + 0.8,
                  z1, 0.8, min(w, d) * 0.34)
    eave.build("upper_eave", MAT_TILE)

    win = Builder()
    yf = cy + face * d * 0.39
    y0, y1 = (yf - 0.12, yf + 0.05) if face < 0 else (yf - 0.05, yf + 0.12)
    win.box(cx - w * 0.17, cx + w * 0.17, y0, y1, z1 + 0.55, z1 + h2 * 0.82)
    win.build("upper_window", MAT_WOOD)

    rb = Builder()
    rb.hip_roof(cx - w * 0.39 - 1.0, cx + w * 0.39 + 1.0, cy - d * 0.39 - 1.0, cy + d * 0.39 + 1.0,
                z1 + h2, min(2.2, h2 * 0.95), min(w, d) * 0.32)
    rb.build("upper_roof", MAT_TILE)
    reserve(cx, cy, w + 3.0, d + 3.0)


def pavilion(cx, cy, r, h=4.4, sides=6, z0=Z_TOP, phase=None):
    """亭：多边形台基 + 木柱 + 坐槛 + 攒尖瓦顶 + 宝顶。"""
    if phase is None:
        phase = math.pi / sides
    base = Builder()
    base.prism(cx, cy, z0 - 0.05, z0 + 0.34, r * 1.10, r * 1.05, sides, phase)
    base.build("pavilion_base", MAT_STONE)

    cols = Builder()
    for i in range(sides):
        a = phase + i * math.tau / sides
        px, py = cx + math.cos(a) * r * 0.86, cy + math.sin(a) * r * 0.86
        cols.box(px - 0.17, px + 0.17, py - 0.17, py + 0.17, z0 + 0.34, z0 + h)
    cols.build("pavilion_columns", MAT_WOOD)

    seat = Builder()
    seat.prism(cx, cy, z0 + 0.34, z0 + 0.86, r * 0.82, r * 0.82, sides, phase)
    seat.build("pavilion_seat", MAT_WOOD)

    roof = Builder()
    roof.prism(cx, cy, z0 + h - 0.15, z0 + h + 1.5, r * 1.58, r * 0.4, sides, phase)
    roof.prism(cx, cy, z0 + h + 1.5, z0 + h + 2.1, r * 0.42, 0.16, sides, phase)
    roof.prism(cx, cy, z0 + h + 2.1, z0 + h + 2.5, 0.17, 0.05, sides, phase)
    roof.build("pavilion_roof", MAT_TILE)
    reserve(cx, cy, r * 2.4, r * 2.4)


def corridor(x0, y0, x1, y1, width=2.6, wall_side=0):
    """环池游廊：石基 + 木柱 + 坐槛 + 两坡瓦顶，外侧可带漏窗矮墙。"""
    dx, dy = x1 - x0, y1 - y0
    ln = math.hypot(dx, dy)
    if ln < 1.0:
        return
    ang = math.atan2(dy, dx)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2

    base = Builder()
    base.box(cx - ln / 2, cx + ln / 2, cy - width / 2, cy + width / 2, Z_TOP - 0.05, Z_TOP + 0.2)
    base.build("corridor_base", MAT_STONE, rot=ang, pivot=(cx, cy))

    wood = Builder()
    n = max(2, int(round(ln / 3.3)))
    for k in range(n + 1):
        x = cx - ln / 2 + 0.35 + (ln - 0.7) * k / n
        for s in (-1, 1):
            y = cy + s * (width / 2 - 0.22)
            wood.box(x - 0.13, x + 0.13, y - 0.13, y + 0.13, Z_TOP + 0.2, Z_TOP + 2.72)
    for s in (-1, 1):
        y = cy + s * (width / 2 - 0.3)
        wood.box(cx - ln / 2, cx + ln / 2, y - 0.09, y + 0.09, Z_TOP + 0.55, Z_TOP + 0.95)
    wood.build("corridor_wood", MAT_WOOD, rot=ang, pivot=(cx, cy))

    if wall_side:
        wh = Builder()
        lo = cy + wall_side * (width / 2 + 0.02)
        hi = cy + wall_side * (width / 2 + 0.3)
        ylo, yhi = min(lo, hi), max(lo, hi)
        cells = max(1, int(round(ln / 2.9)))
        cell = ln / cells
        for k in range(cells + 1):
            x = cx - ln / 2 + k * cell
            wh.box(x - 0.24, x + 0.24, ylo, yhi, Z_TOP + 0.2, Z_TOP + 2.82)
        wh.box(cx - ln / 2, cx + ln / 2, ylo, yhi, Z_TOP + 0.2, Z_TOP + 0.95)
        wh.box(cx - ln / 2, cx + ln / 2, ylo, yhi, Z_TOP + 2.16, Z_TOP + 2.82)
        wh.build("corridor_leakwall", MAT_WALL, rot=ang, pivot=(cx, cy))

    roof = Builder()
    roof.gable_roof(cx - ln / 2 - 0.35, cx + ln / 2 + 0.35, cy - width / 2, cy + width / 2,
                    Z_TOP + 2.95, 0.95, width * 0.42)
    roof.build("corridor_roof", MAT_TILE, rot=ang, pivot=(cx, cy))
    reserve(cx, cy, ln + 1.0, width + 2.0)


def slab_bridge(pts, width=1.5, top=0.34):
    """石板曲桥：平桥面 + 石墩。"""
    b = Builder()
    for k in range(len(pts) - 1):
        x0, y0 = pts[k]
        x1, y1 = pts[k + 1]
        dx, dy = x1 - x0, y1 - y0
        ln = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / ln * width / 2, dx / ln * width / 2
        b.quad((x0 + nx, y0 + ny, top), (x1 + nx, y1 + ny, top),
               (x1 - nx, y1 - ny, top), (x0 - nx, y0 - ny, top))
        b.quad((x0 + nx, y0 + ny, top), (x1 + nx, y1 + ny, top),
               (x1 + nx, y1 + ny, top - 0.16), (x0 + nx, y0 + ny, top - 0.16))
        b.quad((x0 - nx, y0 - ny, top), (x1 - nx, y1 - ny, top),
               (x1 - nx, y1 - ny, top - 0.16), (x0 - nx, y0 - ny, top - 0.16))
    for x, y in pts:
        b.box(x - width * 0.34, x + width * 0.34, y - width * 0.34, y + width * 0.34,
              Z_WATER - 0.04, top)
    b.build("stone_bridge", MAT_STONE)
    reserve(sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), 6.0, 6.0)


def stone_table(cx, cy):
    b = Builder()
    b.prism(cx, cy, Z_TOP + 0.42, Z_TOP + 0.56, 0.72, 0.72, 10, 0.0)
    b.prism(cx, cy, Z_TOP + 0.06, Z_TOP + 0.42, 0.16, 0.16, 6, 0.0)
    b.build("stone_table", MAT_STONE)
    stools = Builder()
    for i in range(4):
        a = i * math.tau / 4 + 0.4
        sx, sy = cx + math.cos(a) * 1.25, cy + math.sin(a) * 1.25
        stools.prism(sx, sy, Z_TOP + 0.05, Z_TOP + 0.42, 0.26, 0.28, 6, 0.0)
    stools.build("stone_stools", MAT_STONE)
    reserve(cx, cy, 3.6, 3.6)


def flower_bed(cx, cy, w, d):
    b = Builder()
    b.box(cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2, Z_TOP, Z_TOP + 0.42)
    b.build("flower_bed", MAT_STONE)
    g = Builder()
    g.box(cx - w / 2 + 0.2, cx + w / 2 - 0.2, cy - d / 2 + 0.2, cy + d / 2 - 0.2,
          Z_TOP + 0.42, Z_TOP + 0.56)
    g.build("flower_soil", MAT_LEAF)
    reserve(cx, cy, w + 1.0, d + 1.0)


def path_strip(pts, width=1.8):
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
        b.box(cx - ln / 2, cx + ln / 2, cy - width / 2, cy + width / 2, Z_TOP, Z_TOP + 0.06)
        b.build("garden_path", MAT_STONE, rot=ang, pivot=(cx, cy))


# ---------------------------------------------------------------- 宅院 / 园林分隔墙

wall_run((-19.7, -22.5), (1.2, -22.5))
wall_run((4.8, -22.5), (33.0, -22.5))
door_head((1.2, -22.5), (4.8, -22.5))

# 南侧宅院
hall(6.0, -43.5, 13.0, 7.0, 4.6, face=-1)     # 轿厅（临街大门）
hall(6.0, -31.5, 15.0, 8.0, 5.2, face=-1)     # 大厅

# ---------------------------------------------------------------- 环池主景

tower(0.0, -6.2, 7.6, 5.6, 2.7, 2.3, face=1)          # 濯缨水阁（临水两层）
pavilion(-18.2, 11.0, 2.7, 4.4, 6)                    # 月到风来亭（池西六角亭）
hall(-17.4, -12.5, 8.0, 6.0, 4.8, face=1)             # 看松读画轩
hall(18.2, 14.0, 9.0, 5.6, 4.4, face=-1)              # 竹外一枝轩
tower(24.0, 31.0, 8.0, 6.5, 3.0, 2.4, face=-1)        # 五峰书屋
hall(23.5, 41.5, 7.5, 5.5, 4.2, face=-1)              # 梯云室

# 环池游廊：南岸 → 东岸（漏窗墙朝外）
corridor(5.2, -4.0, 13.6, -2.6, width=2.5, wall_side=-1)
corridor(13.6, -2.6, 14.2, 9.0, width=2.5, wall_side=1)
# 西岸游廊（月到风来亭 → 看松读画轩）
corridor(-15.0, 6.0, -15.0, -6.5, width=2.4, wall_side=-1)

# 池西北石板曲桥（西岸 → 北岸，斜跨池的西北角）
slab_bridge([(-11.9, 16.0), (-9.8, 15.0), (-9.0, 17.0), (-7.0, 16.0),
             (-6.2, 18.2), (-4.0, 17.2), (-3.6, 19.4), (-1.4, 18.6),
             (-0.6, 20.8)], width=1.5, top=0.42)

# ---------------------------------------------------------------- 殿春簃（独立小院）

wall_run((-23.2, -3.4), (-23.2, 1.4), height=3.2)
wall_run((-23.2, 4.6), (-23.2, 10.4), height=3.2)
wall_run((-23.2, 10.4), (-34.4, 10.4), height=3.2)
wall_run((-34.4, -3.4), (-23.2, -3.4), height=3.2)
door_head((-23.2, 1.4), (-23.2, 4.6), h=3.0)

hall(-29.8, 7.0, 7.0, 4.2, 4.2, face=-1)             # 殿春簃
pavilion(-29.5, 0.6, 1.5, 3.1, 4, phase=math.pi / 4)  # 冷泉亭
stone_table(-25.4, 2.4)
flower_bed(-33.4, 0.8, 1.8, 2.6)

# 东侧院墙：分隔长条院（五峰书屋前的侧院）
wall_run((27.0, -22.0), (27.0, 3.5), height=3.0)
wall_run((27.0, 7.0), (27.0, 24.0), height=3.0)
door_head((27.0, 3.5), (27.0, 7.0), h=2.8)

# ---------------------------------------------------------------- 园路与点景

path_strip([(6.0, -39.3), (6.0, -36.2)])
path_strip([(4.5, -22.2), (4.5, -10.2)])
path_strip([(-17.4, -9.2), (-17.4, -6.6)])
path_strip([(14.2, 9.2), (17.6, 10.6)])

for px, py, r, h in [(9.8, 19.4, 1.1, 1.3), (12.6, 18.2, 0.9, 1.1),
                     (-6.8, -3.9, 0.9, 1.1)]:
    b = Builder()
    pts = []
    for k in range(6):
        a = k * math.tau / 6 + 0.3
        rr = r * (0.72 + RNG.random() * 0.5)
        pts.append((px + math.cos(a) * rr, py + math.sin(a) * rr))
    b.poly_prism(pts, Z_TOP, Z_TOP + h)
    b.build("rockery", MAT_STONE)


# ---------------------------------------------------------------- 树木 / 竹丛


def tree(x, y, h, r, kind="broad", z0=Z_TOP):
    # 树木只作点缀：高度压在厅堂檐口以下，冠幅同步收敛，避免遮住建筑
    h = min(h, 5.6)
    r = min(r, 1.9)
    trunk = Builder()
    trunk.box(x - 0.26, x + 0.26, y - 0.26, y + 0.26, z0, z0 + h * 0.58)
    trunk.build("tree_trunk", MAT_WOOD)

    leaf = Builder()
    if kind == "pine":
        for zz, rr in ((0.4, 1.0), (0.58, 0.78), (0.74, 0.54), (0.87, 0.3)):
            leaf.prism(x, y, z0 + h * zz, z0 + h * (zz + 0.12), r * rr, r * rr * 0.66, 7)
    else:
        leaf.prism(x, y, z0 + h * 0.28, z0 + h * 0.76, r, r * 0.56, 7)
        leaf.prism(x, y, z0 + h * 0.64, z0 + h, r * 0.62, r * 0.14, 7)
    leaf.build("tree_leaf", MAT_LEAF)


def bamboo(cx, cy, count=7, spread=1.9):
    stems = Builder()
    crown = Builder()
    for i in range(count):
        a = RNG.random() * math.tau
        d = RNG.random() * spread
        x = cx + math.cos(a) * d
        y = cy + math.sin(a) * d
        h = RNG.uniform(3.4, 5.4)
        stems.prism(x, y, Z_TOP, Z_TOP + h * 0.92, 0.06, 0.045, 4, 0.0)
        crown.prism(x, y, Z_TOP + h * 0.5, Z_TOP + h * 0.96, 0.5, 0.14, 5, 0.0)
    stems.build("bamboo_stalk", MAT_WOOD)
    crown.build("bamboo_leaf", MAT_LEAF)


# 松（看松读画轩前后）
tree(-20.6, -19.2, 6.6, 1.9, "pine")
tree(-10.8, -18.6, 6.2, 1.8, "pine")
tree(-20.2, -7.0, 5.8, 1.6, "pine")
# 池西 / 殿春簃外围
tree(-26.0, 15.8, 7.0, 2.2)
tree(-31.4, 13.3, 6.2, 1.9, "pine")
tree(-25.8, -7.4, 5.6, 1.6, "pine")
# 池北
tree(-9.6, 21.6, 6.0, 1.8, "pine")
tree(1.8, 21.4, 5.6, 1.6)
# 池东北
tree(15.8, 20.4, 6.4, 1.8)
# 东侧长条院落
tree(31.4, 21.0, 6.8, 2.0, "pine")
tree(31.2, 8.6, 5.8, 1.7)
tree(31.0, -2.6, 5.6, 1.7)
tree(31.4, -12.0, 5.4, 1.6)
tree(30.8, -19.0, 5.0, 1.5)
tree(30.2, 35.8, 6.2, 1.8)
tree(26.6, 47.6, 5.4, 1.6)
# 宅院天井与西院
tree(-14.6, -30.8, 5.6, 1.7)
tree(-14.0, -40.5, 5.2, 1.5)
tree(-8.0, -45.6, 4.8, 1.4)
tree(20.6, -30.0, 5.8, 1.7)
tree(23.6, -41.6, 6.0, 1.8)
tree(15.4, -44.0, 5.2, 1.5)
# 池南东侧空隙
tree(9.6, -12.6, 5.4, 1.6)

# 竹丛：殿春簃小院 4 处 + 池东 2 处
bamboo(-24.6, 6.7, 6, 1.5)
bamboo(-24.9, -0.9, 5, 1.3)
bamboo(-34.3, 4.2, 6, 1.5)
bamboo(-34.5, -2.4, 5, 1.3)
bamboo(16.2, 21.6, 7, 1.8)
bamboo(24.4, 20.2, 6, 1.7)

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
    obj = bpy.data.objects.new(f"wsh_{mat_name}", mesh)
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
meshes = 0
lo = [1e9, 1e9, 1e9]
hi = [-1e9, -1e9, -1e9]
for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    meshes += 1
    obj.data.calc_loop_triangles()
    tris += len(obj.data.loop_triangles)
    for v in obj.data.vertices:
        co = obj.matrix_world @ v.co
        for k in range(3):
            lo[k] = min(lo[k], co[k])
            hi[k] = max(hi[k], co[k])

size_kb = os.path.getsize(OUT) / 1024.0
print(
    f"[wangshiyuan] exported {OUT} | meshes={meshes} tris={tris} "
    f"bbox=({hi[0]-lo[0]:.2f} x {hi[1]-lo[1]:.2f} x {hi[2]-lo[2]:.2f}) "
    f"z=[{lo[2]:.2f}, {hi[2]:.2f}] size={size_kb:.1f}KB trees=23 bamboo=6"
)
