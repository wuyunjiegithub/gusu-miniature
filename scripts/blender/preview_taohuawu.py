"""渲染桃花坞大街样板段预览图，用于核对街面走向、沿街建筑与桃花。

用法：blender -b --python preview_taohuawu.py
输出：%TEMP%\taohuawu_preview.png
"""

import os

import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

NAME = "taohuawu"
# 相机沿街斜 45° 俯视：可同时看到街面、两侧民居、桃花与两端牌坊
CAM = (128.0, -158.0, 190.0)
TARGET = (-20.0, -12.0, 0.0)

GLB = os.path.join(ROOT, "public", "models", f"{NAME}.glb")
OUT = os.path.join(os.environ.get("TEMP", "."), f"{NAME}_preview.png")

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

target = bpy.data.objects.new("target", None)
target.location = TARGET
bpy.context.collection.objects.link(target)

cam_data = bpy.data.cameras.new("cam")
cam_data.lens = 40
cam = bpy.data.objects.new("cam", cam_data)
cam.location = CAM
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
scene.render.resolution_x = 1400
scene.render.resolution_y = 900
scene.render.film_transparent = False
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print(f"[preview] {OUT}")
