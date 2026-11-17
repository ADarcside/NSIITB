"""Floor repaint from photos (pipeline/floor_paint.py) on the synthetic room from test_floaters.py.

The "photos" are renders of the same room with a green floor; the splat floor is brown. The sheet must take
the photo colour, and the thin floor splats under it must go, while walls and ceiling stay."""

import math

import numpy as np
import pytest
import cv2

from pipeline import floaters as fl
from pipeline import floor_paint as fp
from tests.pipeline.test_floaters import make_grid, room

W, H, F = 160, 120, 100.0
CFG = {"paint_step_m": 0.05, "paint_sigma_m": 0.035, "render_div": 2, "workers": 2, "floor_skin_m": [-0.03, 0.03],
       "skin_thick_m": 0.05}


def cameras(tmp_path, scene, tag):
    green = fl.Scene(scene.w, scene.op, scene.sc, scene.cov, np.where((tag == "floor")[:, None], [0.1, 0.8, 0.2], scene.col))
    cams = {"w": W, "h": H, "f": F, "cx": W / 2, "cy": H / 2, "k1": 0.0, "cams": {}, "frame": "synthetic"}
    fov = 2 * math.degrees(math.atan((H / 2) / F))
    k = 0
    for x in (-0.8, 0.0, 0.8):
        for z in (-0.8, 0.0, 0.8):
            e = np.array([x, 1.4, z])
            for yaw in (0, 90, 180, 270):
                d = np.array([math.sin(math.radians(yaw)), -1.2, math.cos(math.radians(yaw))])
                r = fl.camera(e, e + d)
                img, _ = fl.render(green, e, e + d, (W, H), fov, rot=r)
                name = f"f{k:03d}.png"
                cv2.imwrite(str(tmp_path / name), (np.clip(img, 0, 1) * 255).astype(np.uint8)[..., ::-1])
                cams["cams"][name] = {"c": e, "R": r}
                k += 1
    return cams


@pytest.fixture(scope="module")
def result(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("frames")
    scene, tag = room()
    tag = np.asarray(tag)
    keep = np.ones(len(scene.w), bool)
    cams = cameras(tmp, scene, tag)
    out = fp.floor_paint(scene, keep, make_grid(scene), cams, tmp, np.zeros((0, 3)), np.zeros((0, 3)), CFG,
                         log=lambda *a: None)
    return scene, tag, out


def test_sheet_takes_the_photo_colour(result):
    scene, tag, (keep, p, col, stats) = result
    assert stats["painted_pct"] > 50
    assert np.allclose(p[:, 1], fp.DEFAULTS["paint_y_m"])
    assert np.abs(np.median(col, axis=0) - [0.1, 0.8, 0.2]).max() < 0.1


def test_floor_skin_replaced_room_kept(result):
    scene, tag, (keep, p, col, stats) = result
    assert stats["skin_removed"] > 0 and not keep[tag == "floor"].all()
    for k in ("ceiling", "fog", "blob", "shoe"):
        if (tag == k).any():
            assert keep[tag == k].all(), k


def test_project_matches_renderer_convention():
    r = fl.camera((0, 1, 0), (0, 0, 1))
    cams = {"w": W, "h": H, "f": F, "cx": W / 2, "cy": H / 2, "k1": 0.0, "cams": {"a": {"c": np.array([0, 1, 0.0]), "R": r}}}
    u, v, ok = fp.project(cams, "a", np.array([[0.0, 0.0, 1.0], [0.0, 1.0, -1.0]]))
    assert ok.tolist() == [True, False]
    assert u[0] == pytest.approx(W / 2) and v[0] == pytest.approx(H / 2)
