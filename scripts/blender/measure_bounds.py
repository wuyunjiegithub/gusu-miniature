"""测量所有景点 GLB 的世界包围盒，供 scripts/measure-model-bounds.mjs 换算为场景占地矩形。

用法（在项目根目录）：
    blender -b --python scripts/blender/measure_bounds.py
输出：%TEMP%/glb_bbox.json
"""

import json
import os

import bpy
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODELS = [
    "panmen",
    "zhuozhengyuan",
    "liuyuan",
    "pingjiang",
    "guanqianjie",
    "shuangta",
    "beisita",
    "shizilin",
    "wangshiyuan",
    "suzhou_museum",
    "canglangting",
    "hanshansi",
    "tangyinci",
    "taohuawu",
    "shantangjie",
]

out = {}
for name in MODELS:
    path = os.path.join(ROOT, "public", "models", f"{name}.glb")
    if not os.path.exists(path):
        continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    xs, ys, zs = [], [], []
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            w = obj.matrix_world @ Vector(corner)
            xs.append(w.x)
            ys.append(w.y)
            zs.append(w.z)
    out[name] = {"x": [min(xs), max(xs)], "y": [min(ys), max(ys)], "z": [min(zs), max(zs)]}

dst = os.path.join(os.environ.get("TEMP", "."), "glb_bbox.json")
with open(dst, "w", encoding="utf-8") as fp:
    json.dump(out, fp)
print(f"[bbox] {dst}")
