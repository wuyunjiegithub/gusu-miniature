"""唐寅祠（苏州桃花坞）程序化建模并导出 GLB。

坐标约定：Blender +X = 东，+Y = 北，+Z = 上；1 单位 = 1 米；原点 = 景点质心。
scene [x, z] → Blender (x - cx, -(z - cz))；glTF export_yup=True。

布局：外圈粉墙沿 outline；南墙正中开三开间门厅（祠门），门厅之后为第一进院落
（石板铺地、东西厢房、桃树、香炉、石碑），仪门分隔两进，第二进为五开间享堂
（台基抬高 0.6 m、前檐廊柱），东侧六如亭，院中经幢与石碑点缀。

院内几何在「院落坐标系」中编排：p 沿南墙向东，n 垂直南墙向北，建模结束时
统一映射回 Blender 世界坐标（保长变换）。
"""

import json
import math
import os
import random

import bmesh
import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "tangyinci.glb")
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

    def obox(self, cx, cy, ang, half_w, half_d, z0, z1):
        """任意朝向的薄盒。"""
        ux, uy = math.cos(ang), math.sin(ang)
        vx, vy = -uy, ux

        def corner(su, sv, z):
            return (
                cx + ux * su * half_d + vx * sv * half_w,
                cy + uy * su * half_d + vy * sv * half_w,
                z,
            )

        bot = [corner(-1, -1, z0), corner(1, -1, z0), corner(1, 1, z0), corner(-1, 1, z0)]
        top = [corner(-1, -1, z1), corner(1, -1, z1), corner(1, 1, z1), corner(-1, 1, z1)]
        for i in range(4):
            j = (i + 1) % 4
            self.quad(bot[i], bot[j], top[j], top[i])
        self.quad(top[0], top[1], top[2], top[3])
        self.quad(bot[0], bot[1], bot[2], bot[3])

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
            r0, r1 = (xa, ym, z0 + h), (xb, ym, z0 + h)
            self.quad(b0, b1, r1, r0)
            self.quad(b2, b3, r0, r1)
            self.tri(b1, b2, r1)
            self.tri(b3, b0, r0)
        self.quad(b0, b1, b2, b3)
        scale = max(0.7, min(1.5, h / 2.8))
        if ridge and has_ridge:
            self.ridge_cap(xa, xb, ym, z0 + h, scale)
        if upturn:
            for c, out in (((x0, y0), (-1, -1)), ((x1, y0), (1, -1)),
                           ((x1, y1), (1, 1)), ((x0, y1), (-1, 1))):
                self.corner_upturn(c, out, z0, 0.95 * scale, 0.7 * scale, 0.34 * scale)

    def gable_roof(self, x0, x1, y0, y1, z0, h, overhang=0.0, ridge=True):
        """硬山两坡顶：屋脊沿 X 方向，脊头起翘。"""
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
        """正脊压顶 + 两端吻兽。"""
        t = 0.28 * scale
        self.box(xa - t, xb + t, ym - t * 1.05, ym + t * 1.05, zr - 0.08, zr + 0.24 * scale)
        self.box(xa, xb, ym - t * 0.7, ym + t * 0.7, zr + 0.24 * scale, zr + 0.46 * scale)
        self.ridge_horn(xa - t, -1.0, ym, zr + 0.1 * scale, scale)
        self.ridge_horn(xb + t, 1.0, ym, zr + 0.1 * scale, scale)

    def ridge_horn(self, bx, out, ym, zr, scale=1.0):
        """脊端起翘的吻兽轮廓。"""
        tx = bx + out * 0.6 * scale
        w0, w1 = 0.26 * scale, 0.08 * scale
        zb, zt = zr - 0.04, zr + 0.5 * scale
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


class FrameBuilder(Builder):
    """院落坐标系 (p 东, n 北) → Blender 世界坐标，构建时一次映射。"""

    def build(self, name, material, rot=0.0, pivot=(0.0, 0.0)):
        entry = MERGED.setdefault(material.name, [material, [], []])
        offset = len(entry[1])
        px, py = pivot
        c, s = math.cos(rot), math.sin(rot)
        verts = []
        for x, y, z in self.verts:
            if rot:
                dx, dy = x - px, y - py
                x, y = px + dx * c - dy * s, py + dx * s + dy * c
            verts.append((OX + UX * x + NX * y, OY + UY * x + NY * y, z))
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


# ---------------------------------------------------------------- 场景与材质

bpy.ops.wm.read_factory_settings(use_empty=True)

MAT_WALL = material("wall", hexc("e4ddcc"), 0.93)       # 粉墙
MAT_TILE = material("tile", hexc("4d545e"), 0.8)        # 黛瓦
MAT_WOOD = material("wood", hexc("7a4c33"), 0.86)       # 木构 / 门窗
MAT_STONE = material("stone", hexc("b3ab9b"), 0.94)     # 台基 / 碑 / 台阶
MAT_PAVE = material("pave", hexc("c6bfae"), 0.95)       # 院内石板铺地
MAT_LEAF = material("leaf", hexc("556c48"), 0.95)       # 绿荫
MAT_BLOSSOM = material("blossom", hexc("c98a9c"), 0.95)  # 桃花

with open(SCENE_JSON, encoding="utf-8") as f:
    geo = json.load(f)
lm = geo["landmarks"]["tangyinci"]
CX, CZ = lm["centroid"]["x"], lm["centroid"]["z"]
WORLD = [(x - CX, -(z - CZ)) for x, z in lm["outline"]]
if abs(WORLD[0][0] - WORLD[-1][0]) < 0.01 and abs(WORLD[0][1] - WORLD[-1][1]) < 0.01:
    WORLD = WORLD[:-1]

# 南墙 = 平均 y 最小（最南）的那一段；以其为院落坐标系的基准轴
south = min(range(len(WORLD)), key=lambda i: WORLD[i][1] + WORLD[(i + 1) % len(WORLD)][1])
A0, A1 = WORLD[south], WORLD[(south + 1) % len(WORLD)]
if A0[0] > A1[0]:
    A0, A1 = A1, A0
south_ang = math.atan2(A1[1] - A0[1], A1[0] - A0[0])
UX, UY = math.cos(south_ang), math.sin(south_ang)

# 内向法线：指向轮廓质心一侧
mcx = sum(p[0] for p in WORLD) / len(WORLD)
mcy = sum(p[1] for p in WORLD) / len(WORLD)
mx, my = (A0[0] + A1[0]) / 2, (A0[1] + A1[1]) / 2
if (mcx - mx) * (-UY) + (mcy - my) * UX > 0:
    NX, NY = -UY, UX
else:
    NX, NY = UY, -UX

OX, OY = A0
OUTLINE = []
for qx, qy in WORLD:
    dx, dy = qx - OX, qy - OY
    OUTLINE.append((round(dx * UX + dy * UY, 3), round(max(dx * NX + dy * NY, 0.0), 3)))

RNG = random.Random(20261120)


# ---------------------------------------------------------------- 屋顶 / 细部工具


def roof_x(b, p0, p1, n0, n1, z0, h, oh=0.0):
    """两坡顶，屋脊沿 p 轴。"""
    na, nb = n0 - oh, n1 + oh
    nm = (n0 + n1) / 2
    b.quad((p0, na, z0), (p1, na, z0), (p1, nm, z0 + h), (p0, nm, z0 + h))
    b.quad((p0, nb, z0), (p1, nb, z0), (p1, nm, z0 + h), (p0, nm, z0 + h))
    b.tri((p0, na, z0), (p0, nb, z0), (p0, nm, z0 + h))
    b.tri((p1, na, z0), (p1, nb, z0), (p1, nm, z0 + h))
    b.quad((p0, na, z0), (p1, na, z0), (p1, nb, z0), (p0, nb, z0))


def roof_y(b, p0, p1, n0, n1, z0, h, oh=0.0):
    """两坡顶，屋脊沿 n 轴。"""
    pa, pb = p0 - oh, p1 + oh
    pm = (p0 + p1) / 2
    b.quad((pa, n0, z0), (pa, n1, z0), (pm, n1, z0 + h), (pm, n0, z0 + h))
    b.quad((pb, n0, z0), (pb, n1, z0), (pm, n1, z0 + h), (pm, n0, z0 + h))
    b.tri((pa, n0, z0), (pb, n0, z0), (pm, n0, z0 + h))
    b.tri((pa, n1, z0), (pb, n1, z0), (pm, n1, z0 + h))
    b.quad((pa, n0, z0), (pb, n0, z0), (pb, n1, z0), (pa, n1, z0))


def eave(b, p0, p1, n0, n1, z, out=0.28, drop=0.32):
    """檐口挑出的一圈深色瓦口。"""
    b.box(p0 - out, p1 + out, n0 - out, n1 + out, z - drop, z + 0.02)


def lattice(b, p0, p1, n0, n1, z0, z1, cols=2, rows=3):
    """沿 p 方向展开的木格窗。"""
    t = 0.075
    for i in range(cols + 1):
        p = p0 + (p1 - p0) * i / cols
        b.box(p - t, p + t, n0, n1, z0, z1)
    for j in range(rows + 1):
        z = z0 + (z1 - z0) * j / rows
        b.box(p0, p1, n0, n1, max(z - 0.065, z0 - 0.065), min(z + 0.065, z1 + 0.065))


def lattice_y(b, p0, p1, n0, n1, z0, z1, cols=2, rows=3):
    """沿 n 方向展开的木格窗。"""
    t = 0.075
    for i in range(cols + 1):
        n = n0 + (n1 - n0) * i / cols
        b.box(p0, p1, n - t, n + t, z0, z1)
    for j in range(rows + 1):
        z = z0 + (z1 - z0) * j / rows
        b.box(p0, p1, n0, n1, max(z - 0.065, z0 - 0.065), min(z + 0.065, z1 + 0.065))


# ---------------------------------------------------------------- 底板与铺装

base = FrameBuilder()
base.poly_prism(OUTLINE, -0.25, 0.0)
base.build("tyc_ground", MAT_STONE)


def pave(p0, p1, n0, n1, z=0.12):
    b = FrameBuilder()
    b.box(p0, p1, n0, n1, 0.0, z)
    b.build("tyc_paving", MAT_PAVE)


pave(2.0, 54.0, 8.2, 36.0)      # 第一进院落
pave(4.0, 56.0, 36.0, 50.0)     # 第二进院落

# 中轴神道（略高，避免与铺地共面）
b = FrameBuilder()
b.box(16.6, 22.4, 8.0, 48.0, 0.0, 0.16)
b.build("tyc_path", MAT_STONE)

# ---------------------------------------------------------------- 院墙

WALL_H = 4.4
WALL_T = 0.7
GATE_P0, GATE_P1 = 11.0, 27.0


def wall_run(p0, p1, height=WALL_H, thickness=WALL_T):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy)
    if length < 0.4:
        return
    ang = math.atan2(dy, dx)
    cx, cy = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2
    body = FrameBuilder()
    body.box(cx - length / 2, cx + length / 2, cy - thickness / 2, cy + thickness / 2, 0.0, height)
    body.build("tyc_wall", MAT_WALL, rot=ang, pivot=(cx, cy))
    cap = FrameBuilder()
    cap.box(cx - length / 2 - 0.12, cx + length / 2 + 0.12,
            cy - thickness / 2 - 0.34, cy + thickness / 2 + 0.34, height, height + 0.36)
    cap.build("tyc_wall_cap", MAT_TILE, rot=ang, pivot=(cx, cy))
    ridge = FrameBuilder()
    ridge.box(cx - length / 2 - 0.12, cx + length / 2 + 0.12,
              cy - 0.2, cy + 0.2, height + 0.36, height + 0.52)
    ridge.build("tyc_wall_ridge", MAT_TILE, rot=ang, pivot=(cx, cy))


for i in range(len(OUTLINE)):
    p0, p1 = OUTLINE[i], OUTLINE[(i + 1) % len(OUTLINE)]
    if i == south:  # 南墙留门厅缺口
        wall_run((GATE_P1, 0.0), p1)
        wall_run(p0, (GATE_P0, 0.0))
    else:
        wall_run(p0, p1)

# 墙角石基
foot = FrameBuilder()
for x, y in OUTLINE:
    foot.box(x - 0.7, x + 0.7, y - 0.7, y + 0.7, 0.0, 0.5)
foot.build("tyc_wall_foot", MAT_STONE)

# ---------------------------------------------------------------- 祠门（三开间门厅）

GATE_Z = 0.35
GATE_TOP = 5.3

b = FrameBuilder()
b.box(GATE_P0 - 1.0, GATE_P1 + 1.0, -0.7, 8.5, 0.0, GATE_Z)
b.build("tyc_gate_base", MAT_STONE)

b = FrameBuilder()
b.box(GATE_P0, GATE_P1, 0.0, 8.0, GATE_Z, GATE_TOP)
b.build("tyc_gate_wall", MAT_WALL)

b = FrameBuilder()
eave(b, GATE_P0, GATE_P1, 0.0, 8.0, GATE_TOP)
b.build("tyc_gate_eave", MAT_TILE)

b = FrameBuilder()
roof_x(b, GATE_P0 - 0.4, GATE_P1 + 0.4, 0.0, 8.0, GATE_TOP + 0.02, 2.5, oh=1.15)
b.build("tyc_gate_roof", MAT_TILE)

b = FrameBuilder()
b.box(GATE_P0 - 0.2, GATE_P1 + 0.2, 3.7, 4.3, GATE_TOP + 2.4, GATE_TOP + 2.75)
b.build("tyc_gate_ridge", MAT_TILE)

# 木门（三间：明间双扇，次间单扇）+ 门框
b = FrameBuilder()
bay = (GATE_P1 - GATE_P0) / 3.0
for i in range(3):
    pc = GATE_P0 + (i + 0.5) * bay
    half = 1.55 if i == 1 else 1.05
    b.box(pc - half, pc + half, -0.08, 0.12, GATE_Z, GATE_Z + 3.55)
    # 门框
    b.box(pc - half - 0.22, pc - half, -0.14, 0.14, GATE_Z, GATE_Z + 3.75)
    b.box(pc + half, pc + half + 0.22, -0.14, 0.14, GATE_Z, GATE_Z + 3.75)
    b.box(pc - half - 0.22, pc + half + 0.22, -0.14, 0.14, GATE_Z + 3.55, GATE_Z + 3.75)
    if i == 1:
        b.box(pc - 0.05, pc + 0.05, -0.1, 0.14, GATE_Z, GATE_Z + 3.55)
b.build("tyc_gate_door", MAT_WOOD)

# 门额
b = FrameBuilder()
b.box(GATE_P0 + 5.4, GATE_P1 - 5.4, -0.3, 0.02, 4.2, 4.95)
b.build("tyc_gate_plaque", MAT_WOOD)

# 门前踏步与门枕石
b = FrameBuilder()
b.box(GATE_P0 + 1.2, GATE_P1 - 1.2, -1.5, 0.0, 0.0, 0.18)
b.build("tyc_gate_step", MAT_STONE)

b = FrameBuilder()
for pc in (GATE_P0 + 1.4, GATE_P1 - 1.4):
    b.box(pc - 0.45, pc + 0.45, -0.75, 0.05, 0.0, 0.75)
    b.box(pc - 0.3, pc + 0.3, -0.62, 0.02, 0.75, 0.95)
b.build("tyc_door_stone", MAT_STONE)

# ---------------------------------------------------------------- 第一进：东西厢房


def side_hall(p0, p1, n0, n1, face):
    """厢房：硬山两坡，屋脊沿 n；face=+1 门朝东，-1 门朝西。"""
    b = FrameBuilder()
    b.box(p0 - 0.9, p1 + 0.9, n0 - 0.9, n1 + 0.9, 0.0, 0.3)
    b.build("tyc_wing_base", MAT_STONE)

    b = FrameBuilder()
    b.box(p0, p1, n0, n1, 0.3, 4.7)
    b.build("tyc_wing_wall", MAT_WALL)

    b = FrameBuilder()
    eave(b, p0, p1, n0, n1, 4.7, 0.24, 0.3)
    b.build("tyc_wing_eave", MAT_TILE)

    b = FrameBuilder()
    roof_y(b, p0, p1, n0 - 0.2, n1 + 0.2, 4.72, 1.9, oh=0.85)
    b.build("tyc_wing_roof", MAT_TILE)

    b = FrameBuilder()
    pm = (p0 + p1) / 2
    b.box(pm - 0.26, pm + 0.26, n0 - 0.2, n1 + 0.2, 4.7, 5.0)
    b.build("tyc_wing_ridge", MAT_TILE)

    # 硬山山墙：白墙填满两坡之间的三角（薄板，保证法线朝外）
    b = FrameBuilder()
    for ne in (n0 - 0.24, n1 + 0.24):
        g = [(p0 - 0.78, ne, 4.74), (p1 + 0.78, ne, 4.74), (pm, ne, 6.48)]
        dn = 0.12 if ne < (n0 + n1) / 2 else -0.12
        g2 = [(x, y + dn, z) for x, y, z in g]
        b.tri(g[0], g[1], g[2])
        b.tri(g2[0], g2[2], g2[1])
        for i in range(3):
            b.quad(g[i], g[(i + 1) % 3], g2[(i + 1) % 3], g2[i])
    b.build("tyc_wing_gable", MAT_WALL)

    # 面向庭院的木装修：裙板 + 木格窗 + 门
    f = p1 if face > 0 else p0
    q0, q1 = (f - 0.2, f + 0.05) if face > 0 else (f - 0.05, f + 0.2)
    b = FrameBuilder()
    b.box(q0, q1, n0 + 0.6, n1 - 0.6, 0.3, 0.95)
    for k in range(4):
        na = n0 + 0.8 + (n1 - n0 - 1.6) * k / 4
        nb = n0 + 0.8 + (n1 - n0 - 1.6) * (k + 1) / 4
        if k == 1:
            b.box(q0 - 0.02, q1 + 0.02, na + 0.25, nb - 0.25, 0.3, 3.3)
        else:
            lattice_y(b, q0, q1, na + 0.3, nb - 0.3, 1.05, 3.3, 2, 3)
    b.build("tyc_wing_wood", MAT_WOOD)


side_hall(4.0, 13.0, 14.0, 32.0, +1)
side_hall(44.0, 53.0, 14.0, 32.0, -1)

# ---------------------------------------------------------------- 仪门（两进之间）

IN_P0, IN_P1 = 12.0, 26.0

# 明间开口（中间留空，两侧砌墙）
b = FrameBuilder()
b.box(IN_P0 - 0.15, IN_P0 + 5.0, 35.2, 38.8, 0.12, 4.3)
b.box(IN_P1 - 5.0, IN_P1 + 0.15, 35.2, 38.8, 0.12, 4.3)
b.box(IN_P0 + 5.0, IN_P1 - 5.0, 35.2, 38.8, 3.45, 4.3)
b.build("tyc_iner_mass", MAT_WALL)

b = FrameBuilder()
eave(b, IN_P0, IN_P1, 35.2, 38.8, 4.3, 0.22, 0.3)
b.build("tyc_iner_eave", MAT_TILE)

b = FrameBuilder()
roof_x(b, IN_P0 - 0.4, IN_P1 + 0.4, 35.2, 38.8, 4.32, 1.7, oh=0.95)
b.build("tyc_iner_roof", MAT_TILE)

b = FrameBuilder()
b.box(IN_P0 - 0.2, IN_P1 + 0.2, 36.6, 37.4, 5.9, 6.15)
b.build("tyc_iner_ridge", MAT_TILE)

# 明间两侧木柱 + 门额
b = FrameBuilder()
b.box(IN_P0 + 4.75, IN_P0 + 5.15, 36.7, 37.3, 0.12, 3.5)
b.box(IN_P1 - 5.15, IN_P1 - 4.75, 36.7, 37.3, 0.12, 3.5)
b.box(IN_P0 + 6.6, IN_P1 - 6.6, 36.72, 37.28, 3.0, 3.45)
b.build("tyc_iner_wood", MAT_WOOD)

# ---------------------------------------------------------------- 享堂（第二进主体）

HALL_P0, HALL_P1 = 8.0, 32.0
HALL_N0, HALL_N1 = 50.0, 65.0
PLAT_Z = 0.6
HALL_TOP = 6.4

# 台基（抬高 0.6 m）
b = FrameBuilder()
b.box(HALL_P0 - 2.0, HALL_P1 + 2.0, 46.8, 66.0, 0.0, PLAT_Z)
b.build("tyc_hall_platform", MAT_STONE)

# 前檐踏跺（三级）
b = FrameBuilder()
b.box(16.0, 24.0, 44.0, 46.8, 0.0, 0.2)
b.box(16.0, 24.0, 44.7, 46.8, 0.2, 0.4)
b.box(16.0, 24.0, 45.4, 46.8, 0.4, PLAT_Z)
b.build("tyc_hall_steps", MAT_STONE)

# 台基前缘压石
b = FrameBuilder()
b.box(HALL_P0 - 2.2, HALL_P1 + 2.2, 46.55, 47.0, PLAT_Z - 0.14, PLAT_Z + 0.02)
b.build("tyc_hall_platform_trim", MAT_WOOD)

# 殿身
b = FrameBuilder()
b.box(HALL_P0, HALL_P1, HALL_N0, HALL_N1, PLAT_Z, HALL_TOP)
b.build("tyc_hall_wall", MAT_WALL)

# 前檐廊柱与额枋
b = FrameBuilder()
for k in range(6):
    pc = HALL_P0 + 0.6 + (HALL_P1 - HALL_P0 - 1.2) * k / 5
    b.box(pc - 0.23, pc + 0.23, 47.55, 48.01, PLAT_Z, 5.9)
    b.box(pc - 0.36, pc + 0.36, 47.42, 48.14, PLAT_Z, PLAT_Z + 0.2)
b.box(HALL_P0, HALL_P1, 47.5, 48.06, 5.55, 5.95)
b.build("tyc_hall_columns", MAT_WOOD)

# 五开间木装修：明间隔扇门，次间 / 梢间木格窗
b = FrameBuilder()
b.box(HALL_P0 - 0.1, HALL_P1 + 0.1, HALL_N0 - 0.16, HALL_N0 + 0.02, PLAT_Z, PLAT_Z + 0.9)
bayw = (HALL_P1 - HALL_P0) / 5.0
for i in range(5):
    pc = HALL_P0 + (i + 0.5) * bayw
    if i == 2:
        # 明间：四扇落地长窗
        for s in (-1, 0, 1):
            q = pc + s * 1.35
            b.box(q - 0.6, q + 0.6, HALL_N0 - 0.14, HALL_N0 + 0.02, PLAT_Z + 0.9, 5.1)
            lattice(b, q - 0.62, q + 0.62, HALL_N0 - 0.18, HALL_N0 - 0.02, 2.0, 4.9, 1, 3)
        b.box(pc - 2.1, pc - 1.95, HALL_N0 - 0.2, HALL_N0 + 0.02, PLAT_Z, 5.25)
        b.box(pc + 1.95, pc + 2.1, HALL_N0 - 0.2, HALL_N0 + 0.02, PLAT_Z, 5.25)
    else:
        b.box(pc - 1.75, pc + 1.75, HALL_N0 - 0.14, HALL_N0 + 0.02, PLAT_Z + 0.9, PLAT_Z + 1.55)
        lattice(b, pc - 1.6, pc + 1.6, HALL_N0 - 0.18, HALL_N0 - 0.02, 1.55, 5.0, 3, 4)
        b.box(pc - 1.9, pc - 1.72, HALL_N0 - 0.2, HALL_N0 + 0.02, PLAT_Z, 5.35)
        b.box(pc + 1.72, pc + 1.9, HALL_N0 - 0.2, HALL_N0 + 0.02, PLAT_Z, 5.35)
b.build("tyc_hall_wood", MAT_WOOD)

# 两山墙木格窗
b = FrameBuilder()
for f, sgn in ((HALL_P0, -1), (HALL_P1, +1)):
    p0, p1 = (f - 0.2, f - 0.04) if sgn < 0 else (f + 0.04, f + 0.2)
    lattice_y(b, p0, p1, HALL_N0 + 3.5, HALL_N0 + 9.5, 2.1, 4.4, 3, 2)
b.build("tyc_hall_windows", MAT_WOOD)

# 檐口 + 歇山（简化庑殿）顶
b = FrameBuilder()
eave(b, HALL_P0, HALL_P1, HALL_N0, HALL_N1, HALL_TOP, 0.32, 0.36)
b.build("tyc_hall_eave", MAT_TILE)

b = FrameBuilder()
b.hip_roof(HALL_P0 - 2.8, HALL_P1 + 2.8, HALL_N0 - 2.8, HALL_N1 + 2.2,
           HALL_TOP + 0.02, 3.2, 5.4)
b.build("tyc_hall_roof", MAT_TILE)

b = FrameBuilder()
b.box(10.4, 29.6, 56.8, 57.8, 9.4, 9.9)
b.box(10.2, 11.2, 56.6, 57.8, 9.7, 10.5)
b.box(28.8, 29.8, 56.6, 57.8, 9.7, 10.5)
b.build("tyc_hall_ridge", MAT_TILE)

# ---------------------------------------------------------------- 六如亭

PAV_P, PAV_N, PAV_R = 57.0, 41.0, 2.1

b = FrameBuilder()
b.box(PAV_P - 3.3, PAV_P + 3.3, PAV_N - 3.3, PAV_N + 3.3, 0.0, 0.35)
b.build("tyc_pav_base", MAT_STONE)

b = FrameBuilder()
for dp in (-PAV_R, PAV_R):
    for dn in (-PAV_R, PAV_R):
        b.box(PAV_P + dp - 0.16, PAV_P + dp + 0.16,
              PAV_N + dn - 0.16, PAV_N + dn + 0.16, 0.35, 4.1)
# 坐凳栏杆
for dn in (-PAV_R, PAV_R):
    b.box(PAV_P - PAV_R, PAV_P + PAV_R, PAV_N + dn - 0.09, PAV_N + dn + 0.09, 0.35, 0.95)
for dp in (-PAV_R, PAV_R):
    b.box(PAV_P + dp - 0.09, PAV_P + dp + 0.09, PAV_N - PAV_R, PAV_N + PAV_R, 0.35, 0.95)
b.build("tyc_pav_wood", MAT_WOOD)

b = FrameBuilder()
b.prism(PAV_P, PAV_N, 4.1, 5.35, 4.15, 0.55, 4, math.pi / 4)
b.prism(PAV_P, PAV_N, 5.35, 5.7, 0.6, 0.34, 4, math.pi / 4)
b.prism(PAV_P, PAV_N, 5.7, 6.35, 0.24, 0.05, 8)
b.build("tyc_pav_roof", MAT_TILE)

b = FrameBuilder()
b.box(PAV_P - 1.1, PAV_P + 1.1, PAV_N - PAV_R - 0.14, PAV_N - PAV_R + 0.04, 3.2, 3.75)
b.build("tyc_pav_plaque", MAT_WOOD)

# ---------------------------------------------------------------- 香炉 / 石碑 / 经幢

# 香炉（第一进中轴）
b = FrameBuilder()
b.box(16.9, 22.1, 25.4, 30.6, 0.16, 0.55)
b.prism(19.5, 28.0, 0.55, 1.75, 1.25, 1.0, 6, math.pi / 6)
b.prism(19.5, 28.0, 1.75, 2.35, 1.0, 1.0, 6, math.pi / 6)
b.build("tyc_censer", MAT_STONE)

b = FrameBuilder()
b.prism(19.5, 28.0, 2.35, 3.35, 1.55, 0.22, 6, math.pi / 6)
b.prism(19.5, 28.0, 3.35, 3.55, 0.26, 0.1, 6, math.pi / 6)
b.build("tyc_censer_roof", MAT_TILE)


def stele(p, n):
    b = FrameBuilder()
    b.box(p - 0.7, p + 0.7, n - 0.5, n + 0.5, 0.12, 0.42)
    b.box(p - 0.5, p + 0.5, n - 0.28, n + 0.28, 0.42, 2.15)
    b.box(p - 0.62, p + 0.62, n - 0.38, n + 0.38, 2.15, 2.34)
    b.build("tyc_stele", MAT_STONE)


stele(7.0, 18.0)
stele(32.0, 18.0)
stele(36.5, 42.5)

# 经幢（第二进西侧）
b = FrameBuilder()
b.box(7.0, 9.0, 42.5, 44.5, 0.12, 0.6)
b.prism(8.0, 43.5, 0.6, 1.1, 0.72, 0.62, 8, 0.0)
b.prism(8.0, 43.5, 1.1, 3.3, 0.5, 0.42, 8, 0.0)
b.prism(8.0, 43.5, 3.3, 3.7, 0.62, 0.3, 8, 0.0)
b.build("tyc_sutra", MAT_STONE)

# ---------------------------------------------------------------- 树木


def crown(b, cx, cy, z0, z1, r, sides=12):
    """旋转体树冠，轮廓连续，避免分层棱锥感。"""
    levels = [(0.0, 0.30), (0.14, 0.72), (0.34, 0.96), (0.55, 1.0),
              (0.74, 0.78), (0.9, 0.42), (1.0, 0.05)]
    rings = []
    for t, rr in levels:
        z = z0 + (z1 - z0) * t
        rings.append([(cx + math.cos(i * 2 * math.pi / sides) * r * rr,
                       cy + math.sin(i * 2 * math.pi / sides) * r * rr, z)
                      for i in range(sides)])
    for k in range(len(rings) - 1):
        lo, hi = rings[k], rings[k + 1]
        for i in range(sides):
            j = (i + 1) % sides
            b.quad(lo[i], lo[j], hi[j], hi[i])
    for i in range(1, sides - 1):
        b.tri(rings[0][0], rings[0][i], rings[0][i + 1])
        b.tri(rings[-1][0], rings[-1][i], rings[-1][i + 1])


def tree(x, y, h, r, blossom):
    trunk = FrameBuilder()
    trunk.box(x - 0.26, x + 0.26, y - 0.26, y + 0.26, 0.12, h * 0.5)
    trunk.build("tyc_tree_trunk", MAT_WOOD)

    leaf = FrameBuilder()
    crown(leaf, x, y, h * 0.24, h, r)
    leaf.build("tyc_tree_crown", MAT_BLOSSOM if blossom else MAT_LEAF)


# 桃树（呼应桃花坞）
for x, y, h, r in [(5.2, 10.8, 6.2, 2.3), (34.0, 11.8, 6.6, 2.4),
                   (5.9, 35.4, 5.8, 2.2), (34.8, 33.6, 6.0, 2.3),
                   (58.0, 19.5, 6.2, 2.3), (61.0, 32.0, 5.8, 2.2)]:
    tree(x, y, h, r, True)

# 绿荫
for x, y, h, r in [(2.6, 36.0, 7.2, 2.4), (12.0, 72.5, 7.8, 2.7),
                   (30.0, 73.0, 7.4, 2.6), (50.0, 72.0, 7.6, 2.7),
                   (62.0, 51.0, 7.0, 2.4), (63.0, 60.0, 7.4, 2.6),
                   (60.0, 68.0, 7.2, 2.5)]:
    tree(x, y, h, r, False)

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
    obj = bpy.data.objects.new(f"tangyinci_{mat_name}", mesh)
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
    if obj.type == "MESH":
        obj.data.calc_loop_triangles()
        tris += len(obj.data.loop_triangles)
        for v in obj.data.vertices:
            w = obj.matrix_world @ v.co
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
print(
    f"[tangyinci] exported {OUT} | meshes={len([o for o in bpy.data.objects if o.type == 'MESH'])} "
    f"tris={tris} bbox=({hi[0]-lo[0]:.1f} x {hi[1]-lo[1]:.1f} x {hi[2]-lo[2]:.1f}) "
    f"minz={lo[2]:.2f} size={os.path.getsize(OUT)}"
)
