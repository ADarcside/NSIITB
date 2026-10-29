"""
Namma Space: Pipeline Stage S01 - Video & Metadata Validation (Gate G1)
SPEC Section 8:
- Probes input video with ffprobe: duration >= 90s, height >= 1080px
- Validates capture.json against contract validator
- Emits capture_ok.json and records results in run_report.json
- Exits with non-zero code on Gate G1 failure
"""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
from typing import Any, Dict, Optional, Tuple, Union

from pipeline.common import (
    load_config,
    record_stage_result,
    should_skip_stage,
    sha256_file,
    fail_gate,
    GateFailure,
)
from pipeline.validator import load_and_validate_capture, ValidationError


def probe_video(video_path: Union[str, Path]) -> Dict[str, Any]:
    """
    Runs ffprobe to inspect video stream width, height, and duration.
    Verified flags: -v error, -select_streams v:0, -show_entries, -of json.
    """
    video = Path(video_path)
    if not video.is_file():
        raise FileNotFoundError(f"Video file not found: {video}")

    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "format=duration:stream=width,height",
        "-of",
        "json",
        str(video),
    ]

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=30)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffprobe failed to read video '{video}': {e.stderr}")
    except FileNotFoundError:
        raise RuntimeError("ffprobe is not installed or not in PATH")

    data = json.loads(res.stdout)
    streams = data.get("streams", [])
    if not streams:
        raise ValueError(f"No video streams found in '{video}'")

    width = int(streams[0].get("width", 0))
    height = int(streams[0].get("height", 0))

    fmt = data.get("format", {})
    duration_str = fmt.get("duration")
    if duration_str is None:
        raise ValueError(f"Unable to determine duration for '{video}'")
    duration = float(duration_str)

    return {
        "width": width,
        "height": height,
        "duration_s": duration,
        "path": str(video.resolve()),
    }


def run_s01_validate(
    video_path: Union[str, Path],
    capture_json_path: Union[str, Path],
    output_dir: Union[str, Path],
    config_path: Optional[Union[str, Path]] = None,
    allow_short_video_for_testing: bool = False,
) -> Dict[str, Any]:
    """
    Executes Stage S01 validation and enforces Gate G1.
    """
    start_time = time.time()
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / "run_report.json"
    capture_ok_path = out_dir / "capture_ok.json"

    config, config_hash = load_config(config_path)
    val_cfg = config.get("validate", {})
    min_duration = float(val_cfg.get("min_duration_s", 90.0))
    min_height = int(val_cfg.get("min_height_px", 1080))

    if allow_short_video_for_testing:
        min_duration = 0.5

    video_p = Path(video_path)
    capture_p = Path(capture_json_path)

    # Compute input hashes
    video_hash = sha256_file(video_p)
    capture_hash = sha256_file(capture_p)
    combined_input_hash = f"{video_hash[:16]}_{capture_hash[:16]}"

    # Check idempotence
    if should_skip_stage(
        report_path=report_path,
        stage_name="s01_validate",
        current_input_hash=combined_input_hash,
        current_config_hash=config_hash,
        required_outputs=[capture_ok_path],
    ):
        print(f"[s01_validate] Idempotent skip: inputs and config unchanged ({capture_ok_path})")
        with open(capture_ok_path, "r", encoding="utf-8") as f:
            return json.load(f)

    # 1. Validate capture.json schema & semantics
    try:
        capture_data = load_and_validate_capture(capture_p)
    except (ValidationError, Exception) as e:
        elapsed = time.time() - start_time
        fail_gate(
            gate="G1",
            stage="s01_validate",
            measured=f"Invalid capture.json: {e}",
            threshold="Valid schema_version=1 Capture contract",
            message=f"Capture contract validation failed: {e}",
            report_path=report_path,
            duration_s=elapsed,
            input_hash=combined_input_hash,
            config_hash=config_hash,
            metrics={"capture_valid": False},
        )

    # 2. Probe video with ffprobe
    try:
        meta = probe_video(video_p)
    except Exception as e:
        elapsed = time.time() - start_time
        fail_gate(
            gate="G1",
            stage="s01_validate",
            measured=f"Failed to probe video: {e}",
            threshold="Readable video file with video stream",
            message=str(e),
            report_path=report_path,
            duration_s=elapsed,
            input_hash=combined_input_hash,
            config_hash=config_hash,
            metrics={"video_open": False},
        )

    measured_duration = meta["duration_s"]
    measured_height = meta["height"]

    metrics = {
        "duration_s": measured_duration,
        "width": meta["width"],
        "height": measured_height,
        "capture_id": capture_data.get("capture_id"),
        "capture_valid": True,
        "video_open": True,
    }

    # 3. Check Gate G1 thresholds
    if measured_duration < min_duration:
        elapsed = time.time() - start_time
        fail_gate(
            gate="G1",
            stage="s01_validate",
            measured=round(measured_duration, 2),
            threshold=min_duration,
            message=f"Video duration ({measured_duration:.2f}s) is below required minimum ({min_duration}s)",
            report_path=report_path,
            duration_s=elapsed,
            input_hash=combined_input_hash,
            config_hash=config_hash,
            metrics=metrics,
        )

    if measured_height < min_height:
        elapsed = time.time() - start_time
        fail_gate(
            gate="G1",
            stage="s01_validate",
            measured=measured_height,
            threshold=min_height,
            message=f"Video vertical resolution ({measured_height}px) is below required minimum ({min_height}px)",
            report_path=report_path,
            duration_s=elapsed,
            input_hash=combined_input_hash,
            config_hash=config_hash,
            metrics=metrics,
        )

    # 4. Success: write capture_ok.json
    elapsed = time.time() - start_time
    capture_ok_data = {
        "schema_version": 1,
        "validated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "capture": capture_data,
        "video": meta,
        "gate_g1": {
            "passed": True,
            "duration_s": measured_duration,
            "min_duration_s": min_duration,
            "height": measured_height,
            "min_height_px": min_height,
        },
    }

    with open(capture_ok_path, "w", encoding="utf-8") as f:
        json.dump(capture_ok_data, f, indent=2)

    record_stage_result(
        report_path=report_path,
        stage_name="s01_validate",
        gate="G1",
        status="passed",
        duration_s=elapsed,
        input_hash=combined_input_hash,
        config_hash=config_hash,
        metrics=metrics,
        gate_result={
            "passed": True,
            "measured": {
                "duration_s": measured_duration,
                "height": measured_height,
            },
            "threshold": {
                "min_duration_s": min_duration,
                "min_height_px": min_height,
            },
        },
    )

    print(f"[s01_validate] Gate G1 PASSED: duration={measured_duration:.2f}s (>= {min_duration}s), height={measured_height}px (>= {min_height}px)")
    return capture_ok_data


def main() -> int:
    parser = argparse.ArgumentParser(description="Namma Space Stage S01 - Video & Metadata Validation (Gate G1)")
    parser.add_argument("--video", required=True, help="Path to video file")
    parser.add_argument("--capture", required=True, help="Path to capture.json")
    parser.add_argument("--output-dir", default="runs/dev", help="Output directory for stage artifacts")
    parser.add_argument("--config", default=None, help="Optional path to config default.yaml")
    parser.add_argument("--allow-short-video", action="store_true", help="Allow short videos for unit testing")
    args = parser.parse_args()

    try:
        run_s01_validate(
            video_path=args.video,
            capture_json_path=args.capture,
            output_dir=args.output_dir,
            config_path=args.config,
            allow_short_video_for_testing=args.allow_short_video,
        )
        return 0
    except GateFailure:
        return 1
    except Exception as e:
        print(f"[s01_validate ERROR] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
