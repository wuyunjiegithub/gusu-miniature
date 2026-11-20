"""西园戒幢律寺程序化建模并导出 GLB。

坐标约定：Blender +X = 东，+Y = 北，+Z = 上；单位为米，原点为景点质心。
scene [x, z] → Blender (x - centroid.x, -(z - centroid.z))，
glTF export_yup=True 后 +Z→+Y、+Y→-Z，与网页场景一致。

布局：外围黄墙（wall_yellow）围合，南侧三开间山门；中轴自南向北依次为
天王殿、重檐大雄宝殿、藏经楼（两层），东侧配殿、罗汉堂与钟鼓楼；
西侧为西花园，含放生池（water 水面 z=0.15）、六角湖心亭与石曲桥。
地形底板按 outline 拉伸，底面 z = -0.25；建筑均落在 z ≥ 0 的石铺地上。
"""

import json
import math
import os
import random

import bmesh
import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "xiyuansi.glb")
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
        """任意朝向的薄盒（柱、栏杆、门窗）。"""
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
            self.ridge_cap(xa, xb, ym, z0 + h)
        if upturn:
            for c, out in (((x0, y0), (-1, -1)), ((x1, y0), (1, -1)),
                           ((x1, y1), (1, 1)), ((x0, y1), (-1, 1))):
                self.corner_upturn(c, out, z0)

    def ridge_cap(self, xa, xb, ym, zr, scale=1.0):
        """正脊压顶 + 两端吻兽，殿宇尺度比民居更厚重。"""
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

    def eave_ring(self, cx, cy, ow, od, iw, id_, z_out, z_in, thick=0.3):
        """重檐下檐：带厚度的矩形环状腰檐，内缘与上层殿身相接。"""
        o = [(cx - ow, cy - od), (cx + ow, cy - od), (cx + ow, cy + od), (cx - ow, cy + od)]
        i = [(cx - iw, cy - id_), (cx + iw, cy - id_),
             (cx + iw, cy + id_), (cx - iw, cy + id_)]
        for k in range(4):
            k2 = (k + 1) % 4
            self.quad(
                (o[k][0], o[k][1], z_out), (o[k2][0], o[k2][1], z_out),
                (i[k2][0], i[k2][1], z_in), (i[k][0], i[k][1], z_in),
            )
            self.quad(
                (o[k][0], o[k][1], z_out - thick), (o[k2][0], o[k2][1], z_out - thick),
                (i[k2][0], i[k2][1], z_in - thick), (i[k][0], i[k][1], z_in - thick),
            )
            self.quad(
                (o[k][0], o[k][1], z_out), (o[k2][0], o[k2][1], z_out),
                (o[k2][0], o[k2][1], z_out - thick), (o[k][0], o[k][1], z_out - thick),
            )

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


# ---------------------------------------------------------------- 场景与材质

bpy.ops.wm.read_factory_settings(use_empty=True)

MAT_WALL = material("wall_yellow", hexc("d9b96a"), 0.94)     # 寺院黄墙
MAT_HALL = material("wall_hall", hexc("e4ddcc"), 0.94)       # 殿身粉墙
MAT_TILE = material("tile", hexc("4d545e"), 0.82)            # 瓦顶 / 檐口 / 门洞
MAT_WOOD = material("wood", hexc("7a4c33"), 0.86)            # 木构 / 门窗 / 树干
MAT_STONE = material("stone", hexc("b3ab9b"), 0.95)          # 铺地 / 台基 / 石作
MAT_LEAF = material("leaf", hexc("556c48"), 0.95)            # 树冠
MAT_GRASS = material("grass", hexc("6d7d57"), 0.96)          # 院外草地
MAT_WATER = material("water", hexc("4a7d80"), 0.28)          # 放生池水面

with open(SCENE_JSON, encoding="utf-8") as f:
    geo = json.load(f)
lm = geo["landmarks"]["xiyuansi"]
CX, CZ = lm["centroid"]["x"], lm["centroid"]["z"]
OUTLINE = [(x - CX, -(z - CZ)) for x, z in lm["outline"]]
if abs(OUTLINE[0][0] - OUTLINE[-1][0]) < 0.01 and abs(OUTLINE[0][1] - OUTLINE[-1][1]) < 0.01:
    OUTLINE = OUTLINE[:-1]

RNG = random.Random(20261122)
BUILDINGS = []  # (cx, cy, half_w, half_d) 供种树避让


def reserve(cx, cy, hw, hd):
    BUILDINGS.append((cx, cy, hw, hd))


# ---------------------------------------------------------------- 地形底板与铺地

base = Builder()
base.poly_prism(OUTLINE, -0.25, 0.0)
base.build("xiyuansi_base", MAT_STONE)

# 院外空地铺草：底板单色石材在俯瞰时是一整块空地，用草地弱化边界
lawn = Builder()
lawn.poly_prism(OUTLINE, 0.0, 0.06)
lawn.build("xiyuansi_lawn", MAT_GRASS)

# 围墙院落（内接于 outline 主院范围，南侧留山门）
WALL_POLY = [(-190.0, 125.0), (-168.0, -45.0), (120.0, -52.0), (125.0, 145.0)]
PCX = sum(p[0] for p in WALL_POLY) / 4
PCY = sum(p[1] for p in WALL_POLY) / 4


def inset_poly(pts, factor):
    return [(PCX + (x - PCX) * factor, PCY + (y - PCY) * factor) for x, y in pts]


COURT = inset_poly(WALL_POLY, 0.965)
pave = Builder()
pave.poly_prism(COURT, -0.02, 0.12)
pave.build("xiyuansi_pave", MAT_STONE)

# 山门外前庭与南向参道（延伸到 outline 南向凸出地块）
forecourt = Builder()
forecourt.box(-30.0, 56.0, -96.0, -52.0, 0.0, 0.1)
forecourt.box(4.0, 20.0, -186.0, -94.0, 0.0, 0.12)
forecourt.build("xiyuansi_forecourt", MAT_STONE)

# 中轴参道：山门 → 大雄宝殿 → 藏经楼
path = Builder()
path.box(2.0, 22.0, -52.0, 84.0, 0.0, 0.18)
path.build("xiyuansi_path", MAT_STONE)

# ---------------------------------------------------------------- 院墙（黄墙 + 瓦顶压顶）

WALL_H = 5.2
WALL_T = 0.9
WALL_Z = 0.12


def wall_run(p0, p1):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy)
    if length < 0.4:
        return
    ang = math.atan2(dy, dx)
    cx, cy = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2

    foot = Builder()
    foot.box(cx - length / 2, cx + length / 2, cy - WALL_T / 2 - 0.16,
             cy + WALL_T / 2 + 0.16, WALL_Z, WALL_Z + 0.45)
    foot.build("wall_footing", MAT_STONE, rot=ang, pivot=(cx, cy))

    body = Builder()
    body.box(cx - length / 2, cx + length / 2, cy - WALL_T / 2,
             cy + WALL_T / 2, WALL_Z + 0.45, WALL_Z + WALL_H)
    body.build("wall_yellow", MAT_WALL, rot=ang, pivot=(cx, cy))

    cap = Builder()
    cap.box(cx - length / 2 - 0.1, cx + length / 2 + 0.1,
            cy - WALL_T / 2 - 0.34, cy + WALL_T / 2 + 0.34,
            WALL_Z + WALL_H, WALL_Z + WALL_H + 0.46)
    cap.build("wall_cap", MAT_TILE, rot=ang, pivot=(cx, cy))


def south_wall_y(x):
    t = (x + 168.0) / 288.0
    return -45.0 + t * -7.0


# 南墙留出山门（x = -1 … 25）
wall_run(WALL_POLY[0], WALL_POLY[1])
wall_run(WALL_POLY[1], (-1.0, south_wall_y(-1.0)))
wall_run((25.0, south_wall_y(25.0)), WALL_POLY[2])
wall_run(WALL_POLY[2], WALL_POLY[3])
wall_run(WALL_POLY[3], WALL_POLY[0])

# 转角壁柱（黄墙 + 石脚 + 瓦帽）
for x, y in WALL_POLY:
    foot = Builder()
    foot.box(x - 1.0, x + 1.0, y - 1.0, y + 1.0, 0.0, 0.72)
    foot.build("wall_footing", MAT_STONE)
    post = Builder()
    post.box(x - 0.85, x + 0.85, y - 0.85, y + 0.85, 0.72, WALL_Z + WALL_H)
    post.build("wall_yellow", MAT_WALL)
    cap = Builder()
    cap.box(x - 1.1, x + 1.1, y - 1.1, y + 1.1, WALL_Z + WALL_H, WALL_Z + WALL_H + 0.46)
    cap.build("wall_cap", MAT_TILE)


# ---------------------------------------------------------------- 通用殿宇


def hall(cx, cy, w, d, h, roof_h, z0, double_eave=False, roof_inset=None):
    """台基 + 粉墙殿身 + 木裙板 + 灰瓦坡顶；可选重檐。"""
    if roof_inset is None:
        roof_inset = min(w, d) * 0.33
    plat = Builder()
    plat.box(cx - w / 2 - 2.2, cx + w / 2 + 2.2, cy - d / 2 - 2.2, cy + d / 2 + 2.2,
             z0, z0 + 0.65)
    plat.build("hall_platform", MAT_STONE)

    step = Builder()
    step.box(cx - w * 0.2, cx + w * 0.2, cy - d / 2 - 3.3, cy - d / 2 - 2.1, z0, z0 + 0.34)
    step.box(cx - w * 0.24, cx + w * 0.24, cy - d / 2 - 4.1, cy - d / 2 - 3.2, z0, z0 + 0.18)
    step.build("hall_step", MAT_STONE)

    body = Builder()
    body.box(cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2,
             z0 + 0.65, z0 + 0.65 + h)
    body.build("hall_wall", MAT_HALL)

    skirt = Builder()
    skirt.box(cx - w / 2 - 0.16, cx + w / 2 + 0.16, cy - d / 2 - 0.16,
              cy + d / 2 + 0.16, z0 + 0.65, z0 + 1.55)
    skirt.build("hall_skirt", MAT_WOOD)

    doors = Builder()
    n = max(3, int(w / 5.0))
    dw = w / n * 0.56
    for i in range(n):
        dx = cx - w / 2 + (i + 0.5) * w / n
        doors.box(dx - dw / 2, dx + dw / 2, cy - d / 2 - 0.12,
                  cy - d / 2 + 0.05, z0 + 0.65, z0 + 0.65 + h * 0.7)
    doors.build("hall_door", MAT_WOOD)

    cols = Builder()
    ya, yb = cy - d / 2 - 0.52, cy - d / 2 - 0.12
    for k in range(n + 1):
        x = cx - w / 2 + 0.5 + (w - 1.0) * k / n
        cols.box(x - 0.24, x + 0.24, ya, yb, z0 + 0.65, z0 + 0.65 + h * 0.94)
    cols.build("hall_columns", MAT_WOOD)

    zt = z0 + 0.65 + h
    if double_eave:
        # 下檐 + 上层殿身 + 上檐
        iw, id_ = w * 0.36, d * 0.34
        er = Builder()
        er.eave_ring(cx, cy, w / 2 + 3.6, d / 2 + 3.6, iw, id_, zt - 0.55, zt + 1.0, 0.34)
        er.build("hall_lower_eave", MAT_TILE)

        upper = Builder()
        upper.box(cx - iw, cx + iw, cy - id_, cy + id_, zt, zt + 3.5)
        upper.build("hall_upper_wall", MAT_HALL)

        ucols = Builder()
        for k in range(7):
            x = cx - iw + 0.4 + (2 * iw - 0.8) * k / 6
            ucols.box(x - 0.22, x + 0.22, cy - id_ - 0.16, cy - id_ + 0.02,
                      zt, zt + 3.3)
        ucols.build("hall_upper_column", MAT_WOOD)

        roof = Builder()
        roof.hip_roof(cx - iw - 1.8, cx + iw + 1.8, cy - id_ - 1.8, cy + id_ + 1.8,
                      zt + 3.5, roof_h, roof_inset * 0.72)
        roof.build("hall_upper_roof", MAT_TILE)

        ridge = Builder()
        xa = cx - iw - 1.8 + roof_inset * 0.72
        xb = cx + iw + 1.8 - roof_inset * 0.72
        if xb - xa > 0.4:
            ridge.box(xa, xb, cy - 0.38, cy + 0.38,
                      zt + 3.5 + roof_h - 0.06, zt + 3.5 + roof_h + 0.46)
        ridge.build("hall_ridge", MAT_TILE)
    else:
        roof = Builder()
        roof.hip_roof(cx - w / 2 - 2.8, cx + w / 2 + 2.8, cy - d / 2 - 2.8,
                      cy + d / 2 + 2.8, zt, roof_h, roof_inset)
        roof.build("hall_roof", MAT_TILE)

        ridge = Builder()
        xa = cx - w / 2 - 2.8 + roof_inset
        xb = cx + w / 2 + 2.8 - roof_inset
        if xb - xa > 0.4:
            ridge.box(xa, xb, cy - 0.36, cy + 0.36,
                      zt + roof_h - 0.06, zt + roof_h + 0.44)
        ridge.build("hall_ridge", MAT_TILE)

    reserve(cx, cy, w / 2 + 3.5, d / 2 + 3.5)


# 中轴：天王殿、重檐大雄宝殿
hall(12.0, -14.0, 22.0, 12.0, 6.4, 2.9, 0.12, roof_inset=4.2)
hall(12.0, 40.0, 30.0, 18.0, 9.5, 3.5, 0.12, double_eave=True, roof_inset=5.2)

# 东西配殿与罗汉堂（西配殿收在放生池以东）
hall(-42.0, 30.0, 14.0, 10.0, 6.0, 2.8, 0.12, roof_inset=3.4)
hall(84.0, 8.0, 14.0, 10.0, 6.0, 2.8, 0.12, roof_inset=3.4)
hall(86.0, 62.0, 20.0, 13.0, 8.0, 3.0, 0.12, roof_inset=4.2)


# ---------------------------------------------------------------- 山门（三开间）

def gate(cx, cy, w=22.0, d=9.0):
    plat = Builder()
    plat.box(cx - w / 2 - 1.3, cx + w / 2 + 1.3, cy - d / 2 - 1.3,
             cy + d / 2 + 1.3, 0.0, 0.68)
    plat.build("gate_platform", MAT_STONE)

    step = Builder()
    step.box(cx - 3.4, cx + 3.4, cy - d / 2 - 2.6, cy - d / 2 - 1.2, 0.0, 0.32)
    step.build("gate_step", MAT_STONE)

    body = Builder()
    body.box(cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2, 0.68, 7.5)
    body.build("gate_wall", MAT_WALL)

    # 三个深色门洞（中门高，两侧门略低）
    hole = Builder()
    for x0, x1, ztop in ((cx - 9.4, cx - 4.4, 4.7), (cx - 3.6, cx + 3.6, 5.7),
                         (cx + 4.4, cx + 9.4, 4.7)):
        hole.box(x0, x1, cy - d / 2 - 0.16, cy - d / 2 + 0.02, 0.68, ztop)
    hole.build("gate_door", MAT_TILE)

    plaque = Builder()
    plaque.box(cx - 2.9, cx + 2.9, cy - d / 2 - 0.2, cy - d / 2 + 0.02, 6.1, 7.1)
    plaque.build("gate_plaque", MAT_TILE)

    cols = Builder()
    for k in range(4):
        x = cx - w / 2 + 0.6 + (w - 1.2) * k / 3
        cols.box(x - 0.28, x + 0.28, cy - d / 2 - 0.42, cy - d / 2 - 0.05, 0.68, 7.3)
    cols.build("gate_column", MAT_WOOD)

    roof = Builder()
    roof.hip_roof(cx - w / 2 - 2.6, cx + w / 2 + 2.6, cy - d / 2 - 2.4,
                  cy + d / 2 + 2.4, 7.5, 3.0, 5.2)
    roof.build("gate_roof", MAT_TILE)

    ridge = Builder()
    ridge.box(cx - w / 2 + 0.8, cx + w / 2 - 0.8, cy - 0.4, cy + 0.4, 10.44, 10.96)
    ridge.build("gate_ridge", MAT_TILE)

    reserve(cx, cy, w / 2 + 3.0, d / 2 + 3.6)


gate(12.0, -49.1)


# ---------------------------------------------------------------- 藏经楼（两层）

def library(cx, cy, w=26.0, d=14.0):
    plat = Builder()
    plat.box(cx - w / 2 - 2.0, cx + w / 2 + 2.0, cy - d / 2 - 2.0,
             cy + d / 2 + 2.0, 0.12, 0.82)
    plat.build("lib_platform", MAT_STONE)

    lower = Builder()
    lower.box(cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2, 0.82, 7.2)
    lower.build("lib_wall", MAT_HALL)

    skirt = Builder()
    skirt.box(cx - w / 2 - 0.16, cx + w / 2 + 0.16, cy - d / 2 - 0.16,
              cy + d / 2 + 0.16, 0.82, 1.75)
    skirt.build("lib_skirt", MAT_WOOD)

    doors = Builder()
    for k in range(5):
        x = cx - w / 2 + (k + 0.5) * w / 5
        doors.box(x - 1.4, x + 1.4, cy - d / 2 - 0.12, cy - d / 2 + 0.05, 0.82, 4.9)
    doors.build("lib_door", MAT_WOOD)

    # 平座
    band = Builder()
    band.box(cx - w / 2 - 1.2, cx + w / 2 + 1.2, cy - d / 2 - 1.2,
             cy + d / 2 + 1.2, 7.2, 7.8)
    band.build("lib_band", MAT_STONE)

    rail = Builder()
    rail.box(cx - w / 2 - 1.2, cx + w / 2 + 1.2, cy - d / 2 - 1.2, cy - d / 2 - 0.9,
             7.8, 8.7)
    rail.box(cx - w / 2 - 1.2, cx + w / 2 + 1.2, cy + d / 2 + 0.9, cy + d / 2 + 1.2,
             7.8, 8.7)
    rail.box(cx - w / 2 - 1.2, cx - w / 2 - 0.9, cy - d / 2 - 1.2, cy + d / 2 + 1.2,
             7.8, 8.7)
    rail.box(cx + w / 2 + 0.9, cx + w / 2 + 1.2, cy - d / 2 - 1.2, cy + d / 2 + 1.2,
             7.8, 8.7)
    rail.build("lib_rail", MAT_WOOD)

    upper = Builder()
    upper.box(cx - w * 0.42, cx + w * 0.42, cy - d * 0.42, cy + d * 0.42, 7.8, 11.8)
    upper.build("lib_upper_wall", MAT_HALL)

    ucols = Builder()
    for k in range(7):
        x = cx - w * 0.42 + 0.5 + (w * 0.84 - 1.0) * k / 6
        ucols.box(x - 0.22, x + 0.22, cy - d * 0.42 - 0.4, cy - d * 0.42 - 0.05,
                  7.8, 11.5)
    ucols.build("lib_column", MAT_WOOD)

    windows = Builder()
    for k in range(4):
        x = cx - w * 0.42 + (k + 0.5) * w * 0.84 / 4
        windows.box(x - 1.2, x + 1.2, cy - d * 0.42 - 0.14, cy - d * 0.42 + 0.02,
                    8.5, 10.7)
    windows.build("lib_window", MAT_WOOD)

    roof = Builder()
    roof.hip_roof(cx - w * 0.42 - 2.4, cx + w * 0.42 + 2.4, cy - d * 0.42 - 2.4,
                  cy + d * 0.42 + 2.4, 11.8, 3.3, 4.4)
    roof.build("lib_roof", MAT_TILE)

    ridge = Builder()
    ridge.box(cx - w * 0.42 + 1.6, cx + w * 0.42 - 1.6, cy - 0.38, cy + 0.38,
              15.04, 15.5)
    ridge.build("lib_ridge", MAT_TILE)

    reserve(cx, cy, w * 0.42 + 2.6, d * 0.42 + 2.6)


library(12.0, 92.0, 26.0, 14.0)


# ---------------------------------------------------------------- 钟楼 / 鼓楼

def bell_tower(cx, cy):
    plat = Builder()
    plat.box(cx - 4.2, cx + 4.2, cy - 4.2, cy + 4.2, 0.12, 0.8)
    plat.build("tower_platform", MAT_STONE)

    body = Builder()
    body.box(cx - 3.3, cx + 3.3, cy - 3.3, cy + 3.3, 0.8, 5.6)
    body.build("tower_wall", MAT_HALL)

    door = Builder()
    door.box(cx - 1.2, cx + 1.2, cy - 3.3 - 0.12, cy - 3.3 + 0.04, 0.8, 3.6)
    door.build("tower_door", MAT_WOOD)

    band = Builder()
    band.box(cx - 3.6, cx + 3.6, cy - 3.6, cy + 3.6, 5.6, 6.15)
    band.build("tower_band", MAT_WOOD)

    cols = Builder()
    for sx in (-1, 1):
        for sy in (-1, 1):
            cols.box(cx + sx * 2.7 - 0.26, cx + sx * 2.7 + 0.26,
                     cy + sy * 2.7 - 0.26, cy + sy * 2.7 + 0.26, 6.15, 8.9)
    cols.build("tower_column", MAT_WOOD)

    rail = Builder()
    rail.box(cx - 3.2, cx + 3.2, cy - 3.2, cy - 3.0, 6.15, 7.0)
    rail.box(cx - 3.2, cx + 3.2, cy + 3.0, cy + 3.2, 6.15, 7.0)
    rail.box(cx - 3.2, cx - 3.0, cy - 3.2, cy + 3.2, 6.15, 7.0)
    rail.box(cx + 3.0, cx + 3.2, cy - 3.2, cy + 3.2, 6.15, 7.0)
    rail.build("tower_rail", MAT_WOOD)

    roof = Builder()
    roof.hip_roof(cx - 4.4, cx + 4.4, cy - 4.4, cy + 4.4, 8.9, 2.7, 4.25)
    roof.build("tower_roof", MAT_TILE)

    finial = Builder()
    finial.prism(cx, cy, 11.6, 12.3, 0.5, 0.18, 8)
    finial.build("tower_finial", MAT_TILE)

    reserve(cx, cy, 5.2, 5.2)


bell_tower(-30.0, -12.0)
bell_tower(54.0, -12.0)


# ---------------------------------------------------------------- 西花园：放生池 / 湖心亭 / 曲桥

POOL_C = (-120.0, 50.0)
POOL_RX, POOL_RY = 49.0, 39.0


def ellipse_pts(cx, cy, rx, ry, n=12):
    return [
        (cx + math.cos(i * 2 * math.pi / n) * rx, cy + math.sin(i * 2 * math.pi / n) * ry)
        for i in range(n)
    ]


OUTER = ellipse_pts(*POOL_C, POOL_RX, POOL_RY, 12)
INNER = ellipse_pts(*POOL_C, POOL_RX - 3.0, POOL_RY - 3.0, 12)

# 池岸石圈：外壁 + 内壁 + 顶面环
rim = Builder()
for i in range(len(OUTER)):
    j = (i + 1) % len(OUTER)
    ox0, oy0 = OUTER[i]
    ox1, oy1 = OUTER[j]
    ix0, iy0 = INNER[i]
    ix1, iy1 = INNER[j]
    rim.quad((ox0, oy0, 0.1), (ox1, oy1, 0.1), (ox1, oy1, 0.38), (ox0, oy0, 0.38))
    rim.quad((ix0, iy0, 0.05), (ix1, iy1, 0.05), (ix1, iy1, 0.38), (ix0, iy0, 0.38))
    rim.quad((ox0, oy0, 0.38), (ox1, oy1, 0.38), (ix1, iy1, 0.38), (ix0, iy0, 0.38))
rim.build("pool_rim", MAT_STONE)

water = Builder()
water.poly_prism(INNER, 0.08, 0.15)
water.build("pool_water", MAT_WATER)

# 湖心岛 + 六角亭
island = Builder()
island.prism(POOL_C[0], POOL_C[1], 0.15, 0.6, 7.2, 6.8, 8)
island.prism(POOL_C[0], POOL_C[1], 0.6, 0.9, 5.8, 5.6, 6, 0.0)
island.build("island_base", MAT_STONE)

PAV = (POOL_C[0], POOL_C[1])
columns = Builder()
for k in range(6):
    a = k * math.pi / 3
    columns.obox(PAV[0] + math.cos(a) * 4.4, PAV[1] + math.sin(a) * 4.4,
                 a, 0.28, 0.28, 0.9, 4.9)
columns.build("pav_column", MAT_WOOD)

rail = Builder()
for k in range(6):
    a = k * math.pi / 3 + math.pi / 6
    rail.obox(PAV[0] + math.cos(a) * 3.8, PAV[1] + math.sin(a) * 3.8,
              a, 2.1, 0.14, 0.9, 1.45)
rail.build("pav_rail", MAT_WOOD)

pav_roof = Builder()
pav_roof.prism(PAV[0], PAV[1], 4.9, 5.45, 6.3, 5.6, 6, 0.0)
pav_roof.prism(PAV[0], PAV[1], 5.45, 7.7, 5.6, 0.16, 6, 0.0)
pav_roof.build("pav_roof", MAT_TILE)

finial = Builder()
finial.prism(PAV[0], PAV[1], 7.7, 8.4, 0.36, 0.08, 6, 0.0)
finial.build("pav_finial", MAT_TILE)

reserve(PAV[0], PAV[1], 8.0, 8.0)

# 石曲桥：东岸 → 湖心亭
BRIDGE_PTS = [(-73.0, 46.0), (-88.0, 36.0), (-97.0, 54.0), (-108.0, 42.0), (-114.0, 47.0)]

for i in range(len(BRIDGE_PTS) - 1):
    x0, y0 = BRIDGE_PTS[i]
    x1, y1 = BRIDGE_PTS[i + 1]
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    ang = math.atan2(dy, dx)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hl, hw = length / 2 + 0.3, 1.5

    slab = Builder()
    slab.box(cx - hl, cx + hl, cy - hw, cy + hw, 0.42, 0.62)
    slab.build("bridge_slab", MAT_STONE, rot=ang, pivot=(cx, cy))

    rails = Builder()
    rails.box(cx - hl, cx + hl, cy - hw, cy - hw + 0.2, 0.62, 0.95)
    rails.box(cx - hl, cx + hl, cy + hw - 0.2, cy + hw, 0.62, 0.95)
    rails.build("bridge_rail", MAT_STONE, rot=ang, pivot=(cx, cy))

    reserve(cx, cy, hl + 1.0, hw + 1.0)


# ---------------------------------------------------------------- 香炉与经幢


def censer(cx, cy, z0):
    b = Builder()
    b.box(cx - 2.4, cx + 2.4, cy - 2.4, cy + 2.4, z0, z0 + 0.5)
    b.prism(cx, cy, z0 + 0.5, z0 + 1.7, 1.4, 1.12, 6, math.pi / 6)
    b.build("censer_body", MAT_STONE)

    r = Builder()
    r.prism(cx, cy, z0 + 1.7, z0 + 2.8, 1.65, 0.3, 6, math.pi / 6)
    r.build("censer_roof", MAT_TILE)
    reserve(cx, cy, 2.8, 2.8)


censer(12.0, 18.0, 0.18)


def sutra_pillar(cx, cy, z0):
    b = Builder()
    b.prism(cx, cy, z0, z0 + 0.4, 1.0, 0.9, 6, math.pi / 6)
    b.prism(cx, cy, z0 + 0.4, z0 + 3.4, 0.62, 0.56, 6, math.pi / 6)
    b.prism(cx, cy, z0 + 3.4, z0 + 3.8, 0.85, 0.2, 6, math.pi / 6)
    b.build("sutra_pillar", MAT_STONE)
    reserve(cx, cy, 1.2, 1.2)


sutra_pillar(-2.0, 8.0, 0.12)
sutra_pillar(26.0, 8.0, 0.12)


# ---------------------------------------------------------------- 南山道牌坊与石灯


def approach_paifang(cx, cy):
    """山门外参道口的四柱三间石牌坊，瓦顶压檐。"""
    col = Builder()
    for x in (-9.5, -4.0, 4.0, 9.5):
        top = 6.8 if abs(x) > 6 else 6.9
        col.box(cx + x - 0.42, cx + x + 0.42, cy - 0.42, cy + 0.42, 0.12, top)
    col.build("pf_column", MAT_STONE)

    beam = Builder()
    beam.box(cx - 10.6, cx + 10.6, cy - 0.5, cy + 0.5, 5.35, 6.05)
    beam.box(cx - 3.6, cx + 3.6, cy - 0.42, cy + 0.42, 6.05, 6.55)
    beam.build("pf_beam", MAT_STONE)

    plaque = Builder()
    plaque.box(cx - 1.8, cx + 1.8, cy - 0.64, cy - 0.42, 5.95, 6.85)
    plaque.build("pf_plaque", MAT_TILE)

    roof = Builder()
    roof.hip_roof(cx - 11.6, cx + 11.6, cy - 2.0, cy + 2.0, 6.55, 1.85, 6.4)
    roof.build("pf_roof", MAT_TILE)

    reserve(cx, cy, 11.8, 2.2)


approach_paifang(12.0, -176.0)


def stone_lantern(x, y, z0):
    b = Builder()
    b.box(x - 0.5, x + 0.5, y - 0.5, y + 0.5, z0, z0 + 0.32)
    b.prism(x, y, z0 + 0.32, z0 + 1.5, 0.24, 0.2, 6)
    b.prism(x, y, z0 + 1.5, z0 + 1.8, 0.55, 0.45, 6)
    b.prism(x, y, z0 + 1.8, z0 + 2.35, 0.5, 0.12, 6)
    b.build("stone_lantern", MAT_STONE)
    reserve(x, y, 0.8, 0.8)


for ly in (-158.0, -128.0, -104.0):
    stone_lantern(1.8, ly, 0.0)
    stone_lantern(22.2, ly, 0.0)


# ---------------------------------------------------------------- 古树


def tree(x, y, z0, h, r):
    trunk = Builder()
    trunk.box(x - 0.36, x + 0.36, y - 0.36, y + 0.36, z0, z0 + h * 0.52)
    trunk.build("tree_trunk", MAT_WOOD)

    leaf = Builder()
    leaf.prism(x, y, z0 + h * 0.24, z0 + h * 0.7, r, r * 0.82, 8)
    leaf.prism(x, y, z0 + h * 0.5, z0 + h * 0.9, r * 0.84, r * 0.5, 8)
    leaf.prism(x, y, z0 + h * 0.72, z0 + h, r * 0.52, r * 0.12, 8)
    leaf.build("tree_leaf", MAT_LEAF)


TREE_POS = [
    # 寺院内院与东侧
    (-50.0, 75.0), (40.0, 118.0), (-40.0, 118.0), (100.0, 100.0), (115.0, 20.0),
    (70.0, 130.0),
    # 西花园池畔
    (-181.0, 12.0), (-176.0, 94.0), (-64.0, 96.0), (-60.0, 6.0), (-150.0, 110.0),
    # 院墙外西侧 / 北侧
    (-185.0, 40.0), (-175.0, -20.0), (-80.0, 158.0),
    # 山门南参道两侧
    (-30.0, -90.0), (48.0, -95.0), (-26.0, -140.0), (52.0, -150.0),
    (-32.0, -178.0), (44.0, -180.0),
]

for tx, ty in TREE_POS:
    if not point_in_poly(OUTLINE, tx, ty):
        continue
    if -172.0 < tx < -68.0 and 9.0 < ty < 91.0:  # 避开放生池
        continue
    if any(abs(tx - bx) < bw + 1.5 and abs(ty - by) < bd + 1.5
           for bx, by, bw, bd in BUILDINGS):
        continue
    z0 = 0.12 if point_in_poly(WALL_POLY, tx, ty) else 0.0
    tree(tx, ty, z0, RNG.uniform(8.0, 12.0), RNG.uniform(2.8, 3.8))

# 院外草地疏林：抖动网格补种，避开放生池、殿宇基址与各条参道，
# 让 outline 边缘的空地读作园地而不是一块秃台子。
for gy in range(-7, 8):
    for gx in range(-7, 8):
        tx = gx * 28.0 + RNG.uniform(-7.0, 7.0)
        ty = gy * 28.0 + RNG.uniform(-7.0, 7.0)
        if not point_in_poly(OUTLINE, tx, ty):
            continue
        if -175.0 < tx < -65.0 and 6.0 < ty < 94.0:  # 放生池
            continue
        if 1.0 < tx < 23.0 and -54.0 < ty < 86.0:  # 中轴参道
            continue
        if -32.0 < tx < 58.0 and -98.0 < ty < -50.0:  # 山门前庭
            continue
        if 2.0 < tx < 22.0 and -188.0 < ty < -92.0:  # 南向参道
            continue
        if any(abs(tx - bx) < bw + 4.0 and abs(ty - by) < bd + 4.0
               for bx, by, bw, bd in BUILDINGS):
            continue
        tree(tx, ty, 0.06, RNG.uniform(7.0, 11.0), RNG.uniform(2.4, 3.4))


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
    obj = bpy.data.objects.new(f"xiyuansi_{mat_name}", mesh)
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
for obj in meshes:
    obj.data.calc_loop_triangles()
    tris += len(obj.data.loop_triangles)

mins = [1e9, 1e9, 1e9]
maxs = [-1e9, -1e9, -1e9]
for obj in meshes:
    for v in obj.data.vertices:
        for i in range(3):
            mins[i] = min(mins[i], v.co[i])
            maxs[i] = max(maxs[i], v.co[i])
size = [maxs[i] - mins[i] for i in range(3)]
print(
    f"[xiyuansi] exported {OUT} | meshes={len(meshes)} tris={tris} "
    f"bbox=({size[0]:.1f} x {size[1]:.1f} x {size[2]:.1f}) "
    f"minz={mins[2]:.3f} maxz={maxs[2]:.3f} "
    f"size_kb={os.path.getsize(OUT) / 1024:.1f}"
)
