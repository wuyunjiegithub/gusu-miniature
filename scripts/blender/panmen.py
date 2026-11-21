"""盘门三景（水陆城门 + 瑞光塔 + 吴门桥）程序化建模并导出 GLB。

坐标约定：Blender +X = 东，+Y = 北，+Z = 上；单位为米。
glTF 导出（export_yup）后 +Z→+Y（up），+Y→-Z，与网页场景坐标系一致：
世界 +x = 东，-z = 北，+y = 上。

按真实尺度（2026 复核）：
- 盘门城墙：现存段长约 300m、高 8.1m、厚约 12m（水门处因内外两重纵深约 24m）。
- 水门：内外两重、纵深 24.5m；内门第三道拱最大，高 9.7m、宽 9.3m。
- 陆门：内外两重，中为方形瓮城（内周长约 180m）。
- 城楼：1986 年复建，二层重檐歇山顶，阔 15.5m、高 11.3m、进深 8.65m。
- 吴门桥：单孔石拱桥，全长 66.3m、中宽 4.8m、拱券净跨 16m、矢高约 9m，
  南北走向，跨护城河（城墙南侧）。
- 瑞光塔：七级八面楼阁式砖塔，高约 43m。

布局（Blender 局部坐标，城墙中心为原点、城墙沿 X 东西向）：
- 城墙沿 X：X ∈ [-150, 150]（300m），厚沿 Y：Y ∈ [-6, 6]（12m），高 8.1m。
- 水门洞：X=+13，宽 9.3m，沿 Y 穿透。
- 陆门洞：X=-17，宽 7m，沿 Y 穿透。
- 城楼：X=0 附近，跨城墙顶。
- 吴门桥：Y=-66（城墙南侧、护城河中心），沿 Y 南北走向，全长 66.3m。
- 瑞光塔：X=+58、Y=+150（城墙北侧城内），高 43m。
"""

import math
import os

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
        沿 X 生成的构件复用到不同朝向。
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


# ---------------------------------------------------------------- 城墙

# 城墙尺寸（真实）：长 300m、高 8.1m、厚 12m
WALL_X0, WALL_X1 = -150.0, 150.0
WALL_HALF_T = 6.0  # 半厚（Y 方向 ±6m）
WALL_H = 8.1


def wall_with_gates():
    """东西向城墙 + 水门洞（东侧）+ 陆门洞（西侧），门洞沿 Y 方向穿透。

    门洞在城墙上挖出「沿 X 方向分段、拱形顶」的开口：
    openings = [(cx, 宽, 起拱高)]。
    """
    b = Builder()
    openings = [(-17.0, 7.0, 4.6), (13.0, 9.3, 5.6)]
    # 前后（南/北）两个墙面，按 x 分段挖拱洞
    cuts = sorted({WALL_X0, WALL_X1} | {o[0] - o[1] / 2 for o in openings} | {o[0] + o[1] / 2 for o in openings})
    arch_of = {}
    for cx, w, spring in openings:
        arch_of[(round(cx - w / 2, 4), round(cx + w / 2, 4))] = (cx, w, spring)

    segments = []
    for i in range(len(cuts) - 1):
        xa, xb = cuts[i], cuts[i + 1]
        key = (round(xa, 4), round(xb, 4))
        segments.append((xa, xb, arch_of.get(key)))

    y0, y1 = -WALL_HALF_T, WALL_HALF_T
    for y in (y0, y1):
        for xa, xb, arch in segments:
            if arch is None:
                b.quad((xa, y, 0), (xb, y, 0), (xb, y, WALL_H), (xa, y, WALL_H))
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
                b.quad((ax0, y, az0), (ax1, y, az1), (ax1, y, WALL_H), (ax0, y, WALL_H))

    # 东西两端封口 + 顶面
    b.quad((WALL_X0, y0, 0), (WALL_X0, y1, 0), (WALL_X0, y1, WALL_H), (WALL_X0, y0, WALL_H))
    b.quad((WALL_X1, y0, 0), (WALL_X1, y1, 0), (WALL_X1, y1, WALL_H), (WALL_X1, y0, WALL_H))
    b.quad((WALL_X0, y0, WALL_H), (WALL_X1, y0, WALL_H), (WALL_X1, y1, WALL_H), (WALL_X0, y1, WALL_H))

    # 门洞侧壁（沿 Y 方向的洞壁）与拱顶
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

    return b.build("panmen_wall", MAT_STONE, root)


wall_with_gates()


# 垛口：沿外侧（南侧 Y=-6）墙顶连续排布
def merlons():
    b = Builder()
    for x in range(-148, 148, 6):
        b.box(x, x + 2.6, -WALL_HALF_T, -WALL_HALF_T + 1.4, WALL_H, WALL_H + 1.0)
        b.box(x, x + 2.6, WALL_HALF_T - 1.4, WALL_HALF_T, WALL_H, WALL_H + 1.0)
    return b.build("wall_merlon", MAT_STONE_DARK, root)


merlons()


# ---------------------------------------------------------------- 城楼

def gate_tower():
    """二层重檐歇山顶城楼：阔 15.5m、高 11.3m、进深 8.65m，落在城墙顶。"""
    # 城台（城墙顶上的基座）
    p = Builder()
    p.box(-9.0, 9.0, -5.0, 5.0, WALL_H, WALL_H + 1.5)
    p.build("tower_podium", MAT_STONE_DARK, root)

    # 下层
    t = Builder()
    t.box(-7.75, 7.75, -4.3, 4.3, WALL_H + 1.5, WALL_H + 6.5)
    t.build("tower_lower", MAT_WOOD, root)
    t = Builder()
    t.hip_roof(-9.0, 9.0, -5.0, 5.0, WALL_H + 6.5, 2.4, 6.0)
    t.build("tower_eave_1", MAT_TILE, root)

    # 上层
    t = Builder()
    t.box(-5.6, 5.6, -3.2, 3.2, WALL_H + 7.6, WALL_H + 11.3)
    t.build("tower_upper", MAT_WOOD, root)
    t = Builder()
    t.hip_roof(-6.8, 6.8, -4.0, 4.0, WALL_H + 11.3, 3.0, 4.6)
    t.build("tower_eave_2", MAT_TILE, root)


gate_tower()


# ---------------------------------------------------------------- 瑞光塔

def pagoda(cx, cy, height=43.0):
    """七级八面楼阁式砖塔（真实高约 43m）。"""
    platform = Builder()
    platform.prism(cx, cy, 0.0, 1.6, 6.5, 6.2, 8)
    platform.build("pagoda_platform", MAT_STONE, root)

    n = 7
    z = 1.6
    r = 6.0
    tier_h = (height - 1.6 - 3.0) / n  # 每层平均高度
    for i in range(n):
        r0 = r * (1 - 0.07 * i)
        r1 = r * (1 - 0.07 * (i + 1))
        body = Builder()
        body.prism(cx, cy, z, z + tier_h, r0, r1, 8)
        body.build(f"pagoda_body_{i}", MAT_BRICK, root)
        # 出檐
        eave = Builder()
        eave.prism(cx, cy, z + tier_h - 0.5, z + tier_h + 0.25, r1 * 1.5, r1 * 1.15, 8)
        eave.build(f"pagoda_eave_{i}", MAT_TILE, root)
        z += tier_h

    # 塔刹
    spire = Builder()
    spire.prism(cx, cy, z, z + 1.0, 1.4, 1.2, 8)
    spire.prism(cx, cy, z + 1.0, z + 3.0, 0.9, 0.1, 8)
    spire.build("pagoda_spire", MAT_TILE, root)


# 瑞光塔在城墙北侧（城内）约 150m、偏东
pagoda(58.0, 150.0)


# ---------------------------------------------------------------- 吴门桥

def arch_bridge(cx, cy, span, width, rise, band):
    """单孔石拱桥：拱沿 y 方向（南北走向），cx 为桥中心 x，cy 为桥中心 y。

    拱形沿 y 方向拉伸（span 沿 y），宽度沿 x（width）。
    桥两端带引桥坡道，桥面自拱顶向两端落到地面。
    """
    b = Builder()
    steps = 30
    half = span / 2
    top = []
    bot = []
    for k in range(steps + 1):
        y = -half + span * k / steps
        t = y / half
        zt = rise * (1 - t * t)  # 桥面拱形（最高在中间）
        zb = max(0.0, (rise - band) * (1 - t * t))  # 拱腹
        top.append((y, zt))
        bot.append((y, zb))

    for k in range(steps):
        y0, zt0 = top[k]
        y1, zt1 = top[k + 1]
        _, zb0 = bot[k]
        _, zb1 = bot[k + 1]
        # 两个侧面（沿 x 方向的两侧）
        b.quad((cx - width / 2, cy + y0, zb0), (cx - width / 2, cy + y1, zb1),
               (cx - width / 2, cy + y1, zt1), (cx - width / 2, cy + y0, zt0))
        b.quad((cx + width / 2, cy + y0, zb0), (cx + width / 2, cy + y1, zb1),
               (cx + width / 2, cy + y1, zt1), (cx + width / 2, cy + y0, zt0))
        # 桥面（顶）与拱腹（底）
        b.quad((cx - width / 2, cy + y0, zt0), (cx - width / 2, cy + y1, zt1),
               (cx + width / 2, cy + y1, zt1), (cx + width / 2, cy + y0, zt0))
        b.quad((cx - width / 2, cy + y0, zb0), (cx - width / 2, cy + y1, zb1),
               (cx + width / 2, cy + y1, zb1), (cx + width / 2, cy + y0, zb0))

    # 两端封口
    y0, zt0 = top[0]
    b.quad((cx - width / 2, cy + y0, 0.0), (cx + width / 2, cy + y0, 0.0),
           (cx + width / 2, cy + y0, zt0), (cx - width / 2, cy + y0, zt0))
    y1, zt1 = top[-1]
    b.quad((cx - width / 2, cy + y1, 0.0), (cx + width / 2, cy + y1, 0.0),
           (cx + width / 2, cy + y1, zt1), (cx - width / 2, cy + y1, zt1))
    return b


# 吴门桥：单孔，全长 66.3m、宽 4.8m、拱跨（span 沿 y）取桥身弧长、矢高 9m。
# 桥中心在城墙南侧 66m（护城河中心），沿 Y（南北）走向。
BRIDGE_CX = 13.0
BRIDGE_CY = -66.0
BRIDGE_SPAN = 66.0
BRIDGE_WIDTH = 4.8
BRIDGE_RISE = 9.0

bridge = arch_bridge(BRIDGE_CX, BRIDGE_CY, BRIDGE_SPAN, BRIDGE_WIDTH, BRIDGE_RISE, 4.2)
bridge.build("wumen_bridge", MAT_BRIDGE, root)

# 桥栏：与桥面同拱度
def bridge_rail(cx, cy, span, width, rise):
    b = Builder()
    steps = 30
    half = span / 2
    for side in (-1, 1):
        xx = cx + side * (width / 2 - 0.15)
        for k in range(steps):
            y0 = cy - half + span * k / steps
            y1 = cy - half + span * (k + 1) / steps
            t0 = (y0 - cy) / half
            t1 = (y1 - cy) / half
            z0 = rise * (1 - t0 * t0)
            z1 = rise * (1 - t1 * t1)
            b.quad((xx - 0.15, y0, z0), (xx - 0.15, y1, z1), (xx - 0.15, y1, z1 + 0.9), (xx - 0.15, y0, z0 + 0.9))
            b.quad((xx + 0.15, y0, z0), (xx + 0.15, y1, z1), (xx + 0.15, y1, z1 + 0.9), (xx + 0.15, y0, z0 + 0.9))
            b.quad((xx - 0.15, y0, z0 + 0.9), (xx - 0.15, y1, z1 + 0.9), (xx + 0.15, y1, z1 + 0.9), (xx + 0.15, y0, z0 + 0.9))
    return b.build("bridge_rail", MAT_BRIDGE, root)


bridge_rail(BRIDGE_CX, BRIDGE_CY, BRIDGE_SPAN, BRIDGE_WIDTH, BRIDGE_RISE)


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
