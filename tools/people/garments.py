# Procedural Neo-Babylonian garments fitted to an MPFB body (rest pose).
#
# Garments are built as ring shells: for every height z and angle theta the
# radius is taken from the convex hull of the body's cross-section (so a long
# robe spans both legs like real cloth), smoothed, eased and flared. UVs carry
# (theta / 2pi, z) so the shader can paint borders, shawl bands and fringes in
# garment space. Skin weights come from the body (nearest vertices) and, for
# skirts, from a smooth hips/legs blend so the cloth swings without splitting.

import math
import bpy
import bmesh
import numpy as np
from mathutils import Vector

ARM_BONES = ['LeftArm', 'LeftForeArm', 'LeftHand', 'LThumb', 'LeftFingerBase', 'LeftHandFinger1',
             'RightArm', 'RightForeArm', 'RightHand', 'RThumb', 'RightFingerBase', 'RightHandFinger1']


# ---------------------------------------------------------------- body data
class BodyData:
    def __init__(self, base, arm):
        self.base, self.arm = base, arm
        me = base.data
        mw = base.matrix_world
        body_idx = base.vertex_groups['body'].index
        self.co = np.array([(mw @ v.co)[:] for v in me.vertices])
        self.in_body = np.array([any(g.group == body_idx for g in v.groups) for v in me.vertices])
        self.bones = [b.name for b in arm.data.bones]
        gi = {g.name: g.index for g in base.vertex_groups}
        self.W = np.zeros((len(me.vertices), len(self.bones)), np.float32)
        for bi, b in enumerate(self.bones):
            if b not in gi:
                continue
            idx = gi[b]
            for v in me.vertices:
                for g in v.groups:
                    if g.group == idx:
                        self.W[v.index, bi] = g.weight
        s = self.W.sum(1, keepdims=True)
        self.W = np.where(s > 0, self.W / np.maximum(s, 1e-9), 0)
        self.bi = {b: i for i, b in enumerate(self.bones)}
        self.joint = {b.name: np.array(b.head_local[:]) for b in arm.data.bones}
        self.tail = {b.name: np.array(b.tail_local[:]) for b in arm.data.bones}

    def weight_of(self, names):
        return sum(self.W[:, self.bi[n]] for n in names if n in self.bi)

    def mask(self, include=None, exclude=None, thr=0.25):
        m = self.in_body.copy()
        if include:
            m &= self.weight_of(include) > thr
        if exclude:
            m &= self.weight_of(exclude) < thr
        return m


def _hull_radius(pts, center, thetas):
    """Radius of the 2D convex hull of pts (N,2) along rays from center."""
    from mathutils.geometry import convex_hull_2d
    if len(pts) < 3:
        return None
    try:
        hv = convex_hull_2d([Vector((float(p[0]), float(p[1]))) for p in pts])
    except Exception:
        return None
    if len(hv) < 3:
        return None
    poly = pts[hv]
    out = np.zeros(len(thetas))
    for i, t in enumerate(thetas):
        d = np.array([math.sin(t), -math.cos(t)])  # theta = 0 -> front (-Y), increases towards +X (character's left)
        best = 0.0
        n = len(poly)
        for k in range(n):
            a, b = poly[k] - center, poly[(k + 1) % n] - center
            e = b - a
            den = d[0] * (-e[1]) - d[1] * (-e[0])
            if abs(den) < 1e-12:
                continue
            # solve center + s*d = a + u*e
            s_ = (a[0] * (-e[1]) - a[1] * (-e[0])) / den
            u_ = (d[0] * a[1] - d[1] * a[0]) / den
            if s_ > 0 and -1e-6 <= u_ <= 1 + 1e-6:
                best = max(best, s_)
        out[i] = best
    return out


def _smooth_circular(r, k=2, passes=2):
    for _ in range(passes):
        r = (np.roll(r, 1, axis=-1) + np.roll(r, -1, axis=-1) + r * k) / (k + 2)
    return r


def _smooth_rows(R, passes=2):
    for _ in range(passes):
        R2 = R.copy()
        R2[1:-1] = (R[:-2] + R[2:] + 2 * R[1:-1]) / 4
        R = R2
    return R


# ---------------------------------------------------------------- shells
def ring_shell(body, z_levels, seg, select_fn, ease_fn, flare_from=None, min_r=0.04):
    """Returns (centers (Z,2), radii (Z,seg), thetas)."""
    thetas = np.linspace(0, 2 * math.pi, seg, endpoint=False)
    co = body.co
    centers, radii = [], []
    for z in z_levels:
        band = 0.03
        m = select_fn(z) & (np.abs(co[:, 2] - z) < band)
        pts = co[m][:, :2]
        if len(pts) < 8:
            band = 0.06
            m = select_fn(z) & (np.abs(co[:, 2] - z) < band)
            pts = co[m][:, :2]
        if len(pts) >= 3:
            c = np.array([0.0, pts[:, 1].mean() * 0.0 + (pts[:, 1].min() + pts[:, 1].max()) / 2])
            r = _hull_radius(pts, c, thetas)
        else:
            c, r = (centers[-1] if centers else np.zeros(2)), None
        if r is None:
            r = radii[-1].copy() if radii else np.full(seg, min_r)
        centers.append(c)
        radii.append(np.maximum(r, min_r))
    centers = np.array(centers)
    R = np.array(radii)
    R = _smooth_rows(np.array([_smooth_circular(r) for r in R]), passes=3)
    centers[:, 1] = _smooth_rows(centers[:, 1:2], passes=4)[:, 0]
    for i, z in enumerate(z_levels):
        R[i] += ease_fn(z)
    if flare_from is not None:
        # below flare_from the cloth falls freely: never narrower than the ring above
        idx = [i for i, z in enumerate(z_levels) if z < flare_from]
        for i in idx:
            R[i] = np.maximum(R[i], R[i - 1] * 0.995)
            centers[i, 1] = centers[i - 1, 1] * 0.7 + centers[i, 1] * 0.3
    return centers, R, thetas


def build_grid_mesh(name, verts, uvs, rows, cols, closed=True, extra_faces=None):
    me = bpy.data.meshes.new(name)
    faces = []
    for i in range(rows - 1):
        for j in range(cols if closed else cols - 1):
            a = i * cols + j
            b = i * cols + (j + 1) % cols
            c = (i + 1) * cols + (j + 1) % cols
            d = (i + 1) * cols + j
            faces.append((a, d, c, b))
    if extra_faces:
        faces.extend(extra_faces)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    uvl = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            uvl.data[li].uv = uvs[vi]
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def shell_vertices(centers, R, thetas, z_levels, seam_dup=True):
    """Ring vertices; the seam column is duplicated so UVs do not wrap."""
    verts, uvs = [], []
    seg = len(thetas)
    cols = seg + 1 if seam_dup else seg
    for i, z in enumerate(z_levels):
        for j in range(cols):
            jj = j % seg
            t = thetas[jj] if j < seg else 2 * math.pi
            r = R[i, jj]
            x = centers[i, 0] + r * math.sin(t)
            y = centers[i, 1] - r * math.cos(t)
            verts.append((x, y, z))
            uvs.append((t / (2 * math.pi), z))
    return verts, uvs, cols


# ---------------------------------------------------------------- weights
def nearest_weights(body, P, mask, k=6, power=2.0):
    """Inverse-distance weights from the k nearest masked body vertices."""
    from mathutils.kdtree import KDTree
    idx = np.where(mask)[0]
    tree = KDTree(len(idx))
    for n, i in enumerate(idx):
        tree.insert(Vector(body.co[i]), n)
    tree.balance()
    d = np.zeros((len(P), k))
    nn = np.zeros((len(P), k), int)
    for r, p in enumerate(P):
        res = tree.find_n(Vector(p), k)
        for c, (co_, ii, dist) in enumerate(res):
            d[r, c] = dist
            nn[r, c] = ii
    w = 1.0 / np.maximum(d, 1e-4) ** power
    w /= w.sum(1, keepdims=True)
    W = np.einsum('nk,nkb->nb', w, body.W[idx][nn])
    return W


def skirt_weights(body, P, z_top, z_bottom, leg_share=0.75):
    """Smooth hips/legs blend for long skirts (P in rest space)."""
    bi = body.bi
    W = np.zeros((len(P), len(body.bones)), np.float32)
    knee = body.joint['LeftLeg'][2]
    for n, p in enumerate(P):
        x, y, z = p
        t = np.clip((z_top - z) / max(z_top - z_bottom, 1e-3), 0, 1)
        t = t * t * (3 - 2 * t)
        legs = leg_share * t
        hips = 1 - legs
        side = np.clip(0.5 + x / 0.22, 0, 1)  # +X = character's left
        side = side * side * (3 - 2 * side)
        shin = np.clip((knee + 0.08 - z) / 0.3, 0, 1)
        for s, w_side in (('Left', side), ('Right', 1 - side)):
            W[n, bi[s + 'UpLeg']] += legs * w_side * (1 - shin)
            W[n, bi[s + 'Leg']] += legs * w_side * shin
        W[n, bi['Hips']] += hips
    return W


def blend_weights(W1, W2, a):
    return W1 * (1 - a[:, None]) + W2 * a[:, None]


def assign_weights(ob, body, W, max_inf=4):
    for g in list(ob.vertex_groups):
        ob.vertex_groups.remove(g)
    groups = {b: ob.vertex_groups.new(name=b) for b in body.bones}
    for vi in range(W.shape[0]):
        row = W[vi]
        top = np.argsort(row)[::-1][:max_inf]
        s = row[top].sum()
        if s <= 0:
            continue
        for bi_ in top:
            w = row[bi_] / s
            if w > 1e-3:
                groups[body.bones[bi_]].add([vi], float(w), 'REPLACE')


def attach(ob, arm):
    ob.parent = arm
    mod = ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm
    return ob


def set_material(ob, name, color=(0.8, 0.8, 0.8)):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    if not ob.data.materials:
        ob.data.materials.append(mat)
    else:
        ob.data.materials[0] = mat
    return mat


# ---------------------------------------------------------------- garments
def make_robe(body, name='robe', hem=0.075, seg=56, top=1.445, ease_torso=0.016, ease_hem=0.07, sleeves='elbow', material='cloth'):
    """Ankle-length (hem ~0.075) or knee-length tunic with short sleeves."""
    torso_mask = body.mask(exclude=ARM_BONES + ['Head', 'Neck', 'Neck1'], thr=0.3)
    hip_z = body.joint['LeftUpLeg'][2] - 0.02
    crotch = hip_z - 0.12
    nz = int(round((top - hem) / 0.025)) + 1
    z_levels = np.linspace(top, hem, nz)

    def sel(z):
        return torso_mask

    def ease(z):
        if z > hip_z:
            return ease_torso
        t = (hip_z - z) / max(hip_z - hem, 1e-3)
        return ease_torso + (ease_hem - ease_torso) * t ** 1.4

    centers, R, thetas = ring_shell(body, z_levels, seg, sel, ease, flare_from=crotch)
    # above the armpits the tunic must not reach past the shoulder joints: the
    # sleeve is painted on the arm and has to cover the shoulder seam
    sx = abs(body.joint['LeftArm'][0]) - 0.015
    armpit = body.joint['LeftArm'][2] - 0.14
    for i, z in enumerate(z_levels):
        if z > armpit:
            k = min(1.0, (z - armpit) / 0.08)
            lim = sx / np.maximum(np.abs(np.sin(thetas)), 1e-3)
            R[i] = np.minimum(R[i], R[i] * (1 - k) + np.minimum(R[i], lim) * k)
    # soft vertical folds below the belt, deepening towards the hem
    rng = np.random.default_rng(7)
    ph1, ph2 = rng.uniform(0, 6.28, 2)
    for i, z in enumerate(z_levels):
        if z < hip_z:
            k = ((hip_z - z) / max(hip_z - hem, 1e-3)) ** 0.8
            R[i] += k * (0.009 * np.sin(thetas * 11 + ph1) + 0.005 * np.sin(thetas * 5 + ph2)) + 0.006 * k
    verts, uvs, cols = shell_vertices(centers, R, thetas, z_levels)
    # shoulder yoke: close the top ring towards a neck hole
    neck_z = top
    neck_c = np.array([0.0, body.joint['Neck'][1]])
    neck_r = 0.075
    yoke_rows = 3
    extra = []
    base_n = len(verts)
    for k in range(1, yoke_rows + 1):
        f = k / yoke_rows
        for j in range(cols):
            jj = j % seg
            t = thetas[jj] if j < seg else 2 * math.pi
            r0 = R[0, jj]
            c = centers[0] * (1 - f) + neck_c * f
            r = r0 * (1 - f) + neck_r * f
            x = c[0] + r * math.sin(t)
            y = c[1] - r * math.cos(t)
            zz = neck_z + 0.012 * math.sin(f * math.pi * 0.5) + (0.004 if f == 1 else 0)
            verts.append((x, y, zz))
            uvs.append((t / (2 * math.pi), top + 0.05 * f))
    rows = nz + yoke_rows
    # reorder: yoke rows first (top), then body rows -> simplest: build faces manually
    me_rows = [list(range(base_n + (yoke_rows - 1 - k) * cols, base_n + (yoke_rows - k) * cols)) for k in range(yoke_rows)]
    me_rows += [list(range(i * cols, (i + 1) * cols)) for i in range(nz)]
    faces = []
    for i in range(len(me_rows) - 1):
        A, B = me_rows[i], me_rows[i + 1]
        for j in range(cols - 1):
            faces.append((A[j], B[j], B[j + 1], A[j + 1]))
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    uvl = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li in poly.loop_indices:
            uvl.data[li].uv = uvs[me.loops[li].vertex_index]
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    # weights: torso from the body, skirt blended towards a smooth hips/legs scheme
    P = np.array(verts)
    Wb = nearest_weights(body, P, torso_mask | body.mask(include=['LeftUpLeg', 'RightUpLeg', 'Hips'], thr=0.3))
    Ws = skirt_weights(body, P, hip_z, hem)
    a = np.clip((hip_z + 0.04 - P[:, 2]) / 0.12, 0, 1)
    W = blend_weights(Wb, Ws, a)
    # keep the torso shell away from the arm bones (they would drag the cloth)
    for b in ARM_BONES:
        W[:, body.bi[b]] = 0
    assign_weights(ob, body, W)
    set_material(ob, material)
    parts = [ob]
    if sleeves:
        for side in ('Left', 'Right'):
            parts.append(make_sleeve(body, side, length=0.62 if sleeves == 'short' else 1.08, material=material))
    return parts


def make_sleeve(body, side, length=1.0, seg=20, ease=0.012, material='cloth'):
    a = body.joint[side + 'Arm']
    b = body.tail[side + 'Arm']
    axis = b - a
    L = np.linalg.norm(axis)
    ax = axis / L
    # orthonormal frame around the arm axis
    up = np.array([0, 0, 1.0])
    u = np.cross(ax, up)
    u /= np.linalg.norm(u)
    v = np.cross(u, ax)
    arm_mask = body.mask(include=[side + 'Arm', side + 'Shoulder'], thr=0.35)
    co = body.co[arm_mask]
    rel = co - a
    t_par = rel @ ax
    thetas = np.linspace(0, 2 * math.pi, seg, endpoint=False)
    ts = np.linspace(-0.04, length, 12)
    rings = []
    for t in ts:
        m = np.abs(t_par - t * L) < 0.03
        pts = rel[m]
        if len(pts) >= 3:
            p2 = np.stack([pts @ u, pts @ v], 1)
            r = _hull_radius(p2, np.zeros(2), thetas)
        else:
            r = None
        if r is None:
            r = rings[-1].copy() if rings else np.full(seg, 0.05)
        rings.append(np.clip(r, 0.035, 0.075))
    R = _smooth_rows(np.array([_smooth_circular(r) for r in rings]), 2)
    verts, uvs = [], []
    for i, t in enumerate(ts):
        flare = 1 + 0.18 * max(0, (t - (length - 0.35)) / 0.35)
        for j in range(seg + 1):
            jj = j % seg
            th = thetas[jj]
            r = (R[i, jj] + ease) * flare
            p = a + ax * (t * L) + (u * math.cos(th) + v * math.sin(th)) * r
            verts.append(tuple(p))
            uvs.append((j / seg, 2.0 + t * L))
    cols = seg + 1
    faces = []
    for i in range(len(ts) - 1):
        for j in range(seg):
            A = i * cols + j
            faces.append((A, A + 1, A + cols + 1, A + cols))
    me = bpy.data.meshes.new('sleeve' + side)
    me.from_pydata(verts, [], faces)
    me.update()
    uvl = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li in poly.loop_indices:
            uvl.data[li].uv = uvs[me.loops[li].vertex_index]
    ob = bpy.data.objects.new('sleeve' + side, me)
    bpy.context.scene.collection.objects.link(ob)
    P = np.array(verts)
    W = np.zeros((len(P), len(body.bones)), np.float32)
    tt = ((P - a) @ ax) / L
    for n, t in enumerate(tt):
        sh = np.clip((0.15 - t) / 0.3, 0, 1)
        W[n, body.bi[side + 'Arm']] = 1 - sh * 0.6
        W[n, body.bi['Spine1']] += sh * 0.6
        if t > 0.92:
            W[n, body.bi[side + 'ForeArm']] += (t - 0.92) / 0.2
    assign_weights(ob, body, W)
    set_material(ob, material)
    return ob


def paint_sleeves(bm, base, body, length, mat_index):
    """Upper-arm body faces become the garment's sleeves: they get the cloth material
    and garment-space UVs (theta / 2pi, 2 + distance along the arm), so the sleeve
    deforms exactly like the arm."""
    uv_layer = bm.loops.layers.uv.active
    sel = body.weight_of(['LeftArm', 'RightArm', 'LeftShoulder', 'RightShoulder'])
    for side in ('Left', 'Right'):
        a = body.joint[side + 'Arm']
        b = body.tail[side + 'Arm']
        ax = (b - a) / np.linalg.norm(b - a)
        L = np.linalg.norm(b - a)
        up = np.array([0, 0, 1.0])
        u = np.cross(ax, up)
        u /= np.linalg.norm(u)
        v = np.cross(u, ax)
        sgn = 1 if side == 'Left' else -1
        for f in bm.faces:
            idx = [vv.index for vv in f.verts]
            if not all(body.in_body[i] for i in idx):
                continue
            c = body.co[idx].mean(0)
            if sgn * c[0] < 0.05:
                continue
            arm_w = sel[idx].mean()
            t = ((c - a) @ ax) / L
            if arm_w < 0.45 or t > length or t < -0.25:
                continue
            f.material_index = mat_index
            for loop in f.loops:
                p = body.co[loop.vert.index]
                rel = p - a
                tt = (rel @ ax) / L
                th = math.atan2(rel @ v, rel @ u)
                loop[uv_layer].uv = ((th / (2 * math.pi)) % 1.0, 2.0 + tt * L)


def delete_covered_body(base, body, keep_fn, paint=None):
    """Deletes body faces whose vertices all fail keep_fn(vertex index)."""
    bm = bmesh.new()
    bm.from_mesh(base.data)
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    if paint:
        paint(bm)
    keep = np.array([keep_fn(i) for i in range(len(bm.verts))])
    dead = [f for f in bm.faces if not any(keep[v.index] for v in f.verts)]
    bmesh.ops.delete(bm, geom=dead, context='FACES')
    bm.to_mesh(base.data)
    bm.free()
    base.data.update()
