# World-space retargeting of CMU (MotionBuilder-friendly) BVH clips onto the
# MPFB "cmu_mb" rig. Both skeletons share joint names; their rest poses differ
# (BVH rest = T-pose, MakeHuman rest = A-pose), so the target is first given a
# reference pose whose bones point along the source rest directions:
#
#   T_ref[b]   = R_min(dir_T_rest[b] -> dir_S_rest[b]) * T_rest[b]       (world)
#   T_world(t) = S_world(t) * S_rest^-1 * T_ref                          (world)
#
# and the local bases are solved analytically down the hierarchy.

import math
import bpy
from mathutils import Matrix, Quaternion, Vector

NAME_MAP = {'LeftHandFinger1': 'LeftHandIndex1', 'RightHandFinger1': 'RightHandIndex1'}
HAND_LOCK = {}


def import_bvh(path):
    before = set(bpy.data.objects)
    bpy.ops.import_anim.bvh(filepath=path, global_scale=1.0, frame_start=1, use_fps_scale=False,
                            update_scene_fps=False, update_scene_duration=False, rotate_mode='NATIVE',
                            axis_forward='-Z', axis_up='Y')
    new = [o for o in bpy.data.objects if o not in before and o.type == 'ARMATURE']
    return new[0]


def _rot(m):
    return m.to_3x3().normalized()


class Retarget:
    def __init__(self, src, tgt):
        self.src, self.tgt = src, tgt
        sw, tw = src.matrix_world, tgt.matrix_world
        self.order = []  # target bones, parents first

        def walk(b):
            self.order.append(b.name)
            # spine and neck first: arm IK targets may follow the head
            for c in sorted(b.children, key=lambda c: 0 if c.name.startswith(('LowerBack', 'Spine', 'Neck', 'Head')) else 1):
                walk(c)
        for b in tgt.data.bones:
            if b.parent is None:
                walk(b)

        self.S_rest = {}
        for b in src.data.bones:
            self.S_rest[b.name] = sw @ b.matrix_local
        self.T_rest = {b.name: tw @ b.matrix_local for b in tgt.data.bones}
        # Bone directions are taken from the head to the single child's head: BVH
        # bones with several children (Hips, Spine1, hands) or none have no
        # meaningful direction and inherit the alignment of their parent.
        self.T_ref = {}
        q_align = {}
        inv_map = {v: k for k, v in NAME_MAP.items()}

        def child_dir(arm_obj, bone, mapper):
            kids = list(bone.children)
            if len(kids) != 1:
                return None, None
            d = arm_obj.matrix_world.to_3x3() @ (kids[0].head_local - bone.head_local)
            return (d if d.length > 1e-6 else None), mapper(kids[0].name)

        for name in self.order:
            tb = tgt.data.bones[name]
            sname = NAME_MAP.get(name, name)
            tr = _rot(self.T_rest[name])
            q = None
            if sname in src.data.bones:
                sb = src.data.bones[sname]
                td, tchild = child_dir(tgt, tb, lambda n: NAME_MAP.get(n, n))
                sd, schild = child_dir(src, sb, lambda n: n)
                if td is not None and sd is not None and tchild == schild:
                    q = td.normalized().rotation_difference(sd.normalized())
            if name in ('Head',):
                q = Quaternion()  # both rest poses look straight ahead
            if q is None:
                q = q_align[tb.parent.name] if tb.parent is not None else Quaternion()
            q_align[name] = q
            self.T_ref[name] = q.to_matrix() @ tr
        # leg length ratio for root motion
        sh = (sw @ src.data.bones['Hips'].head_local).z - min((sw @ b.head_local).z for b in src.data.bones)
        th = (tw @ tgt.data.bones['Hips'].head_local).z - min((tw @ b.head_local).z for b in tgt.data.bones)
        self.scale = th / max(sh, 1e-6)
        self.src_hips_rest = (sw @ src.data.bones['Hips'].head_local)
        self.tgt_hips_rest = (tw @ tgt.data.bones['Hips'].head_local)

    def sample_source(self, frame):
        bpy.context.scene.frame_set(frame)
        sw = self.src.matrix_world
        out = {}
        for pb in self.src.pose.bones:
            out[pb.name] = sw @ pb.matrix
        return out

    def solve(self, S_pose, root_offset, ik=None, t=0.0):
        """Returns {bone: matrix_basis} for the target given sampled source world matrices.
        ik: {'Left'|'Right': (target_fn(ctx, t) -> world wrist pos, pole Vector)} overrides the arms
        with an analytic two-bone IK (minimal rotations from the mocap pose keep its twist)."""
        tgt = self.tgt
        twi = tgt.matrix_world.inverted()
        tw = tgt.matrix_world
        pose_arm = {}
        basis = {}
        world_rot = {}
        ik_rot = {}
        for name in self.order:
            b = tgt.data.bones[name]
            sname = NAME_MAP.get(name, name)
            if sname in S_pose:
                D = _rot(S_pose[sname]) @ _rot(self.S_rest[sname]).inverted()
            else:
                p = b.parent
                D = None
                while p is not None and D is None:
                    ps = NAME_MAP.get(p.name, p.name)
                    if ps in S_pose:
                        D = _rot(S_pose[ps]) @ _rot(self.S_rest[ps]).inverted()
                    p = p.parent
                if D is None:
                    D = Matrix.Identity(3)
            Rw = D @ self.T_ref[name]
            if b.parent is None:
                pos = twi @ root_offset  # absolute world hips position
            else:
                pp = pose_arm[b.parent.name]
                rel = b.parent.matrix_local.inverted() @ b.matrix_local
                pos = (pp @ rel).to_translation()
            if ik:
                for side, (target_fn, pole) in ik.items():
                    ua, fa, hand = side + 'Arm', side + 'ForeArm', side + 'Hand'
                    if name == ua:
                        S = tw @ pos
                        bones = tgt.data.bones
                        l1 = (bones[fa].head_local - bones[ua].head_local).length
                        l2 = (bones[hand].head_local - bones[fa].head_local).length
                        ctx = dict(hips=tw @ pose_arm['Hips'].to_translation(), shoulder=S,
                                   head=(tw @ pose_arm['Head'].to_translation()) if 'Head' in pose_arm else S)
                        W = target_fn(ctx, t)
                        d = W - S
                        dl = min(max(d.length, 1e-4), (l1 + l2) * 0.999)
                        dn = d.normalized()
                        W = S + dn * dl
                        # elbow in the plane of (d, pole)
                        pv = (pole - dn * pole.dot(dn))
                        pv = pv.normalized() if pv.length > 1e-6 else Vector((0, 0, -1))
                        a = (l1 * l1 + dl * dl - l2 * l2) / (2 * dl)
                        h = math.sqrt(max(l1 * l1 - a * a, 0.0))
                        E = S + dn * a + pv * h
                        # upper arm: minimal rotation from the mocap direction
                        y0 = Rw.col[1].normalized()
                        q1 = y0.rotation_difference((E - S).normalized())
                        Rua = q1.to_matrix() @ Rw
                        ik_rot[ua] = Rua
                        ik_rot['_' + side] = (q1, E, W)
                    elif name == fa and '_' + side in ik_rot:
                        q1, E, W = ik_rot['_' + side]
                        R0 = q1.to_matrix() @ Rw
                        y0 = R0.col[1].normalized()
                        q2 = y0.rotation_difference((W - E).normalized())
                        ik_rot[fa] = q2.to_matrix() @ R0
                    elif name == hand and fa in ik_rot:
                        # the hand keeps one world orientation for the whole clip, so a
                        # held spear or standard stays upright while the arm moves
                        # shared by every clip that uses the same IK target (march_spear and
                        # idle_spear hold the same spear, which is bound to the hand)
                        key = (id(target_fn), side)
                        if key not in HAND_LOCK:
                            HAND_LOCK[key] = ik_rot[fa] @ (self.T_ref[fa].inverted() @ self.T_ref[hand])
                        ik_rot[hand] = HAND_LOCK[key].copy()
                if name in ik_rot:
                    Rw = ik_rot[name]
            Ra = twi.to_3x3() @ Rw  # armature space rotation
            M = Matrix.LocRotScale(pos, Ra.to_quaternion(), Vector((1, 1, 1)))
            pose_arm[name] = M
            if b.parent is None:
                basis[name] = b.matrix_local.inverted() @ M
            else:
                rel = b.parent.matrix_local.inverted() @ b.matrix_local
                basis[name] = rel.inverted() @ pose_arm[b.parent.name].inverted() @ M
        return basis

    def facing_yaw(self, frames):
        """Yaw (about world Z) that turns the motion so the character faces -Y."""
        S0 = self.sample_source(frames[0])
        S1 = self.sample_source(frames[-1])
        v = S1['Hips'].to_translation() - S0['Hips'].to_translation()
        v.z = 0
        if v.length > 0.25 * (1 / max(self.scale, 1e-6)) * 0.3:  # walking: face the travel direction
            d = v.normalized()
        else:  # standing: face where the pelvis faces on average
            d = Vector()
            for f in frames[:: max(1, len(frames) // 8)]:
                S = self.sample_source(f)
                D = _rot(S['Hips']) @ _rot(self.S_rest['Hips']).inverted()
                d += D @ Vector((0, -1, 0))
            d.z = 0
            d.normalize()
        ang = math.atan2(d.x, -d.y)  # angle from -Y to d
        return Matrix.Rotation(-ang, 4, 'Z')

    def bake(self, action_name, frames, in_place=True, loop_blend=0, yaw=None, overrides=None, ik=None):
        """frames: source frame numbers (one key each). overrides(i, basis) may edit bases."""
        tgt = self.tgt
        tgt.animation_data_create()
        act = bpy.data.actions.new(action_name)
        act.use_fake_user = True
        tgt.animation_data.action = act
        for pb in tgt.pose.bones:
            pb.rotation_mode = 'QUATERNION'
        if yaw is None:
            yaw = self.facing_yaw(frames)
        samples = []
        for f in frames:
            S = self.sample_source(f)
            S = {k: yaw @ v for k, v in S.items()}
            off = S['Hips'].to_translation() * self.scale
            samples.append((S, off))
        n = len(samples)
        if in_place and n > 1:
            p0, p1 = samples[0][1].copy(), samples[-1][1].copy()
            if loop_blend == 0 and n > 2:
                # frames are one full cycle [f0, f_end): extrapolate the end point by one step
                p1 = p0 + (p1 - p0) * (n / (n - 1))
            for i, (S, off) in enumerate(samples):
                t = i / n if loop_blend == 0 else i / (n - 1)
                trend = p0.lerp(p1, t)
                off.x -= trend.x
                off.y -= trend.y
        bases = [self.solve(S, off, ik=ik, t=i / max(1, n)) for i, (S, off) in enumerate(samples)]
        if overrides:
            for i, basis in enumerate(bases):
                overrides(i, n, basis)
        if loop_blend > 0 and n > 2 * loop_blend:
            for k in range(loop_blend):
                w = (k + 1) / (loop_blend + 1)
                i = n - loop_blend + k
                for name, M in bases[i].items():
                    B = bases[0][name]
                    q = M.to_quaternion().slerp(B.to_quaternion(), w)
                    l = M.to_translation().lerp(B.to_translation(), w)
                    bases[i][name] = Matrix.LocRotScale(l, q, Vector((1, 1, 1)))
        prev = {}
        for i, basis in enumerate(bases):
            for name, M in basis.items():
                pb = tgt.pose.bones[name]
                loc, rot, _ = M.decompose()
                if name in prev and prev[name].dot(rot) < 0:
                    rot.negate()
                prev[name] = rot.copy()
                pb.rotation_quaternion = rot
                pb.keyframe_insert('rotation_quaternion', frame=i, group=name)
                if tgt.data.bones[name].parent is None:
                    pb.location = loc
                    pb.keyframe_insert('location', frame=i, group=name)
        return act, n

    def find_cycle(self, start, min_len, max_len, step=1):
        """Finds the source frame (start+min_len..start+max_len) whose pose best matches 'start'."""
        bones = ['LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg', 'LeftArm', 'RightArm', 'LeftFoot', 'RightFoot']

        def feat(f):
            bpy.context.scene.frame_set(f)
            return [self.src.pose.bones[b].matrix.to_quaternion() for b in bones]
        f0 = feat(start)
        best, best_f = 1e9, start + min_len
        for f in range(start + min_len, start + max_len + 1, step):
            ff = feat(f)
            d = sum(1 - abs(a.dot(b)) for a, b in zip(f0, ff))
            if d < best:
                best, best_f = d, f
        return best_f, best
