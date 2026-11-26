"""
Floater filter (pipeline/floaters.py) on a small SYNTHETIC room: 3 x 3 m, 2.5 m high. The walls are drawn by
flat Gaussians centred 0.4 m OUTSIDE the room box, like real splats, so a position crop would open holes.
"""

import numpy as np
import pytest

from pipeline import floaters as fl
from pipeline import grid as navgrid

HALF, TOP = 1.5, 2.5
CFG = {"render_px": 96, "view_step_m": 0.9, "heights_m": [0.6, 1.5], "workers": 2}


def disc_grid(axis, value, u_range, v_range, step, sigma, thin=0.005, gap=None):
    """Flat Gaussians on the plane coord[axis] = value; gap = (u0, u1, v0, v1) left open (a window)."""
    us = np.arange(u_range[0] + step / 2, u_range[1], step)
    vs = np.arange(v_range[0] + step / 2, v_range[1], step)
    uu, vv = np.meshgrid(us, vs)
    uu, vv = uu.ravel(), vv.ravel()
    if gap is not None:
        g0, g1, h0, h1 = gap
        ok = ~((uu > g0) & (uu < g1) & (vv > h0) & (vv < h1))
        uu, vv = uu[ok], vv[ok]
    other = [a for a in range(3) if a != axis]
    p = np.zeros((len(uu), 3))
    p[:, axis] = value
    p[:, other[0]], p[:, other[1]] = uu, vv
    s = np.full((len(uu), 3), sigma)
    s[:, axis] = thin
    return p, s


class Builder:
    def __init__(self):
        self.p, self.s, self.o, self.c, self.tag = [], [], [], [], []

    def add(self, p, s, op, col, tag):
        p = np.atleast_2d(p)
        self.p.append(p)
        self.s.append(np.broadcast_to(s, p.shape).copy())
        self.o.append(np.full(len(p), op))
        self.c.append(np.tile(col, (len(p), 1)))
        self.tag += [tag] * len(p)

    def scene(self):
        p, s = np.vstack(self.p), np.vstack(self.s)
        q = np.tile([1.0, 0, 0, 0], (len(p), 1))
        return fl.Scene(p, np.concatenate(self.o), s, fl.covariances(q, s), np.vstack(self.c)), np.array(self.tag)


def room(window=False, table=False, big_fog=False, solid_blob=False, stool=False, shelf=False):
    b = Builder()
    gap = (-0.4, 0.4, 0.8, 1.6) if window else None
    for sign in (-1, 1):
        # walls 0.4 m outside the box (centres outside, surface seen from inside)
        p, s = disc_grid(0, sign * (HALF + 0.4), (-HALF - 0.4, HALF + 0.4), (-0.4, TOP + 0.4), 0.12, 0.09,
                         gap=gap if sign > 0 else None)
        b.add(p[:, [0, 2, 1]], s[:, [0, 2, 1]], 0.95, [0.8, 0.7, 0.6], "wall")
        p, s = disc_grid(2, sign * (HALF + 0.4), (-HALF - 0.4, HALF + 0.4), (-0.4, TOP + 0.4), 0.12, 0.09)
        b.add(p, s, 0.95, [0.6, 0.7, 0.8], "wall")
    # floor and ceiling (on the box faces)
    p, s = disc_grid(1, 0.0, (-HALF - 0.4, HALF + 0.4), (-HALF - 0.4, HALF + 0.4), 0.12, 0.09)
    b.add(p, s, 0.95, [0.5, 0.4, 0.3], "floor")
    p, s = disc_grid(1, TOP, (-HALF - 0.4, HALF + 0.4), (-HALF - 0.4, HALF + 0.4), 0.12, 0.09)
    b.add(p, s, 0.95, [0.9, 0.9, 0.9], "ceiling")
    if window:
        # far outside, seen through the window: must stay
        p, s = disc_grid(0, HALF + 2.0, (-1.2, 1.2), (0.3, 2.1), 0.12, 0.09)
        b.add(p[:, [0, 2, 1]], s[:, [0, 2, 1]], 0.95, [0.2, 0.6, 0.2], "view")
    if table:
        # a table top drawn by four large flat Gaussians: must stay
        pts = [[0.35 + dx, 0.75, -0.6 + dz] for dx in (-0.15, 0.15) for dz in (-0.15, 0.15)]
        b.add(np.array(pts), [0.22, 0.01, 0.22], 0.98, [0.4, 0.2, 0.1], "table")
    rng = np.random.default_rng(1)
    # faint specks in the room
    b.add(rng.uniform([-1, 0.3, -1], [1, 2.2, 1], (200, 3)), [0.03, 0.03, 0.03], 0.02, [1, 1, 1], "faint")
    # a blob in mid air
    b.add(rng.normal([0.3, 1.2, 0.3], 0.01, (30, 3)), [0.015, 0.015, 0.015], 0.6, [1, 0, 0], "blob")
    # a wisp of fog over the walkway
    b.add(rng.normal([-0.2, 0.9, 0.3], 0.03, (12, 3)), [0.03, 0.03, 0.03], 0.15, [0.9, 0.9, 1.0], "fog")
    if solid_blob:
        # an opaque 20 cm cluster floating at chest height in the walkway, touching nothing (a training blob)
        b.add(rng.normal([0.5, 1.2, -0.5], 0.05, (600, 3)), [0.02, 0.02, 0.02], 0.98, [0.8, 0.7, 0.5], "solid_blob")
    if stool:
        # a stool seat 0.45 m up whose thin legs don't register in the grid: must stay
        b.add(rng.normal([-0.6, 0.45, -0.6], [0.08, 0.02, 0.08], (400, 3)), [0.02, 0.02, 0.02], 0.98, [0.3, 0.2, 0.1], "stool")
    if shelf:
        # a box on a wall shelf at 1.3 m, sticking 0.3 m out of the +x wall, its bracket too thin to register
        b.add(rng.normal([HALF - 0.15, 1.3, 0.0], [0.08, 0.05, 0.08], (400, 3)), [0.02, 0.02, 0.02], 0.98, [0.2, 0.5, 0.2], "shelf")
    if big_fog:
        # a large cloud right in front of several viewpoints: removing it changes > 5% of those views
        b.add(rng.normal([-0.5, 0.9, 0.5], 0.08, (25, 3)), [0.08, 0.08, 0.08], 0.15, [0.9, 0.9, 1.0], "cloud")
    # a shoe on the floor of the walkway: opaque, small, below the grid's height band. Real, must stay
    b.add(rng.normal([0.6, 0.07, 0.6], [0.06, 0.03, 0.03], (40, 3)), [0.02, 0.02, 0.02], 0.95, [0.9, 0.4, 0.1], "shoe")
    # junk far outside, behind a solid wall (z side has no window)
    b.add(rng.normal([0.0, 1.2, -(HALF + 1.5)], 0.1, (40, 3)), [0.05, 0.05, 0.05], 0.8, [0, 0, 1], "junk")
    return b.scene()


def make_grid(scene):
    bounds = {"minX": -HALF + 0.25, "maxX": HALF - 0.25, "minZ": -HALF + 0.25, "maxZ": HALF - 0.25}
    cfg = {"cell_m": 0.05, "height_band_m": [0.2, 1.7], "agent_radius_m": 0.25, "occupied_opacity_sum": 6.0,
           "min_opacity": 0.2, "min_obstacle_m2": 0.05,
           "layers": {"y0_m": 0.1, "dy_m": 0.1, "top_m": 2.5, "occupied_opacity_sum": 1.5, "min_opacity": 0.2,
                      "min_obstacle_m2": 0.02, "tall_min_layers": 4}}
    free, meta = navgrid.build_free_mask(scene.w, scene.op, bounds, (0.0, 0.0), cfg)
    occ, lmeta = navgrid.build_layers(scene.w, scene.op, meta, bounds, cfg["layers"])
    doc = {k: meta[k] for k in ("cell_m", "origin", "width", "height", "agent_radius_m")}
    doc["free_bits_b64"] = navgrid.encode_free_bits(free)
    doc["layers"] = {k: lmeta[k] for k in ("y0_m", "dy_m", "count")}
    doc["layers"]["occupied_bits_b64"] = navgrid.encode_free_bits(occ)
    return doc


@pytest.fixture(scope="module")
def plain():
    scene, tag = room()
    grid = make_grid(scene)
    keep, stats = fl.filter_floaters(scene, grid, CFG, TOP, log=lambda *a: None)
    return scene, tag, grid, keep, stats


def test_walls_outside_the_box_are_kept(plain):
    scene, tag, grid, keep, stats = plain
    lo, hi = fl.room_box(grid, TOP)
    wall = tag == "wall"
    outside = np.max(np.maximum(lo - scene.w, scene.w - hi), axis=1) > 0.3
    assert (wall & outside).sum() > 500  # the wall splats really are candidates
    # every wall splat that faces the room stays; parts hidden behind the floor, ceiling or the other walls may go
    w = scene.w
    facing = wall & (w[:, 1] > 0.1) & (w[:, 1] < TOP - 0.1) & (
        (np.abs(w[:, 0]) > HALF + 0.3) & (np.abs(w[:, 2]) < HALF + 0.3)
        | (np.abs(w[:, 2]) > HALF + 0.3) & (np.abs(w[:, 0]) < HALF + 0.3))
    assert stats["verify"]["hole_pct_max"] == 0.0
    assert keep[facing].mean() > 0.99, keep[facing].mean()
    assert keep[tag == "floor"].mean() > 0.95 and keep[tag == "ceiling"].mean() > 0.95


def test_planted_floaters_are_removed(plain):
    scene, tag, grid, keep, stats = plain
    for k in ("faint", "blob", "fog", "junk"):
        assert not keep[tag == k].any(), f"{k}: {keep[tag == k].sum()} of {(tag == k).sum()} kept"
    assert stats["status"] == "PASS"


def test_shoe_on_the_floor_is_kept(plain):
    scene, tag, grid, keep, stats = plain
    assert keep[tag == "shoe"].all()


def test_stats_add_up(plain):
    scene, tag, grid, keep, stats = plain
    for k, r in stats["rules"].items():
        assert r.get("new_candidates", r["candidates"]) == r["removed"] + r.get("put_back", 0), k
    assert sum(r["removed"] for r in stats["rules"].values()) == stats["removed"] == int((~keep).sum())


def test_outside_splat_seen_through_a_window_is_kept():
    scene, tag = room(window=True)
    grid = make_grid(scene)
    keep, stats = fl.filter_floaters(scene, grid, CFG, TOP, log=lambda *a: None)
    assert stats["status"] == "PASS"
    view = tag == "view"
    # the part of the outside view visible through the window stays
    assert keep[view].sum() >= 0.2 * view.sum()
    assert stats["verify"]["hole_pct_max"] <= 0.05
    assert not keep[tag == "junk"].any()


def test_table_top_of_few_large_splats_is_kept():
    scene, tag = room(table=True)
    grid = make_grid(scene)
    keep, stats = fl.filter_floaters(scene, grid, CFG, TOP, log=lambda *a: None)
    assert keep[tag == "table"].all()


def test_verify_gate_puts_back_a_rule_that_changes_too_much():
    scene, tag = room(big_fog=True)
    grid = make_grid(scene)
    keep, stats = fl.filter_floaters(scene, grid, CFG, TOP, log=lambda *a: None)
    assert stats["status"] == "PASS"
    # the first verify fails in the views right next to the cloud; only removals seen there go back
    first = stats["verify_local_repair"][0] if "verify_local_repair" in stats else stats["verify_first"]
    assert first["changed_pct_max"] > 5.0
    assert keep[tag == "cloud"].all() and stats["verify"]["changed_pct_max"] <= 5.0
    assert keep[tag == "faint"].mean() < 0.1  # other removals stay (only those seen right next to the cloud go back)


def test_disabled_keeps_everything():
    scene, tag = room()
    grid = make_grid(scene)
    keep, stats = fl.filter_floaters(scene, grid, {**CFG, "enabled": False}, TOP)
    assert keep.all() and stats == {"enabled": False, "kept": len(scene), "removed": 0}


def test_ply_round_trip(tmp_path):
    names = ["x", "y", "z", "opacity"]
    data = np.arange(20, dtype="<f4").reshape(5, 4)
    src = tmp_path / "a.ply"
    src.write_bytes(("ply\nformat binary_little_endian 1.0\nelement vertex 5\n"
                     + "".join(f"property float {n}\n" for n in names) + "end_header\n").encode() + data.tobytes())
    d, n = fl.read_ply(src)
    assert n == names and np.array_equal(d, data)
    keep = np.array([True, False, True, False, True])
    assert fl.write_ply(src, tmp_path / "b.ply", d, keep) == 3
    d2, _ = fl.read_ply(tmp_path / "b.ply")
    assert np.array_equal(d2, data[keep])


def test_one_bad_view_does_not_throw_away_every_removal():
    scene, tag = room(big_fog=True)
    grid = make_grid(scene)
    keep, stats = fl.filter_floaters(scene, grid, CFG, TOP, log=lambda *a: None)
    assert stats["status"] == "PASS" and stats["removed"] > 0
    assert "verify_local_repair" in stats
    assert not keep[tag == "junk"].any() and keep[tag == "blob"].mean() < 0.1 and keep[tag == "faint"].mean() < 0.1


def test_floating_solid_cluster_is_removed_and_furniture_stays():
    scene, tag = room(solid_blob=True, table=True, stool=True, shelf=True)
    grid = make_grid(scene)
    keep, stats = fl.filter_floaters(scene, grid, {**CFG, "unsupported": True, "unsupported_max_fraction": 1.0}, TOP,
                                    log=lambda *a: None)  # a tiny test scene: the share cap is for real scenes
    assert stats["status"] == "PASS"
    assert keep[tag == "solid_blob"].mean() < 0.05, keep[tag == "solid_blob"].mean()
    assert keep[tag == "shoe"].all() and keep[tag == "table"].all()
    assert keep[tag == "stool"].all() and keep[tag == "shelf"].all()
    assert stats["unsupported_check"]["passed"]
    assert len(stats["unsupported_clusters"]["clusters"]) == 1


def test_floating_cluster_rule_is_off_by_default():
    scene, tag = room(solid_blob=True)
    grid = make_grid(scene)
    keep, stats = fl.filter_floaters(scene, grid, CFG, TOP, log=lambda *a: None)
    assert keep[tag == "solid_blob"].all() and "unsupported_check" not in stats


def test_floating_cluster_cap_keeps_everything():
    scene, tag = room(solid_blob=True)
    grid = make_grid(scene)
    keep, stats = fl.filter_floaters(scene, grid, {**CFG, "unsupported": True}, TOP, log=lambda *a: None)
    assert stats["unsupported_clusters"]["capped"] and keep[tag == "solid_blob"].all()
