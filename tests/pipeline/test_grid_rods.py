"""Thin vertical rods (bunk posts) must stay solid in the walk grid and the height layers."""

import numpy as np

from pipeline import grid as navgrid

CFG = {
    "cell_m": 0.05, "height_band_m": [0.2, 1.7], "agent_radius_m": 0.25, "occupied_opacity_sum": 6.0,
    "min_opacity": 0.2, "min_obstacle_m2": 0.05,
    "layers": {"y0_m": 0.1, "dy_m": 0.1, "top_m": 2.9, "occupied_opacity_sum": 1.5, "min_opacity": 0.2,
               "min_obstacle_m2": 0.02, "tall_min_layers": 4},
}
BOUNDS = {"minX": -2.0, "maxX": 2.0, "minZ": -2.0, "maxZ": 2.0}


def scene(rng):
    # A 3 cm rod from the floor to 1.9 m at (1.0, 0.0), and a small floater blob at 1.2 m at (-1.0, 0.0)
    rod = np.c_[rng.normal(1.0, 0.008, 4000), rng.uniform(0.0, 1.9, 4000), rng.normal(0.0, 0.008, 4000)]
    floater = np.c_[rng.normal(-1.0, 0.01, 60), rng.normal(1.2, 0.02, 60), rng.normal(0.0, 0.01, 60)]
    xyz = np.vstack([rod, floater])
    return xyz, np.full(len(xyz), 0.9)


def cell_of(meta, x, z):
    return int((z - meta["origin"][1]) // meta["cell_m"]), int((x - meta["origin"][0]) // meta["cell_m"])


def test_rod_blocks_walking_and_flying_floater_does_not():
    xyz, op = scene(np.random.default_rng(0))
    free, meta = navgrid.build_free_mask(xyz, op, BOUNDS, (0.0, 1.0), CFG)
    assert not free[cell_of(meta, 1.0, 0.0)]
    assert free[cell_of(meta, -1.0, 0.0)]
    occ, lmeta = navgrid.build_layers(xyz, op, meta, BOUNDS, CFG["layers"])
    r, c = cell_of(meta, 1.0, 0.0)
    for h in (0.3, 0.95, 1.5):
        assert occ[int((h - 0.1) // 0.1), r, c], h
    fr, fc = cell_of(meta, -1.0, 0.0)
    assert not occ[:, fr, fc].any()
