"""
Namma Space: Pipeline Stage S05 - Splat Export & PLY Validation (Gate G5)
SPEC Section 8 & Project Hard Rules:
- ns-export gaussian-splat CLI wrapper
- Pure NumPy-only PLY header & data reader (NO plyfile dependency - Hard Rule 3)
- Validates 62 float32 properties per Gaussian:
  - 3 positions (x, y, z)
  - 3 spherical harmonic DC (f_dc_0, f_dc_1, f_dc_2)
  - 45 spherical harmonic rest (f_rest_0 to f_rest_44)
  - 1 opacity (opacity)
  - 3 log-scales (scale_0, scale_1, scale_2)
  - 4 quaternion rotations (rot_0, rot_1, rot_2, rot_3)
  Total = 62 float32 values (248 bytes per Gaussian)
- Gate G5: PLY exists, num_gaussians > 0, 62 float32 properties verified
"""

import argparse
import json
from pathlib import Path
import shutil
import struct
import os
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np

from pipeline.common import (
    load_config,
    record_stage_result,
    should_skip_stage,
    sha256_file,
    fail_gate,
    GateFailure,
)

EXPECTED_GAUSSIAN_PROPERTY_COUNT = 62

EXPECTED_PROPERTIES_ORDER: List[str] = (
    ["x", "y", "z"]
    + ["nx", "ny", "nz"]
    + ["f_dc_0", "f_dc_1", "f_dc_2"]
    + [f"f_rest_{i}" for i in range(45)]
    + ["opacity"]
    + ["scale_0", "scale_1", "scale_2"]
    + ["rot_0", "rot_1", "rot_2", "rot_3"]
)


def build_ns_export_command(
    config_yml: Union[str, Path],
    output_dir: Union[str, Path],
) -> List[str]:
    """
    Builds the ns-export gaussian-splat command line.
    Flags are marked [U] until verified on the GPU machine.
    """
    return [
        "ns-export",
        "gaussian-splat",  # [U]
        "--load-config",
        str(Path(config_yml).resolve()),  # [U]
        "--output-dir",
        str(Path(output_dir).resolve()),  # [U]
    ]


def execute_ns_export(
    cmd: List[str],
    log_dir: Path,
    timeout_s: int = 3 * 3600,
) -> Tuple[bool, int]:
    """
    Executes ns-export CLI command logging stdout/stderr to runs/<id>/logs/ns_export.log.
    """
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "ns_export.log"
    print(f"[s05_export] Running ns-export: {' '.join(cmd)}")
    # ns-export imports pymeshlab, which breaks when LD_LIBRARY_PATH points at the
    # CUDA toolkit env (Qt_5 symbol clash). Splat export needs neither, so drop it.
    env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}
    with open(log_file, "w", encoding="utf-8") as lf:
        res = subprocess.run(
            cmd,
            env=env,
            stdout=lf,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout_s,
            check=False,
        )
        if res.returncode != 0:
            print(f"[s05_export] ns-export failed with code {res.returncode}. See {log_file}")
            return False, res.returncode
    return True, 0


def read_ply_gaussian_header(file_path: Union[str, Path]) -> Dict[str, Any]:
    """
    Parses the ASCII PLY header using standard library only (Rule 3: no plyfile).
    Returns header metadata including vertex count, format, properties, and data offset.
    """
    path = Path(file_path)
    if not path.is_file():
        raise FileNotFoundError(f"PLY file not found: {path}")

    with open(path, "rb") as f:
        # Read header lines up to end_header
        header_bytes = bytearray()
        while True:
            line = f.readline()
            if not line:
                raise ValueError("Unexpected EOF before 'end_header' in PLY file")
            header_bytes.extend(line)
            if line.strip() == b"end_header":
                break

    data_offset = len(header_bytes)
    header_text = header_bytes.decode("ascii", errors="replace")
    lines = [l.strip() for l in header_text.splitlines() if l.strip()]

    if not lines or lines[0] != "ply":
        raise ValueError("Invalid PLY file: magic 'ply' missing")

    ply_format = None
    num_vertices = 0
    properties: List[Tuple[str, str]] = []  # (name, type)

    in_vertex_element = False
    for line in lines[1:]:
        parts = line.split()
        if not parts:
            continue
        token = parts[0]

        if token == "format":
            ply_format = parts[1]
        elif token == "element":
            if parts[1] == "vertex":
                in_vertex_element = True
                num_vertices = int(parts[2])
            else:
                in_vertex_element = False
        elif token == "property" and in_vertex_element:
            prop_type = parts[1]
            prop_name = parts[2]
            properties.append((prop_name, prop_type))
        elif token == "end_header":
            break

    return {
        "format": ply_format,
        "num_vertices": num_vertices,
        "properties": properties,
        "property_names": [p[0] for p in properties],
        "property_types": [p[1] for p in properties],
        "data_offset": data_offset,
        "file_size": path.stat().st_size,
    }


def read_ply_gaussians_numpy(file_path: Union[str, Path]) -> Dict[str, Any]:
    """
    Reads Gaussian Splat PLY using pure NumPy (Rule 3).
    Validates that each Gaussian defines 62 float32 properties.
    Returns array of shape (N, 62).
    """
    header = read_ply_gaussian_header(file_path)
    num_vertices = header["num_vertices"]
    prop_count = len(header["properties"])

    if prop_count != EXPECTED_GAUSSIAN_PROPERTY_COUNT:
        raise ValueError(
            f"Invalid Gaussian PLY: expected {EXPECTED_GAUSSIAN_PROPERTY_COUNT} properties per vertex, got {prop_count}"
        )

    # Check that all property types are float (or float32)
    for name, p_type in header["properties"]:
        if p_type not in ("float", "float32"):
            raise ValueError(f"Property '{name}' has type '{p_type}'; expected float32")

    path = Path(file_path)
    expected_data_bytes = num_vertices * prop_count * 4
    actual_data_bytes = header["file_size"] - header["data_offset"]

    if actual_data_bytes < expected_data_bytes:
        raise ValueError(
            f"PLY file data truncated: expected {expected_data_bytes} bytes for {num_vertices} Gaussians, found {actual_data_bytes} bytes"
        )

    with open(path, "rb") as f:
        f.seek(header["data_offset"])
        raw_bytes = f.read(expected_data_bytes)

    data = np.frombuffer(raw_bytes, dtype="<f4").reshape((num_vertices, prop_count))

    return {
        "header": header,
        "num_gaussians": num_vertices,
        "data": data,
        "property_names": header["property_names"],
    }


def write_synthetic_ply(
    file_path: Union[str, Path],
    num_gaussians: int = 100,
    seed: int = 42,
) -> Path:
    """
    Generates a valid binary Gaussian Splat PLY with 62 float32 properties.
    Used for unit testing without downloading or training large datasets.
    """
    rng = np.random.default_rng(seed)
    path = Path(file_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    header_lines = [
        "ply",
        "format binary_little_endian 1.0",
        f"element vertex {num_gaussians}",
    ]
    for prop in EXPECTED_PROPERTIES_ORDER:
        header_lines.append(f"property float {prop}")
    header_lines.append("end_header\n")

    header_bytes = "\n".join(header_lines).encode("ascii")

    # Generate synthetic float32 data
    data = np.zeros((num_gaussians, EXPECTED_GAUSSIAN_PROPERTY_COUNT), dtype="<f4")
    # Positions x, y, z
    data[:, 0:3] = rng.uniform(-2.0, 2.0, size=(num_gaussians, 3)).astype("<f4")
    # Normals nx, ny, nz
    data[:, 3:6] = 0.0
    # Base color SH DC
    data[:, 6:9] = rng.uniform(0.1, 0.9, size=(num_gaussians, 3)).astype("<f4")
    # Higher order SH rest (45 floats)
    data[:, 9:54] = rng.normal(0.0, 0.05, size=(num_gaussians, 45)).astype("<f4")
    # Opacity (logit or pre-sigmoid)
    data[:, 54] = rng.uniform(1.0, 5.0, size=num_gaussians).astype("<f4")
    # Log-scales (sx, sy, sz)
    data[:, 55:58] = rng.uniform(-4.0, -1.0, size=(num_gaussians, 3)).astype("<f4")
    # Rotations (qw, qx, qy, qz) normalized quaternions
    quats = rng.normal(0.0, 1.0, size=(num_gaussians, 4)).astype("<f4")
    quats /= np.linalg.norm(quats, axis=1, keepdims=True)
    data[:, 58:62] = quats

    with open(path, "wb") as f:
        f.write(header_bytes)
        f.write(data.tobytes())

    return path


def run_s05_export(
    ply_path: Union[str, Path],
    output_dir: Union[str, Path],
    config_path: Optional[Union[str, Path]] = None,
    nerfstudio_config_yml: Optional[Union[str, Path]] = None,
    log_dir: Optional[Union[str, Path]] = None,
) -> Dict[str, Any]:
    """
    Executes Stage S05: runs export (if ns-export is available) or validates
    an exported raw.ply and enforces Gate G5.
    """
    start_time = time.time()
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / "run_report.json"
    export_json_path = out_dir / "export.json"
    logs = Path(log_dir) if log_dir else out_dir / "logs"

    config, config_hash = load_config(config_path)

    p_path = Path(ply_path)

    # Real Executor: if PLY doesn't exist yet, check if ns-export is available
    if not p_path.is_file() and shutil.which("ns-export"):
        # Look for nerfstudio config.yml
        cfg_yml = nerfstudio_config_yml
        if not cfg_yml:
            found = sorted(out_dir.glob("**/config.yml"), key=lambda p: p.stat().st_mtime)
            if found:
                cfg_yml = found[-1]

        if cfg_yml and Path(cfg_yml).is_file():
            export_target_dir = p_path.parent
            export_target_dir.mkdir(parents=True, exist_ok=True)
            cmd = build_ns_export_command(config_yml=cfg_yml, output_dir=export_target_dir)
            ok, retcode = execute_ns_export(cmd, log_dir=logs)
            if not ok:
                fail_gate(
                    gate="G5",
                    stage="s05_export",
                    measured=f"ns-export returned code {retcode}",
                    threshold="Clean exit code 0",
                    message=f"ns-export execution failed. See {logs / 'ns_export.log'}",
                    report_path=report_path,
                )
            # If exported splat is named differently (e.g. splat.ply instead of raw.ply), check or rename
            if not p_path.is_file():
                exported_candidates = list(export_target_dir.glob("*.ply"))
                if exported_candidates:
                    p_path = exported_candidates[0]

    if not p_path.is_file():
        fail_gate(
            gate="G5",
            stage="s05_export",
            measured=f"File not found: {p_path}",
            threshold="Exported raw.ply exists",
            message=f"PLY export file does not exist at '{p_path}'",
            report_path=report_path,
        )

    file_size_bytes = p_path.stat().st_size
    file_hash = sha256_file(p_path)

    # Validate header and properties using NumPy
    try:
        parsed = read_ply_gaussians_numpy(p_path)
        num_gaussians = parsed["num_gaussians"]
        prop_count = len(parsed["property_names"])
    except Exception as e:
        elapsed = time.time() - start_time
        fail_gate(
            gate="G5",
            stage="s05_export",
            measured=f"Failed to parse PLY: {e}",
            threshold="Valid binary PLY with 62 float32 properties",
            message=str(e),
            report_path=report_path,
            duration_s=elapsed,
            input_hash=file_hash,
            config_hash=config_hash,
        )

    metrics = {
        "num_gaussians": num_gaussians,
        "property_count": prop_count,
        "file_size_bytes": file_size_bytes,
        "file_size_mb": round(file_size_bytes / (1024 * 1024), 2),
        "sha256": file_hash,
        "ply_path": str(p_path.resolve()),
    }

    # Gate G5 evaluation
    errors: List[str] = []
    if num_gaussians <= 0:
        errors.append(f"Exported PLY contains 0 Gaussians (measured={num_gaussians})")
    if prop_count != EXPECTED_GAUSSIAN_PROPERTY_COUNT:
        errors.append(f"Expected {EXPECTED_GAUSSIAN_PROPERTY_COUNT} properties per Gaussian, found {prop_count}")

    elapsed = time.time() - start_time
    if errors:
        fail_gate(
            gate="G5",
            stage="s05_export",
            measured=metrics,
            threshold={"min_gaussians": 1, "property_count": EXPECTED_GAUSSIAN_PROPERTY_COUNT},
            message="; ".join(errors),
            report_path=report_path,
            duration_s=elapsed,
            input_hash=file_hash,
            config_hash=config_hash,
            metrics=metrics,
        )

    export_data = {
        "schema_version": 1,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "metrics": metrics,
        "gate_g5": {
            "passed": True,
            "num_gaussians": num_gaussians,
            "property_count": prop_count,
        },
    }

    with open(export_json_path, "w", encoding="utf-8") as f:
        json.dump(export_data, f, indent=2)

    record_stage_result(
        report_path=report_path,
        stage_name="s05_export",
        gate="G5",
        status="passed",
        duration_s=elapsed,
        input_hash=file_hash,
        config_hash=config_hash,
        metrics=metrics,
        gate_result={
            "passed": True,
            "measured": {"num_gaussians": num_gaussians, "property_count": prop_count},
            "threshold": {"min_gaussians": 1, "property_count": EXPECTED_GAUSSIAN_PROPERTY_COUNT},
        },
    )

    print(f"[s05_export] Gate G5 PASSED: {num_gaussians} Gaussians exported, {prop_count} float32 properties verified ({metrics['file_size_mb']} MB)")
    return export_data


def main() -> int:
    parser = argparse.ArgumentParser(description="Namma Space Stage S05 - Splat Export Validation (Gate G5)")
    parser.add_argument("--ply", required=True, help="Path to exported raw.ply")
    parser.add_argument("--output-dir", default="runs/dev", help="Output directory for stage artifacts")
    parser.add_argument("--config", default=None, help="Optional path to config default.yaml")
    args = parser.parse_args()

    try:
        run_s05_export(ply_path=args.ply, output_dir=args.output_dir, config_path=args.config)
        return 0
    except GateFailure:
        return 1
    except Exception as e:
        print(f"[s05_export ERROR] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
