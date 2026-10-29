"""
Namma Space: Unit Tests for Pipeline Stages S07 & S08 (Gates G7 & G8)
Uses synthetic PLY and synthetic transform.json ONLY.
Explicitly labelled SYNTHETIC per Hard Rule 1.
"""

from __future__ import annotations

import json
from pathlib import Path
import pytest
import numpy as np

from pipeline.common import GateFailure
from pipeline.stages.s05_export import write_synthetic_ply, EXPECTED_PROPERTIES_ORDER
from pipeline.stages.s07_compress import (
    run_s07_compress,
    select_lite_gaussians,
    check_spz_magic,
)
from pipeline.stages.s08_manifest import (
    run_s08_manifest,
    build_manifest_data,
)
from pipeline.validator import validate_manifest


def make_synthetic_transform_json(
    path: Path,
    scale_check_error_pct: float | None = None,
) -> None:
    """Writes a valid synthetic transform.json for testing."""
    path.parent.mkdir(parents=True, exist_ok=True)
    transform_data = {
        "schema_version": 1,
        "synthetic": True,
        "world_from_splat": [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0,
        ],
        "scale": 1.0,
        "method": "floor_ransac+tape_pair",
        "residuals": {
            "floor_rms_m": 0.015,
            "scale_check_error_pct": scale_check_error_pct,
        },
        "start_pose_hint": {
            "x": 0.1,
            "z": 0.2,
        },
        "bounds": {
            "minX": -2.0,
            "maxX": 2.0,
            "minZ": -2.0,
            "maxZ": 2.0,
        },
        "metrics": {
            "synthetic": True,
        },
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(transform_data, f, indent=2)


class TestS07LiteRanking:
    def test_lite_ranking_by_opacity_and_volume(self):
        """
        Tests that select_lite_gaussians ranks strictly by:
        sigmoid(opacity) * exp(scale_0 + scale_1 + scale_2)
        and is never random.
        """
        # 4 Gaussians:
        # G0: high opacity (raw 5.0 -> sigmoid ~0.99), big scale (0, 0, 0 -> vol 1.0) => ~0.99
        # G1: low opacity (raw -5.0 -> sigmoid ~0.007), big scale (0, 0, 0 -> vol 1.0) => ~0.007
        # G2: high opacity (raw 5.0 -> sigmoid ~0.99), huge scale (1, 1, 1 -> vol e^3 ~20.08) => ~19.95 (#1)
        # G3: high opacity (raw 5.0 -> sigmoid ~0.99), tiny scale (-5, -5, -5 -> vol e^-15 ~3e-7) => ~3e-7
        num_gaussians = 4
        prop_names = list(EXPECTED_PROPERTIES_ORDER)
        idx = {name: i for i, name in enumerate(prop_names)}
        data = np.zeros((num_gaussians, len(prop_names)), dtype="<f4")

        # G0
        data[0, idx["opacity"]] = 5.0
        data[0, idx["scale_0"]] = 0.0
        data[0, idx["scale_1"]] = 0.0
        data[0, idx["scale_2"]] = 0.0

        # G1
        data[1, idx["opacity"]] = -5.0
        data[1, idx["scale_0"]] = 0.0
        data[1, idx["scale_1"]] = 0.0
        data[1, idx["scale_2"]] = 0.0

        # G2
        data[2, idx["opacity"]] = 5.0
        data[2, idx["scale_0"]] = 1.0
        data[2, idx["scale_1"]] = 1.0
        data[2, idx["scale_2"]] = 1.0

        # G3
        data[3, idx["opacity"]] = 5.0
        data[3, idx["scale_0"]] = -5.0
        data[3, idx["scale_1"]] = -5.0
        data[3, idx["scale_2"]] = -5.0

        # Top 50% (k=2) should be G2 then G0
        top_2 = select_lite_gaussians(data, prop_names, lite_fraction=0.5)
        assert len(top_2) == 2
        assert top_2[0] == 2  # G2 is rank 1
        assert top_2[1] == 0  # G0 is rank 2

        # Determinism check: running multiple times yields exact same order
        for _ in range(5):
            res = select_lite_gaussians(data, prop_names, lite_fraction=0.5)
            np.testing.assert_array_equal(res, top_2)


class TestS07CompressStage:
    def test_s07_synthetic_ply_compression(self, tmp_path):
        """
        Converts synthetic clean.ply to full.spz and lite.spz.
        Checks magic bytes (0x1f 0x8b) and Gaussian counts.
        """
        run_dir = tmp_path / "test_run_s07"
        run_dir.mkdir(parents=True, exist_ok=True)
        clean_ply = run_dir / "clean.ply"
        write_synthetic_ply(clean_ply, num_gaussians=50)

        # Mock capture_ok.json for capture_id
        cap_ok = run_dir / "capture_ok.json"
        cap_ok.write_text(json.dumps({
            "schema_version": 1,
            "capture": {
                "capture_id": "cap_testscene23a",
            }
        }))

        res = run_s07_compress(run_dir=run_dir)
        scene_id = res["scene_id"]
        assert scene_id == "scn_testscene23a"

        full_spz = run_dir / "publish" / scene_id / "full.spz"
        lite_spz = run_dir / "publish" / scene_id / "lite.spz"

        assert full_spz.is_file()
        assert lite_spz.is_file()

        # Check gzip magic 0x1f 0x8b
        check_spz_magic(full_spz)
        check_spz_magic(lite_spz)

        assert res["full_gaussians"] == 50
        # 50 * 0.4 = 20
        assert res["lite_gaussians"] == 20

    def test_s07_gate_g7_size_limit_failure(self, tmp_path):
        """
        Tests that Gate G7 fails loudly if size exceeds the threshold.
        """
        run_dir = tmp_path / "test_run_s07_fail"
        run_dir.mkdir(parents=True, exist_ok=True)
        clean_ply = run_dir / "clean.ply"
        write_synthetic_ply(clean_ply, num_gaussians=30)

        cap_ok = run_dir / "capture_ok.json"
        cap_ok.write_text(json.dumps({
            "schema_version": 1,
            "capture": {"capture_id": "cap_testscene23b"}
        }))

        # Create config with impossibly small max_full_mb (e.g. 0.000001 MB)
        cfg_path = run_dir / "config.yaml"
        cfg_path.write_text(
            "compress:\n"
            "  max_full_mb: 0.000001\n"
            "  max_lite_mb: 30\n"
        )

        with pytest.raises(GateFailure) as exc_info:
            run_s07_compress(run_dir=run_dir, config_path=cfg_path)

        assert exc_info.value.gate == "G7"
        assert "exceeds maximum allowed" in exc_info.value.message


class TestS08ManifestStage:
    def test_s08_manifest_generation_and_validation(self, tmp_path):
        """
        Tests that S08 generates a compliant manifest with real sha256 and sizes,
        validates against manifest.schema.json, and handles null scale_check_error_pct.
        """
        run_dir = tmp_path / "test_run_s08"
        run_dir.mkdir(parents=True, exist_ok=True)
        clean_ply = run_dir / "clean.ply"
        write_synthetic_ply(clean_ply, num_gaussians=40)

        cap_ok = run_dir / "capture_ok.json"
        cap_ok.write_text(json.dumps({
            "schema_version": 1,
            "capture": {
                "capture_id": "cap_testscene23c",
                "space_id": "spc_testscene23c",
            }
        }))

        # Run S07 first
        s07_res = run_s07_compress(run_dir=run_dir)
        scene_id = s07_res["scene_id"]

        # Write synthetic transform.json with null scale_check_error_pct
        transform_path = run_dir / "transform.json"
        make_synthetic_transform_json(transform_path, scale_check_error_pct=None)

        s08_res = run_s08_manifest(run_dir=run_dir)
        manifest_path = s08_res["manifest_path"]
        assert manifest_path.is_file()

        manifest_data = json.loads(manifest_path.read_text())
        assert manifest_data["schema_version"] == 1
        assert manifest_data["scene_id"] == scene_id
        assert manifest_data["space_id"] == "spc_testscene23c"
        assert manifest_data["transform"]["residuals"]["scale_check_error_pct"] is None
        assert manifest_data["eye_height_m"] == 1.5

        # Verify against pipeline Python validator
        validate_manifest(manifest_data)

        # Asset checks
        full_asset_id = manifest_data["assets"]["full"]
        lite_asset_id = manifest_data["assets"]["lite"]
        assert full_asset_id in manifest_data["asset_table"]
        assert lite_asset_id in manifest_data["asset_table"]

        assert manifest_data["asset_table"][full_asset_id]["gaussians"] == 40
        assert manifest_data["asset_table"][lite_asset_id]["gaussians"] == 16
        assert len(manifest_data["asset_table"][full_asset_id]["sha256"]) == 64
        assert len(manifest_data["asset_table"][lite_asset_id]["sha256"]) == 64

    def test_s08_adds_navgrid_asset(self, tmp_path):
        """A navgrid.json from S06 becomes publish/<scene>/grid.json and a 'grid' asset in the manifest."""
        from pipeline import grid as navgrid

        run_dir = tmp_path / "test_run_s08_grid"
        run_dir.mkdir(parents=True, exist_ok=True)
        write_synthetic_ply(run_dir / "clean.ply", num_gaussians=40)
        (run_dir / "capture_ok.json").write_text(json.dumps({
            "schema_version": 1,
            "capture": {"capture_id": "cap_testscene23c", "space_id": "spc_testscene23c"},
        }))
        scene_id = run_s07_compress(run_dir=run_dir)["scene_id"]
        make_synthetic_transform_json(run_dir / "transform.json", scale_check_error_pct=None)
        free = np.zeros((20, 30), dtype=bool)
        free[5:15, 5:25] = True
        (run_dir / "navgrid.json").write_text(json.dumps({
            "cell_m": 0.05, "origin": [-1.0, -0.75], "width": 30, "height": 20, "agent_radius_m": 0.25,
            "free_bits_b64": navgrid.encode_free_bits(free),
        }))

        manifest = json.loads(run_s08_manifest(run_dir=run_dir)["manifest_path"].read_text())
        validate_manifest(manifest)
        grid_entry = manifest["asset_table"][manifest["assets"]["grid"]]
        assert grid_entry["kind"] == "grid" and grid_entry["uri"] == "grid.json"
        grid_doc = json.loads((run_dir / "publish" / scene_id / "grid.json").read_text())
        assert grid_doc["transform_scene"] == scene_id
        assert grid_doc["nav_id"] == "nav_" + scene_id[4:]
        assert (navgrid.decode_free_bits(grid_doc["free_bits_b64"], 30, 20) == free).all()
