"""罗汉院双塔（苏州双塔）程序化建模并导出 GLB。

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
OUT = os.path.join(ROOT, "public", "models", "shuangta.glb")
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

    def pyra(self, cx, cy, z0, z1, a0, a1):
        """方形锥台（a0/a1 为底面/顶面半边长），用于塔身边坡与出檐。"""
        bot = [(cx - a0, cy - a0, z0), (cx + a0, cy - a0, z0), (cx + a0, cy + a0, z0), (cx - a0, cy + a0, z0)]
        top = [(cx - a1, cy - a1, z1), (cx + a1, cy - a1, z1), (cx + a1, cy + a1, z1), (cx - a1, cy + a1, z1)]
        for i in range(4):
            j = (i + 1) % 4
            self.quad(bot[i], bot[j], top[j], top[i])
        self.quad(top[0], top[1], top[2], top[3])
        self.quad(bot[0], bot[1], bot[2], bot[3])

    def prism(self, cx, cy, z0, z1, r0, r1, sides=8, phase=math.pi / 8):
        """正多棱柱 / 锥台（塔刹、树冠等）。"""
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
        """任意简单多边形拉伸（底板、铺地）。"""
        n = len(pts)
        for i in range(n):
            j = (i + 1) % n
            x0, y0 = pts[i]
            x1, y1 = pts[j]
            self.quad((x0, y0, z0), (x1, y1, z0), (x1, y1, z1), (x0, y0, z1))
        self.faces.append(tuple(self.V(x, y, z1) for x, y in pts))
        self.faces.append(tuple(self.V(x, y, z0) for x, y in reversed(pts)))

    def hip_roof(self, x0, x1, y0, y1, z0, h, inset, ridge=True, upturn=True):
        """庑殿 / 歇山简化的四坡顶：矩形檐口 + 正脊，带正脊压顶与四角起翘。"""
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
        scale = max(0.8, min(1.8, h / 2.8))
        if ridge and has_ridge:
            self.ridge_cap(xa, xb, ym, z0 + h, scale)
        if upturn:
            for c, out in (((x0, y0), (-1, -1)), ((x1, y0), (1, -1)),
                           ((x1, y1), (1, 1)), ((x0, y1), (-1, 1))):
                self.corner_upturn(c, out, z0, 1.0 * scale, 0.72 * scale, 0.34 * scale)

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
    """点到多边形边界的最近距离，用于树木避开院墙。"""
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

MAT_BRICK = material("brick", hexc("9c8f7e"), 0.92)          # 塔身砖色
MAT_TILE = material("tile", hexc("5d6672"), 0.82)            # 檐口 / 瓦 / 塔刹
MAT_STONE = material("stone", hexc("a9a294"), 0.95)          # 铺地 / 台基
MAT_WALL = material("wall", hexc("e4ddcc"), 0.94)            # 殿身粉墙
MAT_WOOD = material("wood", hexc("6b4a33"), 0.86)            # 门窗 / 柱 / 树干
MAT_LEAF = material("leaf", hexc("556c48"), 0.95)            # 树冠

# 景点轮廓（scene 坐标 → Blender 局部坐标）
with open(SCENE_JSON, encoding="utf-8") as f:
    geo = json.load(f)
lm = geo["landmarks"]["shuangta"]
CX, CZ = lm["centroid"]["x"], lm["centroid"]["z"]
OUTLINE = [(x - CX, -(z - CZ)) for x, z in lm["outline"]]
if abs(OUTLINE[0][0] - OUTLINE[-1][0]) < 0.01 and abs(OUTLINE[0][1] - OUTLINE[-1][1]) < 0.01:
    OUTLINE = OUTLINE[:-1]

# ---------------------------------------------------------------- 底板与石铺地

base = Builder()
base.poly_prism(OUTLINE, -0.5, 0.08)
base.build("courtyard_pave", MAT_STONE)

# ---------------------------------------------------------------- 院墙

WALL_H = 3.5
WALL_T = 0.6


def wall_run(p0, p1, height=WALL_H, thickness=WALL_T):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy)
    if length < 0.4:
        return
    ang = math.atan2(dy, dx)
    cx, cy = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2
    body = Builder()
    body.box(cx - length / 2, cx + length / 2, cy - thickness / 2, cy + thickness / 2, 0.08, 0.08 + height)
    body.build("courtyard_wall", MAT_WALL, rot=ang, pivot=(cx, cy))
    cap = Builder()
    cap.box(
        cx - length / 2 - 0.12,
        cx + length / 2 + 0.12,
        cy - thickness / 2 - 0.3,
        cy + thickness / 2 + 0.3,
        0.08 + height,
        0.08 + height + 0.38,
    )
    cap.build("courtyard_wall_cap", MAT_TILE, rot=ang, pivot=(cx, cy))


for i in range(len(OUTLINE)):
    wall_run(OUTLINE[i], OUTLINE[(i + 1) % len(OUTLINE)])

# ---------------------------------------------------------------- 罗汉院大殿

BUILDINGS = []  # (cx, cy, half_w, half_d) 供种树避让


def hall(cx, cy, w, d, h, roof_h=None, z0=0.08, roof_inset=None):
    """单檐歇山简化：台基 + 粉墙殿身 + 木裙板 + 灰瓦四坡顶。"""
    if roof_h is None:
        roof_h = 0.34 * h
    if roof_inset is None:
        roof_inset = min(w, d) * 0.3

    platform = Builder()
    platform.box(cx - w / 2 - 1.6, cx + w / 2 + 1.6, cy - d / 2 - 1.6, cy + d / 2 + 1.6, z0, z0 + 0.6)
    platform.build("hall_platform", MAT_STONE)

    body = Builder()
    body.box(cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2, z0 + 0.6, z0 + 0.6 + h)
    body.build("hall_wall", MAT_WALL)

    skirt = Builder()
    skirt.box(cx - w / 2 - 0.16, cx + w / 2 + 0.16, cy - d / 2 - 0.16, cy + d / 2 + 0.16, z0 + 0.6, z0 + 1.4)
    skirt.build("hall_skirt", MAT_WOOD)

    # 正面（南向）木板门
    doors = Builder()
    n = max(3, int(w / 4.5))
    dw = w / n * 0.62
    for i in range(n):
        dx = cx - w / 2 + (i + 0.5) * w / n
        doors.box(dx - dw / 2, dx + dw / 2, cy - d / 2 - 0.1, cy - d / 2 + 0.05, z0 + 0.6, z0 + 0.6 + h * 0.72)
    doors.build("hall_door", MAT_WOOD)

    roof = Builder()
    zt = z0 + 0.6 + h
    roof.hip_roof(cx - w / 2 - 1.5, cx + w / 2 + 1.5, cy - d / 2 - 1.5, cy + d / 2 + 1.5, zt, roof_h, roof_inset)
    roof.build("hall_roof", MAT_TILE)

    ridge = Builder()
    xa, xb = cx - w / 2 - 1.5 + roof_inset, cx + w / 2 + 1.5 - roof_inset
    ym = cy
    if xb - xa > 0.4:
        ridge.box(xa, xb, ym - 0.35, ym + 0.35, zt + roof_h - 0.05, zt + roof_h + 0.4)
        ridge.build("hall_ridge", MAT_TILE)

    BUILDINGS.append((cx, cy, w / 2 + 2.5, d / 2 + 2.5))


hall(0.0, 8.0, 30.0, 12.0, 7.2, 4.0, roof_inset=5.0)

# ---------------------------------------------------------------- 双塔

TOWERS = [(17.8, -27.0), (-2.0, -30.0)]


def square_pagoda(cx, cy):
    """七层方形砖塔：须弥座 + 逐层收分塔身 + 砖砌角柱 + 出檐 + 塔刹。"""
    base = Builder()
    base.pyra(cx, cy, 0.08, 0.7, 4.8, 4.5)
    base.pyra(cx, cy, 0.7, 1.0, 4.2, 3.9)
    base.build("pagoda_platform", MAT_STONE)

    heights = [4.4, 4.2, 4.0, 3.8, 3.6, 3.4, 3.2]
    z = 1.0
    a = 3.3
    for i, h in enumerate(heights):
        a0 = a
        a1 = a * 0.935
        body = Builder()
        body.pyra(cx, cy, z, z + h, a0, a1)
        body.build(f"pagoda_body_{i}", MAT_BRICK)

        # 四角砖砌角柱
        columns = Builder()
        for sx in (-1, 1):
            for sy in (-1, 1):
                px = cx + sx * (a0 * 0.99)
                py = cy + sy * (a0 * 0.99)
                columns.box(px - 0.26, px + 0.26, py - 0.26, py + 0.26, z, z + h * 0.86)
        columns.build(f"pagoda_column_{i}", MAT_BRICK)

        # 额枋：檐下微凸的砖砌横带
        band = Builder()
        band.pyra(cx, cy, z + h - 0.78, z + h - 0.2, a1 + 0.14, a1 + 0.14)
        band.build(f"pagoda_band_{i}", MAT_BRICK)

        # 四面门窗（深色凹板）
        am = (a0 + a1) / 2
        if i == 0:
            pw, ph, pz0, pz1 = 0.95, 2.2, z + 0.15, z + 2.35
        else:
            pw, ph, pz0, pz1 = 0.5, 1.5, z + h * 0.3, z + h * 0.3 + 1.5
        panels = Builder()
        t = 0.07
        panels.box(cx - pw, cx + pw, cy - am - t, cy - am + t, pz0, pz1)
        panels.box(cx - pw, cx + pw, cy + am - t, cy + am + t, pz0, pz1)
        panels.box(cx - am - t, cx - am + t, cy - pw, cy + pw, pz0, pz1)
        panels.box(cx + am - t, cx + am + t, cy - pw, cy + pw, pz0, pz1)
        panels.build(f"pagoda_window_{i}", MAT_TILE)

        # 出檐：薄板外挑、上收
        ov = 1.55 - i * 0.09
        eave = Builder()
        eave.pyra(cx, cy, z + h - 0.22, z + h + 0.42, a1 + ov, a1 + ov * 0.45)
        eave.build(f"pagoda_eave_{i}", MAT_TILE)

        z += h
        a = a1

    # 顶层小屋顶
    roof = Builder()
    roof.pyra(cx, cy, z, z + 1.2, a + 0.45, 0.85)
    roof.build("pagoda_top_roof", MAT_TILE)

    # 塔刹：刹座 + 相轮 + 宝珠
    spire = Builder()
    zs = z + 1.2
    spire.pyra(cx, cy, zs, zs + 0.45, 0.9, 0.72)
    spire.pyra(cx, cy, zs + 0.45, zs + 3.1, 0.16, 0.11)
    for k in range(6):
        zz = zs + 0.65 + k * 0.38
        r = 0.62 - k * 0.065
        spire.pyra(cx, cy, zz, zz + 0.16, r, r)
    spire.prism(cx, cy, zs + 3.1, zs + 3.45, 0.34, 0.34, 8)
    spire.prism(cx, cy, zs + 3.45, zs + 3.75, 0.3, 0.12, 8)
    spire.build("pagoda_spire", MAT_TILE)

    TOWERS_.append((cx, cy))


TOWERS_ = []
for tx, ty in TOWERS:
    square_pagoda(tx, ty)

# ---------------------------------------------------------------- 树木

RNG = random.Random(20261120)
TREES = 0


def tree(x, y, h, r):
    trunk = Builder()
    trunk.box(x - 0.32, x + 0.32, y - 0.32, y + 0.32, 0.08, h * 0.45)
    trunk.build("tree_trunk", MAT_WOOD)

    leaf = Builder()
    leaf.prism(x, y, h * 0.28, h * 0.76, r, r * 0.55, 7)
    leaf.prism(x, y, h * 0.64, h, r * 0.6, r * 0.14, 7)
    leaf.build("tree_leaf", MAT_LEAF)


placed_pos = []
attempts = 0
while len(placed_pos) < 7 and attempts < 4000:
    attempts += 1
    x = RNG.uniform(-37, 33)
    y = RNG.uniform(-66, 28)
    if not point_in_poly(OUTLINE, x, y) or edge_distance(OUTLINE, x, y) < 4.0:
        continue
    if any(abs(x - bx) < bw and abs(y - by) < bd for bx, by, bw, bd in BUILDINGS):
        continue
    if any(math.hypot(x - tx, y - ty) < 9.5 for tx, ty in TOWERS_):
        continue
    if any(math.hypot(x - px, y - py) < 8.0 for px, py in placed_pos):
        continue
    placed_pos.append((x, y))
    tree(x, y, RNG.uniform(6.0, 9.0), RNG.uniform(2.0, 3.0))

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
    obj = bpy.data.objects.new(f"shuangta_{mat_name}", mesh)
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
    f"[shuangta] exported {OUT} | meshes={len([o for o in bpy.data.objects if o.type=='MESH'])} "
    f"tris={tris} trees={len(placed_pos)}"
)
