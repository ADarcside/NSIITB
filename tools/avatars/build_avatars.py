"""
Namma Space multiplayer: builds the five original cartoon characters in Blender.

Run headless (no Blender window needed):
    pip install bpy==5.2.3            # or use Blender's own Python
    python tools/avatars/build_avatars.py            # all characters
    python tools/avatars/build_avatars.py kid robot  # some
Or inside Blender: Scripting tab > open this file > Run Script.

Writes for each character:
    viewer/src/avatars/models/<id>.glb      loaded by the viewer
    multiplayer/avatars-src/<id>.blend      open and edit in Blender, then File > Export > glTF 2.0
    multiplayer/avatars-src/<id>.png        preview render (only with --preview, needs a display)
Part names and material names the viewer relies on are listed in viewer/src/avatars/models/AVATARS.md.
Characters face -Y in Blender (front view, numpad 1), which the glTF exporter turns into +Z.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
GLB_DIR = ROOT / "viewer" / "src" / "avatars" / "models"
SRC_DIR = ROOT / "multiplayer" / "avatars-src"

# Default colours; the viewer recolours main / second / accent per player
PALETTES = {
    "kid": {"main": "#e63946", "second": "#f1c453", "accent": "#2b59c3"},
    "robot": {"main": "#4cc9f0", "second": "#f8f9fa", "accent": "#ffb703"},
    "hero": {"main": "#7b2cbf", "second": "#ffd60a", "accent": "#ef233c"},
    "ninja": {"main": "#2b2d42", "second": "#e63946", "accent": "#8d99ae"},
    "critter": {"main": "#f4a261", "second": "#fff1d6", "accent": "#e76f51"},
}
FIXED = {"skin": "#f2c9a0", "dark": "#1d1b22", "white": "#ffffff", "glow": "#7df9ff", "blush": "#ff8fa3"}


def hex_rgba(h: str) -> tuple[float, float, float, float]:
    h = h.lstrip("#")
    srgb = [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (lin[0], lin[1], lin[2], 1.0)


def reset() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


_mats: dict[str, bpy.types.Material] = {}


def material(name: str, color: str, emissive: bool = False) -> bpy.types.Material:
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = hex_rgba(color)
    bsdf.inputs["Roughness"].default_value = 0.8
    if emissive:
        bsdf.inputs["Emission Color"].default_value = hex_rgba(color)
        bsdf.inputs["Emission Strength"].default_value = 1.0
    m.diffuse_color = hex_rgba(color)
    return m


def setup_materials(palette: dict[str, str]) -> dict[str, bpy.types.Material]:
    mats = {k: material(k, v) for k, v in palette.items()}
    for k, v in FIXED.items():
        mats[k] = material(k, v, emissive=(k == "glow"))
    return mats


def empty(name: str, loc, parent=None) -> bpy.types.Object:
    o = bpy.data.objects.new(name, None)
    o.empty_display_type = "PLAIN_AXES"
    o.empty_display_size = 0.05
    bpy.context.scene.collection.objects.link(o)
    if parent is not None:
        # loc is a world position; pivots never rotate at build time, so subtract the parent's
        bpy.context.view_layer.update()
        o.parent = parent
        o.location = Vector(loc) - parent.matrix_world.translation
    else:
        o.location = loc
    return o


def finish(o: bpy.types.Object, mat, parent, name: str, smooth=True, bevel=0.0, subsurf=0) -> bpy.types.Object:
    o.name = name
    o.data.name = name
    o.data.materials.clear()
    o.data.materials.append(mat)
    if bevel > 0:
        b = o.modifiers.new("bevel", "BEVEL")
        b.width = bevel
        b.segments = 3
    if subsurf:
        s = o.modifiers.new("subsurf", "SUBSURF")
        s.levels = subsurf
        s.render_levels = subsurf
    if smooth:
        for p in o.data.polygons:
            p.use_smooth = True
    # Keep the world transform while parenting to a pivot (update first: matrix_world lags edits)
    bpy.context.view_layer.update()
    world = o.matrix_world.copy()
    o.parent = parent
    o.matrix_world = world
    return o


def sphere(name, mat, parent, loc, r, scale=(1, 1, 1), seg=20, rings=12):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=rings, radius=r, location=loc)
    o = bpy.context.active_object
    o.scale = scale
    return finish(o, mat, parent, name)


def box(name, mat, parent, loc, size, bevel=0.02, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(o, mat, parent, name, smooth=True, bevel=bevel)


def cyl(name, mat, parent, loc, r, depth, rot=(0, 0, 0), verts=16, r2=None):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=depth, location=loc, rotation=rot)
    o = bpy.context.active_object
    return finish(o, mat, parent, name)


def capsule(name, mat, parent, top, bottom, r):
    """Rounded limb from top to bottom (world points)."""
    top, bottom = Vector(top), Vector(bottom)
    mid = (top + bottom) / 2
    length = (top - bottom).length
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=r, location=mid)
    o = bpy.context.active_object
    o.scale = (1, 1, max(1.0, (length / 2 + r) / r))
    direction = (top - bottom).normalized()
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(direction)
    return finish(o, mat, parent, name)


def smile(name, mat, parent, loc, r, thickness):
    """Lower half of a ring facing -Y: a grin."""
    import bmesh

    bpy.ops.mesh.primitive_torus_add(major_radius=r, minor_radius=thickness, major_segments=24, minor_segments=8, location=(0, 0, 0), rotation=(math.radians(90), 0, 0))
    o = bpy.context.active_object
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.y > 0.2 * r], context="VERTS")
    bm.to_mesh(o.data)
    bm.free()
    o.location = loc
    return finish(o, mat, parent, name)


def eyes(head, m, y_front, z, spread, size=0.055, pupil=0.032):
    for side, sx in (("L", 1), ("R", -1)):
        sphere(f"eye_white_{side}", m["white"], head, (sx * spread, y_front, z), size, scale=(1, 0.45, 1.15), seg=14, rings=8)
        sphere(f"pupil_{side}", m["dark"], head, (sx * spread, y_front - size * 0.42, z - 0.005), pupil, scale=(1, 0.5, 1.1), seg=12, rings=6)
        sphere(f"shine_{side}", m["white"], head, (sx * spread + 0.012, y_front - size * 0.55, z + 0.015), pupil * 0.35, seg=8, rings=4)


def limbs(root, body, m, arm_mat, hand_mat, leg_mat, shoe_mat, hip_z=0.3, shoulder_z=0.55, shoulder_x=0.2, hip_x=0.085):
    for side, sx in (("L", 1), ("R", -1)):
        arm = empty(f"arm_{side}", (sx * shoulder_x, 0, shoulder_z), body)
        capsule(f"arm_{side}_mesh", arm_mat, arm, (sx * shoulder_x, 0, shoulder_z), (sx * (shoulder_x + 0.03), 0, shoulder_z - 0.2), 0.055)
        sphere(f"hand_{side}", hand_mat, arm, (sx * (shoulder_x + 0.035), 0, shoulder_z - 0.25), 0.058, seg=12, rings=8)
        leg = empty(f"leg_{side}", (sx * hip_x, 0, hip_z), root)
        capsule(f"leg_{side}_mesh", leg_mat, leg, (sx * hip_x, 0, hip_z), (sx * hip_x, 0, 0.08), 0.065)
        box(f"shoe_{side}", shoe_mat, leg, (sx * hip_x, -0.03, 0.04), (0.12, 0.19, 0.08), bevel=0.03)


def base_rig():
    root = empty("avatar", (0, 0, 0))
    body = empty("body", (0, 0, 0.3), root)
    return root, body


# ---------------------------------------------------------------------------------------------
# Characters (all original designs)
# ---------------------------------------------------------------------------------------------


def build_kid(m):
    root, body = base_rig()
    # Oversized t-shirt and shorts
    sphere("torso", m["main"], body, (0, 0, 0.45), 0.17, scale=(1.05, 0.85, 1.05))
    cyl("shorts", m["accent"], body, (0, 0, 0.32), 0.16, 0.1, r2=0.15)
    head = empty("head", (0, 0, 0.6), body)
    sphere("head_mesh", m["skin"], head, (0, 0, 0.8), 0.25, scale=(1.05, 1, 0.95), seg=24, rings=16)
    eyes(head, m, -0.225, 0.82, 0.085)
    # Cheeky grin and ears
    grin = smile("grin", m["dark"], head, (0.01, -0.235, 0.75), 0.07, 0.014)
    for side, sx in (("L", 1), ("R", -1)):
        sphere(f"ear_{side}", m["skin"], head, (sx * 0.255, 0, 0.8), 0.05, scale=(0.5, 1, 1))
    # Spiky hair
    for i, (x, y, z, rx, ry) in enumerate(
        [(0, 0.02, 1.04, 0, 0), (0.1, 0.02, 1.01, 0, 0.5), (-0.1, 0.02, 1.01, 0, -0.5), (0.17, 0.05, 0.94, 0, 0.9), (-0.17, 0.05, 0.94, 0, -0.9), (0, 0.15, 0.98, -0.7, 0), (0.08, -0.12, 0.99, 0.5, 0.3), (-0.08, -0.12, 0.99, 0.5, -0.3)]
    ):
        cyl(f"hair_{i}", m["dark"], head, (x, y, z), 0.06, 0.16, rot=(rx, ry, 0), verts=8, r2=0.0)
    sphere("hair_cap", m["dark"], head, (0, 0.02, 0.88), 0.245, scale=(1.05, 1.02, 0.75))
    limbs(root, body, m, m["main"], m["skin"], m["skin"], m["second"])
    empty("hat_socket", (0, 0, 1.02), head)
    return root


def build_robot(m):
    root, body = base_rig()
    box("torso", m["main"], body, (0, 0, 0.45), (0.36, 0.28, 0.3), bevel=0.05)
    box("chest_panel", m["second"], body, (0, -0.14, 0.46), (0.2, 0.02, 0.14), bevel=0.01)
    for i, x in enumerate((-0.05, 0, 0.05)):
        sphere(f"light_{i}", m["accent"], body, (x, -0.155, 0.48), 0.018, seg=8, rings=4)
    head = empty("head", (0, 0, 0.6), body)
    box("head_mesh", m["second"], head, (0, 0, 0.8), (0.44, 0.36, 0.34), bevel=0.07)
    box("screen", m["dark"], head, (0, -0.175, 0.8), (0.34, 0.02, 0.22), bevel=0.03)
    for side, sx in (("L", 1), ("R", -1)):
        box(f"eye_{side}", m["glow"], head, (sx * 0.08, -0.19, 0.82), (0.07, 0.01, 0.08), bevel=0.02)
        cyl(f"bolt_{side}", m["accent"], head, (sx * 0.23, 0, 0.8), 0.04, 0.04, rot=(0, math.pi / 2, 0), verts=12)
    box("mouth", m["glow"], head, (0, -0.19, 0.74), (0.12, 0.01, 0.02), bevel=0.005)
    cyl("antenna", m["dark"], head, (0, 0, 1.03), 0.012, 0.12, verts=8)
    sphere("antenna_ball", m["accent"], head, (0, 0, 1.1), 0.035, seg=12, rings=8)
    limbs(root, body, m, m["second"], m["accent"], m["second"], m["main"], shoulder_x=0.22)
    empty("hat_socket", (0, 0, 0.97), head)
    return root


def build_hero(m):
    root, body = base_rig()
    sphere("torso", m["main"], body, (0, 0, 0.45), 0.16, scale=(1.05, 0.85, 1.1))
    cyl("belt", m["second"], body, (0, 0, 0.33), 0.15, 0.04)
    # Star emblem
    bpy.ops.mesh.primitive_circle_add(vertices=10, radius=0.06, fill_type="TRIFAN", location=(0, -0.14, 0.48), rotation=(math.radians(90), 0, 0))
    star = bpy.context.active_object
    for i, v in enumerate(star.data.vertices):
        if i < 10 and i % 2 == 1:
            v.co *= 0.45
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.extrude_region_move(TRANSFORM_OT_translate={"value": (0, -0.012, 0)})
    bpy.ops.object.mode_set(mode="OBJECT")
    finish(star, m["accent"], body, "emblem", smooth=False)
    # Short cape
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0.15, 0.4), rotation=(math.radians(80), 0, 0))
    cape = bpy.context.active_object
    cape.scale = (0.32, 0.36, 1)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    sol = cape.modifiers.new("solid", "SOLIDIFY")
    sol.thickness = 0.015
    finish(cape, m["accent"], body, "cape", smooth=False)
    head = empty("head", (0, 0, 0.6), body)
    sphere("helmet", m["second"], head, (0, 0, 0.8), 0.25, scale=(1, 1, 1.0), seg=24, rings=16)
    box("visor", m["dark"], head, (0, -0.2, 0.82), (0.3, 0.12, 0.1), bevel=0.04)
    sphere("visor_shine", m["glow"], head, (0.07, -0.26, 0.845), 0.018, scale=(2, 0.5, 0.7), seg=8, rings=4)
    cyl("helmet_fin", m["accent"], head, (0, 0.02, 1.04), 0.03, 0.06, verts=8)
    limbs(root, body, m, m["main"], m["second"], m["main"], m["second"])
    empty("hat_socket", (0, 0, 1.03), head)
    return root


def build_ninja(m):
    root, body = base_rig()
    sphere("torso", m["main"], body, (0, 0, 0.45), 0.16, scale=(1.0, 0.85, 1.05))
    cyl("sash", m["second"], body, (0, 0, 0.34), 0.155, 0.05)
    box("sash_knot", m["second"], body, (0.08, -0.14, 0.34), (0.06, 0.03, 0.06), bevel=0.01)
    head = empty("head", (0, 0, 0.6), body)
    sphere("hood", m["main"], head, (0, 0, 0.8), 0.25, seg=24, rings=16)
    # Eye slit in skin colour, set slightly in front of the hood
    sphere("face_slit", m["skin"], head, (0, -0.2, 0.83), 0.1, scale=(1.75, 0.5, 0.55))
    eyes(head, m, -0.245, 0.835, 0.075, size=0.045, pupil=0.028)
    # Headband with two tails at the back
    cyl("headband", m["second"], head, (0, 0, 0.92), 0.252, 0.05, verts=24)
    for i, (x, rz) in enumerate(((0.04, 0.35), (-0.04, -0.35))):
        box(f"headband_tail_{i}", m["second"], head, (x, 0.3, 0.88), (0.04, 0.16, 0.012), bevel=0.004, rot=(0.6, 0, rz))
    # Scarf
    bpy.ops.mesh.primitive_torus_add(major_radius=0.13, minor_radius=0.04, location=(0, 0, 0.6))
    scarf = bpy.context.active_object
    finish(scarf, m["accent"], head, "scarf")
    limbs(root, body, m, m["main"], m["main"], m["main"], m["dark"])
    empty("hat_socket", (0, 0, 1.03), head)
    return root


def build_critter(m):
    root, body = base_rig()
    sphere("torso", m["main"], body, (0, 0, 0.45), 0.18, scale=(1.0, 0.9, 1.0))
    sphere("belly", m["second"], body, (0, -0.1, 0.43), 0.12, scale=(1, 0.5, 1.1))
    head = empty("head", (0, 0, 0.6), body)
    sphere("head_mesh", m["main"], head, (0, 0, 0.8), 0.25, scale=(1.08, 1, 0.92), seg=24, rings=16)
    sphere("muzzle", m["second"], head, (0, -0.17, 0.74), 0.1, scale=(1.3, 0.8, 0.8))
    sphere("nose", m["dark"], head, (0, -0.25, 0.77), 0.025, seg=10, rings=6)
    eyes(head, m, -0.215, 0.85, 0.095)
    for side, sx in (("L", 1), ("R", -1)):
        sphere(f"cheek_{side}", m["blush"], head, (sx * 0.16, -0.17, 0.76), 0.035, scale=(1, 0.4, 0.7), seg=10, rings=6)
        cyl(f"ear_{side}", m["main"], head, (sx * 0.15, 0, 1.06), 0.09, 0.22, rot=(0, -sx * 0.35, 0), verts=12, r2=0.0)
        cyl(f"ear_inner_{side}", m["accent"], head, (sx * 0.145, -0.03, 1.04), 0.05, 0.15, rot=(0, -sx * 0.35, 0), verts=10, r2=0.0)
    # Bushy tail
    sphere("tail", m["main"], root, (0, 0.24, 0.42), 0.12, scale=(0.8, 1.6, 0.8))
    sphere("tail_tip", m["second"], root, (0, 0.4, 0.5), 0.08)
    limbs(root, body, m, m["main"], m["second"], m["main"], m["accent"], shoulder_x=0.18)
    empty("hat_socket", (0, 0, 1.0), head)
    return root


BUILDERS = {"kid": build_kid, "robot": build_robot, "hero": build_hero, "ninja": build_ninja, "critter": build_critter}


def render_preview(path: Path) -> None:
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new("preview_cam")
    cam = bpy.data.objects.new("preview_cam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (1.4, -2.6, 1.1)
    direction = Vector((0, 0, 0.55)) - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    cam_data.lens = 50
    scene.camera = cam
    light_data = bpy.data.lights.new("preview_sun", "SUN")
    light_data.energy = 3.5
    light = bpy.data.objects.new("preview_sun", light_data)
    light.rotation_euler = (math.radians(50), 0, math.radians(30))
    scene.collection.objects.link(light)
    world = bpy.data.worlds.new("preview_world")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.05, 0.06, 0.1, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.2
    scene.world = world
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_object_outline = True
    scene.display.shading.object_outline_color = (0.05, 0.04, 0.06)
    scene.render.resolution_x = 512
    scene.render.resolution_y = 640
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    # Preview helpers are not part of the character
    for o in (cam, light):
        bpy.data.objects.remove(o, do_unlink=True)


def build(char: str, preview: bool = False) -> None:
    reset()
    mats = setup_materials(PALETTES[char])
    BUILDERS[char](mats)
    GLB_DIR.mkdir(parents=True, exist_ok=True)
    SRC_DIR.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_DIR / f"{char}.glb"),
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_extras=True,  # custom properties such as noOutline reach the viewer
        export_cameras=False,
        export_lights=False,
    )
    bpy.ops.wm.save_as_mainfile(filepath=str(SRC_DIR / f"{char}.blend"), compress=True)
    if preview:
        # Needs a GPU/display (EEVEE/Workbench); the viewer's own previews come from scripts instead
        render_preview(SRC_DIR / f"{char}.png")
    tris = sum(len(o.evaluated_get(bpy.context.evaluated_depsgraph_get()).data.loop_triangles) for o in bpy.data.objects if o.type == "MESH")
    print(f"[avatars] {char}: {tris} triangles -> {GLB_DIR / (char + '.glb')}")


def main(argv: list[str]) -> None:
    chars = [a for a in argv if a in BUILDERS] or list(BUILDERS)
    for c in chars:
        build(c, preview="--preview" in argv)


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    main(args)
