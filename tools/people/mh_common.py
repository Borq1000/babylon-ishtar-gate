# Shared helpers for the headless MPFB character pipeline (Blender 5.2 + MPFB 2.0.18).
# Run with:  set BLENDER_USER_RESOURCES=...\blender-user  &&  blender -b --python <script>

import os
import sys
import math
import bpy
import addon_utils

WORK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(WORK, 'blender-user', 'extensions', '.user', 'user_default', 'mpfb', 'data')
OUT = os.path.join(WORK, 'out')
os.makedirs(OUT, exist_ok=True)

MOD = 'bl_ext.user_default.mpfb'
addon_utils.enable(MOD, default_set=True, persistent=True)
for m in ('io_anim_bvh',):
    try:
        addon_utils.enable(m, default_set=True)
    except Exception as e:  # noqa
        print('could not enable', m, e)

from bl_ext.user_default.mpfb.services.humanservice import HumanService  # noqa: E402
from bl_ext.user_default.mpfb.services.targetservice import TargetService  # noqa: E402


def data(*p):
    return os.path.join(DATA, *p)


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.images, bpy.data.actions, bpy.data.cameras, bpy.data.lights):
        for b in list(coll):
            if b.users == 0:
                coll.remove(b)


def make_human(gender=1.0, age=0.5, muscle=0.55, weight=0.5, height=0.5, proportions=0.6, race=None, rig='cmu_mb'):
    macro = TargetService.get_default_macro_info_dict()
    macro.update(gender=gender, age=age, muscle=muscle, weight=weight, height=height, proportions=proportions)
    macro['race'] = race or {'caucasian': 0.7, 'african': 0.2, 'asian': 0.1}
    base = HumanService.create_human(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=True,
                                     feet_on_ground=True, scale=0.1, macro_detail_dict=macro)
    arm = HumanService.add_builtin_rig(base, rig, import_weights=True) if rig else None
    bake_shape_keys(base)
    return base, arm


def bake_shape_keys(ob):
    """Applies the current shape-key mix (MPFB macro targets) to the mesh data."""
    if ob.data.shape_keys is None:
        return
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.shape_key_remove(all=True, apply_mix=True)


def add_part(base, subdir, name, asset_type, material='GAMEENGINE'):
    path = data(subdir, name, name + '.mhclo')
    if not os.path.exists(path):
        print('missing asset', path)
        return None
    return HumanService.add_mhclo_asset(path, base, asset_type=asset_type, subdiv_levels=0, material_type=material)


def look_at(obj, target):
    from mathutils import Vector
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def setup_render(res=(900, 1200), engine='BLENDER_EEVEE'):
    sc = bpy.context.scene
    try:
        sc.render.engine = engine
    except Exception:
        sc.render.engine = 'BLENDER_EEVEE_NEXT'
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'AgX'
    world = bpy.data.worlds.new('w') if not sc.world else sc.world
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs[0].default_value = (0.55, 0.6, 0.7, 1)
    bg.inputs[1].default_value = 0.6
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 3.5
    so = bpy.data.objects.new('sun', sun)
    so.rotation_euler = (math.radians(50), 0, math.radians(35))
    bpy.context.scene.collection.objects.link(so)


def render(path, cam_loc, target, lens=50):
    cam = bpy.data.cameras.new('cam')
    cam.lens = lens
    co = bpy.data.objects.new('cam', cam)
    bpy.context.scene.collection.objects.link(co)
    co.location = cam_loc
    look_at(co, target)
    bpy.context.scene.camera = co
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(co, do_unlink=True)
