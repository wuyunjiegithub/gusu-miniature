"""渲染山塘街样板段 GLB 预览图，用于人工核对街、河、桥与民居布局。

用法：blender -b --python scripts/blender/preview_shantangjie.py
输出：%TEMP%/shantangjie_preview.png
"""

import os

import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GLB = os.path.join(ROOT, "public", "models", "shantangjie.glb")
OUT = os.path.join(os.environ.get("TEMP", "."), "shantangjie_preview.png")

# 从东南方向俯视：相机位于模型东南、高处，看向街段中部
CAM = (240, -260, 145)
TARGET = (85, -60, 3)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

target = bpy.data.objects.new("target", None)
target.location = TARGET
bpy.context.collection.objects.link(target)

cam_data = bpy.data.cameras.new("cam")
cam_data.lens = 44
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
scene.render.resolution_y = 950
scene.render.film_transparent = False
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print(f"[preview] {OUT}")
