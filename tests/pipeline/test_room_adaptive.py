"""Per-room settings: video skip windows (S02), viewpoint heights and flying layers that follow the room height."""

from pathlib import Path

import pytest

from pipeline import floaters as fl
from pipeline import grid as navgrid
from pipeline.common import load_config
from pipeline.stages.s02_frames import drop_skipped, parse_clock, parse_skip_ranges

CONFIG = Path(__file__).resolve().parents[2] / "pipeline" / "config"


def test_parse_clock_and_ranges():
    assert parse_clock("50:22") == 3022 and parse_clock("1:02:03") == 3723 and parse_clock("83.5") == 83.5
    assert parse_skip_ranges(["33:41-33:49", "50:22-50:29"]) == [(2021, 2029), (3022, 3029)]
    assert parse_skip_ranges([[10, 12]]) == [(10, 12)]
    assert parse_skip_ranges(None) == [] and parse_skip_ranges([]) == []
    with pytest.raises(ValueError):
        parse_skip_ranges(["50:29-50:22"])
    with pytest.raises(ValueError):
        parse_skip_ranges(["50:22"])


def test_drop_skipped_by_video_time():
    paths = [Path(f"cand_{i + 1:06d}.jpg") for i in range(2 * 60)]  # 60 s at 2 fps
    kept, n = drop_skipped(paths, 2.0, [(10, 12)])
    times = [int(p.stem[5:]) - 1 for p in kept]
    assert n == 7  # 10.0-12.0 s is 5 candidates, plus one each side
    assert all(not (9.5 <= t / 2 <= 12.5) for t in times)
    assert drop_skipped(paths, 2.0, []) == (paths, 0)


def test_skip_windows_only_in_the_room3_run_configs():
    for name in ("default.yaml", "room.yaml", "room_sharp.yaml", "omen.yaml"):
        assert not load_config(CONFIG / name)[0]["frames"].get("skip_ranges")
    for name in ("lab.yaml", "omen.yaml"):
        assert load_config(CONFIG / "room3" / name)[0]["frames"]["skip_ranges"] == ["33:41-33:49", "50:22-50:29"]


def test_room_heights():
    hs = (0.6, 1.5, 2.3)
    assert fl.room_heights(hs, None) == hs
    assert fl.room_heights(hs, 2.61) == hs and fl.room_heights(hs, 2.84) == hs  # K-720: unchanged
    low = fl.room_heights(hs, 2.2)
    assert max(low) <= 2.0 + 1e-9 and 0.6 in low and 1.5 in low
    hall = fl.room_heights(hs, 4.5)
    assert hall[:3] == hs and hall[3] == pytest.approx(3.82)


def test_layers_for_room():
    cfg = {"top_m": 2.9, "dy_m": 0.1}
    assert navgrid.layers_for_room(cfg, None) == cfg
    assert navgrid.layers_for_room(cfg, 2.84)["top_m"] == 2.9  # K-720: unchanged
    assert navgrid.layers_for_room(cfg, 4.5)["top_m"] == 4.5
