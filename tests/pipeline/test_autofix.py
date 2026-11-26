"""Photo judge (pipeline/autofix.py) on a synthetic wall: a floater the photos do not show goes, real things stay."""

import numpy as np
import pytest
import cv2

from pipeline import autofix as af
from pipeline import floaters as fl

W, H, F = 320, 240, 260.0


def splats(p, s, col, op=1.0):
    p = np.asarray(p, float)
    s = np.broadcast_to(np.asarray(s, float), p.shape).copy()
    q = np.tile([1.0, 0, 0, 0], (len(p), 1))
    return fl.Scene(p, np.full(len(p), op), s, fl.covariances(q, s), np.broadcast_to(np.asarray(col, float), p.shape).copy())


def join(*parts):
    return fl.Scene(*(np.concatenate([getattr(x, k) for x in parts]) for k in ("w", "op", "sc", "cov", "col")))


def wall_room():
    # textured back wall at z = 2 (stripes so a blob is visible against it), a red box on it, a white blob in the air
    u, v = np.meshgrid(np.arange(-2.0, 2.0, 0.02), np.arange(0.0, 2.6, 0.02))
    p = np.stack([u.ravel(), v.ravel(), np.full(u.size, 2.0)], 1)
    stripe = (np.floor(u.ravel() / 0.2) % 2)[:, None]
    wall = splats(p, [0.015, 0.015, 0.002], 0.35 + 0.3 * stripe * np.array([[1, 0.9, 0.7]]))
    bx, by = np.meshgrid(np.arange(-0.3, 0.3, 0.02), np.arange(0.4, 1.0, 0.02))
    box = splats(np.stack([bx.ravel(), by.ravel(), np.full(bx.size, 1.8)], 1), [0.015, 0.015, 0.003], [0.8, 0.15, 0.1])
    rng = np.random.default_rng(1)
    blob = splats(rng.normal([0.9, 1.5, 0.9], [0.06, 0.06, 0.06], (60, 3)), 0.05, [0.95, 0.95, 0.92], op=0.6)
    scene = join(wall, box, blob)
    tag = np.array(["wall"] * len(wall.w) + ["box"] * len(box.w) + ["blob"] * len(blob.w))
    return scene, tag


def cams_facing_wall():
    out = {"frame": "test", "w": W, "h": H, "fx": F, "fy": F, "cx": W / 2, "cy": H / 2, "k1": 0.0, "cams": {}}
    for i, (x, y) in enumerate([(-0.8, 1.3), (-0.3, 1.5), (0.2, 1.2), (0.7, 1.4), (1.1, 1.6), (0.4, 1.7)]):
        c = np.array([x, y, -1.5])
        r = fl.camera(c, c + np.array([0.15 * (0.3 - x), 0.0, 1.0]))
        out["cams"][f"f{i:03d}.png"] = {"c": c, "R": r}
    return out


@pytest.fixture(scope="module")
def result(tmp_path_factory):
    scene, tag = wall_room()
    cams = cams_facing_wall()
    frames = tmp_path_factory.mktemp("frames")
    real = tag != "blob"
    intr = {k: cams[k] for k in ("fx", "fy", "cx", "cy")}
    for name, cam in cams["cams"].items():
        img, a, *_ = af.render_cam(scene, cam, intr, (W, H), keep=real)
        img = np.clip(img * 1.1 + 0.03, 0, 1)            # the phone's own exposure: the judge matches colours first
        cv2.imwrite(str(frames / name), (img[:, :, ::-1] * 255).astype(np.uint8))
    cfg = {"holdout_every": 1, "render_div": 1, "workers": 1, "min_cluster": 5, "blame_pct": 90.0, "min_depth_m": 0.3,
           "min_gain": 1.0}
    keep, report, lab = af.judge(scene, cams, frames, cfg, log=lambda *a: None)
    return scene, tag, keep, report


def test_floater_removed(result):
    scene, tag, keep, report = result
    assert (~keep[tag == "blob"]).mean() > 0.8


def test_real_things_stay(result):
    scene, tag, keep, report = result
    assert keep[tag == "box"].all()
    assert keep[tag == "wall"].mean() > 0.999


def test_report_lists_the_removed_cluster(result):
    scene, tag, keep, report = result
    rem = [c for c in report["clusters"] if c["removed"]]
    assert rem and all(c["gain_pct"] > 0 for c in rem)
    c = max(rem, key=lambda c: c["gaussians"])
    assert np.allclose(c["centre"], [0.9, 1.5, 0.9], atol=0.15)


def test_heldout_names_match_nerfstudio_interval():
    names = [f"frame_{i:06d}.jpg" for i in range(20, 0, -1)]
    assert af.heldout_names(names, 8) == ["frame_000001.jpg", "frame_000009.jpg", "frame_000017.jpg"]


def test_error_ignores_one_pixel_shift():
    rng = np.random.default_rng(0)
    photo = np.zeros((40, 40, 3), np.float32); photo[:, 20:] = 1.0
    shifted = np.roll(photo, 1, axis=1); shifted[:, 0] = photo[:, 0]
    assert af.error_image(shifted, photo, 0.0, 0.02).max() == 0.0
    blob = photo.copy(); blob[5:15, 5:15] = 0.8
    assert af.error_image(blob, photo, 0.0, 0.02)[5:15, 5:15].min() > 0.5


def test_images_txt_with_empty_point_lines(tmp_path):
    p = tmp_path / "images.txt"
    p.write_text("# header\n1 1 0 0 0 0 0 0 1 a.jpg\n\n2 1 0 0 0 1 2 3 1 b.jpg\n\n3 1 0 0 0 0 0 0 1 c.jpg\n1.0 2.0 -1\n")
    im = af.read_images_txt(p)
    assert [v["name"] for v in im.values()] == ["a.jpg", "b.jpg", "c.jpg"]
    assert im[2]["tvec"] == [1.0, 2.0, 3.0]


def test_rebuild_grid_only_frees_cells():
    # a dense floater column at walking height blocks cells; removing it frees them, nothing gets blocked
    from pipeline import grid as navgrid
    rng = np.random.default_rng(2)
    post = splats(rng.normal([1.0, 1.0, 1.0], [0.03, 0.3, 0.03], (400, 3)), 0.02, [0.5, 0.5, 0.5])
    floor = splats(np.c_[rng.uniform(0, 2, 500), np.zeros(500), rng.uniform(0, 2, 500)], 0.02, [0.4, 0.4, 0.4])
    scene = join(floor, post)
    b = {"minX": 0.2, "maxX": 1.8, "minZ": 0.2, "maxZ": 1.8}
    cfg = {"cell_m": 0.05, "agent_radius_m": 0.2}
    free, meta = navgrid.build_free_mask(scene.w, scene.op, b, (0.5, 0.5), cfg)
    grid = {k: meta[k] for k in ("cell_m", "origin", "width", "height", "agent_radius_m")}
    grid["free_bits_b64"] = navgrid.encode_free_bits(free)
    before = np.ones(len(scene.w), bool)
    after = before.copy(); after[len(floor.w):] = False
    new, changed = af.rebuild_grid(scene, before, after, grid, {"bounds_xz": b, "grid_start_xz": [0.5, 0.5]}, 2.6)
    nf = navgrid.decode_free_bits(new["free_bits_b64"], grid["width"], grid["height"])
    assert changed["walk_cells_freed"] > 0
    assert not (free & ~nf).any()          # nothing that was free got blocked
    r, c = navgrid.to_cell(1.0, 1.0, tuple(grid["origin"]), 0.05)
    assert not free[r, c] and nf[r, c]     # the floater's own cell is walkable now
