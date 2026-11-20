"""渲染网师园 GLB 预览图，用于核对彩霞池、水阁、六角亭与小院布局。

用法：blender -b --python preview_wangshiyuan.py
"""

import os

import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

CAM = (74.0, -116.0, 110.0)   # 西南偏南俯瞰，正对濯缨水阁与彩霞池
TARGET = (-3.0, -4.0, 2.0)

GLB = os.path.join(ROOT, "public", "models", "wangshiyuan.glb")
OUT = os.path.join(os.environ.get("TEMP", "."), "wangshiyuan_preview.png")

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

target = bpy.data.objects.new("target", None)
target.location = TARGET
bpy.context.collection.objects.link(target)

cam_data = bpy.data.cameras.new("cam")
cam_data.lens = 50
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
