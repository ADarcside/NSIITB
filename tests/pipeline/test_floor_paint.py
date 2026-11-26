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


def cameras(tmp_path, scene, tag, colour=(0.1, 0.8, 0.2)):
    green = fl.Scene(scene.w, scene.op, scene.sc, scene.cov, np.where((tag == "floor")[:, None], list(colour), scene.col))
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


DARK = (0.05, 0.07, 0.15)  # dark blue-black tiles (Room 3): the sheet must follow the photos, not any fixed colour


@pytest.fixture(scope="module")
def dark_frames(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("dark")
    scene, tag = room()
    tag = np.asarray(tag)
    return scene, tag, tmp, cameras(tmp, scene, tag, DARK)


def test_dark_floor_takes_its_own_colour(dark_frames):
    scene, tag, tmp, cams = dark_frames
    keep, p, col, stats = fp.floor_paint(scene, np.ones(len(scene.w), bool), make_grid(scene), cams, tmp,
                                         np.zeros((0, 3)), np.zeros((0, 3)), CFG, log=lambda *a: None)
    assert stats["status"] == "painted"
    assert np.abs(np.median(col, axis=0) - DARK).max() < 0.06


def test_clean_floor_left_alone(dark_frames):
    """Splat floor already the photo colour -> nothing repainted, nothing removed."""
    scene, tag, tmp, cams = dark_frames
    grid = make_grid(scene)
    sp, _ = fp.sheet_points(grid, fp.merged_config(CFG))
    keep = np.ones(len(scene.w), bool)
    k2, p, col, stats = fp.floor_paint(scene, keep, grid, cams, tmp, sp, np.tile(DARK, (len(sp), 1)), CFG,
                                       log=lambda *a: None)
    assert stats["status"] == "skipped_clean", stats
    assert len(p) == 0 and k2.all()


def test_dirty_floor_still_painted(dark_frames):
    """Splat floor a different colour from the photos -> repainted (the K-720 case)."""
    scene, tag, tmp, cams = dark_frames
    grid = make_grid(scene)
    sp, _ = fp.sheet_points(grid, fp.merged_config(CFG))
    k2, p, col, stats = fp.floor_paint(scene, np.ones(len(scene.w), bool), grid, cams, tmp, sp,
                                       np.tile([0.45, 0.4, 0.35], (len(sp), 1)), CFG, log=lambda *a: None)
    assert stats["status"] == "painted" and stats["check"]["clean"] is False and len(p)


def test_flatten_evens_out_glare_and_keeps_tile_lines():
    import numpy as np
    from pipeline import floor_paint as fp
    cfg = fp.merged_config({})
    gh, gw = 200, 300
    yy, xx = np.mgrid[0:gh, 0:gw]
    lum = np.full((gh, gw), 0.45)
    lum[(xx % 80) < 2] = 0.30                                              # tile lines (grout)
    lum += 0.35 * np.exp(-(((xx - 200) ** 2 + (yy - 100) ** 2) / (2 * 60.0 ** 2)))  # window glare patch (~0.4 m)
    col = np.repeat(lum.reshape(-1, 1), 3, 1)
    before = fp.floor_unevenness(col, (gh, gw), cfg)
    flat = fp.flatten_colours(col, (gh, gw), cfg)
    after = fp.floor_unevenness(flat, (gh, gw), cfg)
    assert before > 0.1 and after < before / 3
    img = flat[:, 0].reshape(gh, gw)
    assert img[100, 83] - img[100, 80] > 0.05                              # grout line still darker
    assert abs(img[100, 200] - img[100, 120]) <= cfg["flatten_clip"]          # glare 0.35 brighter -> at most the clip


def test_flatten_is_off_by_default():
    from pipeline import floor_paint as fp
    assert fp.DEFAULTS["flatten"] == "off"


def test_flatten_keeps_a_rug_and_auto_needs_a_threshold():
    import numpy as np
    from pipeline import floor_paint as fp
    cfg = fp.merged_config({})
    gh, gw = 200, 300
    col = np.full((gh, gw, 3), 0.45)
    col[50:150, 30:130] = [0.6, 0.25, 0.2]                    # 0.7 m red rug
    flat = fp.flatten_colours(col.reshape(-1, 3), (gh, gw), cfg).reshape(gh, gw, 3)
    assert np.abs(flat[100, 80] - col[100, 80]).max() < 0.02  # rug centre untouched
    assert np.abs(flat[100, 250] - 0.45).max() < 0.02         # plain floor stays plain
    assert fp.DEFAULTS["flatten_uneven"] is None


def test_flatten_colour_even_removes_a_light_cast():
    import numpy as np
    from pipeline import floor_paint as fp
    cfg = fp.merged_config({"flatten_colour": "even"})
    gh, gw = 200, 300
    col = np.full((gh, gw, 3), 0.45)
    yy, xx = np.mgrid[0:gh, 0:gw]
    cast = np.exp(-(((xx - 80) ** 2 + (yy - 100) ** 2) / (2 * 50.0 ** 2)))
    col[..., 2] += 0.25 * cast; col[..., 1] -= 0.08 * cast             # purple lamp light
    flat = fp.flatten_colours(col.reshape(-1, 3), (gh, gw), cfg).reshape(gh, gw, 3)
    assert np.abs(flat[100, 80] - flat[100, 280]).max() <= cfg["flatten_clip"] + 0.01
    keep = fp.flatten_colours(col.reshape(-1, 3), (gh, gw), fp.merged_config({})).reshape(gh, gw, 3)
    assert keep[100, 80, 2] - keep[100, 280, 2] > 0.15                 # default keeps colour patches
