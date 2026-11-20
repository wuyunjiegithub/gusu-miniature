"""渲染留园 GLB 预览图，用于人工核对体量、朝向与布局。

用法：blender -b --python preview_liuyuan.py -- liuyuan
"""

import os
import sys

import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 每个模型的取景参数：相机位置 / 观察目标
CONFIG = {
    "liuyuan": {"cam": (230, -270, 205), "target": (0, 25, 4)},
}

args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
name = args[0] if args else "liuyuan"
cfg = CONFIG[name]

GLB = os.path.join(ROOT, "public", "models", f"{name}.glb")
OUT = os.path.join(os.environ.get("TEMP", "."), f"{name}_preview.png")

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

target = bpy.data.objects.new("target", None)
target.location = cfg["target"]
bpy.context.collection.objects.link(target)

cam_data = bpy.data.cameras.new("cam")
cam_data.lens = 50
cam = bpy.data.objects.new("cam", cam_data)
cam.location = cfg["cam"]
bpy.context.collection.objects.link(cam)
con = cam.constraints.new("TRACK_TO")
con.target = target
con.track_axis = "TRACK_NEGATIVE_Z"
con.up_axis = "UP_Y"
bpy.context.scene.camera = cam

scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.display.shading.show_shadows = True
scene.display.shading.show_cavity = True
scene.render.resolution_x = 1000
scene.render.resolution_y = 700
scene.render.film_transparent = False
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print(f"[preview] {OUT}")
