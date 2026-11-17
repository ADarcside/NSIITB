"""Floor backing (pipeline/floor.py) on the synthetic room from test_floaters.py, with blobs under the floor."""

import numpy as np
import pytest

from pipeline import floaters as fl
from pipeline import floor as fb
from tests.pipeline.test_floaters import HALF, TOP, make_grid, room

CFG = {"render_px": 96, "view_step_m": 0.9, "heights_m": [0.6, 1.5], "workers": 2, "backing_step_m": 0.03,
       "backing_sigma_m": 0.02}


def with_blobs():
    scene, tag = room()
    rng = np.random.default_rng(3)
    p = rng.normal([0.3, -0.15, -0.4], [0.2, 0.03, 0.2], (30, 3))   # blob where the camera person stood
    s = np.full((30, 3), 0.08)
    q = np.tile([1.0, 0, 0, 0], (30, 1))
    blob = fl.Scene(p, np.full(30, 1.0), s, fl.covariances(q, s), np.tile([1.0, 1.0, 1.0], (30, 1)))
    both = fl.Scene(np.r_[scene.w, blob.w], np.r_[scene.op, blob.op], np.r_[scene.sc, blob.sc],
                    np.r_[scene.cov, blob.cov], np.r_[scene.col, blob.col])
    return both, np.r_[tag, np.array(["below"] * 30)]


@pytest.fixture(scope="module")
def result():
    scene, tag = with_blobs()
    grid = make_grid(scene)
    keep, p, col, stats = fb.floor_backing(scene, grid, CFG, TOP, log=lambda *a: None)
    return scene, tag, grid, keep, p, col, stats


def test_backing_covers_the_floor(result):
    scene, tag, grid, keep, p, col, stats = result
    assert stats["status"] == "PASS"
    assert np.allclose(p[:, 1], fb.DEFAULTS["backing_y_m"])
    c = grid["cell_m"]
    area = grid["width"] * grid["height"] * c * c
    assert len(p) * 0.03 ** 2 > 0.8 * area
    # the floor is brown (0.5, 0.4, 0.3): the backing takes its colour from it
    assert np.abs(np.median(col, axis=0) - [0.5, 0.4, 0.3]).max() < 0.1


def test_below_floor_blob_removed_room_untouched(result):
    scene, tag, grid, keep, p, col, stats = result
    assert not keep[tag == "below"].any()
    for k in ("floor", "ceiling", "fog", "blob", "shoe"):
        assert keep[tag == k].all(), k
    assert stats["verify"]["hole_pct_max"] <= 0.05
    assert stats["removed"] + stats["put_back"] == stats["candidates"]


def test_backing_rows_round_trip():
    names = ["x", "y", "z"] + [f"rot_{i}" for i in range(4)] + [f"scale_{i}" for i in range(3)] + ["opacity"] + \
            [f"f_dc_{i}" for i in range(3)] + [f"f_rest_{i}" for i in range(3)]
    th = np.radians(30)
    r = np.array([[np.cos(th), 0, np.sin(th)], [0, 1, 0], [-np.sin(th), 0, np.cos(th)]]) @ \
        np.array([[1, 0, 0], [0, np.cos(1.0), -np.sin(1.0)], [0, np.sin(1.0), np.cos(1.0)]])
    m = np.eye(4)
    m[:3, :3] = 0.5 * r
    m[:3, 3] = [0.1, 1.4, -0.2]
    p = np.array([[0.3, -0.012, 0.4], [1.0, -0.012, -0.5]])
    col = np.array([[0.2, 0.5, 0.9], [0.8, 0.1, 0.3]])
    cfg = fb.merged_config({})
    s = fl.Scene.from_splat(fb.backing_rows(p, col, names, m, cfg), names, m)
    assert np.allclose(s.w, p, atol=1e-5) and np.allclose(s.col, col, atol=1e-5)
    assert np.allclose(np.sqrt(np.diag(s.cov[0])), [0.007, 0.002, 0.007], atol=1e-5)
    assert np.allclose(s.op, 0.99, atol=1e-4)


def test_disabled_keeps_everything():
    scene, tag = with_blobs()
    keep, p, col, stats = fb.floor_backing(scene, make_grid(scene), {**CFG, "enabled": False}, TOP)
    assert keep.all() and len(p) == 0 and stats == {"enabled": False}


def test_lite_backing_is_a_quarter_and_wider():
    names = ["x", "y", "z"] + [f"rot_{i}" for i in range(4)] + [f"scale_{i}" for i in range(3)] + ["opacity"] + \
            [f"f_dc_{i}" for i in range(3)]
    g = np.arange(0, 1.0, 0.01)
    xx, zz = np.meshgrid(g, g)
    p = np.c_[xx.ravel(), np.full(xx.size, -0.012), zz.ravel()]
    col = np.full((len(p), 3), 0.5)
    cfg = fb.merged_config({})
    rows = fb.lite_backing_rows(p, col, names, np.eye(4), cfg)
    assert len(rows) == len(p) // 4
    assert np.allclose(np.exp(rows[:, names.index("scale_0")]), 2 * cfg["backing_sigma_m"])
