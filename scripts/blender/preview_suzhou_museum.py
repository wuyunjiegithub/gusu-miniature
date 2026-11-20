"""渲染苏州博物馆 GLB 预览图（白墙 + 深灰坡顶 + 水院）。

用法：blender -b --python preview_suzhou_museum.py
输出：%TEMP%\\suzhou_museum_preview.png
"""

import os

import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GLB = os.path.join(ROOT, "public", "models", "suzhou_museum.glb")
OUT = os.path.join(os.environ.get("TEMP", "."), "suzhou_museum_preview.png")

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

target = bpy.data.objects.new("target", None)
target.location = (4.0, -48.0, 7.0)
bpy.context.collection.objects.link(target)

cam_data = bpy.data.cameras.new("cam")
cam_data.lens = 52
cam = bpy.data.objects.new("cam", cam_data)
cam.location = (132.0, -198.0, 98.0)
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
scene.display.shading.cavity_type = "BOTH"
scene.render.resolution_x = 1200
scene.render.resolution_y = 800
scene.render.film_transparent = False
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print(f"[preview] {OUT}")
