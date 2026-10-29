"""
Namma Space: Pipeline Stage S08 - Scene Manifest Generation & Validation (Gate G8)
SPEC Section 8 & Section 9:
- Writes <run>/publish/<scene_id>/manifest.json matching pipeline/schemas/manifest.schema.json
- Records real SHA-256 digests, byte sizes, and Gaussian counts for full.spz and lite.spz
- Copies world_from_splat, scale, method, and residuals from <run>/transform.json
- Contract rule: residuals.scale_check_error_pct is null when there are no tape marks
  (never write a made-up number)
- start_pose: x, z from start_pose_hint, yaw_deg 0.0, eye_height_m 1.5, bounds from transform.json
- Validates against pipeline/validator.py and viewer's TypeScript contract validator
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any, Dict, Optional, Tuple, Union

import jsonschema

from pipeline.common import (
    derive_ids,
    fail_gate,
    load_config,
    record_stage_result,
    sha256_file,
    should_skip_stage,
)
from pipeline.stages.s05_export import read_ply_gaussian_header
from pipeline.stages.s07_compress import find_capture_id
from pipeline.validator import validate_manifest, ValidationError


def validate_with_ts_validator(manifest_path: Path) -> Tuple[bool, Optional[str]]:
    """
    Validates manifest using viewer's TypeScript contract validator (viewer/src/contracts/validator.ts).
    Uses npx tsx to execute the TypeScript validator directly.
    """
    repo_root = Path(__file__).resolve().parent.parent.parent
    js_code = (
        "import fs from 'node:fs';\n"
        "import path from 'node:path';\n"
        "import { validateSceneManifest } from './viewer/src/contracts/validator.ts';\n"
        f"const manifestPath = path.resolve({json.dumps(str(manifest_path.resolve()))});\n"
        "const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));\n"
        "const res = validateSceneManifest(data);\n"
        "if (!res.valid) {\n"
        "  console.error((res.errors || []).join('\\n'));\n"
        "  process.exit(1);\n"
        "} else {\n"
        "  console.log('TS_VALIDATOR_OK');\n"
        "}\n"
    )
    cmd = ["npx", "-y", "tsx@4.19.2", "-e", js_code]  # pinned (Hard Rule 2)
    try:
        res = subprocess.run(cmd, cwd=str(repo_root), capture_output=True, text=True, timeout=600)
        if res.returncode == 0 and "TS_VALIDATOR_OK" in res.stdout:
            return True, None
        return False, res.stderr or res.stdout
    except Exception as e:
        return False, str(e)


def build_manifest_data(
    run_dir: Path,
    scene_id: str,
    space_id: str,
    job_id: str,
    full_asset_id: str,
    lite_asset_id: str,
    full_spz: Path,
    lite_spz: Path,
    transform_data: Dict[str, Any],
    full_gaussians: int,
    lite_gaussians: int,
) -> Dict[str, Any]:
    """Constructs the dictionary adhering to pipeline/schemas/manifest.schema.json."""
    full_bytes = full_spz.stat().st_size
    full_sha256 = sha256_file(full_spz)

    lite_bytes = lite_spz.stat().st_size
    lite_sha256 = sha256_file(lite_spz)

    bounds = transform_data["bounds"]
    min_x = float(bounds["minX"])
    max_x = float(bounds["maxX"])
    min_z = float(bounds["minZ"])
    max_z = float(bounds["maxZ"])

    # start_pose hint clamped safely to room bounds
    hint_x = float(transform_data.get("start_pose_hint", {}).get("x", 0.0))
    hint_z = float(transform_data.get("start_pose_hint", {}).get("z", 0.0))
    start_x = max(min_x, min(max_x, hint_x))
    start_z = max(min_z, min(max_z, hint_z))

    residuals = transform_data.get("residuals", {})
    scale_check_pct = residuals.get("scale_check_error_pct")
    if scale_check_pct is not None:
        scale_check_pct = float(scale_check_pct)

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    manifest = {
        "schema_version": 1,
        "scene_id": scene_id,
        "space_id": space_id,
        "version": 1,
        "created_at": now_iso,
        "job_id": job_id,
        "assets": {
            "full": full_asset_id,
            "lite": lite_asset_id,
        },
        "asset_table": {
            full_asset_id: {
                "schema_version": 1,
                "asset_id": full_asset_id,
                "kind": "splat_full",
                "format": "spz",
                "uri": "full.spz",
                "sha256": full_sha256,
                "bytes": full_bytes,
                "gaussians": full_gaussians,
            },
            lite_asset_id: {
                "schema_version": 1,
                "asset_id": lite_asset_id,
                "kind": "splat_lite",
                "format": "spz",
                "uri": "lite.spz",
                "sha256": lite_sha256,
                "bytes": lite_bytes,
                "gaussians": lite_gaussians,
            },
        },
        "transform": {
            "world_from_splat": [float(v) for v in transform_data["world_from_splat"]],
            "scale": float(transform_data["scale"]),
            "method": transform_data.get("method", "floor_ransac+tape_pair"),
            "residuals": {
                "floor_rms_m": float(residuals.get("floor_rms_m", 0.0)),
                "scale_check_error_pct": scale_check_pct,
            },
        },
        "start_pose": {
            "x": round(start_x, 4),
            "z": round(start_z, 4),
            "yaw_deg": 0.0,
        },
        "eye_height_m": 1.5,
        "bounds": {
            "minX": min_x,
            "maxX": max_x,
            "minZ": min_z,
            "maxZ": max_z,
        },
    }
    return manifest


def run_s08_manifest(
    run_dir: Union[str, Path],
    config_path: Optional[Union[str, Path]] = None,
    capture_json_path: Optional[Union[str, Path]] = None,
    scene_id_override: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Executes pipeline stage S08 (Gate G8).
    Writes <run>/publish/<scene_id>/manifest.json and validates against schemas.
    """
    start_time = time.time()
    r_dir = Path(run_dir)
    report_path = r_dir / "run_report.json"
    transform_path = r_dir / "transform.json"

    config, config_hash = load_config(config_path)

    def fail(measured: Any, threshold: Any, message: str, metrics: Optional[Dict[str, Any]] = None) -> None:
        fail_gate(
            gate="G8",
            stage="s08_manifest",
            measured=measured,
            threshold=threshold,
            message=message,
            report_path=report_path,
            duration_s=time.time() - start_time,
            config_hash=config_hash,
            metrics=metrics,
        )

    if not transform_path.is_file():
        fail("transform.json missing", "transform.json exists from S06", f"Missing file: {transform_path}")

    capture_id = find_capture_id(r_dir, capture_json_path)
    # Check space_id in capture if present
    space_id_hint = None
    if capture_json_path and Path(capture_json_path).is_file():
        try:
            c = json.loads(Path(capture_json_path).read_text(encoding="utf-8"))
            space_id_hint = c.get("space_id")
        except Exception:
            pass

    scene_id, space_id, job_id, full_asset_id, lite_asset_id = derive_ids(capture_id, space_id_hint)
    if scene_id_override:
        scene_id = scene_id_override

    publish_dir = r_dir / "publish" / scene_id
    full_spz = publish_dir / "full.spz"
    lite_spz = publish_dir / "lite.spz"
    manifest_path = publish_dir / "manifest.json"

    if not full_spz.is_file() or not lite_spz.is_file():
        fail("SPZ assets missing", "full.spz and lite.spz exist from S07", f"Missing assets in {publish_dir}")

    navgrid_path = r_dir / "navgrid.json"
    grid_path = publish_dir / "grid.json"
    input_hash = f"{sha256_file(transform_path)[:16]}_{sha256_file(full_spz)[:16]}_{sha256_file(lite_spz)[:16]}"
    if navgrid_path.is_file():
        input_hash += f"_{sha256_file(navgrid_path)[:16]}"
    else:
        grid_path.unlink(missing_ok=True)
    if should_skip_stage(report_path, "s08_manifest", input_hash, config_hash, [manifest_path]):
        print(f"[s08_manifest] Idempotent skip: inputs unchanged and manifest exists ({manifest_path})")
        return {
            "scene_id": scene_id,
            "manifest_path": manifest_path,
            "manifest_bytes": manifest_path.stat().st_size,
        }

    # 1. Read transform.json
    transform_data = json.loads(transform_path.read_text(encoding="utf-8"))

    # 2. Determine Gaussian counts
    full_gaussians = 0
    lite_gaussians = 0
    clean_ply = r_dir / "clean.ply"
    if clean_ply.is_file():
        try:
            header = read_ply_gaussian_header(clean_ply)
            full_gaussians = header["num_vertices"]
            c_cfg = config.get("compress", {})
            lite_fraction = float(c_cfg.get("lite_fraction", 0.4))
            lite_gaussians = max(1, int(math.ceil(full_gaussians * lite_fraction)))
        except Exception:
            pass

    # Read from run_report if available
    if report_path.is_file():
        try:
            rep = json.loads(report_path.read_text(encoding="utf-8"))
            s07_m = rep.get("stages", {}).get("s07_compress", {}).get("metrics", {})
            if s07_m.get("full_gaussians"):
                full_gaussians = s07_m["full_gaussians"]
            if s07_m.get("lite_gaussians"):
                lite_gaussians = s07_m["lite_gaussians"]
        except Exception:
            pass

    # 3. Construct manifest
    manifest_data = build_manifest_data(
        run_dir=r_dir,
        scene_id=scene_id,
        space_id=space_id,
        job_id=job_id,
        full_asset_id=full_asset_id,
        lite_asset_id=lite_asset_id,
        full_spz=full_spz,
        lite_spz=lite_spz,
        transform_data=transform_data,
        full_gaussians=full_gaussians,
        lite_gaussians=lite_gaussians,
    )

    # 3b. Walkable floor grid from S06 (optional: without it the viewer stays in ghost mode)
    if navgrid_path.is_file():
        grid_doc = {
            "schema_version": 1,
            "nav_id": "nav_" + scene_id[4:],
            "transform_scene": scene_id,
            **json.loads(navgrid_path.read_text(encoding="utf-8")),
        }
        try:
            schema_path = Path(__file__).resolve().parent.parent / "schemas" / "navgrid.schema.json"
            jsonschema.validate(grid_doc, json.loads(schema_path.read_text(encoding="utf-8")))
        except jsonschema.ValidationError as ve:
            fail(str(ve.message), "valid navgrid.schema.json", f"NavGrid schema validation failed: {ve.message}")
        grid_path.write_text(json.dumps(grid_doc), encoding="utf-8")
        grid_asset_id = f"ast_{scene_id[4:14]}gd"
        manifest_data["assets"]["grid"] = grid_asset_id
        manifest_data["asset_table"][grid_asset_id] = {
            "schema_version": 1,
            "asset_id": grid_asset_id,
            "kind": "grid",
            "format": "json",
            "uri": "grid.json",
            "sha256": sha256_file(grid_path),
            "bytes": grid_path.stat().st_size,
        }

    # 4. Validate with pipeline Python validator (Draft 7 JSON Schema + cross-field semantics)
    try:
        validate_manifest(manifest_data)
    except ValidationError as ve:
        fail(str(ve), "valid manifest against manifest.schema.json", f"Python schema validation failed: {ve}")

    # Write manifest.json
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest_data, f, indent=2)

    # 5. Validate with TypeScript validator
    ts_ok, ts_err = validate_with_ts_validator(manifest_path)
    if not ts_ok:
        fail(ts_err, "valid manifest against TypeScript validator", f"TypeScript validator failed: {ts_err}")

    # 6. Success
    metrics = {
        "scene_id": scene_id,
        "space_id": space_id,
        "job_id": job_id,
        "full_asset_id": full_asset_id,
        "lite_asset_id": lite_asset_id,
        "manifest_path": str(manifest_path),
        "manifest_bytes": manifest_path.stat().st_size,
        "scale": manifest_data["transform"]["scale"],
        "floor_rms_m": manifest_data["transform"]["residuals"]["floor_rms_m"],
        "scale_check_error_pct": manifest_data["transform"]["residuals"]["scale_check_error_pct"],
        "start_pose": manifest_data["start_pose"],
        "eye_height_m": manifest_data["eye_height_m"],
        "grid": "grid.json" if navgrid_path.is_file() else None,
    }
    record_stage_result(
        report_path=report_path,
        stage_name="s08_manifest",
        gate="G8",
        status="passed",
        duration_s=time.time() - start_time,
        input_hash=input_hash,
        config_hash=config_hash,
        metrics=metrics,
        gate_result={
            "passed": True,
            "manifest_valid": True,
            "schema_version": 1,
        },
    )
    print(f"[s08_manifest] Gate G8 PASSED: wrote {manifest_path} ({manifest_path.stat().st_size} bytes)")
    return {
        "scene_id": scene_id,
        "manifest_path": manifest_path,
        "manifest": manifest_data,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Namma Space: Stage S08 Manifest Generation (Gate G8)")
    parser.add_argument("--run-dir", required=True, help="Path to run directory")
    parser.add_argument("--config", default=None, help="Path to pipeline configuration YAML")
    parser.add_argument("--capture", default=None, help="Path to capture.json")
    parser.add_argument("--scene-id", default=None, help="Optional explicit scene ID")
    args = parser.parse_args()

    try:
        run_s08_manifest(
            run_dir=args.run_dir,
            config_path=args.config,
            capture_json_path=args.capture,
            scene_id_override=args.scene_id,
        )
        return 0
    except Exception as e:
        print(f"[s08_manifest ERROR] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
