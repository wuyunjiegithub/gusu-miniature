"""报恩寺·北寺塔程序化建模并导出 GLB。

坐标约定：Blender +X = 东，+Y = 北，+Z = 上；单位为米，原点为景点质心。
scene [x, z] → Blender (x - centroid.x, -(z - centroid.z))，
glTF export_yup=True 后 +Z→+Y、+Y→-Z，与网页场景一致。
"""

import json
import math
import os
import random

import bmesh
import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "beisita.glb")
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
        """任意朝向的薄盒（八边形塔身各面的门窗）。"""
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
        """两坡顶：屋脊沿 X 方向（廊庑）。"""
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


# ---------------------------------------------------------------- 场景与材质

bpy.ops.wm.read_factory_settings(use_empty=True)

MAT_BRICK = material("brick", hexc("cfc6b4"), 0.93)          # 塔身：米白砖墙，与深色檐口拉开
MAT_TILE = material("tile", hexc("4d545e"), 0.82)            # 檐口 / 瓦 / 塔刹
MAT_STONE = material("stone", hexc("b3ab9b"), 0.95)          # 铺地 / 台基 / 平座
MAT_WALL = material("wall", hexc("e4ddcc"), 0.94)            # 殿身粉墙
MAT_WOOD = material("wood", hexc("7a4c33"), 0.86)            # 门窗 / 柱 / 树干
MAT_LEAF = material("leaf", hexc("556c48"), 0.95)            # 树冠

with open(SCENE_JSON, encoding="utf-8") as f:
    geo = json.load(f)
lm = geo["landmarks"]["beisita"]
CX, CZ = lm["centroid"]["x"], lm["centroid"]["z"]
OUTLINE = [(x - CX, -(z - CZ)) for x, z in lm["outline"]]
if abs(OUTLINE[0][0] - OUTLINE[-1][0]) < 0.01 and abs(OUTLINE[0][1] - OUTLINE[-1][1]) < 0.01:
    OUTLINE = OUTLINE[:-1]

# ---------------------------------------------------------------- 底板与石铺地

base = Builder()
base.poly_prism(OUTLINE, -0.5, 0.08)
base.build("temple_pave", MAT_STONE)

# ---------------------------------------------------------------- 院墙

WALL_H = 4.2
WALL_T = 0.7


def wall_run(p0, p1, height=WALL_H, thickness=WALL_T):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy)
    if length < 0.4:
        return
    ang = math.atan2(dy, dx)
    cx, cy = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2
    body = Builder()
    body.box(cx - length / 2, cx + length / 2, cy - thickness / 2, cy + thickness / 2, 0.08, 0.08 + height)
    body.build("temple_wall", MAT_WALL, rot=ang, pivot=(cx, cy))
    cap = Builder()
    cap.box(
        cx - length / 2 - 0.15,
        cx + length / 2 + 0.15,
        cy - thickness / 2 - 0.35,
        cy + thickness / 2 + 0.35,
        0.08 + height,
        0.08 + height + 0.42,
    )
    cap.build("temple_wall_cap", MAT_TILE, rot=ang, pivot=(cx, cy))


for i in range(len(OUTLINE)):
    wall_run(OUTLINE[i], OUTLINE[(i + 1) % len(OUTLINE)])

# ---------------------------------------------------------------- 殿宇

BUILDINGS = []


def hall(cx, cy, w, d, h, roof_h=None, z0=0.08, roof_inset=None, side_step=1.5):
    """单檐歇山简化院落建筑。"""
    if roof_h is None:
        roof_h = 0.36 * h
    if roof_inset is None:
        roof_inset = min(w, d) * 0.3

    platform = Builder()
    platform.box(cx - w / 2 - 1.8, cx + w / 2 + 1.8, cy - d / 2 - 1.8, cy + d / 2 + 1.8, z0, z0 + 0.7)
    platform.build("hall_platform", MAT_STONE)

    body = Builder()
    body.box(cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2, z0 + 0.7, z0 + 0.7 + h)
    body.build("hall_wall", MAT_WALL)

    skirt = Builder()
    skirt.box(cx - w / 2 - 0.18, cx + w / 2 + 0.18, cy - d / 2 - 0.18, cy + d / 2 + 0.18, z0 + 0.7, z0 + 1.6)
    skirt.build("hall_skirt", MAT_WOOD)

    doors = Builder()
    n = max(3, int(w / 5.0))
    dw = w / n * 0.6
    for i in range(n):
        dx = cx - w / 2 + (i + 0.5) * w / n
        doors.box(dx - dw / 2, dx + dw / 2, cy - d / 2 - 0.12, cy - d / 2 + 0.06, z0 + 0.7, z0 + 0.7 + h * 0.72)
    doors.build("hall_door", MAT_WOOD)

    roof = Builder()
    zt = z0 + 0.7 + h
    roof.hip_roof(
        cx - w / 2 - side_step,
        cx + w / 2 + side_step,
        cy - d / 2 - side_step,
        cy + d / 2 + side_step,
        zt,
        roof_h,
        roof_inset,
    )
    roof.build("hall_roof", MAT_TILE)

    xa, xb = cx - w / 2 - side_step + roof_inset, cx + w / 2 + side_step - roof_inset
    if xb - xa > 0.4:
        ridge = Builder()
        ridge.box(xa, xb, cy - 0.4, cy + 0.4, zt + roof_h - 0.05, zt + roof_h + 0.5)
        ridge.build("hall_ridge", MAT_TILE)

    BUILDINGS.append((cx, cy, w / 2 + 3.0, d / 2 + 3.0))


def corridor(x0, y0, x1, y1, width=4.2, h_body=2.8, h_roof=5.2):
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    ang = math.atan2(dy, dx)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2

    body = Builder()
    body.box(cx - length / 2, cx + length / 2, cy - width / 2, cy + width / 2, 0.08, 0.08 + h_body)
    body.build("corridor_wall", MAT_WALL, rot=ang, pivot=(cx, cy))

    skirt = Builder()
    skirt.box(cx - length / 2, cx + length / 2, cy - width / 2 - 0.18, cy + width / 2 + 0.18, 0.08, 1.0)
    skirt.build("corridor_skirt", MAT_WOOD, rot=ang, pivot=(cx, cy))

    roof = Builder()
    roof.gable_roof(cx - length / 2 - 0.3, cx + length / 2 + 0.3, cy - width / 2, cy + width / 2, h_roof, 1.2, width * 0.42)
    roof.build("corridor_roof", MAT_TILE, rot=ang, pivot=(cx, cy))

    BUILDINGS.append((cx, cy, length / 2, width / 2 + 3.0))


def censer(cx, cy):
    """香炉：石台 + 六边形炉身 + 攒尖炉盖。"""
    b = Builder()
    b.box(cx - 2.0, cx + 2.0, cy - 2.0, cy + 2.0, 0.08, 0.5)
    b.prism(cx, cy, 0.5, 1.6, 1.35, 1.1, 6, math.pi / 6)
    b.build("censer_body", MAT_STONE)

    b = Builder()
    b.prism(cx, cy, 1.6, 2.6, 1.55, 0.3, 6, math.pi / 6)
    b.build("censer_roof", MAT_TILE)
    BUILDINGS.append((cx, cy, 3.0, 3.0))


# 山门（南端）
hall(-4.0, -112.0, 20.0, 9.0, 7.0, 4.4, roof_inset=3.5)
# 大雄宝殿（面阔 36m，位于塔北的寺院主院）
hall(-16.0, 62.0, 36.0, 18.0, 10.0, 5.2, roof_inset=6.0)
# 东西廊庑
corridor(-48.0, 30.0, -48.0, 98.0)
corridor(16.0, 30.0, 16.0, 98.0)
# 香炉（塔前）
censer(-20.0, 30.0)

# ---------------------------------------------------------------- 北寺塔（九层八角）

PAGODA = (-23.7, -1.8)


def octagonal_pagoda(cx, cy):
    px, py = cx, cy

    # 台基：两级八角石台 + 平座栏杆
    podium = Builder()
    podium.prism(px, py, 0.08, 1.3, 14.4, 13.8, 8)
    podium.prism(px, py, 1.3, 1.9, 13.2, 13.0, 8)
    podium.build("pagoda_podium", MAT_STONE)

    rail = Builder()
    rail.prism(px, py, 1.9, 2.5, 12.4, 12.2, 8)
    rail.build("pagoda_rail", MAT_STONE)

    # 南向踏跺
    step = Builder()
    step.box(px - 4.0, px + 4.0, py - 14.4, py - 11.6, 0.08, 1.3)
    step.build("pagoda_step", MAT_STONE)

    # 九层逐层收分，每层都有明显的平座 + 挑檐 + 翘角
    radii = [10.4, 9.95, 9.5, 9.05, 8.6, 8.15, 7.7, 7.25, 6.8]
    heights = [8.6, 8.3, 8.0, 7.7, 7.4, 7.1, 6.8, 6.5, 6.2]
    z = 2.5
    for i, (r0, h) in enumerate(zip(radii, heights)):
        r1 = r0 * 0.93

        body = Builder()
        body.prism(px, py, z, z + h, r0, r1, 8)
        body.build(f"pagoda_body_{i}", MAT_BRICK)

        # 八角木柱：让塔身立面有竖向分割，不再像光板高楼
        col = Builder()
        for k in range(8):
            a = math.pi / 8 + k * math.pi / 4
            col.obox(
                px + math.cos(a) * r0 * 0.985,
                py + math.sin(a) * r0 * 0.985,
                a,
                0.42,
                0.42,
                z,
                z + h * 0.96,
            )
        col.build(f"pagoda_col_{i}", MAT_WOOD)

        # 八面门窗（浅进深木色板）
        rm = (r0 + r1) / 2 * math.cos(math.pi / 8)
        if i == 0:
            hw, hh, z0 = 1.25, 3.2, z + 0.3
        else:
            hw, hh, z0 = 0.8, 2.2, z + h * 0.26
        panels = Builder()
        for k in range(8):
            a = k * math.pi / 4
            panels.obox(px + math.cos(a) * rm, py + math.sin(a) * rm, a, hw, 0.14, z0, z0 + hh)
        panels.build(f"pagoda_window_{i}", MAT_WOOD)

        # 平座（浅色石栏板）——每层一条明显的水平亮带
        balcony = Builder()
        balcony.prism(px, py, z + h - 0.06, z + h + 0.42, r1 + 1.6, r1 + 1.5, 8)
        balcony.build(f"pagoda_balcony_{i}", MAT_STONE)

        # 挑檐：厚挑、外宽内窄，形成楼阁式塔的层层伞檐
        eave = Builder()
        eave.prism(px, py, z + h + 0.42, z + h + 1.7, r1 + 4.0, r1 + 2.9, 8)
        eave.build(f"pagoda_eave_{i}", MAT_TILE)

        # 八个檐角起翘
        tip = Builder()
        for k in range(8):
            a = math.pi / 8 + k * math.pi / 4
            d = r1 + 3.5
            tip.obox(
                px + math.cos(a) * d,
                py + math.sin(a) * d,
                a,
                0.5,
                0.5,
                z + h + 1.35,
                z + h + 2.45,
            )
        tip.build(f"pagoda_tip_{i}", MAT_TILE)

        z += h

    # 塔刹：刹座 + 相轮 + 宝珠（约 8m）
    spire = Builder()
    spire.prism(px, py, z, z + 1.4, 2.9, 2.3, 8)
    spire.build("pagoda_spire_base", MAT_STONE)

    spire = Builder()
    spire.prism(px, py, z + 1.4, z + 6.8, 0.6, 0.12, 8)
    for k in range(7):
        zz = z + 1.9 + k * 0.55
        r = 1.6 - k * 0.14
        spire.prism(px, py, zz, zz + 0.26, r, r, 8)
    spire.prism(px, py, z + 6.8, z + 7.6, 0.6, 0.42, 8)
    spire.prism(px, py, z + 7.6, z + 8.2, 0.45, 0.09, 8)
    spire.build("pagoda_spire", MAT_TILE)


octagonal_pagoda(*PAGODA)

# ---------------------------------------------------------------- 树木

RNG = random.Random(20261120)


def tree(x, y, h, r):
    trunk = Builder()
    trunk.box(x - 0.35, x + 0.35, y - 0.35, y + 0.35, 0.08, h * 0.45)
    trunk.build("tree_trunk", MAT_WOOD)

    leaf = Builder()
    leaf.prism(x, y, h * 0.28, h * 0.76, r, r * 0.55, 7)
    leaf.prism(x, y, h * 0.64, h, r * 0.6, r * 0.14, 7)
    leaf.build("tree_leaf", MAT_LEAF)


placed_pos = [(-17.0, -92.0), (2.0, -92.0), (-20.0, -60.0), (4.0, -55.0)]
for tx, ty in placed_pos:
    tree(tx, ty, RNG.uniform(7.0, 9.5), RNG.uniform(2.4, 3.1))

attempts = 0
while len(placed_pos) < 14 and attempts < 8000:
    attempts += 1
    x = RNG.uniform(-95, 66)
    y = RNG.uniform(-130, 165)
    if not point_in_poly(OUTLINE, x, y) or edge_distance(OUTLINE, x, y) < 4.5:
        continue
    if math.hypot(x - PAGODA[0], y - PAGODA[1]) < 17.0:
        continue
    if any(abs(x - bx) < bw and abs(y - by) < bd for bx, by, bw, bd in BUILDINGS):
        continue
    if any(math.hypot(x - px, y - py) < 8.0 for px, py in placed_pos):
        continue
    placed_pos.append((x, y))
    tree(x, y, RNG.uniform(6.5, 10.0), RNG.uniform(2.2, 3.2))

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
    obj = bpy.data.objects.new(f"beisita_{mat_name}", mesh)
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
    f"[beisita] exported {OUT} | meshes={len([o for o in bpy.data.objects if o.type=='MESH'])} "
    f"tris={tris} trees={len(placed_pos)}"
)
