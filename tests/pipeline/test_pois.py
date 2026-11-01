"""
Tests for pipeline.pois CLI and attachment logic (Round 2).
Covers:
  - attach to a temp copy of a scene: hash and bytes correct
  - re-attach keeps the same asset id
  - wrong scene_id fails without --fix-scene-id
  - --fix-scene-id works and updates scene_id on set and POIs
  - invalid POI fails (empty name, bad id)
  - check command inspects POIs and walkability
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
import pytest

from pipeline.common import sha256_file
from pipeline.pois import attach_pois, check_pois
from pipeline.validator import ValidationError

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"


@pytest.fixture
def temp_scene(tmp_path: Path) -> Path:
    """Create a temporary scene folder with a valid manifest.json."""
    manifest_src = FIXTURES_DIR / "manifest_valid.json"
    manifest_data = json.loads(manifest_src.read_text(encoding="utf-8"))
    (tmp_path / "manifest.json").write_text(json.dumps(manifest_data, indent=2), encoding="utf-8")
    return tmp_path


def make_sample_pois(scene_id: str = "scn_23j7x56k3y7a", poi_name: str = "Meeting Table") -> dict:
    return {
        "schema_version": 1,
        "scene_id": scene_id,
        "updated_at": "2026-10-31T12:00:00Z",
        "pois": [
            {
                "schema_version": 1,
                "poi_id": "poi_test72abcdef",
                "scene_id": scene_id,
                "name": poi_name,
                "category": "furniture",
                "aliases": ["table", "desk"],
                "position": {"x": 0.5, "y": 1.2, "z": -0.8},
                "yaw_deg": 45,
            }
        ],
    }


def test_attach_success(temp_scene: Path, tmp_path: Path):
    scene_id = "scn_23j7x56k3y7a"
    pois_file = tmp_path / "test_pois.json"
    pois_data = make_sample_pois(scene_id=scene_id)
    pois_file.write_text(json.dumps(pois_data, indent=2), encoding="utf-8")

    attach_pois(temp_scene, pois_file)

    dest_pois = temp_scene / "pois.json"
    assert dest_pois.is_file()

    expected_hash = sha256_file(dest_pois)
    expected_bytes = dest_pois.stat().st_size

    manifest = json.loads((temp_scene / "manifest.json").read_text(encoding="utf-8"))
    pois_asset_id = manifest["assets"]["pois"]
    assert pois_asset_id.startswith("ast_")
    assert pois_asset_id in manifest["asset_table"]

    asset_entry = manifest["asset_table"][pois_asset_id]
    assert asset_entry["kind"] == "pois"
    assert asset_entry["format"] == "json"
    assert asset_entry["uri"] == "pois.json"
    assert asset_entry["sha256"] == expected_hash
    assert asset_entry["bytes"] == expected_bytes


def test_reattach_keeps_same_asset_id(temp_scene: Path, tmp_path: Path):
    scene_id = "scn_23j7x56k3y7a"
    pois_file1 = tmp_path / "pois1.json"
    pois_file1.write_text(json.dumps(make_sample_pois(scene_id, "Desk 1"), indent=2), encoding="utf-8")
    attach_pois(temp_scene, pois_file1)

    manifest1 = json.loads((temp_scene / "manifest.json").read_text(encoding="utf-8"))
    initial_asset_id = manifest1["assets"]["pois"]

    pois_file2 = tmp_path / "pois2.json"
    pois_file2.write_text(json.dumps(make_sample_pois(scene_id, "Desk 2 Updated"), indent=2), encoding="utf-8")
    attach_pois(temp_scene, pois_file2)

    manifest2 = json.loads((temp_scene / "manifest.json").read_text(encoding="utf-8"))
    assert manifest2["assets"]["pois"] == initial_asset_id
    assert manifest2["asset_table"][initial_asset_id]["bytes"] == (temp_scene / "pois.json").stat().st_size


def test_wrong_scene_id_fails(temp_scene: Path, tmp_path: Path):
    wrong_pois = tmp_path / "wrong_scene.json"
    wrong_data = make_sample_pois(scene_id="scn_diffrent2233")
    wrong_pois.write_text(json.dumps(wrong_data, indent=2), encoding="utf-8")

    with pytest.raises(SystemExit) as exc_info:
        attach_pois(temp_scene, wrong_pois, fix_scene_id=False)
    assert "Scene ID mismatch" in str(exc_info.value)


def test_fix_scene_id_works(temp_scene: Path, tmp_path: Path):
    wrong_pois = tmp_path / "wrong_scene_fix.json"
    wrong_data = make_sample_pois(scene_id="scn_diffrent2233")
    wrong_pois.write_text(json.dumps(wrong_data, indent=2), encoding="utf-8")

    attach_pois(temp_scene, wrong_pois, fix_scene_id=True)

    dest_pois = json.loads((temp_scene / "pois.json").read_text(encoding="utf-8"))
    expected_scene_id = "scn_23j7x56k3y7a"
    assert dest_pois["scene_id"] == expected_scene_id
    assert dest_pois["pois"][0]["scene_id"] == expected_scene_id


def test_invalid_poi_empty_name_fails(temp_scene: Path, tmp_path: Path):
    invalid_pois = tmp_path / "invalid_name.json"
    invalid_data = make_sample_pois(scene_id="scn_23j7x56k3y7a", poi_name="")
    invalid_pois.write_text(json.dumps(invalid_data, indent=2), encoding="utf-8")

    with pytest.raises(ValidationError):
        attach_pois(temp_scene, invalid_pois)


def test_invalid_poi_bad_id_fails(temp_scene: Path, tmp_path: Path):
    invalid_pois = tmp_path / "bad_id.json"
    data = make_sample_pois(scene_id="scn_23j7x56k3y7a")
    data["pois"][0]["poi_id"] = "poi_1invalid099!"
    invalid_pois.write_text(json.dumps(data, indent=2), encoding="utf-8")

    with pytest.raises(ValidationError):
        attach_pois(temp_scene, invalid_pois)


def test_check_pois_with_grid(temp_scene: Path, tmp_path: Path, capsys):
    scene_id = "scn_23j7x56k3y7a"
    pois_file = tmp_path / "check_pois.json"
    pois_file.write_text(json.dumps(make_sample_pois(scene_id), indent=2), encoding="utf-8")
    attach_pois(temp_scene, pois_file)

    # Copy navgrid fixture into temp_scene
    navgrid_src = FIXTURES_DIR / "navgrid_valid.json"
    (temp_scene / "grid.json").write_text(navgrid_src.read_text(encoding="utf-8"), encoding="utf-8")

    check_pois(temp_scene)
    captured = capsys.readouterr()
    assert "Scene: scn_23j7x56k3y7a (1 POIs)" in captured.out
    assert "Meeting Table" in captured.out
