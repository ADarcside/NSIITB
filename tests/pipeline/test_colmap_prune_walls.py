"""Far-camera drop (S03) and the wall finder ignoring furniture inside the walked area (S06)."""

import numpy as np

from pipeline import normalize as nz
from pipeline.colmap_prune import far_cameras, prune_far_cameras
from pipeline.stages.s03_poses import parse_images_txt, parse_points3D_txt


def write_model(d, centres):
    """Identity-rotation cameras at the given centres (t = -c), each seeing points 0..2, plus point 3 seen only
    by the last camera and camera 0."""
    d.mkdir(parents=True)
    (d / "cameras.txt").write_text("1 SIMPLE_RADIAL 100 100 50 50 50 0\n")
    n = len(centres)
    img, frames = ["# images"], ["# frames"]
    for i, c in enumerate(centres, start=1):
        img.append(f"{i} 1 0 0 0 {-c[0]} {-c[1]} {-c[2]} 1 f{i:03d}.jpg")
        pts = "10 10 1 20 20 2 30 30 3" + (" 40 40 4" if i in (1, n) else "")
        img.append(pts)
        frames.append(f"{i} 1 1 CAMERA 1 {i}")
    (d / "images.txt").write_text("\n".join(img) + "\n")
    (d / "frames.txt").write_text("\n".join(frames) + "\n")
    pts = []
    for pid in (1, 2, 3):
        tr = " ".join(f"{i} {pid - 1}" for i in range(1, n + 1))
        pts.append(f"{pid} 0 0 0 128 128 128 0.5 {tr}")
    pts.append(f"4 0 0 0 128 128 128 0.5 1 3 {n} 3")
    (d / "points3D.txt").write_text("\n".join(pts) + "\n")
    (d / "points3D.bin").write_bytes(b"x")


def walk(n=40, seed=0):
    rng = np.random.default_rng(seed)
    return np.c_[rng.uniform(-2, 2, n), rng.uniform(1.2, 1.6, n), rng.uniform(-1, 1, n)]


def test_far_cameras_scale_free():
    c = walk()
    far = np.r_[c, [[300.0, 5, -80]]]
    assert far_cameras(far).tolist() == [False] * len(c) + [True]
    assert far_cameras(far * 0.01).tolist() == far_cameras(far).tolist()
    assert not far_cameras(c).any()


def test_prune_edits_model(tmp_path):
    c = walk()
    model = tmp_path / "colmap" / "sparse" / "0"
    write_model(model, np.r_[c, [[300.0, 5, -80]]])
    st = prune_far_cameras(model)
    n = len(c)
    assert st["far_cameras_dropped"] == 1 and st["cameras_kept"] == n and st["points_dropped"] == 1
    im = parse_images_txt(model / "images.txt")
    pt = parse_points3D_txt(model / "points3D.txt")
    assert len(im) == n and n + 1 not in im and set(pt) == {1, 2, 3}
    assert all(i in im for p in pt.values() for i, _ in p["track"])
    assert all(pid == -1 or pid in pt for v in im.values() for *_, pid in v["points2D"])
    assert not list(model.glob("*.bin"))
    assert (tmp_path / "colmap" / "sparse_unpruned" / "0" / "points3D.bin").exists()
    assert str(n + 1) not in [ln.split()[0] for ln in (model / "frames.txt").read_text().splitlines()[1:]]
    assert prune_far_cameras(model)["far_cameras_dropped"] == 0  # idempotent


def test_prune_refuses_a_broken_model(tmp_path):
    c = walk(20)
    model = tmp_path / "colmap" / "sparse" / "0"
    write_model(model, np.r_[c, np.full((4, 3), 500.0)])
    before = (model / "images.txt").read_text()
    st = prune_far_cameras(model)
    assert st.get("refused") and (model / "images.txt").read_text() == before


def profile(rng):
    """Room 3 shape on one axis: weak real walls at -2.0 and 1.8, a strong cupboard front at 1.1, a strong
    furniture line at 0.1, scattered points between."""
    parts = [rng.normal(-2.0, 0.01, 3000), rng.normal(1.8, 0.01, 3500), rng.normal(1.1, 0.01, 30000),
             rng.normal(0.1, 0.01, 12000), rng.uniform(-2, 1.8, 20000)]
    return np.concatenate(parts)


def test_walls_inside_the_walk_are_replaced():
    v = profile(np.random.default_rng(1))
    old = nz.outer_walls(v, 0.03)
    assert old[0] > -0.5 or old[1] < 1.5  # the old rule takes furniture for a wall
    a, b = nz.outer_walls(v, 0.03, walked=(-1.5, 1.2), clearance=0.15)
    assert abs(a + 2.0) < 0.05 and abs(b - 1.8) < 0.05


def test_walls_outside_the_walk_unchanged():
    rng = np.random.default_rng(2)
    v = np.concatenate([rng.normal(-3.1, 0.01, 20000), rng.normal(3.2, 0.01, 20000), rng.uniform(-3.1, 3.2, 20000),
                        rng.normal(3.6, 0.01, 1500)])  # weak junk past the wall: ignored, wall already clear of the walk
    assert nz.outer_walls(v, 0.03, walked=(-2.5, 2.5), clearance=0.15) == nz.outer_walls(v, 0.03)


def test_long_real_excursion_kept():
    """A big venue: most frames in one area plus a long walk down a corridor (15% of frames) are all real."""
    rng = np.random.default_rng(0)
    c = np.r_[rng.normal(0, 1, (170, 3)), np.c_[np.linspace(3, 12, 30), np.zeros(30), np.zeros(30)]]
    assert not far_cameras(c).any()
