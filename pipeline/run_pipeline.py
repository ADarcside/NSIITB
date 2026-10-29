"""
Namma Space: Pipeline Orchestrator (Phase 3)
SPEC Section 8:
- Executes reconstruction stages S01 to S05 in sequence
- Enforces quality gates G1 to G5
- Implements idempotence (skips completed stages with unchanged hashes)
- Stops immediately at the first failed gate with non-zero exit code
- Prints a one-screen CLI summary table
- Writes/updates run_report.json
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import time
from typing import Any, Dict, List, Optional, Tuple, Union

from pipeline.common import (
    load_config,
    load_run_report,
    get_git_commit,
    get_tool_versions,
    GateFailure,
)
from pipeline.stages.s01_validate import run_s01_validate
from pipeline.stages.s02_frames import run_s02_frames
from pipeline.stages.s03_poses import run_s03_poses
from pipeline.stages.s04_train import run_s04_train
from pipeline.stages.s06_normalize import run_s06_normalize
from pipeline.stages.s05_export import run_s05_export, write_synthetic_ply
from pipeline.stages.s07_compress import run_s07_compress
from pipeline.stages.s08_manifest import run_s08_manifest
from pipeline.trainers.base import MockTrainer
from pipeline.trainers.splatfacto import SplatfactoTrainer


def print_summary_table(
    run_dir: Path,
    report: Dict[str, Any],
    overall_status: str,
    total_time_s: float,
) -> None:
    """Prints a clean one-screen CLI summary table of the pipeline run."""
    if report.get("synthetic"):
        print("\n" + "*" * 78)
        print("*" + " " * 76 + "*")
        print("*" + " " * 27 + "! ! ! SYNTHETIC RUN ! ! !" + " " * 24 + "*")
        print("*" + " " * 9 + "TEST SHORTCUTS / MOCKS WERE USED. NOT A REAL RECONSTRUCTION." + " " * 7 + "*")
        print("*" + " " * 76 + "*")
        print("*" * 78)

    print("\n" + "=" * 78)
    print("                    NAMMA SPACE PIPELINE EXECUTION SUMMARY")
    print("=" * 78)
    print(f" Run Directory: {run_dir}")
    print(f" Git Commit:    {report.get('git_commit', 'unknown')[:12]}")
    print(f" Overall:       {overall_status.upper()} (Total time: {total_time_s:.2f}s)")
    print("-" * 78)
    print(f" {'STAGE':<14} | {'GATE':<4} | {'STATUS':<9} | {'TIME':<8} | {'KEY METRIC / SUMMARY':<30}")
    print("-" * 78)

    stage_names = [
        ("s01_validate", "G1"),
        ("s02_frames", "G2"),
        ("s03_poses", "G3"),
        ("s04_train", "G4"),
        ("s05_export", "G5"),
        ("s06_normalize", "G6"),
        ("s07_compress", "G7"),
        ("s08_manifest", "G8"),
    ]

    stages_data = report.get("stages", {})
    for st_name, gate in stage_names:
        info = stages_data.get(st_name)
        if not info:
            print(f" {st_name:<14} | {gate:<4} | {'PENDING':<9} | {'-':<8} | {'Not reached':<30}")
            continue

        status = info.get("status", "unknown").upper()
        dur_str = f"{info.get('duration_s', 0.0):.2f}s"
        metrics = info.get("metrics", {})

        metric_desc = "-"
        if st_name == "s01_validate":
            metric_desc = f"dur={metrics.get('duration_s', 0):.1f}s, h={metrics.get('height', 0)}px"
        elif st_name == "s02_frames":
            metric_desc = f"kept={metrics.get('kept_frames', 0)}/{metrics.get('total_candidates', 0)} frames"
        elif st_name == "s03_poses":
            reg_ratio = metrics.get('largest_component_ratio', metrics.get('registered_ratio', 0))
            metric_desc = f"comp={metrics.get('num_components', 1)}, kept={reg_ratio:.1%}, err={metrics.get('mean_reproj_px', 0)}px"
        elif st_name == "s04_train":
            metric_desc = f"PSNR={metrics.get('psnr_db', 0):.1f} dB, coord={metrics.get('coord_verification_max_error_m', 0):.4f}m"
        elif st_name == "s05_export":
            metric_desc = f"gaussians={metrics.get('num_gaussians', 0):,}, size={metrics.get('file_size_mb', 0)}MB"
        elif st_name == "s06_normalize":
            approx = " approx" if metrics.get("approximate_scale") else ""
            metric_desc = f"floor={metrics.get('floor_rms_m', 0) * 100:.1f}cm, scale={metrics.get('scale', 0):.3f}{approx}"
        elif st_name == "s07_compress":
            metric_desc = f"full={metrics.get('full_mb', 0):.1f}MB ({metrics.get('full_gaussians', 0):,}), lite={metrics.get('lite_mb', 0):.1f}MB"
        elif st_name == "s08_manifest":
            metric_desc = f"scene={metrics.get('scene_id', '-')}, manifest={metrics.get('manifest_bytes', 0)}B"

        print(f" {st_name:<14} | {gate:<4} | {status:<9} | {dur_str:<8} | {metric_desc:<30}")

    print("=" * 78 + "\n")


def run_pipeline(
    video_path: Union[str, Path],
    capture_json_path: Union[str, Path],
    run_dir: Union[str, Path],
    config_path: Optional[Union[str, Path]] = None,
    allow_test_shortcuts: bool = False,
    mock_sparse_dir: Optional[Union[str, Path]] = None,
    mock_psnr: Optional[float] = None,
    mock_ply_path: Optional[Union[str, Path]] = None,
    stop_after: Optional[str] = None,
    stages: Optional[Union[str, List[str]]] = None,
    max_width: Optional[int] = None,
    scale_override: Optional[float] = None,
) -> bool:
    """
    Runs stages S01 through S05 in sequence (or up to stop_after / stages).
    Returns True if all executed stages pass; raises GateFailure or returns False on failure.
    """
    total_start = time.time()
    r_dir = Path(run_dir)
    r_dir.mkdir(parents=True, exist_ok=True)
    report_path = r_dir / "run_report.json"
    logs_dir = r_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)

    # Resolve stage filter
    ordered_stages = ["s01", "s02", "s03", "s04", "s05", "s06", "s07", "s08"]
    if stages:
        if isinstance(stages, str):
            selected_stages = set(s.strip().lower() for s in stages.split(",") if s.strip())
        else:
            selected_stages = set(s.strip().lower() for s in stages)
    elif stop_after:
        stop_norm = stop_after.strip().lower()
        if stop_norm in ordered_stages:
            idx = ordered_stages.index(stop_norm)
            selected_stages = set(ordered_stages[:idx + 1])
        else:
            selected_stages = set(ordered_stages)
    else:
        selected_stages = set(ordered_stages)

    is_synthetic = bool(
        allow_test_shortcuts
        or (mock_sparse_dir is not None)
        or (mock_psnr is not None)
        or (mock_ply_path is not None)
    )

    # S06-S08 need real outputs from prior stages; synthetic unit-test runs stop at S05 unless asked
    if is_synthetic and not stages:
        selected_stages.discard("s06")
        selected_stages.discard("s07")
        selected_stages.discard("s08")

    # Item 8: Refuse test shortcuts unless run directory starts with "test_"
    if is_synthetic and not r_dir.name.startswith("test_"):
        raise ValueError(
            f"Test shortcut flags (--allow-test-shortcuts, --mock-psnr, --mock-sparse-dir, --mock-ply) "
            f"are strictly refused unless run directory starts with 'test_'. Run directory was: '{r_dir.name}'"
        )

    report = load_run_report(report_path)
    if is_synthetic:
        report["synthetic"] = True
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)

    overall_status = "passed"

    try:
        # Stage S01: Validation (Gate G1)
        if "s01" in selected_stages:
            print("\n>>> Running Stage S01: Video & Metadata Validation (Gate G1)...")
            run_s01_validate(
                video_path=video_path,
                capture_json_path=capture_json_path,
                output_dir=r_dir,
                config_path=config_path,
                allow_short_video_for_testing=allow_test_shortcuts,
            )

        # Stage S02: Frames (Gate G2)
        kept_frames_count = 0
        if "s02" in selected_stages:
            print("\n>>> Running Stage S02: Frame Extraction & Filtering (Gate G2)...")
            s02_out = run_s02_frames(
                video_path=video_path,
                output_dir=r_dir,
                config_path=config_path,
                allow_low_frame_count_for_testing=allow_test_shortcuts,
                max_width=max_width,
            )
            kept_frames_count = s02_out.get("metrics", {}).get("kept_frames", 0)

        # Check early stop after s02
        if selected_stages.issubset({"s01", "s02"}):
            print("\n[run_pipeline] Requested stages completed (stopped after S02).")
            report = load_run_report(report_path)
            print_summary_table(r_dir, report, overall_status, time.time() - total_start)
            return True

        frames_dir = r_dir / "frames"
        # When S02 ran in an earlier invocation, count its kept frames so G3's ratio is real
        if kept_frames_count == 0 and frames_dir.is_dir():
            kept_frames_count = sum(
                1 for p in frames_dir.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png")
            )

        # Stage S03: Poses (Gate G3)
        if "s03" in selected_stages:
            print("\n>>> Running Stage S03: COLMAP Camera Poses & SfM Quality (Gate G3)...")
            sparse_dir = mock_sparse_dir
            if not sparse_dir or not Path(sparse_dir).exists():
                if allow_test_shortcuts:
                    sparse_dir = r_dir / "sparse" / "0"
                    sparse_dir.mkdir(parents=True, exist_ok=True)
                    (sparse_dir / "cameras.txt").write_text("1 SIMPLE_RADIAL 1920 1080 1200 960 540 0.01\n")
                    img_lines = []
                    for k in range(1, max(kept_frames_count, 2) + 1):
                        img_lines.append(f"{k} 1.0 0.0 0.0 0.0 0.0 0.0 {k*0.05} 1 frame_{k:06d}.jpg\n10 10 1\n")
                    (sparse_dir / "images.txt").write_text("".join(img_lines))
                    (sparse_dir / "points3D.txt").write_text("1 0 0 1 255 255 255 0.5 1 0 2 0\n")
                elif shutil.which("colmap"):
                    sparse_dir = r_dir / "colmap" / "sparse"
                else:
                    raise RuntimeError(
                        "Stage S03 requires COLMAP reconstruction outputs. "
                        "Run on a machine with colmap installed, or provide --mock-sparse-dir in a test_ run."
                    )

            run_s03_poses(
                sparse_dir=sparse_dir,
                total_input_images=max(kept_frames_count, 2),
                output_dir=r_dir,
                config_path=config_path,
                image_dir=frames_dir if (frames_dir.is_dir() and shutil.which("colmap")) else None,
                log_dir=logs_dir,
            )

        if selected_stages.issubset({"s01", "s02", "s03"}):
            print("\n[run_pipeline] Requested stages completed (stopped after S03).")
            report = load_run_report(report_path)
            print_summary_table(r_dir, report, overall_status, time.time() - total_start)
            return True

        # Stage S04: Training (Gate G4)
        if "s04" in selected_stages:
            print("\n>>> Running Stage S04: Gaussian Splat Training & Coordinate Check (Gate G4)...")
            if is_synthetic:
                trainer = MockTrainer(psnr=mock_psnr if mock_psnr is not None else 26.5)
            else:
                trainer = SplatfactoTrainer()

            run_s04_train(
                data_dir=r_dir,
                output_dir=r_dir,
                config_path=config_path,
                trainer=trainer,
                log_dir=logs_dir,
            )

        if selected_stages.issubset({"s01", "s02", "s03", "s04"}):
            print("\n[run_pipeline] Requested stages completed (stopped after S04).")
            report = load_run_report(report_path)
            print_summary_table(r_dir, report, overall_status, time.time() - total_start)
            return True

        # Stage S05: Export (Gate G5)
        if "s05" in selected_stages:
            print("\n>>> Running Stage S05: Splat Export & PLY Validation (Gate G5)...")
            ply_target = mock_ply_path
            if not ply_target or not Path(ply_target).exists():
                if allow_test_shortcuts:
                    ply_target = r_dir / "raw.ply"
                    write_synthetic_ply(ply_target, num_gaussians=150)
                else:
                    ply_target = r_dir / "raw.ply"

            run_s05_export(
                ply_path=ply_target,
                output_dir=r_dir,
                config_path=config_path,
                log_dir=logs_dir,
            )

        # Stage S06: Normalize (Gate G6)
        if "s06" in selected_stages:
            print("\n>>> Running Stage S06: Floor Alignment, Scale & Cleanup (Gate G6)...")
            run_s06_normalize(
                run_dir=r_dir,
                capture_json_path=capture_json_path,
                config_path=config_path,
                scale_override=scale_override,
            )

        if selected_stages.issubset({"s01", "s02", "s03", "s04", "s05", "s06"}):
            print("\n[run_pipeline] Requested stages completed (stopped after S06).")
            report = load_run_report(report_path)
            print_summary_table(r_dir, report, overall_status, time.time() - total_start)
            return True

        # Stage S07: Compress (Gate G7)
        if "s07" in selected_stages:
            print("\n>>> Running Stage S07: SPZ Compression Full & Lite (Gate G7)...")
            run_s07_compress(
                run_dir=r_dir,
                config_path=config_path,
                capture_json_path=capture_json_path,
            )

        if selected_stages.issubset({"s01", "s02", "s03", "s04", "s05", "s06", "s07"}):
            print("\n[run_pipeline] Requested stages completed (stopped after S07).")
            report = load_run_report(report_path)
            print_summary_table(r_dir, report, overall_status, time.time() - total_start)
            return True

        # Stage S08: Manifest (Gate G8)
        if "s08" in selected_stages:
            print("\n>>> Running Stage S08: Scene Manifest Generation & Validation (Gate G8)...")
            run_s08_manifest(
                run_dir=r_dir,
                config_path=config_path,
                capture_json_path=capture_json_path,
            )

    except GateFailure as e:
        overall_status = f"failed (Gate {e.gate})"
        report = load_run_report(report_path)
        print_summary_table(r_dir, report, overall_status, time.time() - total_start)
        return False
    except Exception as e:
        overall_status = f"error ({e})"
        report = load_run_report(report_path)
        print_summary_table(r_dir, report, overall_status, time.time() - total_start)
        raise

    total_time = time.time() - total_start
    report = load_run_report(report_path)
    print_summary_table(r_dir, report, overall_status, total_time)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Namma Space Reconstruction Pipeline Orchestrator (Stages S01-S05)")
    parser.add_argument("--video", required=True, help="Path to input smartphone video")
    parser.add_argument("--capture", required=True, help="Path to capture.json metadata file")
    parser.add_argument("--run-dir", default="runs/current_run", help="Output directory for run artifacts")
    parser.add_argument("--config", default=None, help="Optional path to config default.yaml")
    parser.add_argument("--allow-test-shortcuts", action="store_true", help="Allow synthetic test shortcuts for unit testing")
    parser.add_argument("--mock-sparse-dir", default=None, help="Path to existing COLMAP sparse model")
    parser.add_argument("--mock-psnr", type=float, default=None, help="Mock PSNR value for testing Gate G4")
    parser.add_argument("--mock-ply", default=None, help="Path to existing raw.ply for testing Gate G5")
    parser.add_argument("--stop-after", choices=["s01", "s02", "s03", "s04", "s05", "s06", "s07", "s08"], default=None, help="Stop pipeline after stage (e.g. s02)")
    parser.add_argument("--stages", default=None, help="Comma-separated stages to run (e.g. s01,s02)")
    parser.add_argument("--scale", type=float, default=None, help="S06 manual scale override (metres per splat unit)")
    parser.add_argument("--max-width", type=int, default=None, help="Optionally downscale kept frames to max_width (e.g. 1600)")
    args = parser.parse_args()

    try:
        success = run_pipeline(
            video_path=args.video,
            capture_json_path=args.capture,
            run_dir=args.run_dir,
            config_path=args.config,
            allow_test_shortcuts=args.allow_test_shortcuts,
            mock_sparse_dir=args.mock_sparse_dir,
            mock_psnr=args.mock_psnr,
            mock_ply_path=args.mock_ply,
            stop_after=args.stop_after,
            stages=args.stages,
            max_width=args.max_width,
            scale_override=args.scale,
        )
        return 0 if success else 1
    except ValueError as ve:
        print(f"[run_pipeline ERROR] {ve}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
