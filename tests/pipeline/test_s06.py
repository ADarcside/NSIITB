"""
Tests for Stage S06 (normalize). SYNTHETIC data only: a box room with a floor tape pair,
placed in a tilted, rescaled COLMAP frame. S06 must recover floor at y=0, +Y up, metres.
"""

import json
from pathlib import Path

import numpy as np
import pytest

from pipeline import normalize as nz
from pipeline.common import GateFailure
from pipeline.stages.s05_export import EXPECTED_PROPERTIES_ORDER
from pipeline.stages.s06_normalize import run_s06_normalize

TRUE_SCALE = 2.5  # metres per COLMAP unit in the synthetic scene
F, CX, CY, W, H = 800.0, 800.0, 450.0, 1600, 900


def rot_x(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_y(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rotmat_to_qvec(r):
    w = np.sqrt(max(1e-12, 1 + r[0, 0] + r[1, 1] + r[2, 2])) / 2
    return [w, (r[2, 1] - r[1, 2]) / (4 * w), (r[0, 2] - r[2, 0]) / (4 * w), (r[1, 0] - r[0, 1]) / (4 * w)]


def room_points_world(rng):
    """Metric room, +Y up, floor y=0: 4 x 5 m, 2.6 m high."""
    floor = np.c_[rng.uniform(-2, 2, 6000), np.zeros(6000), rng.uniform(-2.5, 2.5, 6000)]
    walls = []
    for x in (-2, 2):
        walls.append(np.c_[np.full(2000, x), rng.uniform(0, 2.6, 2000), rng.uniform(-2.5, 2.5, 2000)])
    for z in (-2.5, 2.5):
        walls.append(np.c_[rng.uniform(-2, 2, 2000), rng.uniform(0, 2.6, 2000), np.full(2000, z)])
    floor[:, 1] += rng.normal(0, 0.004, len(floor))
    return np.vstack([floor] + walls)


def measured_room_points_world(rng):
    """
    Metric room 4.0 (x) x 6.0 (z) x 2.8 m, yawed 7 degrees, with a ceiling, two top-bunk
    mattresses above eye height, a plain floor drawn with large Gaussians, and floaters
    just outside the walls.
    """
    yaw = np.radians(7.0)
    c, s = np.cos(yaw), np.sin(yaw)
    rot = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    parts, sizes = [], []

    def add(p, size):
        parts.append(p)
        sizes.append(np.full(len(p), size))

    # Plain floor: few large Gaussians. Lower-bunk mattresses at 0.45 m: many small ones.
    add(np.c_[rng.uniform(-2, 2, 1200), rng.normal(0, 0.004, 1200), rng.uniform(-3, 3, 1200)], 0.3)
    for x0 in (-1.95, 1.05):
        add(np.c_[rng.uniform(x0, x0 + 0.9, 8000), rng.normal(0.45, 0.004, 8000), rng.uniform(-2.5, -0.5, 8000)], 0.01)
    add(np.c_[rng.uniform(-2, 2, 3000), np.full(3000, 2.8), rng.uniform(-3, 3, 3000)], 0.15)
    for x in (-2, 2):
        add(np.c_[np.full(4000, x), rng.uniform(0, 2.8, 4000), rng.uniform(-3, 3, 4000)], 0.03)
    for z in (-3, 3):
        add(np.c_[rng.uniform(-2, 2, 3000), rng.uniform(0, 2.8, 3000), np.full(3000, z)], 0.03)
    for x0 in (-1.95, 1.05):  # top bunks at 1.7 m, small textured Gaussians
        add(np.c_[rng.uniform(x0, x0 + 0.9, 6000), np.full(6000, 1.7), rng.uniform(-2.5, -0.5, 6000)], 0.01)
    add(np.c_[rng.uniform(2.9, 3.9, 800), rng.uniform(0.3, 2.5, 800), rng.uniform(-3, 3, 800)], 0.05)
    pts = np.vstack(parts) @ rot.T
    return pts, np.concatenate(sizes)


def build_run(tmp_path, pts_world, sizes=None, cam_radius=(1.0, 1.2)):
    rng = np.random.default_rng(1)
    # COLMAP world = metric world tilted, rotated, shrunk, shifted (y down like OpenCV-ish)
    r_wc = rot_x(np.radians(110)) @ rot_y(np.radians(35))
    t_wc = np.array([0.3, -1.2, 4.0])

    def to_colmap(p):
        return (p @ r_wc.T) / TRUE_SCALE + t_wc

    pts_colmap = to_colmap(pts_world)

    # Cameras walking the room at 1.35 m: outward at the walls, then inward tilted down at the floor
    cams = []
    angles = np.linspace(0, 2 * np.pi, 24, endpoint=False)
    for i, (ang, sign, pitch) in enumerate([(a, 1, -0.1) for a in angles] + [(a, -1, -0.8) for a in angles]):
        c_world = np.array([cam_radius[0] * np.cos(ang), 1.35, cam_radius[1] * np.sin(ang)])
        fwd = np.array([sign * np.cos(ang), pitch, sign * np.sin(ang)])
        fwd /= np.linalg.norm(fwd)
        up = np.array([0.0, 1.0, 0.0])
        right = np.cross(fwd, up)
        right /= np.linalg.norm(right)
        down = np.cross(fwd, right)
        r_c2w_world = np.vstack([right, down, fwd]).T  # columns: x right, y down, z forward
        r_c2w = r_wc @ r_c2w_world
        c = to_colmap(c_world.reshape(1, 3))[0]
        r_w2c = r_c2w.T
        cams.append((i + 1, r_w2c, -r_w2c @ c, f"frame_{i + 1:06d}.jpg"))

    run = tmp_path / "test_s06_run"
    sparse = run / "colmap" / "sparse" / "0"
    sparse.mkdir(parents=True)
    (sparse / "cameras.txt").write_text(f"1 SIMPLE_RADIAL {W} {H} {F} {CX} {CY} 0.0\n")
    lines = []
    for iid, r, t, name in cams:
        q = rotmat_to_qvec(r)
        lines.append(f"{iid} {q[0]} {q[1]} {q[2]} {q[3]} {t[0]} {t[1]} {t[2]} 1 {name}\n10.0 10.0 -1\n")
    (sparse / "images.txt").write_text("".join(lines))
    sub = pts_colmap[rng.choice(len(pts_colmap), 3000, replace=False)]
    (sparse / "points3D.txt").write_text("".join(f"{k} {p[0]} {p[1]} {p[2]} 128 128 128 0.5\n" for k, p in enumerate(sub, 1)))

    # Nerfstudio frame: world flip then identity transform, scale 1
    splat_xyz = pts_colmap @ nz.COLMAP_WORLD_FLIP.T
    ns_dir = run / "splatfacto_run" / "splatfacto" / "2026-10-25_000000"
    ns_dir.mkdir(parents=True)
    (ns_dir / "dataparser_transforms.json").write_text(json.dumps({"transform": np.eye(4)[:3].tolist(), "scale": 1.0}))

    # Splat PLY (62 float32 props); add 50 far floaters
    floaters = splat_xyz.mean(axis=0) + rng.normal(0, 20, (50, 3))
    all_xyz = np.vstack([splat_xyz, floaters])
    data = np.zeros((len(all_xyz), 62), dtype="<f4")
    names = EXPECTED_PROPERTIES_ORDER
    data[:, 0:3] = all_xyz
    data[:, names.index("opacity")] = 3.0
    data[:, names.index("scale_0"):names.index("scale_0") + 3] = np.log(0.01)
    if sizes is not None:  # flat discs: two large axes, one thin
        sc = names.index("scale_0")
        data[:len(sizes), sc] = np.log(sizes / TRUE_SCALE)
        data[:len(sizes), sc + 1] = np.log(sizes / TRUE_SCALE)
        data[:len(sizes), sc + 2] = np.log(0.002 / TRUE_SCALE)
    header = "ply\nformat binary_little_endian 1.0\nelement vertex %d\n" % len(data)
    header += "".join(f"property float {n}\n" for n in names) + "end_header\n"
    (run / "splat.ply").write_bytes(header.encode("ascii") + data.tobytes())

    # Tape: A-B 2.000 m scale, C-D 1.000 m check, on the floor. Click each in two cameras.
    tape = {"A": [0.0, 0.0, 0.0], "B": [2.0, 0.0, 0.0], "C": [-1.0, 0.0, 1.0], "D": [-1.0, 0.0, 2.0]}
    marks = {}
    for label, p in tape.items():
        pc = to_colmap(np.array(p).reshape(1, 3))[0]
        obs = []
        for _, r, t, name in cams:
            x = r @ pc + t
            if x[2] <= 0.1:
                continue
            u, v = F * x[0] / x[2] + CX, F * x[1] / x[2] + CY
            if 0 <= u < W and 0 <= v < H:
                obs.append({"frame": name, "u": float(u), "v": float(v)})
        assert len(obs) >= 2, label
        marks[label] = obs[:3]
    (run / "marks_2d.json").write_text(json.dumps({"schema_version": 1, "marks": marks}))

    capture = {"scale_pairs": [
        {"a": "A", "b": "B", "distance_m": 2.0, "role": "scale"},
        {"a": "C", "b": "D", "distance_m": 1.0, "role": "check"},
    ]}
    (run / "capture.json").write_text(json.dumps(capture))
    return run, pts_world, tape


@pytest.fixture
def synthetic_run(tmp_path):
    return build_run(tmp_path, room_points_world(np.random.default_rng(1)))


def world_matrix(transform):
    return np.asarray(transform["world_from_splat"]).reshape(4, 4).T


def test_s06_recovers_floor_scale_and_origin_with_tape(synthetic_run):
    run, pts_world, tape = synthetic_run
    tr = run_s06_normalize(run, run / "capture.json")
    m = world_matrix(tr)
    assert tr["scale_method"] == "tape_pair"
    assert tr["metrics"]["colmap_frame"] in ("dataparser+flip", "flip_only")  # identity dataparser here
    assert tr["scale"] / nz.COLMAP_WORLD_FLIP[0, 0] == pytest.approx(TRUE_SCALE, rel=0.01)
    assert tr["residuals"]["floor_rms_m"] < 0.01
    assert tr["residuals"]["scale_check_error_pct"] < 1.0

    # Floor points land on y=0, walls reach 2.6 m, tape A is the origin
    splat = np.asarray(json.loads((run / "transform.json").read_text())["world_from_splat"])
    assert splat.shape == (16,)
    data = np.frombuffer((run / "clean.ply").read_bytes().split(b"end_header\n", 1)[1], dtype="<f4").reshape(-1, 62)
    w = nz.apply(m, data[:, :3].astype(np.float64))
    assert np.percentile(w[:, 1], 5) == pytest.approx(0.0, abs=0.02)
    assert np.percentile(w[:, 1], 99.9) == pytest.approx(2.6, abs=0.05)
    assert tr["metrics"]["camera_height_median_m"] == pytest.approx(1.35, abs=0.02)
    # Floaters removed
    assert tr["metrics"]["removed_outside_box"] >= 45
    assert len(data) < len(pts_world) + 50


def test_s06_camera_height_prior_without_tape(synthetic_run):
    run, _, _ = synthetic_run
    (run / "marks_2d.json").unlink()
    tr = run_s06_normalize(run, run / "capture.json")
    assert tr["scale_method"].startswith("camera_height_prior")
    assert tr["metrics"]["approximate_scale"] is True
    assert tr["scale"] == pytest.approx(TRUE_SCALE, rel=0.02)
    assert tr["residuals"]["scale_check_error_pct"] is None


def test_s06_fails_when_tape_required(synthetic_run, tmp_path):
    run, _, _ = synthetic_run
    (run / "marks_2d.json").unlink()
    cfg = Path(__file__).resolve().parents[2] / "pipeline" / "config" / "default.yaml"
    strict = tmp_path / "strict.yaml"
    strict.write_text(cfg.read_text().replace("normalize:\n", "normalize:\n  require_tape: true\n"))
    with pytest.raises(GateFailure):
        run_s06_normalize(run, run / "capture.json", config_path=strict)


def test_s06_measured_room_scale_walls_and_bounds(tmp_path):
    """
    SYNTHETIC: no tape marks; room_dims_m (ceiling, length, width) sets the scale and the walls
    bound the room. The floor must be the plain floor under the walked path, not the more
    numerous lower-bunk mattress Gaussians.
    """
    pts, sizes = measured_room_points_world(np.random.default_rng(2))
    run, _, _ = build_run(tmp_path, pts, sizes, cam_radius=(0.4, 2.0))
    (run / "marks_2d.json").unlink()
    cap = json.loads((run / "capture.json").read_text())
    cap["room_dims_m"] = {"width": 4.0, "length": 6.0, "height": 2.8}
    (run / "capture.json").write_text(json.dumps(cap))

    room_cfg = Path(__file__).resolve().parents[2] / "pipeline" / "config" / "room.yaml"
    tr = run_s06_normalize(run, run / "capture.json", config_path=room_cfg)
    met = tr["metrics"]
    assert met["floor_layer"] == "camera_path"
    assert tr["scale_method"] == "room_dims_median"
    assert met["approximate_scale"] is False
    assert abs(tr["scale"]) == pytest.approx(TRUE_SCALE, rel=0.02)
    assert met["camera_height_median_m"] == pytest.approx(1.35, abs=0.05)
    assert met["room_dims_check_pct"]["length"] < 2.0
    assert met["room_dims_check_pct"]["width"] < 2.0
    assert "room_dims_warning" not in met

    b = tr["bounds"]
    spans = sorted([b["maxX"] - b["minX"], b["maxZ"] - b["minZ"]])
    assert spans[0] == pytest.approx(4.0 - 0.5, abs=0.1)
    assert spans[1] == pytest.approx(6.0 - 0.5, abs=0.1)
    # Plain floor/ceiling Gaussians (0.15-0.3 m) survive; floaters outside the walls go
    assert met["removed_scale_outlier"] == 0
    assert met["removed_outside_box"] >= 700
    # Walkable grid: written, start and the walked path free, mattresses blocked
    assert met["grid_written"] is True
    assert met["grid_start_free"] is True
    assert met["grid_path_free_pct"] >= 80
    bounds_m2 = spans[0] * spans[1]
    assert 0.4 * bounds_m2 < met["grid_free_m2"] < 0.9 * bounds_m2
    doc = json.loads((run / "navgrid.json").read_text())
    from pipeline import grid as navgrid
    free = navgrid.decode_free_bits(doc["free_bits_b64"], doc["width"], doc["height"])
    assert free.sum() * doc["cell_m"] ** 2 == pytest.approx(met["grid_free_m2"], abs=0.01)
    # Height layers: mattress slice (0.4-0.5 m) and top-bunk slices occupied, the gap between them open
    lay = doc["layers"]
    occ = navgrid.decode_free_bits(lay["occupied_bits_b64"], doc["width"], doc["height"] * lay["count"])
    assert occ.shape == (doc["height"] * lay["count"], doc["width"])
    pct = met["grid_layer_occupied_pct"]
    idx = lambda h: int((h - lay["y0_m"]) // lay["dy_m"])
    assert pct[idx(0.45)] > 10
    assert pct[idx(0.95)] < 2
    assert max(pct[idx(1.65)], pct[idx(1.75)]) > 10
    assert (run / "navgrid_layers.png").is_file()
