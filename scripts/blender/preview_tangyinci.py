"""渲染唐寅祠 GLB 预览图，用于人工核对体量、朝向与布局。

取景自祠外东南上空，可同时看到南侧祠门、两进院落、享堂、六如亭与桃花院墙。
用法：blender -b --python preview_tangyinci.py
"""

import os

import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NAME = "tangyinci"
GLB = os.path.join(ROOT, "public", "models", f"{NAME}.glb")
OUT = os.path.join(os.environ.get("TEMP", "."), f"{NAME}_preview.png")

# 相机位置 / 观察目标（Blender 坐标：+X 东，+Y 北，+Z 上）
CAM = (33.0, -132.0, 68.0)
TARGET = (-12.0, 2.0, 3.0)
LENS = 50.0

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

target = bpy.data.objects.new("target", None)
target.location = TARGET
bpy.context.collection.objects.link(target)

cam_data = bpy.data.cameras.new("cam")
cam_data.lens = LENS
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
scene.render.resolution_x = 1100
scene.render.resolution_y = 760
scene.render.film_transparent = False
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print(f"[preview] {OUT}")
