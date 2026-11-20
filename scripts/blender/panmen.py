"""盘门三景（水陆城门 + 瑞光塔 + 吴门桥）程序化建模并导出 GLB。

坐标约定：Blender +X = 东，+Y = 北，+Z = 上；单位为米，原点为景点质心。
glTF 导出后 +Z→+Y（up），+Y→-Z，与网页场景坐标系一致。
"""

import math
import os
import sys

import bpy
import bmesh

OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "public",
    "models",
    "panmen.glb",
)


# ---------------------------------------------------------------- 基础工具

MERGED = {}


class Builder:
    """共享顶点的网格构造器，配合 recalc_face_normals 保证法线朝外。"""

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
        """正多棱柱（r0 底半径、r1 顶半径，可做锥台）。"""
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

    def hip_roof(self, x0, x1, y0, y1, z0, h, inset=None, ridge=True, upturn=True):
        """庑殿顶：底面矩形 + 顶部屋脊，带正脊压顶与四角起翘。"""
        if inset is None:
            inset = min((x1 - x0), (y1 - y0)) * 0.5
        xa, xb = x0 + inset, x1 - inset
        ym = (y0 + y1) / 2
        b0 = (x0, y0, z0)
        b1 = (x1, y0, z0)
        b2 = (x1, y1, z0)
        b3 = (x0, y1, z0)
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

    def build(self, name, material, parent=None, rot=0.0, pivot=(0.0, 0.0)):
        """把本段几何并入按材质分组的缓存，最终每种材质只生成一个 mesh。

        rot / pivot：可选绕 Z 轴旋转（弧度）及旋转中心，便于把同一套
        沿 X 生成的构件复用到不同朝向（如与城墙垂直的吴门桥）。
        """
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


def material(name, color, roughness=0.86, metallic=0.0):
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


# ---------------------------------------------------------------- 场景清理

bpy.ops.wm.read_factory_settings(use_empty=True)

MAT_STONE = material("stone", hexc("9c9484"), 0.92)
MAT_STONE_DARK = material("stone_dark", hexc("6d685c"), 0.95)
MAT_WOOD = material("wood", hexc("7c3f2c"), 0.8)
MAT_TILE = material("tile", hexc("3b424c"), 0.78)
MAT_BRICK = material("brick", hexc("b6a68b"), 0.9)
MAT_BRIDGE = material("bridge", hexc("a9a294"), 0.94)

root = None


# ---------------------------------------------------------------- 水陆城门


def arched_wall(name, x0, x1, y0, y1, h, openings, mat):
    """带拱形门洞的城墙体块。openings: [(cx, 宽, 起拱高)]"""
    b = Builder()
    # 前后面按 x 分段分解，保证拱洞区域被精确挖空
    cuts = sorted({x0, x1} | {o[0] - o[1] / 2 for o in openings} | {o[0] + o[1] / 2 for o in openings})
    arch_of = {}
    for cx, w, spring in openings:
        arch_of[(round(cx - w / 2, 4), round(cx + w / 2, 4))] = (cx, w, spring)

    segments = []
    for i in range(len(cuts) - 1):
        xa, xb = cuts[i], cuts[i + 1]
        key = (round(xa, 4), round(xb, 4))
        segments.append((xa, xb, arch_of.get(key)))

    for y in (y0, y1):
        # 实心段
        for xa, xb, arch in segments:
            if arch is None:
                b.quad((xa, y, 0), (xb, y, 0), (xb, y, h), (xa, y, h))
                continue
            cx, w, spring = arch
            r = w / 2
            steps = 14
            for k in range(steps):
                t0 = -1 + 2 * k / steps
                t1 = -1 + 2 * (k + 1) / steps
                ax0, ax1 = cx + t0 * r, cx + t1 * r
                az0 = spring + math.sqrt(max(0.0, r * r - (t0 * r) ** 2))
                az1 = spring + math.sqrt(max(0.0, r * r - (t1 * r) ** 2))
                b.quad((ax0, y, az0), (ax1, y, az1), (ax1, y, h), (ax0, y, h))

    # 外轮廓四面
    b.quad((x0, y0, 0), (x0, y1, 0), (x0, y1, h), (x0, y0, h))
    b.quad((x1, y0, 0), (x1, y1, 0), (x1, y1, h), (x1, y0, h))
    b.quad((x0, y0, h), (x1, y0, h), (x1, y1, h), (x0, y1, h))
    b.quad((x0, y0, 0), (x1, y0, 0), (x1, y1, 0), (x0, y1, 0))

    # 每个门洞的侧壁与拱顶
    for cx, w, spring in openings:
        r = w / 2
        for jx in (cx - r, cx + r):
            b.quad((jx, y0, 0), (jx, y1, 0), (jx, y1, spring), (jx, y0, spring))
        steps = 14
        for k in range(steps):
            t0 = -1 + 2 * k / steps
            t1 = -1 + 2 * (k + 1) / steps
            ax0, ax1 = cx + t0 * r, cx + t1 * r
            az0 = spring + math.sqrt(max(0.0, r * r - (t0 * r) ** 2))
            az1 = spring + math.sqrt(max(0.0, r * r - (t1 * r) ** 2))
            b.quad((ax0, y0, az0), (ax1, y0, az1), (ax1, y1, az1), (ax0, y1, az0))

    return b.build(name, mat, root)


# 主城墙：东西向，含陆门（西）与水门（东）
WALL_Y0, WALL_Y1 = 18.0, 40.0
WALL_H = 12.0
arched_wall(
    "panmen_wall",
    -78.0,
    78.0,
    WALL_Y0,
    WALL_Y1,
    WALL_H,
    [(-17.0, 7.0, 5.0), (13.0, 11.0, 4.6)],
    MAT_STONE,
)

# 城墙延伸段
for i, (x0, x1) in enumerate([(-160.0, -78.0), (78.0, 158.0)]):
    b = Builder()
    b.box(x0, x1, WALL_Y0, WALL_Y1, 0.0, 10.4)
    b.build(f"wall_run_{i}", MAT_STONE, root)
    # 女墙压顶
    b = Builder()
    b.box(x0, x1, WALL_Y0, WALL_Y1, 10.4, 10.9)
    b.build(f"wall_cap_{i}", MAT_STONE_DARK, root)

# 垛口：沿外侧墙顶连续排布，拉出城墙的纵向线条
for x in range(-158, 158, 6):
    top = WALL_H if -78.0 <= x <= 78.0 else 10.9
    merlon = Builder()
    merlon.box(x, x + 2.6, WALL_Y0, WALL_Y0 + 2.6, top, top + 1.1)
    merlon.build("wall_merlon", MAT_STONE_DARK, root)


# 城楼：双层重檐
tower = Builder()
tower.box(-36.0, 32.0, WALL_Y0 + 2.0, WALL_Y1 - 2.0, WALL_H, WALL_H + 1.6)
tower.build("tower_podium", MAT_STONE_DARK, root)

tower = Builder()
tower.box(-33.0, 29.0, WALL_Y0 + 4.0, WALL_Y1 - 4.0, WALL_H + 1.6, WALL_H + 7.0)
tower.build("tower_lower", MAT_WOOD, root)

tower = Builder()
tower.hip_roof(-38.0, 34.0, WALL_Y0 + 1.0, WALL_Y1 - 1.0, WALL_H + 7.0, 3.0, 16.0)
tower.build("tower_eave_1", MAT_TILE, root)

tower = Builder()
tower.box(-25.0, 21.0, WALL_Y0 + 6.0, WALL_Y1 - 6.0, WALL_H + 8.6, WALL_H + 13.2)
tower.build("tower_upper", MAT_WOOD, root)

tower = Builder()
tower.hip_roof(-30.0, 26.0, WALL_Y0 + 3.0, WALL_Y1 - 3.0, WALL_H + 13.2, 4.6, 14.0)
tower.build("tower_eave_2", MAT_TILE, root)


# ---------------------------------------------------------------- 瑞光塔


def pagoda(cx, cy):
    platform = Builder()
    platform.prism(cx, cy, 0.0, 1.6, 10.4, 10.0, 8)
    platform.build("pagoda_platform", MAT_STONE, root)

    storeys = [
        (9.0, 7.8, 5.4),
        (7.8, 6.9, 4.8),
        (6.9, 6.1, 4.6),
        (6.1, 5.4, 4.4),
        (5.4, 4.8, 4.2),
        (4.8, 4.3, 4.0),
        (4.3, 3.8, 3.8),
    ]
    z = 1.6
    for i, (r0, r1, height) in enumerate(storeys):
        body = Builder()
        body.prism(cx, cy, z, z + height, r0, r1, 8)
        body.build(f"pagoda_body_{i}", MAT_BRICK, root)

        eave = Builder()
        eave.prism(cx, cy, z + height - 0.6, z + height + 0.25, r1 * 1.5, r1 * 1.18, 8)
        eave.build(f"pagoda_eave_{i}", MAT_TILE, root)
        z += height

    # 塔刹
    spire = Builder()
    spire.prism(cx, cy, z, z + 1.0, 1.5, 1.3, 8)
    spire.prism(cx, cy, z + 1.0, z + 7.6, 1.1, 0.12, 8)
    for k in range(4):
        zz = z + 1.8 + k * 1.2
        spire.prism(cx, cy, zz, zz + 0.24, 1.05 - k * 0.15, 1.05 - k * 0.15, 8)
    spire.build("pagoda_spire", MAT_TILE, root)


pagoda(58.0, 112.0)


# ---------------------------------------------------------------- 吴门桥


def arch_bridge(cx, cy, span, width, rise, band):
    """单孔石拱桥：拱带沿 y 方向拉伸。"""
    b = Builder()
    steps = 26
    half = span / 2
    top = []
    bot = []
    for k in range(steps + 1):
        x = -half + span * k / steps
        t = x / half
        zt = rise * (1 - t * t)
        zb = max(0.0, (rise - band) * (1 - t * t))
        top.append((cx + x, zt))
        bot.append((cx + x, zb))

    for k in range(steps):
        x0, zt0 = top[k]
        x1, zt1 = top[k + 1]
        _, zb0 = bot[k]
        _, zb1 = bot[k + 1]
        # 两个侧面
        b.quad((x0, cy - width / 2, zb0), (x1, cy - width / 2, zb1), (x1, cy - width / 2, zt1), (x0, cy - width / 2, zt0))
        b.quad((x0, cy + width / 2, zb0), (x1, cy + width / 2, zb1), (x1, cy + width / 2, zt1), (x0, cy + width / 2, zt0))
        # 桥面与拱腹
        b.quad((x0, cy - width / 2, zt0), (x1, cy - width / 2, zt1), (x1, cy + width / 2, zt1), (x0, cy + width / 2, zt0))
        b.quad((x0, cy - width / 2, zb0), (x1, cy - width / 2, zb1), (x1, cy + width / 2, zb1), (x0, cy + width / 2, zb0))

    # 两端封口
    x0, zt0 = top[0]
    b.quad((x0, cy - width / 2, 0.0), (x0, cy + width / 2, 0.0), (x0, cy + width / 2, zt0), (x0, cy - width / 2, zt0))
    x1, zt1 = top[-1]
    b.quad((x1, cy - width / 2, 0.0), (x1, cy + width / 2, 0.0), (x1, cy + width / 2, zt1), (x1, cy - width / 2, zt1))
    return b


# 吴门桥跨护城河，桥身与城墙垂直（旋转 90° 复用沿 X 生成的拱桥）
BRIDGE_CX, BRIDGE_CY = 13.0, -26.0
BRIDGE_SPAN, BRIDGE_WIDTH, BRIDGE_RISE = 56.0, 6.6, 9.0

bridge = arch_bridge(BRIDGE_CX, BRIDGE_CY, BRIDGE_SPAN, BRIDGE_WIDTH, BRIDGE_RISE, 4.2)
bridge.build("wumen_bridge", MAT_BRIDGE, root, rot=math.pi / 2, pivot=(BRIDGE_CX, BRIDGE_CY))

# 桥栏：与桥面同拱度，随桥一起旋转
rail = Builder()
steps = 26
half = BRIDGE_SPAN / 2
for side in (-1, 1):
    yy = BRIDGE_CY + side * (BRIDGE_WIDTH / 2 - 0.3)
    for k in range(steps):
        x0 = BRIDGE_CX - half + BRIDGE_SPAN * k / steps
        x1 = BRIDGE_CX - half + BRIDGE_SPAN * (k + 1) / steps
        t0 = (x0 - BRIDGE_CX) / half
        t1 = (x1 - BRIDGE_CX) / half
        z0 = BRIDGE_RISE * (1 - t0 * t0)
        z1 = BRIDGE_RISE * (1 - t1 * t1)
        rail.quad((x0, yy - 0.2, z0), (x1, yy - 0.2, z1), (x1, yy - 0.2, z1 + 1.0), (x0, yy - 0.2, z0 + 1.0))
        rail.quad((x0, yy + 0.2, z0), (x1, yy + 0.2, z1), (x1, yy + 0.2, z1 + 1.0), (x0, yy + 0.2, z0 + 1.0))
        rail.quad((x0, yy - 0.2, z0 + 1.0), (x1, yy - 0.2, z1 + 1.0), (x1, yy + 0.2, z1 + 1.0), (x0, yy + 0.2, z0 + 1.0))
rail.build("bridge_rail", MAT_BRIDGE, root, rot=math.pi / 2, pivot=(BRIDGE_CX, BRIDGE_CY))


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
    obj = bpy.data.objects.new(f"panmen_{mat_name}", mesh)
    obj.data.materials.append(mat)
    bpy.context.collection.objects.link(obj)


# ---------------------------------------------------------------- 导出

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
print(f"[panmen] exported {OUT} | meshes={len([o for o in bpy.data.objects if o.type=='MESH'])} tris={tris}")
