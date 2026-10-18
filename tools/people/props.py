# Hand-held props of the procession and their arm poses.
#
# Each prop clip re-bakes a base mocap clip with two-bone IK on one or both
# arms (targets follow the pelvis or the head, so the hands ride on the body's
# own motion). Each prop mesh is modelled in world space at frame 0 of its
# reference clip, then expressed in the bind pose of the bone that carries it
# (v_bind = B_rest * P_pose(0)^-1 * v_world) and skinned rigidly to that bone.

import math
import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector

V = Vector
TAU = 2 * math.pi


def at_hips(x, y, z):
    return lambda ctx, t: ctx['hips'] + V((x, y, z))


def at_head(x, y, z):
    return lambda ctx, t: ctx['head'] + V((x, y, z))


def beat(x, y, z, amp, k):
    return lambda ctx, t: ctx['hips'] + V((x, y, z + amp * max(0.0, math.sin(TAU * k * t))))


def pluck(x, y, z, amp, k):
    return lambda ctx, t: ctx['hips'] + V((x + amp * math.sin(TAU * k * t), y, z + 0.6 * amp * math.cos(TAU * k * t)))


# character frame in Blender: front = -Y, character's right = -X, up = +Z
POLE_R = V((-0.7, 0.5, -0.6))
POLE_L = V((0.7, 0.5, -0.6))
SPEAR = {'Right': (at_hips(-0.25, -0.15, 0.3), POLE_R), 'Left': (at_hips(0.2, -0.26, 0.17), V((0.9, 0.3, -0.5)))}
CARRY_R = {'Right': (at_head(-0.15, 0.02, 0.13), V((-1.0, 0.3, 0.1)))}
CARRY_L = {'Left': (at_head(0.14, 0.02, 0.15), V((1.0, 0.3, 0.1)))}
STAFF = {'Right': (at_hips(-0.3, -0.13, 0.08), V((-1.0, 0.6, -0.2)))}

# clip name -> (base clip, ik spec)
PROP_CLIPS = {
    'male': {
        'march_spear': ('march', SPEAR),
        'idle_spear': ('idle', SPEAR),
        'walk_standard': ('walk_slow', {'Right': (at_hips(-0.03, -0.31, 0.45), V((-1, 0.3, -0.5))), 'Left': (at_hips(-0.01, -0.3, 0.2), V((1, 0.3, -0.5)))}),
        'walk_drum': ('walk_slow', {'Left': (at_hips(0.2, -0.33, 0.13), V((1, 0.3, -0.6))), 'Right': (beat(-0.04, -0.37, 0.1, 0.075, 4), V((-1, 0.3, -0.6)))}),
        'walk_lyre': ('walk_slow', {'Left': (at_hips(0.17, -0.27, 0.4), V((1, 0.4, -0.5))), 'Right': (pluck(0.0, -0.31, 0.3, 0.025, 6), V((-1, 0.3, -0.5)))}),
        'walk_censer': ('walk_slow', {'Right': (at_hips(-0.18, -0.34, 0.2), V((-1, 0.4, -0.5))), 'Left': (at_hips(0.06, -0.2, 0.44), V((1, 0.2, -0.8)))}),
        'walk_bearer': ('walk_slow', {'Right': (at_hips(-0.2, -0.14, 0.5), V((-1, 0.2, -0.3))), 'Left': (at_hips(0.2, -0.14, 0.5), V((1, 0.2, -0.3)))}),
        'walk_carry': ('walk', CARRY_R),
        'idle_carry': ('idle', CARRY_R),
        'walk_staff': ('walk_slow', STAFF),
        'idle_staff': ('idle', STAFF),
    },
    'elder': {
        'walk_staff': ('walk_slow', STAFF),
        'idle_staff': ('idle', STAFF),
    },
    'female': {
        'walk_carry': ('walk', CARRY_L),
        'idle_carry': ('idle', CARRY_L),
    },
}

# prop -> (reference clip, bone, builder)
PROPS = {
    'male': {
        'spear': ('march_spear', 'RightHand'),
        'shield': ('march_spear', 'LeftForeArm'),
        'standard': ('walk_standard', 'RightHand'),
        'drum': ('walk_drum', 'Spine'),
        'lyre': ('walk_lyre', 'LeftHand'),
        'censer': ('walk_censer', 'RightHand'),
        'staff': ('walk_staff', 'RightHand'),
        'basket': ('walk_carry', 'Head'),
    },
    'elder': {'staff': ('walk_staff', 'RightHand')},
    'female': {'jar': ('walk_carry', 'Head')},
}


# ---------------------------------------------------------------- geometry helpers
def _bm_cyl(bm, p0, p1, r0, r1, seg=10, cap=True):
    p0, p1 = V(p0), V(p1)
    d = p1 - p0
    L = d.length
    z = d.normalized()
    x = z.orthogonal().normalized()
    y = z.cross(x)
    ring0, ring1 = [], []
    for k in range(seg):
        a = TAU * k / seg
        o = x * math.cos(a) + y * math.sin(a)
        ring0.append(bm.verts.new(p0 + o * r0))
        ring1.append(bm.verts.new(p1 + o * r1))
    for k in range(seg):
        bm.faces.new((ring0[k], ring0[(k + 1) % seg], ring1[(k + 1) % seg], ring1[k]))
    if cap:
        bm.faces.new(list(reversed(ring0)))
        bm.faces.new(ring1)


def _bm_lathe(bm, axis_p, prof, seg=14):
    """prof: [(r, h)] along +Z from axis_p."""
    rings = []
    for r, h in prof:
        ring = []
        for k in range(seg):
            a = TAU * k / seg
            ring.append(bm.verts.new(V(axis_p) + V((r * math.cos(a), r * math.sin(a), h))))
        rings.append(ring)
    for i in range(len(rings) - 1):
        for k in range(seg):
            bm.faces.new((rings[i][k], rings[i][(k + 1) % seg], rings[i + 1][(k + 1) % seg], rings[i + 1][k]))


def _bm_box(bm, c, size, rot=None):
    c = V(c)
    hs = V(size) / 2
    corners = []
    for dz in (-1, 1):
        for dy in (-1, 1):
            for dx in (-1, 1):
                p = V((dx * hs.x, dy * hs.y, dz * hs.z))
                if rot is not None:
                    p = rot @ p
                corners.append(bm.verts.new(c + p))
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    for q in f:
        bm.faces.new([corners[i] for i in q])


def _mesh_from_bm(name, parts):
    """parts: list of (bmesh, material name) -> one object with material slots."""
    me = bpy.data.meshes.new(name)
    full = bmesh.new()
    mats = []
    for bm, mat in parts:
        if mat not in mats:
            mats.append(mat)
        mi = mats.index(mat)
        tmp = bpy.data.meshes.new('tmp')
        bm.to_mesh(tmp)
        bm.free()
        nf = len(full.faces)
        full.from_mesh(tmp)
        full.faces.ensure_lookup_table()
        for k in range(nf, len(full.faces)):
            full.faces[k].material_index = mi
        bpy.data.meshes.remove(tmp)
    full.to_mesh(me)
    full.free()
    for m in mats:
        me.materials.append(bpy.data.materials.get(m) or bpy.data.materials.new(m))
    uvl = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            uvl.data[li].uv = (co.x * 3 + co.y * 3, 3.0 + co.z)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def build_prop(kind, ctx):
    """ctx: world positions at frame 0 of the reference clip: rh, lh, lfa (forearm mid), head, hips, spine."""
    parts = []
    bm = lambda: bmesh.new()  # noqa: E731
    if kind == 'spear':
        h = ctx['rh']
        b = bm(); _bm_cyl(b, (h.x, h.y - 0.02, 0.06), (h.x, h.y - 0.02, 2.55), 0.016, 0.014, 8); parts.append((b, 'wood'))
        b = bm(); _bm_cyl(b, (h.x, h.y - 0.02, 2.55), (h.x, h.y - 0.02, 2.82), 0.03, 0.002, 8); parts.append((b, 'metal'))
        b = bm(); _bm_cyl(b, (h.x, h.y - 0.02, 0.0), (h.x, h.y - 0.02, 0.07), 0.012, 0.016, 6); parts.append((b, 'metal'))
    elif kind == 'shield':
        c = ctx['lfa'] + V((0.07, -0.05, 0.0))
        n = V((0.55, -0.83, 0.0)).normalized()
        b = bm(); _bm_cyl(b, c, c + n * 0.035, 0.33, 0.33, 20); parts.append((b, 'cloth2'))
        b = bm(); _bm_cyl(b, c + n * 0.035, c + n * 0.07, 0.07, 0.04, 12); parts.append((b, 'metal'))
        b = bm(); _bm_cyl(b, c + n * 0.03, c + n * 0.045, 0.335, 0.335, 20, cap=False); parts.append((b, 'metal'))
    elif kind == 'standard':
        h = ctx['rh']
        b = bm(); _bm_cyl(b, (h.x, h.y, 0.35), (h.x, h.y, 3.25), 0.02, 0.018, 8); parts.append((b, 'wood'))
        # the marru, Marduk's spade-shaped emblem, gilded, on a short socket
        b = bm(); _bm_cyl(b, (h.x, h.y, 3.25), (h.x, h.y, 3.36), 0.03, 0.025, 8); parts.append((b, 'gold'))
        b = bm()
        tip = [V((h.x, h.y, 3.82)), V((h.x - 0.13, h.y, 3.46)), V((h.x - 0.05, h.y, 3.36)), V((h.x + 0.05, h.y, 3.36)), V((h.x + 0.13, h.y, 3.46))]
        vs = [b.verts.new(p + V((0, 0.012, 0))) for p in tip] + [b.verts.new(p - V((0, 0.012, 0))) for p in tip]
        b.faces.new(vs[:5]); b.faces.new(list(reversed(vs[5:])))
        for k in range(5):
            b.faces.new((vs[k], vs[(k + 1) % 5], vs[5 + (k + 1) % 5], vs[5 + k]))
        parts.append((b, 'gold'))
        b = bm(); _bm_box(b, (h.x, h.y, 3.1), (0.5, 0.012, 0.3)); parts.append((b, 'cloth2'))
    elif kind == 'drum':
        c = ctx['hips'] + V((0.12, -0.3, 0.12))
        ax = V((1, 0, 0))
        b = bm(); _bm_cyl(b, c - ax * 0.14, c + ax * 0.14, 0.17, 0.17, 18, cap=False); parts.append((b, 'wood'))
        b = bm(); _bm_cyl(b, c - ax * 0.145, c - ax * 0.13, 0.172, 0.172, 18); parts.append((b, 'cloth2'))
        b = bm(); _bm_cyl(b, c + ax * 0.13, c + ax * 0.145, 0.172, 0.172, 18); parts.append((b, 'cloth2'))
        # strap over the right shoulder
        b = bm(); _bm_cyl(b, c + V((0.0, 0.06, 0.15)), ctx['spine'] + V((-0.16, 0.0, 0.3)), 0.012, 0.012, 4); parts.append((b, 'leather'))
    elif kind == 'lyre':
        h = ctx['lh']
        o = h + V((-0.1, -0.06, -0.12))
        b = bm(); _bm_box(b, o, (0.3, 0.07, 0.16)); parts.append((b, 'wood'))
        b = bm(); _bm_cyl(b, o + V((-0.12, 0, 0.06)), o + V((-0.15, 0, 0.5)), 0.016, 0.014, 6); parts.append((b, 'wood'))
        b = bm(); _bm_cyl(b, o + V((0.12, 0, 0.06)), o + V((0.15, 0, 0.5)), 0.016, 0.014, 6); parts.append((b, 'wood'))
        b = bm(); _bm_cyl(b, o + V((-0.17, 0, 0.47)), o + V((0.17, 0, 0.47)), 0.014, 0.014, 6); parts.append((b, 'wood'))
        for k in range(5):
            x = -0.08 + k * 0.04
            b = bm(); _bm_cyl(b, o + V((x, -0.01, 0.08)), o + V((x * 1.2, -0.01, 0.46)), 0.002, 0.002, 3, cap=False); parts.append((b, 'gold'))
    elif kind == 'censer':
        h = ctx['rh']
        bowl = h + V((0.0, -0.03, -0.38))
        for dx, dy in ((0.04, 0), (-0.04, 0), (0, 0.04)):
            b = bm(); _bm_cyl(b, h + V((0, 0, -0.04)), bowl + V((dx, dy, 0.06)), 0.003, 0.003, 3, cap=False); parts.append((b, 'metal'))
        b = bm(); _bm_lathe(b, bowl, [(0.0, -0.03), (0.06, -0.02), (0.085, 0.03), (0.08, 0.06), (0.06, 0.09), (0.02, 0.13), (0.0, 0.14)], 14); parts.append((b, 'metal'))
    elif kind == 'staff':
        h = ctx['rh']
        b = bm(); _bm_cyl(b, (h.x - 0.01, h.y, 0.02), (h.x + 0.01, h.y, 1.62), 0.018, 0.015, 8); parts.append((b, 'wood'))
        b = bm(); _bm_lathe(b, (h.x + 0.01, h.y, 1.62), [(0.015, 0.0), (0.035, 0.03), (0.03, 0.07), (0.0, 0.1)], 10); parts.append((b, 'gold'))
    elif kind == 'basket':
        c = ctx['head'] + V((0, 0.0, -0.075))
        b = bm(); _bm_lathe(b, c, [(0.0, 0.0), (0.16, 0.0), (0.24, 0.05), (0.27, 0.15), (0.26, 0.16), (0.23, 0.06), (0.0, 0.03)], 18); parts.append((b, 'reed'))
        b = bm(); _bm_lathe(b, c + V((0, 0, 0.12)), [(0.0, 0.0), (0.2, 0.0), (0.19, 0.06), (0.1, 0.1), (0.0, 0.11)], 14); parts.append((b, 'clay'))
    elif kind == 'jar':
        c = ctx['head'] + V((0, 0.0, -0.075))
        b = bm(); _bm_lathe(b, c, [(0.0, 0.0), (0.07, 0.0), (0.14, 0.08), (0.16, 0.18), (0.12, 0.3), (0.06, 0.36), (0.055, 0.42), (0.075, 0.45), (0.06, 0.46), (0.0, 0.45)], 16); parts.append((b, 'clay'))
    return _mesh_from_bm('prop_' + kind, parts)


def frame0_context(arm):
    bpy.context.view_layer.update()
    mw = arm.matrix_world
    pb = arm.pose.bones
    f = lambda n: mw @ pb[n].head  # noqa: E731
    lfa = (mw @ pb['LeftForeArm'].head + mw @ pb['LeftHand'].head) / 2
    return dict(rh=f('RightHand'), lh=f('LeftHand'), lfa=lfa, head=mw @ pb['Head'].tail, hips=f('Hips'), spine=f('Spine1'))


def bind_rigid(ob, arm, bone, body_bones):
    """Expresses a world-space prop (at the current pose) in bind space and skins it to `bone`."""
    pb = arm.pose.bones[bone]
    rest = arm.matrix_world @ arm.data.bones[bone].matrix_local
    pose = arm.matrix_world @ pb.matrix
    M = rest @ pose.inverted()
    for v in ob.data.vertices:
        v.co = M @ v.co
    for name in body_bones:
        ob.vertex_groups.new(name=name)
    ob.vertex_groups[bone].add(list(range(len(ob.data.vertices))), 1.0, 'REPLACE')
    ob.parent = arm
    mod = ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm
    return ob
