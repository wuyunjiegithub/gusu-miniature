"""苏州博物馆（本馆，贝聿铭）程序化建模并导出 GLB。

坐标约定：Blender +X = 东，+Y = 北，+Z = 上；1 单位 = 1 米，原点为景点质心。
scene [x, z] → Blender (x - centroid.x, -(z - centroid.z))；
glTF export_yup=True 后 +Z→+Y、+Y→-Z，与网页场景一致。
取「中而新」语汇：白墙、深灰四坡/角锥顶、几何体量、水院片石假山。
"""

import json
import math
import os
import random

import bmesh
import bpy
from mathutils import Vector
from mathutils.geometry import tessellate_polygon

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "suzhou_museum.glb")
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

    def slab(self, pts, z0, z1):
        """任意（含凹）多边形板：用 earcut 三角化上下表面。"""
        n = len(pts)
        for i in range(n):
            j = (i + 1) % n
            x0, y0 = pts[i]
            x1, y1 = pts[j]
            self.quad((x0, y0, z0), (x1, y1, z0), (x1, y1, z1), (x0, y0, z1))
        tris = tessellate_polygon([[Vector((x, y, 0.0)) for x, y in pts]])
        for a, b, c in tris:
            if isinstance(a, int):
                a, b, c = pts[a], pts[b], pts[c]
            else:
                a, b, c = (a.x, a.y), (b.x, b.y), (c.x, c.y)
            self.tri((a[0], a[1], z1), (b[0], b[1], z1), (c[0], c[1], z1))
            self.tri((c[0], c[1], z0), (b[0], b[1], z0), (a[0], a[1], z0))

    def hip_roof(self, x0, x1, y0, y1, z0, h, inset, ridge=True, upturn=True):
        """庑殿顶；inset 大时收成角锥，屋脊与起翘保持克制尺度。"""
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
        scale = 0.45
        if ridge and has_ridge:
            self.ridge_cap(xa, xb, ym, z0 + h, scale)
        if upturn:
            for c, out in (((x0, y0), (-1, -1)), ((x1, y0), (1, -1)),
                           ((x1, y1), (1, 1)), ((x0, y1), (-1, 1))):
                self.corner_upturn(c, out, z0, 0.9 * scale, 0.7 * scale, 0.34 * scale)

    def ridge_cap(self, xa, xb, ym, zr, scale=1.0):
        """正脊压顶 + 两端吻兽，博物馆取小尺度以保持体块简洁。"""
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
        """屋角起翘：自檐角向外上挑的尖翘（此处仅作轻微轮廓变化）。"""
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


# ---------------------------------------------------------------- 场景与材质

bpy.ops.wm.read_factory_settings(use_empty=True)

MAT_WALL = material("wall_white", hexc("eceae3"), 0.92)     # 白墙
MAT_ROOF = material("roof_dark", hexc("4b5158"), 0.84)      # 深灰坡顶 / 檐口 / 格栅
MAT_GLASS = material("glass_blue", hexc("7f98a8"), 0.26, 0.15)  # 玻璃幕墙 / 天窗
MAT_STONE = material("stone", hexc("b3ab9b"), 0.95)         # 石板台 / 桥 / 铺地
MAT_WOOD = material("wood", hexc("7a4c33"), 0.86)           # 木门 / 树干
MAT_WATER = material("water", hexc("2f7ea8"), 0.14, 0.05)   # 水面
MAT_LEAF = material("leaf", hexc("556c48"), 0.95)           # 树冠 / 竹

with open(SCENE_JSON, encoding="utf-8") as f:
    geo = json.load(f)
lm = geo["landmarks"]["suzhou-museum"]
CX, CZ = lm["centroid"]["x"], lm["centroid"]["z"]
OUTLINE = [(x - CX, -(z - CZ)) for x, z in lm["outline"]]
if abs(OUTLINE[0][0] - OUTLINE[-1][0]) < 0.01 and abs(OUTLINE[0][1] - OUTLINE[-1][1]) < 0.01:
    OUTLINE = OUTLINE[:-1]

RNG = random.Random(20261120)
Z0 = 0.02          # 建筑落地高度（底板顶面为 0）
PLINTH = 0.35      # 台基高


# ---------------------------------------------------------------- 地形底板

base = Builder()
base.slab(OUTLINE, -0.25, 0.0)
base.build("museum_base", MAT_STONE)


# ---------------------------------------------------------------- 建筑构件

def massing(x0, x1, y0, y1, h, roof="hip", roof_h=4.2, inset=None):
    """白墙几何体块 + 石台基 + 白檐口 + 深灰坡顶。返回屋顶顶标高。"""
    z_top = Z0 + h

    plinth = Builder()
    plinth.box(x0 - 0.35, x1 + 0.35, y0 - 0.35, y1 + 0.35, Z0 - 0.02, Z0 + PLINTH)
    plinth.build("wall_plinth", MAT_STONE)

    wall = Builder()
    wall.box(x0, x1, y0, y1, Z0, z_top)
    wall.build("wall_body", MAT_WALL)

    # 白檐口
    cornice = Builder()
    cornice.box(x0 - 0.55, x1 + 0.55, y0 - 0.55, y1 + 0.55, z_top - 0.34, z_top - 0.02)
    cornice.build("wall_cornice", MAT_WALL)

    # 深灰挑檐
    eave = Builder()
    eave.box(x0 - 1.6, x1 + 1.6, y0 - 1.6, y1 + 1.6, z_top - 0.08, z_top + 0.3)
    eave.build("roof_eave", MAT_ROOF)

    # 转角白色壁柱
    pil = Builder()
    for px in (x0, x1):
        for py in (y0, y1):
            pil.box(px - 0.42, px + 0.42, py - 0.42, py + 0.42, Z0, z_top - 0.02)
    pil.build("wall_pilaster", MAT_WALL)

    # 檐下暗线
    under = Builder()
    under.box(x0 - 0.2, x0 + 0.02, y0 - 0.2, y1 + 0.2, z_top - 0.75, z_top - 0.58)
    under.box(x1 - 0.02, x1 + 0.2, y0 - 0.2, y1 + 0.2, z_top - 0.75, z_top - 0.58)
    under.box(x0 - 0.2, x1 + 0.2, y0 - 0.2, y0 + 0.02, z_top - 0.75, z_top - 0.58)
    under.box(x0 - 0.2, x1 + 0.2, y1 - 0.02, y1 + 0.2, z_top - 0.75, z_top - 0.58)
    under.build("eave_shadow", MAT_ROOF)

    if roof == "flat":
        slab = Builder()
        slab.box(x0 - 0.5, x1 + 0.5, y0 - 0.5, y1 + 0.5, z_top, z_top + 0.4)
        slab.build("roof_flat", MAT_ROOF)
        return z_top + 0.4

    if inset is None:
        inset = min(x1 - x0, y1 - y0) / 2 - 0.15
    rb = Builder()
    rb.hip_roof(x0 - 1.6, x1 + 1.6, y0 - 1.6, y1 + 1.6, z_top + 0.28, roof_h, inset)
    rb.build("roof_hip", MAT_ROOF)

    # 屋脊压顶
    xa, xb = x0 - 1.6 + inset, x1 + 1.6 - inset
    ym = (y0 + y1) / 2
    if xb - xa > 1.2:
        ridge = Builder()
        ridge.box(xa, xb, ym - 0.45, ym + 0.45, z_top + 0.28 + roof_h - 0.12, z_top + 0.28 + roof_h + 0.42)
        ridge.build("roof_ridge", MAT_ROOF)
    return z_top + 0.28 + roof_h


def string_course(x0, x1, y, z, face=-1, depth=0.16, thick=0.2):
    """立面水平细线（白色细带）。"""
    b = Builder()
    if face < 0:
        b.box(x0, x1, y - depth, y + 0.02, z, z + thick)
    else:
        b.box(x0, x1, y - 0.02, y + depth, z, z + thick)
    b.build("facade_string", MAT_WALL)


def slit_row(x0, x1, y, z0, z1, count, face=-1, w=0.85):
    """贝氏窄竖窗（玻璃细条）。"""
    b = Builder()
    step = (x1 - x0) / max(1, count - 1) if count > 1 else 0.0
    for i in range(count):
        cx = x0 + i * step if count > 1 else (x0 + x1) / 2
        if face < 0:
            b.box(cx - w / 2, cx + w / 2, y - 0.15, y + 0.02, z0, z1)
        else:
            b.box(cx - w / 2, cx + w / 2, y - 0.02, y + 0.15, z0, z1)
    b.build("facade_slit", MAT_GLASS)


def slit_row_y(x, y0, y1, z0, z1, count, face=1, w=0.85):
    """沿 Y 方向排布的窄竖窗（东 / 西立面）。"""
    b = Builder()
    step = (y1 - y0) / max(1, count - 1) if count > 1 else 0.0
    for i in range(count):
        cy = y0 + i * step if count > 1 else (y0 + y1) / 2
        if face > 0:
            b.box(x - 0.02, x + 0.15, cy - w / 2, cy + w / 2, z0, z1)
        else:
            b.box(x - 0.15, x + 0.02, cy - w / 2, cy + w / 2, z0, z1)
    b.build("facade_slit", MAT_GLASS)


def curtain_band(x0, x1, y, z0, z1, face=-1, mullions=0, pitch=None):
    """玻璃幕墙带 + 深色竖梃。"""
    g = Builder()
    if face < 0:
        g.box(x0, x1, y - 0.16, y + 0.02, z0, z1)
    else:
        g.box(x0, x1, y - 0.02, y + 0.16, z0, z1)
    g.build("curtain_glass", MAT_GLASS)

    if mullions:
        m = Builder()
        if pitch is None:
            pitch = (x1 - x0) / max(1, mullions - 1)
        for i in range(mullions):
            cx = x0 + i * pitch
            if face < 0:
                m.box(cx - 0.09, cx + 0.09, y - 0.24, y + 0.02, z0 - 0.1, z1 + 0.1)
            else:
                m.box(cx - 0.09, cx + 0.09, y - 0.02, y + 0.24, z0 - 0.1, z1 + 0.1)
        m.build("curtain_mullion", MAT_ROOF)


# ---------------------------------------------------------------- 主体体量

# 西侧主展厅（四坡顶，带屋脊天窗带）
WEST = (-32.0, 2.0, -54.0, -20.0)
apex_a = massing(-32.0, 2.0, -54.0, -20.0, 11.2, "hip", 4.3, inset=13.0)
slit_row(-28.6, -1.4, -54.0, 1.1, 7.4, 7, face=-1)
slit_row_y(-32.0, -50.0, -24.0, 1.1, 7.4, 5, face=-1)
string_course(-32.0, 2.0, -54.0, 8.1)
string_course(-32.0, 2.0, -20.0, 8.1, face=1)

# 屋脊玻璃天窗带（浅色细条 + 深色压边）
zt_a = 11.2 + 0.02
sk = Builder()
sk.box(-20.5, -9.5, -38.6, -35.4, zt_a + 0.28 + 4.3 - 0.55, zt_a + 0.28 + 4.3 + 0.28)
sk.build("skylight_ridge", MAT_GLASS)
skf = Builder()
skf.box(-21.0, -9.0, -39.1, -38.6, zt_a + 0.28 + 4.3 - 0.5, zt_a + 0.28 + 4.3 + 0.3)
skf.box(-21.0, -9.0, -35.4, -34.9, zt_a + 0.28 + 4.3 - 0.5, zt_a + 0.28 + 4.3 + 0.3)
skf.build("skylight_frame", MAT_ROOF)

# 东侧展厅（角锥顶 + 顶部玻璃采光亭）
apex_b = massing(16.0, 56.0, -50.0, -12.0, 14.8, "pyramid", 4.8, inset=22.3)
curtain_band(19.0, 53.0, -50.0, 1.0, 6.6, face=-1, mullions=13)
string_course(16.0, 56.0, -50.0, 7.6)
string_course(16.0, 56.0, -12.0, 7.6, face=1)
slit_row(20.5, 51.5, -50.0, 9.0, 12.8, 6, face=-1, w=0.9)
slit_row_y(56.0, -45.0, -17.0, 8.2, 12.6, 6, face=1, w=0.9)

# 东立面玻璃带（横向细条 + 竖梃）
eb = Builder()
eb.box(55.98, 56.16, -46.0, -20.0, 1.2, 3.4)
eb.build("east_glass", MAT_GLASS)
em = Builder()
for i in range(6):
    cy = -44.0 + i * 4.6
    em.box(55.9, 56.24, cy - 0.08, cy + 0.08, 1.2, 3.4)
em.box(55.96, 56.18, -46.0, -20.0, 3.55, 3.7)
em.box(55.96, 56.18, -46.0, -20.0, 1.0, 1.15)
em.build("east_mullion", MAT_ROOF)

# 幕墙横梃
tr = Builder()
tr.box(19.0, 53.0, -50.24, -50.02, 3.55, 3.7)
tr.box(19.0, 53.0, -50.24, -50.02, 5.1, 5.25)
tr.build("curtain_transom", MAT_ROOF)

PYR = (36.0, -31.0)
zt_b = 14.8 + 0.02
lan = Builder()
lan.box(PYR[0] - 3.0, PYR[0] + 3.0, PYR[1] - 3.0, PYR[1] + 3.0,
        zt_b + 0.28 + 4.8 - 1.05, zt_b + 0.28 + 4.8 + 0.35)
lan.build("skylight_lantern", MAT_GLASS)
lanf = Builder()
lanf.box(PYR[0] - 3.5, PYR[0] + 3.5, PYR[1] - 3.5, PYR[1] + 3.5,
         zt_b + 0.28 + 4.8 + 0.35, zt_b + 0.28 + 4.8 + 0.62)
lanf.build("lantern_cap", MAT_ROOF)

# 北侧低体量（平顶 + 天窗带）
massing(-32.0, -2.0, -18.0, -9.0, 6.4, "flat")
zt_d = 6.4 + 0.02 + 0.4
dk = Builder()
dk.box(-27.0, -7.0, -16.0, -13.2, zt_d, zt_d + 0.32)
dk.build("skylight_band", MAT_GLASS)
dkf = Builder()
dkf.box(-27.4, -6.6, -16.4, -15.9, zt_d, zt_d + 0.38)
dkf.box(-27.4, -6.6, -13.3, -12.8, zt_d, zt_d + 0.38)
dkf.build("skylight_band_frame", MAT_ROOF)
slit_row(-28.0, -6.0, -18.0, 1.0, 4.6, 6, face=-1, w=0.8)

# 东西展厅之间的玻璃连廊
pl = Builder()
pl.box(1.8, 16.2, -42.2, -27.8, Z0 - 0.02, Z0 + PLINTH)
pl.build("link_plinth", MAT_STONE)
lg = Builder()
lg.box(2.2, 15.8, -41.8, -28.2, Z0 + PLINTH, 5.35)
lg.build("link_glass", MAT_GLASS)
lr = Builder()
lr.box(1.5, 16.5, -42.5, -27.5, 5.35, 5.75)
lr.build("link_roof", MAT_ROOF)
lmul = Builder()
for i in range(7):
    cx = 3.0 + i * 2.1
    lmul.box(cx - 0.08, cx + 0.08, -41.95, -41.7, Z0 + PLINTH, 5.4)
lmul.build("link_mullion", MAT_WOOD)


# ---------------------------------------------------------------- 入口门廊与台阶

# 台基
pl = Builder()
pl.box(21.8, 38.2, -65.0, -49.8, Z0 - 0.02, Z0 + PLINTH)
pl.build("porch_plinth", MAT_STONE)

# 玻璃幕墙（南 / 东西两侧）
curtain_band(24.6, 35.4, -64.8, 0.4, 5.9, face=-1, mullions=6)
sg = Builder()
sg.box(24.55, 24.72, -64.8, -50.2, 0.4, 5.9)
sg.box(35.28, 35.45, -64.8, -50.2, 0.4, 5.9)
sg.build("porch_side_glass", MAT_GLASS)

# 木门
door = Builder()
door.box(29.2, 31.6, -64.94, -64.74, 0.4, 4.6)
door.build("porch_door", MAT_WOOD)

# 四角石柱
cols = Builder()
for px in (23.4, 36.6):
    for py in (-64.9, -50.1):
        cols.box(px - 0.32, px + 0.32, py - 0.32, py + 0.32, Z0 + PLINTH, 6.0)
cols.build("porch_column", MAT_STONE)

# 深灰平屋顶 + 顶部天窗细条
pr = Builder()
pr.box(20.6, 39.4, -65.8, -49.6, 6.0, 6.5)
pr.build("porch_roof", MAT_ROOF)
ps = Builder()
ps.box(25.0, 35.0, -61.0, -57.8, 6.5, 6.66)
ps.build("porch_skylight", MAT_GLASS)

# 台阶（三级石阶）
for i, (ya, yb, top) in enumerate([(-68.6, -65.0, 0.14), (-67.2, -65.0, 0.26), (-65.8, -65.0, 0.37)]):
    st = Builder()
    st.box(22.6, 37.4, ya, yb, 0.0, top)
    st.build("entry_step", MAT_STONE)


# ---------------------------------------------------------------- 水院

POND = (-28.0, 10.0, -76.0, -57.0)  # x0 x1 y0 y1

water = Builder()
water.box(POND[0] + 0.8, POND[1] - 0.8, POND[2] + 0.8, POND[3] - 0.8, 0.02, 0.13)
water.build("pond_water", MAT_WATER)

# 池岸压顶（四边石条，中间重叠以免留缝）
rim = Builder()
rim.box(POND[0] - 1.2, POND[1] + 1.2, POND[2] - 1.2, POND[2] + 0.4, 0.0, 0.42)   # 南
rim.box(POND[0] - 1.2, POND[1] + 1.2, POND[3] - 0.4, POND[3] + 0.4, 0.0, 0.42)   # 北
rim.box(POND[0] - 1.2, POND[0] + 0.4, POND[2], POND[3], 0.0, 0.42)               # 西
rim.box(POND[1] - 0.4, POND[1] + 1.2, POND[2], POND[3], 0.0, 0.42)               # 东
rim.build("pond_rim", MAT_STONE)


# 曲折石桥（分段盒体 + 低石栏，转角处略有搭接）
def flat_bridge(pts, width=2.0, top=0.62):
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
        b.box(cx - ln / 2 - 0.18, cx + ln / 2 + 0.18,
              cy - width / 2, cy + width / 2, 0.18, top)
        b.box(cx - ln / 2 - 0.18, cx + ln / 2 + 0.18,
              cy - width / 2, cy - width / 2 + 0.16, top, top + 0.3)
        b.box(cx - ln / 2 - 0.18, cx + ln / 2 + 0.18,
              cy + width / 2 - 0.16, cy + width / 2, top, top + 0.3)
        b.build("pond_bridge", MAT_STONE, rot=ang, pivot=(cx, cy))


BRIDGE = [(1.0, -75.5), (-2.5, -71.0), (2.5, -66.5), (-1.0, -62.0), (4.5, -58.6)]
flat_bridge(BRIDGE)

# 桥墩
pier = Builder()
for px, py in [(0.0, -68.75), (0.75, -64.25), (1.75, -60.3)]:
    pier.box(px - 0.45, px + 0.45, py - 0.45, py + 0.45, 0.0, 0.5)
pier.build("bridge_pier", MAT_STONE)


# ---------------------------------------------------------------- 片石假山（几何剪影墙）

PILE_Y = (-56.95, -55.75)
PROFILE = [
    (-28.0, 2.8), (-26.2, 4.8), (-24.6, 3.4), (-22.8, 6.4), (-20.6, 4.6),
    (-18.6, 7.6), (-16.4, 5.2), (-13.8, 8.2), (-11.6, 5.8), (-9.2, 7.0),
    (-6.6, 4.8), (-4.0, 6.2), (-1.8, 4.2), (-0.2, 2.6),
]
# 前排贴水叠石（低一层，形成前后层次）
FRONT_PROFILE = [
    (-26.5, 1.9), (-23.6, 3.7), (-21.0, 2.5), (-17.8, 4.9), (-15.2, 3.1),
    (-12.4, 4.4), (-9.6, 2.7), (-6.8, 3.9), (-3.6, 2.4), (-0.8, 1.6),
]


def rockery_wall(profile, y0, y1, base_z=0.34):
    b = Builder()
    # 石座
    b.box(profile[0][0] - 0.2, profile[-1][0] + 0.2, y0, y1, 0.0, base_z)
    for i in range(len(profile) - 1):
        xa, za = profile[i]
        xb, zb = profile[i + 1]
        b.quad((xa, y0, base_z), (xb, y0, base_z), (xb, y0, zb), (xa, y0, za))  # 南立面
        b.quad((xa, y1, base_z), (xb, y1, base_z), (xb, y1, zb), (xa, y1, za))  # 北立面
        b.quad((xa, y0, za), (xb, y0, zb), (xb, y1, zb), (xa, y1, za))          # 顶面窄条
    b.tri((profile[0][0], y0, base_z), (profile[0][0], y1, base_z),
          (profile[0][0], y0, profile[0][1]))
    b.tri((profile[0][0], y1, base_z), (profile[0][0], y1, profile[0][1]),
          (profile[0][0], y0, profile[0][1]))
    b.tri((profile[-1][0], y0, base_z), (profile[-1][0], y1, base_z),
          (profile[-1][0], y0, profile[-1][1]))
    b.tri((profile[-1][0], y1, base_z), (profile[-1][0], y1, profile[-1][1]),
          (profile[-1][0], y0, profile[-1][1]))
    b.build("rockery_wall", MAT_STONE)


rockery_wall(PROFILE, PILE_Y[0], PILE_Y[1])
rockery_wall(FRONT_PROFILE, -57.9, -56.8, base_z=0.02)

# 池中置石（假山前的高石与点石）
for px, py, r, hh, seed in [
    (-9.0, -72.5, 1.5, 2.1, 3), (5.8, -70.7, 1.2, 1.5, 8), (-22.0, -73.5, 1.1, 1.3, 12),
    (-24.0, -59.0, 1.5, 4.0, 21), (-18.3, -58.5, 1.2, 3.2, 27), (-1.6, -59.4, 1.3, 3.6, 33),
]:
    rng = random.Random(seed)
    pts = []
    for s in range(5):
        a = s * math.tau / 5 + 0.3
        rr = r * (0.72 + rng.random() * 0.5)
        pts.append((px + math.cos(a) * rr, py + math.sin(a) * rr))
    b = Builder()
    b.poly_prism(pts, 0.03, hh)
    b.build("pond_rock", MAT_STONE)


# 池南石栏杆
def pond_rail(x0, x1, y, base):
    post = Builder()
    n = max(2, int((x1 - x0) / 3.0))
    for i in range(n + 1):
        x = x0 + (x1 - x0) * i / n
        post.box(x - 0.09, x + 0.09, y - 0.09, y + 0.09, base, base + 0.78)
    post.box(x0, x1, y - 0.07, y + 0.07, base + 0.7, base + 0.82)
    post.box(x0, x1, y - 0.05, y + 0.05, base + 0.34, base + 0.42)
    post.build("pond_rail", MAT_STONE)


pond_rail(-22.0, -3.6, -76.4, 0.42)  # 桥头留缺口
pond_rail(5.6, 9.0, -76.4, 0.42)


# ---------------------------------------------------------------- 铺地

fore = Builder()
fore.box(12.0, 50.0, -77.0, -63.0, 0.0, 0.09)
fore.box(-26.0, 12.0, -78.0, -76.2, 0.0, 0.09)
fore.build("forecourt", MAT_STONE)

# 铺地分缝（深色细条，增加几何层次）
joint = Builder()
for i in range(11):
    x = 14.0 + i * 3.4
    joint.box(x, x + 0.22, -76.6, -63.4, 0.09, 0.12)
for i in range(4):
    y = -75.0 + i * 3.4
    joint.box(12.4, 49.6, y, y + 0.22, 0.09, 0.12)
joint.build("paving_joint", MAT_ROOF)

# 东侧步道
path = Builder()
path.box(50.0, 62.0, -62.0, -58.4, 0.0, 0.09)
path.build("east_path", MAT_STONE)


def bench(x, y):
    b = Builder()
    b.box(x - 1.5, x + 1.5, y - 0.28, y + 0.28, 0.42, 0.54)
    b.box(x - 1.3, x - 1.0, y - 0.22, y + 0.22, 0.09, 0.42)
    b.box(x + 1.0, x + 1.3, y - 0.22, y + 0.22, 0.09, 0.42)
    b.build("stone_bench", MAT_STONE)


for bx, by in [(17.5, -66.0), (43.5, -66.0), (-31.5, -71.0)]:
    bench(bx, by)


# ---------------------------------------------------------------- 植物

def ginkgo(x, y, h, r):
    trunk = Builder()
    trunk.box(x - 0.3, x + 0.3, y - 0.3, y + 0.3, 0.0, h * 0.56)
    trunk.build("tree_trunk", MAT_WOOD)

    leaf = Builder()
    leaf.prism(x, y, h * 0.30, h * 0.72, r, r * 0.62, 9)
    leaf.prism(x, y, h * 0.55, h * 0.9, r * 0.7, r * 0.4, 9)
    leaf.prism(x, y, h * 0.78, h, r * 0.42, r * 0.07, 9)
    leaf.build("tree_leaf", MAT_LEAF)


def bamboo(x, y, count, seed):
    rng = random.Random(seed)
    b = Builder()
    for i in range(count):
        a = rng.random() * math.tau
        d = rng.random() * 1.6
        px, py = x + math.cos(a) * d, y + math.sin(a) * d
        hh = 6.2 + rng.random() * 3.0
        rr = 0.13 + rng.random() * 0.05
        b.prism(px, py, 0.0, hh, rr, rr * 0.72, 5, a)
    b.build("bamboo_stalk", MAT_LEAF)

    c = Builder()
    for i in range(3):
        a = seed * 0.7 + i * 2.1
        c.prism(x + math.cos(a) * 0.9, y + math.sin(a) * 0.9,
                4.6 + i * 0.4, 6.6 + i * 0.8, 1.15, 0.32, 6)
    c.build("bamboo_crown", MAT_LEAF)


def shrub(x, y, r, hh):
    b = Builder()
    b.prism(x, y, 0.0, hh, r, r * 0.72, 6)
    b.build("shrub", MAT_LEAF)


# 银杏：前庭与东侧
for x, y, h, r in [
    (45.0, -70.6, 9.6, 3.0), (49.4, -64.8, 8.4, 2.6), (14.2, -71.8, 8.0, 2.4),
    (60.0, -24.0, 8.6, 2.6), (62.0, -40.0, 9.2, 2.8),
    (-54.0, 47.0, 8.4, 2.6), (-50.0, 36.0, 7.6, 2.4), (-22.0, 24.0, 8.0, 2.5),
    (-25.0, 9.0, 6.8, 2.2), (-30.5, -66.0, 7.2, 2.2),
    (52.5, -69.5, 8.2, 2.5), (66.0, -32.0, 8.8, 2.7), (66.0, -46.0, 8.4, 2.6),
]:
    ginkgo(x, y, h, r)

# 竹丛
for i, (x, y) in enumerate([(-34.6, -36.0), (-34.6, -24.0), (13.4, -62.0),
                            (13.4, -72.5), (39.6, -60.4), (-34.6, -48.0),
                            (-34.6, -30.0), (53.0, -63.5)]):
    bamboo(x, y, 11, 31 + i)

# 低矮灌木
for x, y, r, hh in [(-36.0, -13.0, 1.6, 1.2), (14.5, -55.6, 1.4, 1.0),
                    (20.0, -66.0, 1.5, 1.1), (40.0, -66.0, 1.5, 1.1)]:
    shrub(x, y, r, hh)


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
    obj = bpy.data.objects.new(f"sm_{mat_name}", mesh)
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
mn = [1e9, 1e9, 1e9]
mx = [-1e9, -1e9, -1e9]
meshes = 0
for obj in bpy.data.objects:
    if obj.type == "MESH":
        meshes += 1
        obj.data.calc_loop_triangles()
        tris += len(obj.data.loop_triangles)
        for v in obj.data.vertices:
            for i in range(3):
                mn[i] = min(mn[i], v.co[i])
                mx[i] = max(mx[i], v.co[i])
size_kb = os.path.getsize(OUT) / 1024
print(
    f"[suzhou-museum] exported {OUT} | meshes={meshes} tris={tris} "
    f"bbox=({mx[0]-mn[0]:.1f}, {mx[1]-mn[1]:.1f}, {mx[2]-mn[2]:.1f}) "
    f"min_z={mn[2]:.2f} max_z={mx[2]:.2f} glb={size_kb:.1f}KB"
)
