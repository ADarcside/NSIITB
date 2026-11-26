"""
Room 2 safety checks (18 Nov): a model stretched along one axis must stop at G6, and the tape
marks must be writable and measurable without the COLMAP GUI. SYNTHETIC data only, built with
the S06 test room (tests/pipeline/test_s06.py).
"""

import json
from pathlib import Path

import numpy as np
import pytest

from pipeline import normalize as nz
from pipeline.common import GateFailure
from pipeline.stages.s03_poses import parse_cameras_txt, parse_images_txt
from pipeline.stages.s06_normalize import run_s06_normalize
from pipeline.tools import marks as mk
from tests.pipeline.test_s06 import (
    TRUE_SCALE, build_run, measured_room_points_world, rot_x, rot_y,
)

ROOM_CFG = Path(__file__).resolve().parents[2] / "pipeline" / "config" / "room.yaml"
DIMS = {"width": 4.0, "length": 6.0, "height": 2.8}


def test_path_span_check_flags_a_path_longer_than_the_room():
    rng = np.random.default_rng(0)
    ang = np.radians(20)
    rot = np.array([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]])
    inside = np.c_[rng.uniform(-2.7, 2.7, 400), rng.uniform(-1.6, 1.6, 400)] @ rot.T
    ok = nz.path_span_check(inside, DIMS)
    assert ok["path_span_over"] == []
    assert ok["path_span_m"]["long"] == pytest.approx(5.2, abs=0.2)
    # Room 2: the same walk stretched 1.8x along the length
    stretched = (inside @ rot) * [1.8, 1.0] @ rot.T
    bad = nz.path_span_check(stretched, DIMS)
    assert bad["path_span_over"] == ["long"]


def stretched_room_run(tmp_path, stretch=1.8):
    """The measured S06 room (4 x 6 x 2.8 m) reconstructed 1.8x too long, like room 2."""
    pts, sizes = measured_room_points_world(np.random.default_rng(2))
    pts = pts * [1.0, 1.0, stretch]
    run, _, _ = build_run(tmp_path, pts, sizes, cam_radius=(0.4, 2.0 * stretch))
    (run / "marks_2d.json").unlink()
    cap = json.loads((run / "capture.json").read_text())
    cap["room_dims_m"] = dict(DIMS)
    (run / "capture.json").write_text(json.dumps(cap))
    return run


def no_cleanups(cfg_path, tmp_path):
    """The config with the floater filter, floor backing and floor repaint off: these tests check
    G6's shape gates and the tape marks, and the clean-ups have their own tests. Keeps the CI
    pipeline job inside its 15 minute limit."""
    lines = Path(cfg_path).read_text().splitlines()
    section = None
    for i, line in enumerate(lines):
        if line and not line.startswith(" "):
            section = line.split(":")[0]
        elif section in ("floaters", "floor", "floor_paint") and line.strip().startswith("enabled: true"):
            lines[i] = line.replace("enabled: true", "enabled: false")
    out = Path(tmp_path) / f"nocleanup_{Path(cfg_path).name}"
    out.write_text("\n".join(lines) + "\n")
    return out


def config_with(tmp_path, **replace):
    text = no_cleanups(ROOM_CFG, tmp_path).read_text()
    for key, value in replace.items():
        assert f"  {key}: fail" in text
        text = text.replace(f"  {key}: fail", f"  {key}: {value}")
    out = tmp_path / "shape.yaml"
    out.write_text(text)
    return out


def test_s06_stops_a_room_stretched_along_its_length(tmp_path):
    run = stretched_room_run(tmp_path)
    with pytest.raises(GateFailure) as e:
        run_s06_normalize(run, run / "capture.json", config_path=config_with(tmp_path))
    msg = str(e.value.message if hasattr(e.value, "message") else e.value)
    assert "Room sizes disagree" in msg
    assert "Camera path spans" in msg
    report = json.loads((run / "run_report.json").read_text())["stages"]["s06_normalize"]
    assert report["status"] == "failed"
    assert report["metrics"]["path_span_over"] == ["long"]


def test_s06_shape_gates_can_be_set_to_warn(tmp_path):
    run = stretched_room_run(tmp_path)
    tr = run_s06_normalize(run, run / "capture.json",
                           config_path=config_with(tmp_path, room_dims_gate="warn", path_gate="warn"))
    met = tr["metrics"]
    assert met["room_dims_gate"] == "warn"
    assert met["path_gate"] == "warn"
    assert max(met["room_dims_check_pct"].values()) > 30
    assert met["path_span_over"] == ["long"]
    assert met["tape_check"].startswith("not run")


# ---------------------------------------------------------------- tape marks without the GUI

@pytest.fixture
def tape_run(tmp_path):
    from tests.pipeline.test_s06 import room_points_world
    run, _, tape = build_run(tmp_path, room_points_world(np.random.default_rng(1)))
    truth = json.loads((run / "marks_2d.json").read_text())["marks"]
    (run / "marks_2d.json").unlink()
    return run, truth


def test_marks_add_then_check_measures_the_tape_pairs(tape_run, tmp_path):
    run, truth = tape_run
    for label, obs in truth.items():
        for o in obs:
            mk.add_mark(run, label, o["frame"], o["u"], o["v"])
    assert mk.load_marks(run / "marks_2d.json") == truth
    cap = json.loads((run / "capture.json").read_text())
    # Before S06: no metres yet, but the check pair against the scale pair already works
    out = mk.measure_pairs(run, cap)
    assert out["metres_from_transform"] is False
    check = next(p for p in out["pairs"] if p["role"] == "check")
    assert check["vs_scale_pair_error_pct"] < 1.0
    # After S06: metres
    run_s06_normalize(run, run / "capture.json", config_path=no_cleanups(ROOM_CFG.parent / "default.yaml", tmp_path))
    out = mk.measure_pairs(run, cap)
    assert out["metres_from_transform"] is True
    for p in out["pairs"]:
        assert p["error_pct"] < 1.0
    assert mk.main(["check", "--run-dir", str(run), "--capture", str(run / "capture.json")]) == 0


def test_marks_add_rejects_unregistered_frames(tape_run):
    run, _ = tape_run
    with pytest.raises(SystemExit):
        mk.add_mark(run, "A", "frame_999999.jpg", 10, 10)


def test_aruco_markers_in_frames_become_marks(tape_run, tmp_path):
    """Prints the four markers onto the floor at the tape crosses, renders them into the frames,
    detects them and checks the triangulated pairs."""
    cv2 = pytest.importorskip("cv2")
    run, truth = tape_run
    cameras = parse_cameras_txt(run / "colmap" / "sparse" / "0" / "cameras.txt")
    images = parse_images_txt(run / "colmap" / "sparse" / "0" / "images.txt")
    by_name = {img["name"]: img for img in images.values()}
    cam = cameras[1]
    f, cx, cy = cam["params"][:3]
    w, h = cam["width"], cam["height"]
    r_wc = rot_x(np.radians(110)) @ rot_y(np.radians(35))  # build_run's COLMAP frame
    ex, ez = r_wc @ [1.0, 0, 0] / TRUE_SCALE, r_wc @ [0, 0, 1.0] / TRUE_SCALE
    half = 0.25  # 0.5 m printed marker
    labels = {0: "A", 1: "B", 2: "C", 3: "D"}
    d = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    frames = {name: np.full((h, w), 255, np.uint8) for name in by_name}
    for i, label in labels.items():
        centre = nz.triangulate_mark(truth[label], by_name, cameras)
        # marker corners (top-left, top-right, bottom-right, bottom-left) on the floor plane
        corners = [centre + sx * half * ex + sz * half * ez for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        side = 600
        img = cv2.aruco.generateImageMarker(d, i, side)
        src = np.float32([[0, 0], [side, 0], [side, side], [0, side]])
        for name, im in by_name.items():
            r = nz.qvec_to_rotmat(im["qvec"])
            pc = [r @ c + np.asarray(im["tvec"]) for c in corners]
            if min(p[2] for p in pc) < 0.1:
                continue
            dst = np.float32([[f * p[0] / p[2] + cx, f * p[1] / p[2] + cy] for p in pc])
            if dst[:, 0].min() < 0 or dst[:, 1].min() < 0 or dst[:, 0].max() >= w or dst[:, 1].max() >= h:
                continue
            hmat = cv2.getPerspectiveTransform(src, dst)
            warped = cv2.warpPerspective(img, hmat, (w, h), borderValue=255)
            mask = cv2.warpPerspective(np.full_like(img, 255), hmat, (w, h)) > 0
            frames[name][mask] = warped[mask]
    (run / "frames").mkdir()
    for name, im in frames.items():
        cv2.imwrite(str(run / "frames" / name), im)

    assert mk.main(["aruco", "--run-dir", str(run)]) == 0
    marks = mk.load_marks(run / "marks_2d.json")
    assert set(marks) == {"A", "B", "C", "D"}
    out = mk.measure_pairs(run, json.loads((run / "capture.json").read_text()))
    check = next(p for p in out["pairs"] if p["role"] == "check")
    assert check["vs_scale_pair_error_pct"] < 2.0
    assert len(mk.write_sheet(tmp_path / "sheet", [0, 1], labels, 200)) == 2
