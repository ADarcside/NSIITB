"""
Namma Space: Pipeline Data Contract Validator (Phase 1)
Validates Capture, SceneManifest, and NavGrid against JSON Schemas in pipeline/schemas/
(authored via scripts/generate_schemas.mjs mirroring the TypeScript contract definitions).
Uses jsonschema library (pinned per Hard Rule 2).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import jsonschema
from jsonschema import Draft7Validator


class ValidationError(Exception):
    """Raised when data fails schema or semantic validation."""

    def __init__(self, message: str, errors: list[str] | None = None):
        super().__init__(message)
        self.errors = errors or [message]


_SCHEMAS_DIR = Path(__file__).resolve().parent / "schemas"


def _load_schema(schema_filename: str) -> dict[str, Any]:
    schema_path = _SCHEMAS_DIR / schema_filename
    if not schema_path.exists():
        raise FileNotFoundError(f"Schema file not found: {schema_path}")
    with open(schema_path, "r", encoding="utf-8") as f:
        return json.load(f)


_CAPTURE_SCHEMA = _load_schema("capture.schema.json")
_MANIFEST_SCHEMA = _load_schema("manifest.schema.json")
_NAVGRID_SCHEMA = _load_schema("navgrid.schema.json")
_POIS_SCHEMA = _load_schema("pois.schema.json")

_CAPTURE_VALIDATOR = Draft7Validator(_CAPTURE_SCHEMA)
_MANIFEST_VALIDATOR = Draft7Validator(_MANIFEST_SCHEMA)
_NAVGRID_VALIDATOR = Draft7Validator(_NAVGRID_SCHEMA)
_POIS_VALIDATOR = Draft7Validator(_POIS_SCHEMA)


def is_valid_schema_capture(data: dict[str, Any]) -> bool:
    """Return True if data satisfies capture.schema.json alone."""
    return isinstance(data, dict) and _CAPTURE_VALIDATOR.is_valid(data)


def is_valid_schema_manifest(data: dict[str, Any]) -> bool:
    """Return True if data satisfies manifest.schema.json alone."""
    return isinstance(data, dict) and _MANIFEST_VALIDATOR.is_valid(data)


def is_valid_schema_navgrid(data: dict[str, Any]) -> bool:
    """Return True if data satisfies navgrid.schema.json alone."""
    return isinstance(data, dict) and _NAVGRID_VALIDATOR.is_valid(data)


def is_valid_schema_pois(data: dict[str, Any]) -> bool:
    """Return True if data satisfies pois.schema.json alone."""
    return isinstance(data, dict) and _POIS_VALIDATOR.is_valid(data)


def _format_error(e: jsonschema.ValidationError) -> str:
    path = ".".join(str(p) for p in e.path)
    if path:
        return f"{path}: {e.message}"
    return e.message


def validate_capture(data: dict[str, Any]) -> None:
    """
    Validate a capture metadata dictionary against capture.schema.json.
    Raises ValidationError if invalid.
    """
    if not isinstance(data, dict):
        raise ValidationError("Capture data must be a dictionary")

    errors = [_format_error(e) for e in _CAPTURE_VALIDATOR.iter_errors(data)]
    if errors:
        raise ValidationError(
            f"Capture validation failed:\n- " + "\n- ".join(errors),
            errors=errors,
        )


def is_valid_capture(data: dict[str, Any]) -> bool:
    """Return True if capture data is valid, False otherwise."""
    try:
        validate_capture(data)
        return True
    except ValidationError:
        return False


def validate_manifest(data: dict[str, Any]) -> None:
    """
    Validate a scene manifest dictionary against manifest.schema.json.
    Also validates semantic rules (assets consistency, bounds ordering).
    Raises ValidationError if invalid.
    """
    if not isinstance(data, dict):
        raise ValidationError("SceneManifest data must be a dictionary")

    errors = [_format_error(e) for e in _MANIFEST_VALIDATOR.iter_errors(data)]

    # Semantic cross-field validations
    if "bounds" in data and isinstance(data["bounds"], dict):
        bounds = data["bounds"]
        min_x = bounds.get("minX")
        max_x = bounds.get("maxX")
        min_z = bounds.get("minZ")
        max_z = bounds.get("maxZ")
        if isinstance(min_x, (int, float)) and isinstance(max_x, (int, float)) and min_x > max_x:
            errors.append(f"bounds.minX ({min_x}) cannot be greater than bounds.maxX ({max_x})")
        if isinstance(min_z, (int, float)) and isinstance(max_z, (int, float)) and min_z > max_z:
            errors.append(f"bounds.minZ ({min_z}) cannot be greater than bounds.maxZ ({max_z})")

        # Cross-check: start_pose must fall within bounds
        if "start_pose" in data and isinstance(data["start_pose"], dict):
            start_pose = data["start_pose"]
            x = start_pose.get("x")
            z = start_pose.get("z")
            if isinstance(min_x, (int, float)) and isinstance(max_x, (int, float)) and isinstance(x, (int, float)):
                if x < min_x or x > max_x:
                    errors.append(f"start_pose.x ({x}) is outside bounds [minX: {min_x}, maxX: {max_x}]")
            if isinstance(min_z, (int, float)) and isinstance(max_z, (int, float)) and isinstance(z, (int, float)):
                if z < min_z or z > max_z:
                    errors.append(f"start_pose.z ({z}) is outside bounds [minZ: {min_z}, maxZ: {max_z}]")

    if "assets" in data and "asset_table" in data:
        assets = data["assets"]
        asset_table = data["asset_table"]
        if isinstance(assets, dict) and isinstance(asset_table, dict):
            for ref_name in ("full", "lite", "grid", "pois"):
                asset_id = assets.get(ref_name)
                if asset_id and asset_id not in asset_table:
                    errors.append(f"asset_table is missing referenced asset '{ref_name}': {asset_id}")

    if errors:
        raise ValidationError(
            f"SceneManifest validation failed:\n- " + "\n- ".join(errors),
            errors=errors,
        )


def is_valid_manifest(data: dict[str, Any]) -> bool:
    """Return True if manifest data is valid, False otherwise."""
    try:
        validate_manifest(data)
        return True
    except ValidationError:
        return False


def validate_navgrid(data: dict[str, Any]) -> None:
    """
    Validate a navgrid dictionary against navgrid.schema.json.
    Raises ValidationError if invalid.
    """
    if not isinstance(data, dict):
        raise ValidationError("NavGrid data must be a dictionary")

    errors = [_format_error(e) for e in _NAVGRID_VALIDATOR.iter_errors(data)]
    if errors:
        raise ValidationError(
            f"NavGrid validation failed:\n- " + "\n- ".join(errors),
            errors=errors,
        )


def is_valid_navgrid(data: dict[str, Any]) -> bool:
    """Return True if navgrid data is valid, False otherwise."""
    try:
        validate_navgrid(data)
        return True
    except ValidationError:
        return False


def load_and_validate_capture(file_path: str | Path) -> dict[str, Any]:
    """Load JSON from path and validate as Capture."""
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    validate_capture(data)
    return data


def load_and_validate_manifest(file_path: str | Path) -> dict[str, Any]:
    """Load JSON from path and validate as SceneManifest."""
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    validate_manifest(data)
    return data


def load_and_validate_navgrid(file_path: str | Path) -> dict[str, Any]:
    """Load JSON from path and validate as NavGrid."""
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    validate_navgrid(data)
    return data


def validate_pois(data: dict[str, Any]) -> None:
    """
    Validate a points of interest dictionary against pois.schema.json.
    Raises ValidationError if invalid.
    """
    if not isinstance(data, dict):
        raise ValidationError("PoiSet data must be a dictionary")

    errors = [_format_error(e) for e in _POIS_VALIDATOR.iter_errors(data)]
    if errors:
        raise ValidationError(
            f"PoiSet validation failed:\n- " + "\n- ".join(errors),
            errors=errors,
        )


def is_valid_pois(data: dict[str, Any]) -> bool:
    """Return True if POI data is valid, False otherwise."""
    try:
        validate_pois(data)
        return True
    except ValidationError:
        return False


def load_and_validate_pois(file_path: str | Path) -> dict[str, Any]:
    """Load JSON from path and validate as PoiSet."""
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    validate_pois(data)
    return data

