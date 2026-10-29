"""
Namma Space: Pipeline Stage S07 - Compression to SPZ Full and Lite (Gate G7)
SPEC Section 8 & Decisions 003, 004:
- Converts <run>/clean.ply (from S06) to SPZ using @playcanvas/splat-transform@3.10.1
- Always passes --spz-version 3 (gzip-compressed SPZ v3 starting with 1f 8b)
- Full: full scene representation <run>/publish/<scene_id>/full.spz
- Lite: top compress.lite_fraction (default 0.4) ranked by:
    opacity * volume = sigmoid(opacity) * exp(scale_0 + scale_1 + scale_2)
  Never random (Decision 003).
- Validates 0x1f 0x8b gzip magic header on both assets.
- Gate G7: full < max_full_mb (100 MB), lite < max_lite_mb (30 MB).
  Fails loudly if full > 100 MB (never silently drop Gaussians).
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np

from pipeline.common import (
    derive_ids,
    fail_gate,
    load_config,
    record_stage_result,
    sha256_file,
    should_skip_stage,
)
from pipeline.stages.s05_export import read_ply_gaussians_numpy


SPLAT_TRANSFORM_VERSION = "3.10.1"
DEFAULT_SPZ_VERSION = 3


def select_lite_gaussians(
    ply_data: np.ndarray,
    property_names: List[str],
    lite_fraction: float = 0.4,
) -> np.ndarray:
    """
    Ranks Gaussians by importance = sigmoid(opacity) * exp(scale_0 + scale_1 + scale_2).
    Returns array of indices of the top lite_fraction Gaussians, sorted descending by importance.
    Never random (Decision 003).
    """
    num_gaussians = len(ply_data)
    if num_gaussians == 0:
        return np.array([], dtype=int)

    k = max(1, int(math.ceil(num_gaussians * lite_fraction)))
    if k >= num_gaussians:
        return np.arange(num_gaussians, dtype=int)

    idx = {name: i for i, name in enumerate(property_names)}
    raw_opacity = ply_data[:, idx["opacity"]].astype(np.float64)
    # Numerical stability clip
    sig_opacity = 1.0 / (1.0 + np.exp(-np.clip(raw_opacity, -60.0, 60.0)))

    log_volume = (
        ply_data[:, idx["scale_0"]].astype(np.float64)
        + ply_data[:, idx["scale_1"]].astype(np.float64)
        + ply_data[:, idx["scale_2"]].astype(np.float64)
    )
    volume = np.exp(np.clip(log_volume, -60.0, 60.0))
    importance = sig_opacity * volume

    # Partition to find top k elements in O(N)
    top_indices = np.argpartition(-importance, k)[:k]
    # Sort top k descending
    top_indices = top_indices[np.argsort(-importance[top_indices])]
    return top_indices


def write_ply_subset(
    src_ply: Path,
    dst_ply: Path,
    data: np.ndarray,
    keep_indices: np.ndarray,
) -> None:
    """
    Copies the PLY header with updated vertex count and writes kept rows as float32.
    Uses NumPy only (Hard Rule 3: no plyfile).
    """
    raw = src_ply.read_bytes()
    end = raw.index(b"end_header") + len(b"end_header")
    end = raw.index(b"\n", end) + 1
    header_lines = raw[:end].decode("ascii").splitlines(keepends=True)
    kept = np.ascontiguousarray(data[keep_indices]).astype("<f4")

    out_lines = []
    for line in header_lines:
        if line.startswith("element vertex"):
            line = f"element vertex {kept.shape[0]}\n"
        out_lines.append(line)

    dst_ply.parent.mkdir(parents=True, exist_ok=True)
    with open(dst_ply, "wb") as f:
        f.write("".join(out_lines).encode("ascii"))
        f.write(kept.tobytes())


def convert_ply_to_spz(
    ply_path: Path,
    spz_path: Path,
    spz_version: int = DEFAULT_SPZ_VERSION,
    tool_version: str = SPLAT_TRANSFORM_VERSION,
    timeout_s: int = 2 * 3600,
) -> None:
    """
    Invokes @playcanvas/splat-transform CLI via npx to convert PLY to SPZ.
    Always specifies --spz-version 3 per Decision 004.
    """
    spz_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "npx",
        "-y",
        f"@playcanvas/splat-transform@{tool_version}",
        str(ply_path.resolve()),
        str(spz_path.resolve()),
        "-w",
        "--spz-version",
        str(spz_version),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
    if res.returncode != 0:
        raise RuntimeError(
            f"splat-transform failed with exit code {res.returncode}:\n"
            f"STDERR:\n{res.stderr}\nSTDOUT:\n{res.stdout}"
        )
    if not spz_path.is_file():
        raise FileNotFoundError(f"splat-transform exited 0 but output file was not created: {spz_path}")


def check_spz_magic(spz_path: Path) -> None:
    """
    Verifies that the SPZ file begins with gzip magic bytes 0x1f 0x8b (SPZ v3 format).
    """
    if not spz_path.is_file():
        raise FileNotFoundError(f"SPZ file not found: {spz_path}")
    with open(spz_path, "rb") as f:
        magic = f.read(2)
    if magic != b"\x1f\x8b":
        raise ValueError(
            f"Invalid SPZ header in {spz_path.name}: expected gzip magic bytes b'\\x1f\\x8b' "
            f"(SPZ v3), got 0x{magic.hex()}"
        )


def find_capture_id(run_dir: Path, capture_json_path: Optional[Union[str, Path]] = None) -> Optional[str]:
    """Helper to discover capture_id for scene_id derivation."""
    if capture_json_path and Path(capture_json_path).is_file():
        try:
            c = json.loads(Path(capture_json_path).read_text(encoding="utf-8"))
            if c.get("capture_id"):
                return c["capture_id"]
        except Exception:
            pass

    cap_ok = run_dir / "capture_ok.json"
    if cap_ok.is_file():
        try:
            c = json.loads(cap_ok.read_text(encoding="utf-8"))
            if c.get("capture", {}).get("capture_id"):
                return c["capture"]["capture_id"]
        except Exception:
            pass

    report = run_dir / "run_report.json"
    if report.is_file():
        try:
            r = json.loads(report.read_text(encoding="utf-8"))
            c_id = r.get("stages", {}).get("s01_validate", {}).get("metrics", {}).get("capture_id")
            if c_id:
                return c_id
        except Exception:
            pass

    return None


def run_s07_compress(
    run_dir: Union[str, Path],
    config_path: Optional[Union[str, Path]] = None,
    capture_json_path: Optional[Union[str, Path]] = None,
    scene_id_override: Optional[str] = None,
    allow_synthetic: bool = False,
) -> Dict[str, Any]:
    """
    Executes pipeline stage S07 (Gate G7).
    Converts clean.ply into full.spz and lite.spz under <run>/publish/<scene_id>/.
    """
    start_time = time.time()
    r_dir = Path(run_dir)
    report_path = r_dir / "run_report.json"
    clean_ply = r_dir / "clean.ply"

    config, config_hash = load_config(config_path)
    c_cfg = config.get("compress", {})
    lite_fraction = float(c_cfg.get("lite_fraction", 0.4))
    max_full_mb = float(c_cfg.get("max_full_mb", 100))
    max_lite_mb = float(c_cfg.get("max_lite_mb", 30))
    spz_version = int(c_cfg.get("spz_version", DEFAULT_SPZ_VERSION))

    def fail(measured: Any, threshold: Any, message: str, metrics: Optional[Dict[str, Any]] = None) -> None:
        fail_gate(
            gate="G7",
            stage="s07_compress",
            measured=measured,
            threshold=threshold,
            message=message,
            report_path=report_path,
            duration_s=time.time() - start_time,
            config_hash=config_hash,
            metrics=metrics,
        )

    if not clean_ply.is_file():
        fail("clean.ply missing", "clean.ply exists from S06", f"Input file not found: {clean_ply}")

    capture_id = find_capture_id(r_dir, capture_json_path)
    if scene_id_override:
        scene_id = scene_id_override
    else:
        scene_id, _, _, _, _ = derive_ids(capture_id)

    publish_dir = r_dir / "publish" / scene_id
    publish_dir.mkdir(parents=True, exist_ok=True)
    full_spz = publish_dir / "full.spz"
    lite_spz = publish_dir / "lite.spz"

    input_hash = sha256_file(clean_ply)
    if should_skip_stage(report_path, "s07_compress", input_hash, config_hash, [full_spz, lite_spz]):
        print(f"[s07_compress] Idempotent skip: clean.ply unchanged and outputs exist ({publish_dir})")
        return {
            "scene_id": scene_id,
            "full_spz": full_spz,
            "lite_spz": lite_spz,
            "full_bytes": full_spz.stat().st_size,
            "lite_bytes": lite_spz.stat().st_size,
        }

    # 1. Read clean.ply using pure NumPy
    print(f"[s07_compress] Reading {clean_ply}...")
    ply_info = read_ply_gaussians_numpy(clean_ply)
    data = ply_info["data"]
    prop_names = ply_info["property_names"]
    num_full = len(data)
    print(f"[s07_compress] Total Gaussians in clean.ply: {num_full:,}")

    # 2. Convert full.ply -> full.spz
    print(f"[s07_compress] Converting full scene to SPZ v{spz_version} via splat-transform {SPLAT_TRANSFORM_VERSION}...")
    convert_ply_to_spz(clean_ply, full_spz, spz_version=spz_version)
    check_spz_magic(full_spz)
    full_bytes = full_spz.stat().st_size
    full_mb = full_bytes / (1024 * 1024)
    print(f"[s07_compress] Wrote full.spz: {full_bytes:,} bytes ({full_mb:.2f} MB)")

    # 3. Create lite PLY via opacity * volume ranking
    print(f"[s07_compress] Selecting top {lite_fraction:.0%} Gaussians by opacity * volume...")
    keep_indices = select_lite_gaussians(data, prop_names, lite_fraction=lite_fraction)
    num_lite = len(keep_indices)
    temp_lite_ply = publish_dir / "temp_lite.ply"
    try:
        write_ply_subset(clean_ply, temp_lite_ply, data, keep_indices)
        print(f"[s07_compress] Converting lite subset ({num_lite:,} Gaussians) to SPZ v{spz_version}...")
        convert_ply_to_spz(temp_lite_ply, lite_spz, spz_version=spz_version)
        check_spz_magic(lite_spz)
    finally:
        if temp_lite_ply.is_file():
            temp_lite_ply.unlink()

    lite_bytes = lite_spz.stat().st_size
    lite_mb = lite_bytes / (1024 * 1024)
    print(f"[s07_compress] Wrote lite.spz: {lite_bytes:,} bytes ({lite_mb:.2f} MB)")

    # 4. Gate G7 checks: full < max_full_mb, lite < max_lite_mb
    metrics = {
        "scene_id": scene_id,
        "full_bytes": full_bytes,
        "full_mb": round(full_mb, 2),
        "full_gaussians": num_full,
        "lite_bytes": lite_bytes,
        "lite_mb": round(lite_mb, 2),
        "lite_gaussians": num_lite,
        "lite_fraction": lite_fraction,
        "spz_version": spz_version,
    }

    if full_mb >= max_full_mb:
        fail(
            round(full_mb, 2),
            f"< {max_full_mb} MB",
            f"Full SPZ size ({full_mb:.2f} MB) exceeds maximum allowed ({max_full_mb} MB). "
            f"Failing loudly without dropping Gaussians.",
            metrics=metrics,
        )

    if lite_mb >= max_lite_mb:
        fail(
            round(lite_mb, 2),
            f"< {max_lite_mb} MB",
            f"Lite SPZ size ({lite_mb:.2f} MB) exceeds maximum allowed ({max_lite_mb} MB).",
            metrics=metrics,
        )

    # 5. Success
    record_stage_result(
        report_path=report_path,
        stage_name="s07_compress",
        gate="G7",
        status="passed",
        duration_s=time.time() - start_time,
        input_hash=input_hash,
        config_hash=config_hash,
        metrics=metrics,
        gate_result={
            "passed": True,
            "full_mb": round(full_mb, 2),
            "max_full_mb": max_full_mb,
            "lite_mb": round(lite_mb, 2),
            "max_lite_mb": max_lite_mb,
        },
    )
    print(f"[s07_compress] Gate G7 PASSED: full={full_mb:.2f} MB ({num_full:,} gs), lite={lite_mb:.2f} MB ({num_lite:,} gs)")
    return {
        "scene_id": scene_id,
        "full_spz": full_spz,
        "lite_spz": lite_spz,
        "full_bytes": full_bytes,
        "lite_bytes": lite_bytes,
        "full_gaussians": num_full,
        "lite_gaussians": num_lite,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Namma Space: Stage S07 SPZ Compression (Gate G7)")
    parser.add_argument("--run-dir", required=True, help="Path to run directory containing clean.ply")
    parser.add_argument("--config", default=None, help="Path to pipeline configuration YAML")
    parser.add_argument("--capture", default=None, help="Path to capture.json")
    parser.add_argument("--scene-id", default=None, help="Optional explicit scene ID")
    args = parser.parse_args()

    try:
        run_s07_compress(
            run_dir=args.run_dir,
            config_path=args.config,
            capture_json_path=args.capture,
            scene_id_override=args.scene_id,
        )
        return 0
    except Exception as e:
        print(f"[s07_compress ERROR] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
