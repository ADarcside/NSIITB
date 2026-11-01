"""
Namma Space: Pipeline Contracts & Schema Validation Test Suite (Phase 1)
Tests Capture, SceneManifest, and NavGrid validation using pytest and jsonschema.
Includes cross-validator parity verification driven by tests/fixtures/expected.json.
"""

import json
from pathlib import Path
import pytest

from pipeline.validator import (
    ValidationError,
    validate_capture,
    is_valid_capture,
    is_valid_schema_capture,
    validate_manifest,
    is_valid_manifest,
    is_valid_schema_manifest,
    validate_navgrid,
    is_valid_navgrid,
    is_valid_schema_navgrid,
    validate_pois,
    is_valid_pois,
    is_valid_schema_pois,
    load_and_validate_capture,
    load_and_validate_manifest,
    load_and_validate_navgrid,
    load_and_validate_pois,
)

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"


def load_fixture(name: str) -> dict:
    file_path = FIXTURES_DIR / name
    with open(file_path, "r", encoding="utf-8") as f:
        return json.load(f)


def test_cross_validator_parity_all_fixtures():
    """
    Parity test: Reads tests/fixtures/expected.json and asserts that pipeline
    validator yields the exact expected verdict for every single fixture file.
    """
    expected_path = FIXTURES_DIR / "expected.json"
    with open(expected_path, "r", encoding="utf-8") as f:
        expected_items = json.load(f)

    assert len(expected_items) >= 15, "Expected at least 15 test fixtures in expected.json"

    for item in expected_items:
        filename = item["fixture"]
        contract = item["contract"]
        expected_valid = item["expected_valid"]

        data = load_fixture(filename)

        if contract == "Capture":
            schema_valid = is_valid_schema_capture(data)
            full_valid = is_valid_capture(data)
        elif contract == "SceneManifest":
            schema_valid = is_valid_schema_manifest(data)
            full_valid = is_valid_manifest(data)
        elif contract == "NavGrid":
            schema_valid = is_valid_schema_navgrid(data)
            full_valid = is_valid_navgrid(data)
        elif contract == "PoiSet":
            schema_valid = is_valid_schema_pois(data)
            full_valid = is_valid_pois(data)
        else:
            pytest.fail(f"Unknown contract type in expected.json: {contract}")

        assert full_valid == expected_valid, (
            f"Parity mismatch for fixture '{filename}' ({contract}): "
            f"expected {expected_valid}, got {full_valid}. Description: {item['description']}"
        )

        check_layer = item.get("check_layer")
        if check_layer == "semantic":
            assert schema_valid is True, (
                f"Fixture '{filename}' is marked 'semantic' check_layer but was rejected by JSON Schema alone."
            )
            assert full_valid is False, (
                f"Fixture '{filename}' is marked 'semantic' check_layer but was accepted by full validator."
            )
        elif check_layer == "schema":
            assert schema_valid is False, (
                f"Fixture '{filename}' is marked 'schema' check_layer but was accepted by JSON Schema alone."
            )
            assert full_valid is False, (
                f"Fixture '{filename}' is marked 'schema' check_layer but was accepted by full validator."
            )
        elif expected_valid is True:
            assert schema_valid is True, (
                f"Fixture '{filename}' is valid but was rejected by JSON Schema alone."
            )
            assert full_valid is True


class TestCaptureContract:
    def test_valid_capture(self):
        data = load_fixture("capture_valid.json")
        validate_capture(data)
        assert is_valid_capture(data) is True

    def test_load_and_validate_capture(self):
        file_path = FIXTURES_DIR / "capture_valid.json"
        data = load_and_validate_capture(file_path)
        assert data["schema_version"] == 1
        assert data["capture_id"] == "cap_23j7x42k7z5b"

    def test_invalid_schema_version(self):
        data = load_fixture("capture_invalid_version.json")
        assert is_valid_capture(data) is False
        with pytest.raises(ValidationError) as exc_info:
            validate_capture(data)
        assert any("schema_version" in err or "1" in err for err in exc_info.value.errors)

    def test_invalid_capture_id(self):
        data = load_fixture("capture_invalid_id.json")
        assert is_valid_capture(data) is False
        with pytest.raises(ValidationError) as exc_info:
            validate_capture(data)
        assert any("capture_id" in err or "pattern" in err for err in exc_info.value.errors)

    def test_missing_required_fields(self):
        data = load_fixture("capture_invalid_missing_fields.json")
        assert is_valid_capture(data) is False
        with pytest.raises(ValidationError) as exc_info:
            validate_capture(data)
        assert len(exc_info.value.errors) > 0


class TestSceneManifestContract:
    def test_valid_manifest(self):
        data = load_fixture("manifest_valid.json")
        validate_manifest(data)
        assert is_valid_manifest(data) is True

    def test_valid_manifest_null_scale_check(self):
        data = load_fixture("manifest_valid_null_scale_check.json")
        validate_manifest(data)
        assert is_valid_manifest(data) is True
        assert data["transform"]["residuals"]["scale_check_error_pct"] is None

    def test_load_and_validate_manifest(self):
        file_path = FIXTURES_DIR / "manifest_valid.json"
        data = load_and_validate_manifest(file_path)
        assert data["schema_version"] == 1
        assert data["scene_id"] == "scn_23j7x56k3y7a"
        assert len(data["transform"]["world_from_splat"]) == 16

    def test_missing_referenced_full_asset(self):
        data = load_fixture("manifest_invalid_assets.json")
        assert is_valid_manifest(data) is False
        with pytest.raises(ValidationError) as exc_info:
            validate_manifest(data)
        assert any("missing referenced asset" in err or "asset_table" in err for err in exc_info.value.errors)

    def test_missing_referenced_lite_asset(self):
        data = load_fixture("manifest_invalid_missing_lite_asset.json")
        assert is_valid_manifest(data) is False
        with pytest.raises(ValidationError) as exc_info:
            validate_manifest(data)
        assert any("missing referenced asset 'lite'" in err for err in exc_info.value.errors)

    def test_invalid_transform_matrix_length(self):
        data = load_fixture("manifest_invalid_transform.json")
        assert is_valid_manifest(data) is False
        with pytest.raises(ValidationError) as exc_info:
            validate_manifest(data)
        assert any("world_from_splat" in err or "items" in err for err in exc_info.value.errors)

    def test_inverted_bounds(self):
        data = load_fixture("manifest_invalid_bounds.json")
        assert is_valid_manifest(data) is False
        with pytest.raises(ValidationError) as exc_info:
            validate_manifest(data)
        assert any("bounds.minX" in err and "greater than" in err for err in exc_info.value.errors)

    def test_invalid_sha256_checksum(self):
        data = load_fixture("manifest_invalid_sha256.json")
        assert is_valid_manifest(data) is False
        with pytest.raises(ValidationError) as exc_info:
            validate_manifest(data)
        assert any("sha256" in err or "pattern" in err for err in exc_info.value.errors)

    def test_invalid_asset_kind(self):
        data = load_fixture("manifest_invalid_asset_kind.json")
        assert is_valid_manifest(data) is False
        with pytest.raises(ValidationError) as exc_info:
            validate_manifest(data)
        assert any("kind" in err or "enum" in err for err in exc_info.value.errors)

    def test_start_pose_outside_bounds(self):
        data = load_fixture("manifest_invalid_start_pose_bounds.json")
        assert is_valid_manifest(data) is False
        with pytest.raises(ValidationError) as exc_info:
            validate_manifest(data)
        assert any("start_pose.x" in err and "outside bounds" in err for err in exc_info.value.errors)

    def test_generated_dev_scene_manifest_valid(self):
        """
        Validates that viewer/public/dev/manifest.json adheres to schema
        and semantic validator rules (RFC 4648 12-char base32 IDs, bounds, assets).
        """
        dev_manifest_path = Path(__file__).resolve().parent.parent.parent / "viewer" / "public" / "dev" / "manifest.json"
        assert dev_manifest_path.exists(), "viewer/public/dev/manifest.json should exist"
        data = load_and_validate_manifest(dev_manifest_path)
        assert data["schema_version"] == 1
        assert is_valid_manifest(data) is True

    def test_dev_scene_spz_magic_bytes(self):
        """
        Validates that all .spz files generated in viewer/public/dev start with
        the gzip magic bytes 0x1f 0x8b (SPZ v3 format required by Spark 2.3.1).
        """
        dev_dir = Path(__file__).resolve().parent.parent.parent / "viewer" / "public" / "dev"
        spz_files = list(dev_dir.glob("*.spz"))
        assert len(spz_files) >= 2, "Expected at least dev_full.spz and dev_lite.spz"
        for spz_path in spz_files:
            with open(spz_path, "rb") as f:
                header = f.read(2)
            assert header == b"\x1f\x8b", (
                f"{spz_path.name} magic header is {header.hex()}, expected 1f8b (gzip-wrapped SPZ v3). "
                "Spark 2.3.1 cannot decode uncompressed SPZ v4 (NGSP header)."
            )


class TestNavGridContract:
    def test_valid_navgrid(self):
        data = load_fixture("navgrid_valid.json")
        validate_navgrid(data)
        assert is_valid_navgrid(data) is True

    def test_load_and_validate_navgrid(self):
        file_path = FIXTURES_DIR / "navgrid_valid.json"
        data = load_and_validate_navgrid(file_path)
        assert data["schema_version"] == 1
        assert data["cell_m"] == 0.05
        assert data["nav_id"] == "nav_23j7x72k3w3c"

    def test_invalid_base64_bitstring(self):
        data = load_fixture("navgrid_invalid_base64.json")
        assert is_valid_navgrid(data) is False
        with pytest.raises(ValidationError) as exc_info:
            validate_navgrid(data)
        assert any("free_bits_b64" in err or "pattern" in err for err in exc_info.value.errors)

    def test_invalid_origin_dimension(self):
        data = load_fixture("navgrid_invalid_origin.json")
        assert is_valid_navgrid(data) is False
        with pytest.raises(ValidationError) as exc_info:
            validate_navgrid(data)
        assert any("origin" in err or "items" in err for err in exc_info.value.errors)


class TestPoiSetContract:
    def test_valid_pois(self):
        data = load_fixture("pois_valid.json")
        validate_pois(data)
        assert is_valid_pois(data) is True

    def test_load_and_validate_pois(self):
        file_path = FIXTURES_DIR / "pois_valid.json"
        data = load_and_validate_pois(file_path)
        assert data["schema_version"] == 1
        assert data["scene_id"] == "scn_testroomaa34"
        assert len(data["pois"]) == 2

    def test_invalid_name(self):
        data = load_fixture("pois_invalid_name.json")
        assert is_valid_pois(data) is False
        with pytest.raises(ValidationError) as exc_info:
            validate_pois(data)
        assert any("name" in err for err in exc_info.value.errors)

