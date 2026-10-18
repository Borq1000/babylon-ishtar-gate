# Builds the crowd characters for one body type and exports a GLB:
#   armature (cmu_mb) + one mesh per archetype and LOD + baked mocap clips.
# Usage: blender -b --python build_people.py -- <type>
#   type: male | elder | female

import os, sys, json, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mh_common import *  # noqa
from retarget import import_bvh, Retarget
from garments import BodyData, make_robe, attach, delete_covered_body, ARM_BONES
import props as PR
import garments as G
import numpy as np
import bmesh

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else ['male']
TYPE = argv[0]
ONLY = argv[1].split(',') if len(argv) > 1 else None

TYPES = {
    'male': dict(macro=dict(gender=1.0, age=0.62, muscle=0.62, weight=0.56, height=0.5, proportions=0.6),
                 race={'caucasian': 0.55, 'african': 0.15, 'asian': 0.3}, skin='middleage_caucasian_male'),
    'elder': dict(macro=dict(gender=1.0, age=0.85, muscle=0.45, weight=0.6, height=0.45, proportions=0.55),
                  race={'caucasian': 0.6, 'african': 0.15, 'asian': 0.25}, skin='old_caucasian_male'),
    'female': dict(macro=dict(gender=0.0, age=0.5, muscle=0.45, weight=0.5, height=0.45, proportions=0.65),
                   race={'caucasian': 0.55, 'african': 0.15, 'asian': 0.3}, skin='middleage_caucasian_female'),
}

# archetype -> garments and assets
ARCH = {
    'male': {
        'man': dict(robe='long', hair='sonntag78_junglebook_hair', beard='grinsegold_beard_sigmund_wip', head='band'),
        'robed': dict(robe='long', hair='o4saken_long01', beard='grinsegold_beard_sigmund_wip', head='turban'),
        'noble': dict(robe='long', hair='o4saken_long01', beard='grinsegold_beard_sigmund_wip', head='royal'),
        'guard': dict(robe='short', hair='culturalibre_hair_02', beard='grinsegold_beard_sigmund_wip', head='helmet'),
        'worker': dict(robe='short', hair='cortu_short_messy_hair', beard='wdg_scruffy_beard', head='none'),
        'priest': dict(robe='long', hair=None, beard=None, head='none'),  # shaven-headed priests (sangu)
    },
    'elder': {
        'elder': dict(robe='long', hair='o4saken_long01', beard='grinsegold_beard_sigmund_wip', head='cap'),
    },
    'female': {
        'woman': dict(robe='long', hair='braid01', beard=None, head='veil'),
    },
}

CLIPS = [
    # name, bvh, start, (min_len, max_len) for cycle search or explicit end, kind
    ('walk', '08_01', 20, (100, 170), 'cycle'),
    ('walk_slow', '08_04', 30, (150, 260), 'cycle'),
    ('march', '20_06', 30, (90, 170), 'cycle'),
    ('idle', '111_28', 200, 1400, 'idle'),
    ('talk', '18_08', 300, 1500, 'idle'),
    ('wave', '111_37', 40, 300, 'idle'),
]


def bake_clips(arm):
    info = {}
    for name, bvh, start, rng, kind in CLIPS:
        src = import_bvh(os.path.join(WORK, 'bvh', bvh + '.bvh'))
        rt = Retarget(src, arm)
        if kind == 'cycle':
            end, err = rt.find_cycle(start, rng[0], rng[1])
            frames = list(range(start, end, 4))
            act, n = rt.bake(name, frames, in_place=True)
            # natural travel speed of the source cycle (m/s) for foot-locked playback
            S0 = rt.sample_source(start)['Hips'].to_translation()
            S1 = rt.sample_source(end)['Hips'].to_translation()
            dist = (S1 - S0).length * rt.scale
            dur = (end - start) / 120.0
            info[name] = dict(frames=n, fps=30, loop=True, speed=dist / dur, duration=dur)
        else:
            end = rng
            frames = list(range(start, end, 4))
            act, n = rt.bake(name, frames, in_place=True, loop_blend=12)
            info[name] = dict(frames=n, fps=30, loop=True, speed=0.0, duration=(end - start) / 120.0)
        print('clip', name, info[name])
        # arm-pose variants of this clip for the hand-held props
        for pname, (base_name, ik) in PR.PROP_CLIPS.get(TYPE, {}).items():
            if base_name != name:
                continue
            if kind == 'cycle':
                act2, n2 = rt.bake(pname, frames, in_place=True, ik=ik)
            else:
                act2, n2 = rt.bake(pname, frames, in_place=True, loop_blend=12, ik=ik)
            info[pname] = dict(info[name])
            info[pname]['frames'] = n2
            print('clip', pname, n2)
        src_act = src.animation_data.action if src.animation_data else None
        bpy.data.objects.remove(src, do_unlink=True)
        if src_act is not None:
            bpy.data.actions.remove(src_act)
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
    return info


def lathe(name, profile, seg, center, mat):
    """profile: list of (r, z) from top to bottom."""
    verts, faces = [], []
    for i, (r, z) in enumerate(profile):
        for j in range(seg):
            t = 2 * math.pi * j / seg
            verts.append((center[0] + r * math.sin(t), center[1] - r * math.cos(t), z))
    for i in range(len(profile) - 1):
        for j in range(seg):
            a = i * seg + j
            b = i * seg + (j + 1) % seg
            faces.append((a, b, b + seg, a + seg))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    uvl = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            i, j = divmod(vi, seg)
            uvl.data[li].uv = (j / seg, 3.0 + i / max(1, len(profile) - 1))
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    G.set_material(ob, mat)
    return ob


def head_metrics(body):
    co = body.co
    m = body.mask(include=['Head'], thr=0.5)
    pts = co[m]
    top = pts[:, 2].max()
    band = pts[np.abs(pts[:, 2] - (top - 0.07)) < 0.01]
    cx, cy = 0.0, (band[:, 1].min() + band[:, 1].max()) / 2
    r = np.sqrt((band[:, 0] - cx) ** 2 + (band[:, 1] - cy) ** 2).max()
    return top, (cx, cy), r


def make_headwear(body, kind):
    if kind in (None, 'none', 'veil'):
        return None
    top, c, r = head_metrics(body)
    seg = 28
    if kind == 'band':
        prof = [(r + 0.012, top - 0.055), (r + 0.016, top - 0.07), (r + 0.016, top - 0.085), (r + 0.012, top - 0.1)]
        mat = 'cloth2'
    elif kind == 'turban':
        return make_turban(body, top, c, r)
    elif kind == 'cap':
        # low, soft felt cap following the skull
        prof = [(0.0, top + 0.022), (r * 0.55, top + 0.019), (r * 0.85, top + 0.006), (r + 0.01, top - 0.025),
                (r + 0.013, top - 0.055), (r + 0.011, top - 0.07)]
        mat = 'cloth2'
    elif kind == 'royal':
        # rounded, slightly conical felt cap with a broad band (Neo-Babylonian royal / noble cap)
        prof = [(0.0, top + 0.115), (r * 0.42, top + 0.108), (r * 0.78, top + 0.085), (r + 0.004, top + 0.04),
                (r + 0.016, top - 0.01), (r + 0.024, top - 0.02), (r + 0.026, top - 0.06), (r + 0.02, top - 0.075), (r + 0.012, top - 0.085)]
        mat = 'cloth2'
    elif kind == 'helmet':
        prof = [(0.0, top + 0.16), (r * 0.35, top + 0.1), (r * 0.75, top + 0.03), (r + 0.012, top - 0.03), (r + 0.016, top - 0.075), (r + 0.02, top - 0.085)]
        mat = 'metal'
    ob = lathe('headwear', prof, seg, c, mat)
    W = np.zeros((len(ob.data.vertices), len(body.bones)), np.float32)
    W[:, body.bi['Head']] = 1
    G.assign_weights(ob, body, W)
    return ob


def make_turban(body, top, c, r):
    """Cloth wound in three overlapping, slightly tilted coils over a soft crown."""
    import bmesh as _bm
    verts, faces, uvs = [], [], []
    seg, rs = 32, 8
    coils = [(top - 0.075, 0.034, 0.10), (top - 0.045, 0.032, -0.14), (top - 0.018, 0.026, 0.12)]
    for ci, (zc, tube, tilt) in enumerate(coils):
        R = r + 0.018 - ci * 0.01
        base_i = len(verts)
        for j in range(seg):
            t = 2 * math.pi * j / seg
            cx = c[0] + R * math.sin(t)
            cy = c[1] - R * math.cos(t)
            cz = zc + tilt * 0.12 * math.sin(t + ci)
            nx, ny = math.sin(t), -math.cos(t)
            for k in range(rs):
                a = 2 * math.pi * k / rs
                rr = tube * (1 + 0.08 * math.sin(3 * t + k))
                verts.append((cx + nx * rr * math.cos(a), cy + ny * rr * math.cos(a), cz + rr * 0.8 * math.sin(a)))
                uvs.append((j / seg, 3.0 + ci * 0.1 + k / rs * 0.1))
        for j in range(seg):
            for k in range(rs):
                a = base_i + j * rs + k
                b = base_i + ((j + 1) % seg) * rs + k
                c2 = base_i + ((j + 1) % seg) * rs + (k + 1) % rs
                d = base_i + j * rs + (k + 1) % rs
                faces.append((a, b, c2, d))
    # crown
    crown = lathe('crown', [(0.0, top + 0.035), (r * 0.6, top + 0.03), (r * 0.9, top + 0.012), (r + 0.004, top - 0.02)], 24, c, 'cloth2')
    me = bpy.data.meshes.new('turban')
    me.from_pydata(verts, [], faces)
    me.update()
    uvl = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li in poly.loop_indices:
            uvl.data[li].uv = uvs[me.loops[li].vertex_index]
    ob = bpy.data.objects.new('turban', me)
    bpy.context.scene.collection.objects.link(ob)
    G.set_material(ob, 'cloth2')
    # merge the crown into the turban object
    bpy.ops.object.select_all(action='DESELECT')
    crown.select_set(True)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.join()
    W = np.zeros((len(ob.data.vertices), len(body.bones)), np.float32)
    W[:, body.bi['Head']] = 1
    G.assign_weights(ob, body, W)
    return ob


def make_veil(body):
    """Head cloth: a hood that follows the skull and frames the face, flaring
    over the shoulders into a mantle that falls down the back to the waist."""
    top, c, r = head_metrics(body)
    co = body.co
    seg = 40
    thetas = np.linspace(0, 2 * math.pi, seg, endpoint=False)
    head_mask = body.mask(include=['Head', 'Neck', 'Neck1'], thr=0.4)
    torso_mask = body.mask(exclude=ARM_BONES, thr=0.3)
    z_head = list(np.linspace(top + 0.018, top - 0.16, 9))
    z_mantle = list(np.linspace(top - 0.2, 0.96, 12))
    zs = z_head + z_mantle
    radii, centers = [], []
    for i, z in enumerate(zs):
        on_head = i < len(z_head)
        m = (head_mask if on_head else torso_mask) & (np.abs(co[:, 2] - z) < 0.025)
        pts = co[m][:, :2]
        cc = np.array([c[0], c[1]]) if on_head else np.array([0.0, c[1] + 0.03])
        rr = G._hull_radius(pts, cc, thetas) if len(pts) > 3 else None
        if rr is None:
            rr = radii[-1].copy() if radii else np.full(seg, r)
        if on_head:
            k = i / (len(z_head) - 1)
            rr = rr + 0.024 + 0.02 * k  # loosens towards the neck
            if i == 0:
                rr = rr * 0.55
        else:
            k = (i - len(z_head)) / max(1, len(z_mantle) - 1)
            rr = rr + 0.045 + 0.03 * k
        radii.append(G._smooth_circular(rr, passes=3))
        centers.append(cc)
    R = G._smooth_rows(np.array(radii), passes=2)
    verts, uvs = [], []
    for i, z in enumerate(zs):
        for j in range(seg + 1):
            jj = j % seg
            t = thetas[jj] if j < seg else 2 * math.pi
            x = centers[i][0] + R[i, jj] * math.sin(t)
            y = centers[i][1] - R[i, jj] * math.cos(t)
            verts.append((x, y, z))
            uvs.append((j / seg, 4.0 + i / len(zs)))
    cols = seg + 1
    faces = []
    for i in range(len(zs) - 1):
        z = zs[i]
        for j in range(seg):
            tc = math.cos((thetas[j] + math.pi / seg))
            if i < len(z_head) - 1 and z < top - 0.035 and tc > 0.58:
                continue  # the face stays free
            if i >= len(z_head) - 1 and tc > 0.35:
                continue  # the mantle is open in front
            a = i * cols + j
            faces.append((a, a + 1, a + cols + 1, a + cols))
    me = bpy.data.meshes.new('veil')
    me.from_pydata(verts, [], faces)
    me.update()
    uvl = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li in poly.loop_indices:
            uvl.data[li].uv = uvs[me.loops[li].vertex_index]
    ob = bpy.data.objects.new('veil', me)
    bpy.context.scene.collection.objects.link(ob)
    G.set_material(ob, 'cloth2')
    P = np.array(verts)
    W = G.nearest_weights(body, P, body.mask(exclude=ARM_BONES, thr=0.3))
    for b in ARM_BONES:
        W[:, body.bi[b]] = 0
    headrow = np.array([1.0 if i < len(z_head) - 2 else 0.0 for i in range(len(zs)) for _ in range(cols)])
    W = W * (1 - headrow[:, None])
    W[:, body.bi['Head']] += headrow
    G.assign_weights(ob, body, W)
    return ob


def apply_masks_and_cleanup(base):
    bpy.context.view_layer.objects.active = base
    for m in list(base.modifiers):
        if m.type == 'MASK':
            try:
                bpy.ops.object.modifier_apply(modifier=m.name)
            except Exception as e:
                print('mask apply failed', m.name, e)
    # drop helper vertex groups
    for g in list(base.vertex_groups):
        if g.name.startswith(('helper', 'joint')) or g.name in ('HelperGeometry', 'JointCubes', 'body', 'Left', 'Right', 'Mid', 'nippleTip', 'nipple', 'lips', 'fingernails', 'toenails', 'ears', 'scalp', 'genitals'):
            base.vertex_groups.remove(g)


def name_materials(ob, part):
    mat = bpy.data.materials.get(part) or bpy.data.materials.new(part)
    if not ob.material_slots:
        ob.data.materials.append(mat)
    for slot in ob.material_slots:
        slot.link = 'DATA'  # MPFB links some materials to the object; the mesh data travels alone
        slot.material = mat


def build_archetype(key, spec, tdef):
    clear_scene_keep_actions()
    base, arm = make_human(race=tdef['race'], **tdef['macro'])
    add_part(base, 'eyes', 'low-poly', 'Eyes', material='MAKESKIN')
    add_part(base, 'eyebrows', 'eyebrow001', 'Eyebrows')
    add_part(base, 'eyelashes', 'eyelashes01', 'Eyelashes')
    hair = add_part(base, 'hair', spec['hair'], 'Hair') if spec.get('hair') else None
    beard = add_part(base, 'clothes', spec['beard'], 'Clothes') if spec.get('beard') else None
    body = BodyData(base, arm)
    hem = 0.075 if spec['robe'] == 'long' else 0.47
    parts = make_robe(body, hem=hem, sleeves=None, ease_hem=0.07 if spec['robe'] == 'long' else 0.05)
    hw = make_veil(body) if spec.get('head') == 'veil' else make_headwear(body, spec.get('head'))
    # body parts hidden by the garments
    covered = body.weight_of(['Hips', 'LowerBack', 'Spine', 'Spine1', 'LHipJoint', 'RHipJoint', 'LeftUpLeg', 'RightUpLeg'])
    arm_w = body.weight_of(['LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm'])
    legw = body.weight_of(['LeftLeg', 'RightLeg'])
    co = body.co
    long_robe = spec['robe'] == 'long'

    def keep(i):
        if not body.in_body[i]:
            return False  # helper geometry
        z = co[i, 2]
        if covered[i] > 0.5 and z < 1.43 and arm_w[i] < 0.3:
            if not long_robe and z < hem + 0.02 and z > 0:  # short tunic: thighs below the hem stay
                return body.weight_of(['LeftUpLeg', 'RightUpLeg'])[i] > 0.5
            return False
        if long_robe and legw[i] > 0.5 and z > hem + 0.16:
            return False
        return True
    # body materials: slot 0 skin, slot 1 painted sleeves (cloth)
    skin_mat = bpy.data.materials.get('skin:' + tdef['skin']) or bpy.data.materials.new('skin:' + tdef['skin'])
    cloth_mat = bpy.data.materials.get('cloth') or bpy.data.materials.new('cloth')
    for slot in base.material_slots:
        slot.link = 'DATA'
    base.data.materials.clear()
    base.data.materials.append(skin_mat)
    base.data.materials.append(cloth_mat)
    for poly in base.data.polygons:
        poly.material_index = 0
    sleeve_len = 0.98 if long_robe else 0.55
    delete_covered_body(base, body, keep, paint=lambda bm: G.paint_sleeves(bm, base, body, sleeve_len, 1))
    apply_masks_and_cleanup(base)
    for ob in list(bpy.data.objects):
        if ob.type != 'MESH' or ob == base:
            continue
        n = ob.name.lower()
        if 'low-poly' in n:
            name_materials(ob, 'eyes:brown')
        elif 'eyebrow' in n:
            name_materials(ob, 'brows:eyebrow001')
        elif 'eyelash' in n:
            name_materials(ob, 'lashes:eyelashes01')
        elif hair is not None and ob == hair:
            name_materials(ob, 'hair:' + spec['hair'])
        elif beard is not None and ob == beard:
            name_materials(ob, 'beard:' + spec['beard'])
    for p in parts:
        attach(p, arm)
    if hw is not None:
        attach(hw, arm)
    # join everything into one mesh (one shared UV layer)
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    for o in meshes:
        uvs = o.data.uv_layers
        act = uvs.active
        for l in list(uvs):
            if l != act:
                uvs.remove(l)
        if uvs.active:
            uvs.active.name = 'UVMap'
    for o in meshes:
        # bake non-armature modifiers (mhclo delete masks etc.)
        bpy.context.view_layer.objects.active = o
        for m in list(o.modifiers):
            if m.type not in ('ARMATURE',):
                try:
                    bpy.ops.object.modifier_apply(modifier=m.name)
                except Exception as e:
                    print('apply failed', o.name, m.name, e)
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = base
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = key
    ob.data.name = key
    # keep only bone vertex groups
    bones = {b.name for b in arm.data.bones}
    for g in list(ob.vertex_groups):
        if g.name not in bones:
            ob.vertex_groups.remove(g)
    return ob, arm


def clear_scene_keep_actions():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.images):
        for b in list(coll):
            if b.users == 0:
                coll.remove(b)


def make_lods(ob, ratios):
    out = [ob]
    for k, r in enumerate(ratios, start=1):
        c = ob.copy()
        c.data = ob.data.copy()
        bpy.context.scene.collection.objects.link(c)
        c.name = f'{ob.name}_LOD{k}'
        bpy.context.view_layer.objects.active = c
        d = c.modifiers.new('dec', 'DECIMATE')
        d.ratio = r
        d.use_collapse_triangulate = True
        # keep the armature modifier last
        bpy.ops.object.modifier_move_to_index(modifier='dec', index=0)
        bpy.ops.object.modifier_apply(modifier='dec')
        out.append(c)
    ob.name = ob.name + '_LOD0'
    return out


def main():
    tdef = TYPES[TYPE]
    kept = []
    master_arm = None
    for key, spec in ARCH[TYPE].items():
        if ONLY and key not in ONLY:
            continue
        ob, arm = build_archetype(key, spec, tdef)
        # stash the finished mesh data, rebuild later under the master rig
        data_copy = ob.data.copy()
        data_copy.name = key + '_mesh'
        data_copy.use_fake_user = True
        kept.append((key, data_copy, [g.name for g in ob.vertex_groups]))
        print('built', key, 'verts', len(ob.data.vertices), 'polys', len(ob.data.polygons))
    # final scene: one rig + all archetypes (vertex groups live on the objects, so rebuild them)
    clear_scene_keep_actions()
    bpy.context.scene.render.fps = 30
    bpy.context.scene.render.fps_base = 1.0
    base, arm = make_human(race=tdef['race'], **tdef['macro'])
    bpy.data.objects.remove(base, do_unlink=True)
    arm.name = 'rig'
    info = bake_clips(arm)
    lod_info = {}
    for key, me, groups in kept:
        ob = bpy.data.objects.new(key, me)
        bpy.context.scene.collection.objects.link(ob)
        if len(ob.vertex_groups) == 0:
            for gname in groups:
                ob.vertex_groups.new(name=gname)
        print('restored groups', key, len(ob.vertex_groups))
        ob.parent = arm
        mod = ob.modifiers.new('Armature', 'ARMATURE')
        mod.object = arm
        lods = make_lods(ob, [0.6, 0.2, 0.06, 0.022])
        # LOD0 = the 0.6 decimation; drop the full-density original
        full = lods.pop(0)
        bpy.data.objects.remove(full, do_unlink=True)
        for k, o in enumerate(lods):
            o.name = f'{key}_LOD{k}'
        lod_info[key] = [len(o.data.polygons) for o in lods]
    # hand-held props, modelled at frame 0 of their reference clip and bound rigidly
    bone_names = [b.name for b in arm.data.bones]
    for kind, (clip, bone) in PR.PROPS.get(TYPE, {}).items():
        act = bpy.data.actions.get(clip)
        if act is None:
            print('no clip for prop', kind, clip)
            continue
        arm.animation_data.action = act
        bpy.context.scene.frame_set(0)
        ctx = PR.frame0_context(arm)
        ob = PR.build_prop(kind, ctx)
        PR.bind_rigid(ob, arm, bone, bone_names)
        print('prop', kind, len(ob.data.polygons))
    arm.animation_data.action = None
    bpy.context.scene.frame_set(0)
    with open(os.path.join(OUT, f'people_{TYPE}.json'), 'w') as f:
        json.dump(dict(clips=info, lods=lod_info), f, indent=1)
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.data.objects:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, f'people_{TYPE}.glb'), export_format='GLB',
                              use_selection=True, export_image_format='NONE', export_animations=True,
                              export_animation_mode='ACTIONS', export_skins=True, export_all_influences=False,
                              export_morph=False, export_apply=False, export_yup=True, export_texcoords=True,
                              export_normals=True, export_materials='EXPORT', export_optimize_animation_size=False,
                              export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
                              export_draco_position_quantization=14, export_draco_normal_quantization=10,
                              export_draco_texcoord_quantization=12, export_draco_generic_quantization=12)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, f'people_{TYPE}.blend'))
    print('lods', lod_info)


main()
