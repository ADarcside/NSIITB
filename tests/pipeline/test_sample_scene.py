"""
Sample data check: the published K-720 scene in sample/test-capture/ must
match its manifest (schema, file sizes, sha256) and grid contract, so a
reviewer can load it in the viewer without running the GPU pipeline.
"""

import hashlib
import json
from pathlib import Path

from pipeline.validator import validate_manifest, validate_navgrid

SCENE_DIR = Path(__file__).resolve().parent.parent.parent / "sample" / "test-capture" / "scn_hostelroomac"


def load_json(name: str) -> dict:
    with open(SCENE_DIR / name, "r", encoding="utf-8") as f:
        return json.load(f)


def test_sample_manifest_is_valid():
    manifest = load_json("manifest.json")
    validate_manifest(manifest)
    assert manifest["scene_id"] == SCENE_DIR.name


def test_sample_assets_match_manifest():
    manifest = load_json("manifest.json")
    for asset in manifest["asset_table"].values():
        path = SCENE_DIR / asset["uri"]
        data = path.read_bytes()
        assert len(data) == asset["bytes"], asset["uri"]
        assert hashlib.sha256(data).hexdigest() == asset["sha256"], asset["uri"]


def test_sample_grid_is_valid():
    grid = load_json("grid.json")
    validate_navgrid(grid)
    assert grid["transform_scene"] == SCENE_DIR.name
