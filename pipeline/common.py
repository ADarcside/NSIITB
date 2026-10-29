"""
Namma Space: Pipeline Common Utilities & Gate Infrastructure (Phase 3)
Provides:
- Config loader for default.yaml with SHA-256 config hash
- run_report.json writer (git commit, tool versions, config hash, input hashes, timings, metrics, gate result)
- Idempotence helper (skip stage when input hash + config hash are unchanged and outputs exist)
- fail_gate helper exiting with non-zero code on gate failure
"""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple, Union


class GateFailure(Exception):
    """Exception raised when a quality gate condition fails."""

    def __init__(
        self,
        gate: str,
        stage: str,
        measured: Any,
        threshold: Any,
        message: str,
    ):
        super().__init__(f"Gate {gate} failed in {stage}: {message} (measured={measured}, threshold={threshold})")
        self.gate = gate
        self.stage = stage
        self.measured = measured
        self.threshold = threshold
        self.message = message


def sha256_file(path: Union[str, Path]) -> str:
    """Computes SHA-256 hex digest of a file in 64KB blocks."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    """Computes SHA-256 hex digest of bytes."""
    return hashlib.sha256(data).hexdigest()


def _parse_yaml_subset(text: str) -> Dict[str, Any]:
    """
    Lightweight dependency-free YAML parser for Namma Space's default.yaml.
    Parses top-level sections, nested key-value pairs, comments, lists, numbers, booleans.
    """
    result: Dict[str, Any] = {}
    current_section: Optional[str] = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        # Strip inline comments
        if " #" in line:
            line = line.split(" #", 1)[0].strip()

        # Check for top-level section: "section_name:"
        if not raw_line.startswith(" ") and not raw_line.startswith("\t") and line.endswith(":"):
            current_section = line[:-1].strip()
            result[current_section] = {}
            continue

        # Check for key: value inside section or root
        if ":" in line:
            key_part, val_part = line.split(":", 1)
            key = key_part.strip()
            val_str = val_part.strip()

            val: Any
            if not val_str:
                val = {}
            elif val_str.lower() in ("true", "yes", "on"):
                val = True
            elif val_str.lower() in ("false", "no", "off"):
                val = False
            elif val_str.startswith("[") and val_str.endswith("]"):
                inner = val_str[1:-1].strip()
                if not inner:
                    val = []
                else:
                    items = [x.strip() for x in inner.split(",")]
                    parsed_items = []
                    for it in items:
                        try:
                            if "." in it:
                                parsed_items.append(float(it))
                            else:
                                parsed_items.append(int(it))
                        except ValueError:
                            parsed_items.append(it.strip("\"'"))
                    val = parsed_items
            else:
                try:
                    if "." in val_str:
                        val = float(val_str)
                    else:
                        val = int(val_str)
                except ValueError:
                    val = val_str.strip("\"'")

            if current_section is not None:
                result[current_section][key] = val
            else:
                result[key] = val

    return result


def load_config(config_path: Optional[Union[str, Path]] = None) -> Tuple[Dict[str, Any], str]:
    """
    Loads pipeline configuration and computes its SHA-256 hash.
    Returns (config_dict, config_hash).
    """
    if config_path is None:
        # Default relative to this file
        base_dir = Path(__file__).resolve().parent
        config_path = base_dir / "config" / "default.yaml"

    path = Path(config_path)
    if not path.is_file():
        raise FileNotFoundError(f"Pipeline config file not found: {path}")

    raw_text = path.read_text(encoding="utf-8")
    config_hash = hashlib.sha256(raw_text.encode("utf-8")).hexdigest()

    try:
        import yaml  # type: ignore
        config_dict = yaml.safe_load(raw_text) or {}
    except ImportError:
        config_dict = _parse_yaml_subset(raw_text)

    return config_dict, config_hash


def get_git_commit() -> str:
    """Returns the current git commit SHA or 'unknown'."""
    try:
        res = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        return res.stdout.strip()
    except Exception:
        return "unknown"


def get_tool_versions() -> Dict[str, str]:
    """Inspects and returns versions of CLI and Python tools."""
    versions: Dict[str, str] = {
        "python": sys.version.split()[0],
    }

    # FFmpeg / FFprobe
    for tool in ("ffmpeg", "ffprobe"):
        try:
            res = subprocess.run(
                [tool, "-version"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if res.returncode == 0:
                first_line = res.stdout.strip().splitlines()[0]
                versions[tool] = first_line
        except Exception:
            versions[tool] = "not installed"

    # OpenCV
    try:
        import cv2  # type: ignore
        versions["opencv"] = getattr(cv2, "__version__", "unknown")
    except ImportError:
        versions["opencv"] = "not installed"

    # NumPy
    try:
        import numpy as np
        versions["numpy"] = getattr(np, "__version__", "unknown")
    except ImportError:
        pass

    # COLMAP
    try:
        res = subprocess.run(
            ["colmap", "-h"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if res.returncode == 0:
            first_line = res.stdout.strip().splitlines()[0]
            versions["colmap"] = first_line
    except Exception:
        versions["colmap"] = "not installed"

    return versions


def load_run_report(report_path: Union[str, Path]) -> Dict[str, Any]:
    """Loads an existing run_report.json or initializes a fresh one."""
    path = Path(report_path)
    if path.is_file():
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass

    return {
        "schema_version": 1,
        "git_commit": get_git_commit(),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tool_versions": get_tool_versions(),
        "stages": {},
    }


def record_stage_result(
    report_path: Union[str, Path],
    stage_name: str,
    gate: str,
    status: str,
    duration_s: float,
    input_hash: str,
    config_hash: str,
    metrics: Dict[str, Any],
    gate_result: Dict[str, Any],
    error: Optional[str] = None,
) -> Dict[str, Any]:
    """Records a stage execution result into run_report.json."""
    report = load_run_report(report_path)
    report["git_commit"] = get_git_commit()
    report["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    report["stages"][stage_name] = {
        "gate": gate,
        "status": status,
        "duration_s": round(duration_s, 3),
        "input_hash": input_hash,
        "config_hash": config_hash,
        "metrics": metrics,
        "gate_result": gate_result,
        "error": error,
    }

    path = Path(report_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    return report


def should_skip_stage(
    report_path: Union[str, Path],
    stage_name: str,
    current_input_hash: str,
    current_config_hash: str,
    required_outputs: List[Union[str, Path]],
) -> bool:
    """
    Idempotence check:
    Returns True if the stage already ran successfully with identical input and config hashes
    AND all required output files exist and are non-empty.
    """
    path = Path(report_path)
    if not path.is_file():
        return False

    report = load_run_report(report_path)
    stage_record = report.get("stages", {}).get(stage_name)
    if not stage_record or stage_record.get("status") != "passed":
        return False

    if (
        stage_record.get("input_hash") != current_input_hash
        or stage_record.get("config_hash") != current_config_hash
    ):
        return False

    for out in required_outputs:
        out_p = Path(out)
        if not out_p.exists():
            return False
        if out_p.is_file() and out_p.stat().st_size == 0:
            return False

    return True


def fail_gate(
    gate: str,
    stage: str,
    measured: Any,
    threshold: Any,
    message: str,
    report_path: Optional[Union[str, Path]] = None,
    duration_s: float = 0.0,
    input_hash: str = "",
    config_hash: str = "",
    metrics: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Handles a gate failure: logs error, writes failure to run_report.json, and exits with code 1.
    """
    print(f"\n[GATE FAILURE] Gate {gate} in {stage}: {message}", file=sys.stderr)
    print(f"  Measured:  {measured}", file=sys.stderr)
    print(f"  Threshold: {threshold}", file=sys.stderr)

    if report_path:
        record_stage_result(
            report_path=report_path,
            stage_name=stage,
            gate=gate,
            status="failed",
            duration_s=duration_s,
            input_hash=input_hash,
            config_hash=config_hash,
            metrics=metrics or {},
            gate_result={
                "passed": False,
                "measured": measured,
                "threshold": threshold,
            },
            error=message,
        )

    raise GateFailure(gate=gate, stage=stage, measured=measured, threshold=threshold, message=message)


def derive_ids(
    capture_id: Optional[str] = None,
    space_id: Optional[str] = None,
) -> Tuple[str, str, str, str, str]:
    """
    Derives (scene_id, space_id, job_id, full_asset_id, lite_asset_id).
    All IDs follow prefix + 12 lowercase RFC 4648 base32 characters [a-z2-7].
    """
    body = None
    if capture_id and capture_id.startswith("cap_") and len(capture_id) == 16:
        candidate = capture_id[4:].lower()
        if re.match(r"^[a-z2-7]{12}$", candidate):
            body = candidate

    if not body:
        seed = capture_id or "default_seed"
        digest = hashlib.sha256(seed.encode("utf-8")).digest()
        import base64
        b32 = base64.b32encode(digest).decode("ascii").lower()
        # Filter to RFC 4648 base32 characters [a-z2-7]
        clean = "".join(c for c in b32 if ('a' <= c <= 'z') or ('2' <= c <= '7'))
        body = (clean + "222222222222")[:12]

    scene_id = f"scn_{body}"
    if space_id and space_id.startswith("spc_") and len(space_id) == 16 and re.match(r"^[a-z2-7]{12}$", space_id[4:].lower()):
        derived_space_id = space_id
    else:
        derived_space_id = f"spc_{body}"
    job_id = f"job_{body}"
    full_asset_id = f"ast_{body[:10]}fl"
    lite_asset_id = f"ast_{body[:10]}lt"
    return scene_id, derived_space_id, job_id, full_asset_id, lite_asset_id

