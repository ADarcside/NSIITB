"""
Namma Space: Pipeline Stage S02 - Frame Extraction & Filtering (Gate G2)
SPEC Section 8:
- ffmpeg frame extraction at candidate_fps (default 4 fps)
- Pass 1: Laplacian-variance sharpness filter (drop < 0.6x median)
- Pass 2: Near-duplicate removal
- Pass 3: Minimum spacing and target frame management (target 200-400, bounds 150-600)
- Gate G2: keep_min <= kept_frames <= keep_max
- Outputs frames/ directory and frames.json metadata
"""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple, Union

import cv2  # type: ignore
import numpy as np

from pipeline.common import (
    load_config,
    record_stage_result,
    should_skip_stage,
    sha256_file,
    fail_gate,
    GateFailure,
)


def compute_laplacian_sharpness(img_bgr: np.ndarray) -> float:
    """Computes the variance of the Laplacian of a grayscale image."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def compute_image_difference(img_a: np.ndarray, img_b: np.ndarray) -> float:
    """
    Computes normalized absolute difference between two images resized to a small thumbnail.
    Returns float in range [0.0, 255.0].
    """
    thumb_a = cv2.resize(img_a, (64, 64), interpolation=cv2.INTER_AREA)
    thumb_b = cv2.resize(img_b, (64, 64), interpolation=cv2.INTER_AREA)
    gray_a = cv2.cvtColor(thumb_a, cv2.COLOR_BGR2GRAY) if len(thumb_a.shape) == 3 else thumb_a
    gray_b = cv2.cvtColor(thumb_b, cv2.COLOR_BGR2GRAY) if len(thumb_b.shape) == 3 else thumb_b
    return float(np.mean(np.abs(gray_a.astype(float) - gray_b.astype(float))))


def extract_candidate_frames(
    video_path: Union[str, Path],
    extract_dir: Union[str, Path],
    candidate_fps: float = 4.0,
    max_width: Optional[int] = None,
) -> List[Path]:
    """
    Extracts frames from video using ffmpeg at candidate_fps.
    Verified flags: -y, -i, -vf fps=<candidate_fps>, -q:v 2.
    max_width: also scale candidates down to this width (never up) while extracting. A 4K video then
    needs about a quarter of the temporary disk (Room 3: ~16 GB -> ~4 GB at 1920 px).
    """
    video = Path(video_path)
    out_dir = Path(extract_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Reuse only a finished extraction: a run killed mid-ffmpeg leaves a partial set
    done_marker = out_dir / ".extraction_complete"
    candidates = sorted(out_dir.glob("cand_*.jpg"))
    if candidates and done_marker.is_file():
        print(f"[s02_frames] Found {len(candidates)} existing candidate frames in {out_dir}, reusing...")
        return candidates

    pattern = str(out_dir / "cand_%06d.jpg")
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(video),
        "-vf",
        f"fps={candidate_fps}" + (f",scale='min(iw,{int(max_width)})':-2:flags=area" if max_width else ""),
        "-q:v",
        "2",
        pattern,
    ]

    try:
        subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=4 * 3600)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffmpeg frame extraction failed: {e.stderr}")
    except FileNotFoundError:
        raise RuntimeError("ffmpeg is not installed or not in PATH")

    candidates = sorted(out_dir.glob("cand_*.jpg"))
    if not candidates:
        raise RuntimeError(f"ffmpeg extracted 0 frames from '{video}'")
    done_marker.write_text(str(len(candidates)))

    return candidates


def parse_clock(text: str) -> float:
    """'50:22', '1:02:03' or '83.5' -> seconds."""
    parts = [float(p) for p in str(text).strip().split(":")]
    sec = 0.0
    for p in parts:
        sec = sec * 60 + p
    return sec


def parse_skip_ranges(raw: Any) -> List[Tuple[float, float]]:
    """frames.skip_ranges: ["33:41-33:49", "50:22-50:29"] -> [(2021, 2029), (3022, 3029)] in seconds."""
    out: List[Tuple[float, float]] = []
    for item in raw or []:
        if isinstance(item, (list, tuple)) and len(item) == 2:
            a, b = item
        else:
            a, sep, b = str(item).partition("-")
            if not sep:
                raise ValueError(f"frames.skip_ranges entry '{item}' must look like '33:41-33:49'")
        lo, hi = parse_clock(a), parse_clock(b)
        if hi < lo:
            raise ValueError(f"frames.skip_ranges entry '{item}' ends before it starts")
        out.append((lo, hi))
    return out


def drop_skipped(candidate_paths: List[Path], candidate_fps: float,
                 ranges: List[Tuple[float, float]]) -> Tuple[List[Path], int]:
    """Drops candidates whose video time falls in a skip range (one frame of margin each side).
    ffmpeg's fps filter writes cand_000001 at t=0, cand_000002 at 1/fps, and so on."""
    if not ranges:
        return candidate_paths, 0
    pad = 1.0 / candidate_fps
    kept = []
    for i, p in enumerate(candidate_paths):
        t = i / candidate_fps
        if any(lo - pad <= t <= hi + pad for lo, hi in ranges):
            continue
        kept.append(p)
    return kept, len(candidate_paths) - len(kept)


def filter_frames(
    candidate_paths: List[Path],
    blur_factor: float = 0.6,
    duplicate_threshold: float = 3.0,
    keep_min: int = 150,
    keep_max: int = 600,
    keep_target: Tuple[int, int] = (200, 400),
    allow_low_frame_count_for_testing: bool = False,
) -> Tuple[List[Dict[str, Any]], List[Path]]:
    """
    Performs 3-pass filtering:
    Pass 1: Laplacian sharpness vs median
    Pass 2: Near-duplicate removal
    Pass 3: Spacing / target range culling
    """
    total = len(candidate_paths)
    if total == 0:
        return [], []

    # Compute sharpness for all candidates
    frame_records: List[Dict[str, Any]] = []
    sharpness_scores: List[float] = []

    for idx, path in enumerate(candidate_paths):
        img = cv2.imread(str(path))
        if img is None:
            sharpness_scores.append(0.0)
            frame_records.append({
                "index": idx,
                "candidate_path": str(path),
                "sharpness": 0.0,
                "kept": False,
                "drop_reason": "unreadable",
            })
            continue

        score = compute_laplacian_sharpness(img)
        sharpness_scores.append(score)
        frame_records.append({
            "index": idx,
            "candidate_path": str(path),
            "sharpness": round(score, 2),
            "kept": False,
            "drop_reason": None,
        })

    valid_scores = [s for s in sharpness_scores if s > 0]
    median_sharpness = float(np.median(valid_scores)) if valid_scores else 0.0
    sharpness_threshold = blur_factor * median_sharpness

    # Pass 1: Sharpness thresholding
    pass1_indices: List[int] = []
    for idx in range(total):
        if sharpness_scores[idx] <= 0.0:
            continue
        if sharpness_scores[idx] < sharpness_threshold:
            frame_records[idx]["drop_reason"] = "blurry"
        else:
            pass1_indices.append(idx)

    # Pass 2: Near-duplicate removal
    pass2_indices: List[int] = []
    prev_img: Optional[np.ndarray] = None

    for idx in pass1_indices:
        curr_img = cv2.imread(str(candidate_paths[idx]))
        if curr_img is None:
            continue
        if prev_img is None:
            pass2_indices.append(idx)
            prev_img = curr_img
            continue

        diff = compute_image_difference(curr_img, prev_img)
        if diff < duplicate_threshold:
            frame_records[idx]["drop_reason"] = "duplicate"
        else:
            pass2_indices.append(idx)
            prev_img = curr_img

    # Pass 3: Spacing and target management
    target_low, target_high = keep_target
    if len(pass2_indices) > keep_max:
        # Uniform subsample down to target_high
        step = len(pass2_indices) / target_high
        selected_subset = [pass2_indices[int(i * step)] for i in range(target_high)]
        final_indices = sorted(list(set(selected_subset)))
        for idx in pass2_indices:
            if idx not in final_indices:
                frame_records[idx]["drop_reason"] = "excess_spacing"
    else:
        final_indices = pass2_indices

    kept_paths: List[Path] = []
    for idx in final_indices:
        frame_records[idx]["kept"] = True
        frame_records[idx]["drop_reason"] = None
        kept_paths.append(candidate_paths[idx])

    return frame_records, kept_paths


def run_s02_frames(
    video_path: Union[str, Path],
    output_dir: Union[str, Path],
    config_path: Optional[Union[str, Path]] = None,
    allow_low_frame_count_for_testing: bool = False,
    max_width: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Executes Stage S02: frame extraction, filtering, and Gate G2 check.
    Optionally downscales kept frames to max_width (e.g. 1600px).
    """
    start_time = time.time()
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / "run_report.json"
    frames_json_path = out_dir / "frames.json"
    frames_dir = out_dir / "frames"
    raw_candidates_dir = out_dir / ".candidates"

    config, config_hash = load_config(config_path)
    f_cfg = config.get("frames", {})
    candidate_fps = float(f_cfg.get("candidate_fps", 4.0))
    blur_factor = float(f_cfg.get("blur_factor", 0.6))
    keep_min = int(f_cfg.get("keep_min", 150))
    keep_max = int(f_cfg.get("keep_max", 600))
    keep_target_raw = f_cfg.get("keep_target", [200, 400])
    keep_target = (int(keep_target_raw[0]), int(keep_target_raw[1]))
    skip_ranges = parse_skip_ranges(f_cfg.get("skip_ranges"))  # per-run only (e.g. a hand over the lens)
    if max_width is None and f_cfg.get("max_width"):
        max_width = int(f_cfg["max_width"])  # --max-width on the command line wins
    # Scale candidates while extracting (saves temp disk). Off unless set, so existing configs are unchanged.
    extract_width = max_width if (f_cfg.get("extract_at_max_width") and max_width) else None

    if allow_low_frame_count_for_testing:
        keep_min = 1

    video_p = Path(video_path)
    input_hash = sha256_file(video_p)

    # Check idempotence
    if should_skip_stage(
        report_path=report_path,
        stage_name="s02_frames",
        current_input_hash=input_hash,
        current_config_hash=config_hash,
        required_outputs=[frames_json_path, frames_dir],
    ):
        print(f"[s02_frames] Idempotent skip: inputs and config unchanged ({frames_json_path})")
        with open(frames_json_path, "r", encoding="utf-8") as f:
            return json.load(f)

    # 1. Extract candidate frames
    raw_candidates_dir.mkdir(parents=True, exist_ok=True)
    candidate_paths = extract_candidate_frames(
        video_path=video_p,
        extract_dir=raw_candidates_dir,
        candidate_fps=candidate_fps,
        max_width=extract_width,
    )

    candidate_paths, skipped = drop_skipped(candidate_paths, candidate_fps, skip_ranges)
    if skip_ranges:
        print(f"[s02_frames] Skipped {skipped} candidates inside frames.skip_ranges {f_cfg.get('skip_ranges')}")

    # 2. Filter frames
    frame_records, kept_paths = filter_frames(
        candidate_paths=candidate_paths,
        blur_factor=blur_factor,
        keep_min=keep_min,
        keep_max=keep_max,
        keep_target=keep_target,
        allow_low_frame_count_for_testing=allow_low_frame_count_for_testing,
    )

    num_kept = len(kept_paths)
    total_candidates = len(candidate_paths)

    # Clean and write kept frames to frames/
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)

    kept_frame_manifest: List[Dict[str, Any]] = []
    for new_idx, src_path in enumerate(kept_paths, start=1):
        dst_filename = f"frame_{new_idx:06d}.jpg"
        dst_path = frames_dir / dst_filename
        if max_width and max_width > 0:
            img = cv2.imread(str(src_path))
            if img is not None:
                h, w = img.shape[:2]
                if w > max_width:
                    new_h = int(round(h * (max_width / w)))
                    resized = cv2.resize(img, (max_width, new_h), interpolation=cv2.INTER_AREA)
                    cv2.imwrite(str(dst_path), resized, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
                else:
                    shutil.copy2(src_path, dst_path)
            else:
                shutil.copy2(src_path, dst_path)
        else:
            shutil.copy2(src_path, dst_path)

        kept_frame_manifest.append({
            "frame_id": dst_filename,
            "source_candidate": src_path.name,
            "index": new_idx,
            "path": str(dst_path.resolve()),
        })

    # Cleanup temporary candidate extraction directory
    shutil.rmtree(raw_candidates_dir, ignore_errors=True)

    valid_sharpness = [r["sharpness"] for r in frame_records if r["sharpness"] > 0]
    median_sharpness = float(np.median(valid_sharpness)) if valid_sharpness else 0.0

    metrics = {
        "candidate_fps": candidate_fps,
        "candidate_width": extract_width,
        "total_candidates": total_candidates,
        "skip_ranges_s": [list(r) for r in skip_ranges],
        "skipped_candidates": skipped,
        "kept_frames": num_kept,
        "median_sharpness": round(median_sharpness, 2),
        "keep_min": keep_min,
        "keep_max": keep_max,
        "target_range": list(keep_target),
    }

    # 3. Check Gate G2
    if num_kept < keep_min:
        elapsed = time.time() - start_time
        fail_gate(
            gate="G2",
            stage="s02_frames",
            measured=num_kept,
            threshold=f">= {keep_min}",
            message=f"Kept frames count ({num_kept}) is below minimum threshold ({keep_min})",
            report_path=report_path,
            duration_s=elapsed,
            input_hash=input_hash,
            config_hash=config_hash,
            metrics=metrics,
        )

    if num_kept > keep_max:
        elapsed = time.time() - start_time
        fail_gate(
            gate="G2",
            stage="s02_frames",
            measured=num_kept,
            threshold=f"<= {keep_max}",
            message=f"Kept frames count ({num_kept}) exceeds maximum threshold ({keep_max})",
            report_path=report_path,
            duration_s=elapsed,
            input_hash=input_hash,
            config_hash=config_hash,
            metrics=metrics,
        )

    # 4. Success: write frames.json
    elapsed = time.time() - start_time
    output_data = {
        "schema_version": 1,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "metrics": metrics,
        "gate_g2": {
            "passed": True,
            "kept_frames": num_kept,
            "keep_min": keep_min,
            "keep_max": keep_max,
        },
        "frames": kept_frame_manifest,
        "filtering_summary": {
            "total_candidates": total_candidates,
            "blurry_dropped": sum(1 for r in frame_records if r.get("drop_reason") == "blurry"),
            "duplicates_dropped": sum(1 for r in frame_records if r.get("drop_reason") == "duplicate"),
            "spacing_dropped": sum(1 for r in frame_records if r.get("drop_reason") == "excess_spacing"),
            "kept": num_kept,
        },
    }

    with open(frames_json_path, "w", encoding="utf-8") as f:
        json.dump(output_data, f, indent=2)

    record_stage_result(
        report_path=report_path,
        stage_name="s02_frames",
        gate="G2",
        status="passed",
        duration_s=elapsed,
        input_hash=input_hash,
        config_hash=config_hash,
        metrics=metrics,
        gate_result={
            "passed": True,
            "measured": num_kept,
            "threshold": [keep_min, keep_max],
        },
    )

    print(f"[s02_frames] Gate G2 PASSED: {num_kept} frames kept (bounds [{keep_min}, {keep_max}], target {keep_target})")
    return output_data


def main() -> int:
    parser = argparse.ArgumentParser(description="Namma Space Stage S02 - Frame Extraction & Filtering (Gate G2)")
    parser.add_argument("--video", required=True, help="Path to input video file")
    parser.add_argument("--output-dir", default="runs/dev", help="Output directory for stage artifacts")
    parser.add_argument("--config", default=None, help="Optional path to config default.yaml")
    parser.add_argument("--allow-low-frame-count", action="store_true", help="Allow low frame count for unit testing")
    parser.add_argument("--max-width", type=int, default=None, help="Optionally downscale kept frames to max_width")
    args = parser.parse_args()

    try:
        run_s02_frames(
            video_path=args.video,
            output_dir=args.output_dir,
            config_path=args.config,
            allow_low_frame_count_for_testing=args.allow_low_frame_count,
            max_width=args.max_width,
        )
        return 0
    except GateFailure:
        return 1
    except Exception as e:
        print(f"[s02_frames ERROR] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
