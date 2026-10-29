"""
Namma Space: Pipeline Stage S03 - COLMAP Camera Poses & Sparse Reconstruction (Gate G3)
SPEC Section 8:
- Builds COLMAP CLI command lines (feature_extractor, matcher, mapper, global_mapper)
- Real executor: executes COLMAP via subprocess with logging to runs/<id>/logs when installed
- Text parsers for cameras.txt, images.txt, points3D.txt across single or multiple components
- Gate G3: keeps largest component; fails only if largest component holds < min_largest_component_ratio (80%),
  and reprojection error <= 1.0 px. Records discarded frames.
- Marks unverified CLI flags as [U]
"""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np

from pipeline.common import (
    load_config,
    record_stage_result,
    should_skip_stage,
    fail_gate,
    GateFailure,
)


def build_colmap_commands(
    database_path: Union[str, Path],
    image_path: Union[str, Path],
    output_path: Union[str, Path],
    camera_model: str = "SIMPLE_RADIAL",
    matcher: str = "exhaustive",
    use_global_mapper: bool = False,
    sequential_overlap: int = 10,
) -> Dict[str, List[str]]:
    """
    Builds the complete set of COLMAP CLI commands.
    Flags are marked with comments # [U] until verified on the GPU machine.
    """
    db = str(Path(database_path).resolve())
    img = str(Path(image_path).resolve())
    out = str(Path(output_path).resolve())

    # 1. Feature extraction
    # # [U] COLMAP 4.x feature_extractor flags
    feature_cmd = [
        "colmap",
        "feature_extractor",
        "--database_path",
        db,
        "--image_path",
        img,
        "--ImageReader.camera_model",
        camera_model,
        "--ImageReader.single_camera",
        "1",
    ]

    # 2. Matching
    # # [U] COLMAP matcher flags
    if matcher == "sequential":
        match_cmd = [
            "colmap",
            "sequential_matcher",
            "--database_path",
            db,
            "--SequentialMatching.overlap",
            str(sequential_overlap),
        ]
    else:
        match_cmd = [
            "colmap",
            "exhaustive_matcher",
            "--database_path",
            db,
        ]

    # 3. Mapper (incremental or global retry)
    # # [U] COLMAP mapper/global_mapper flags
    mapper_executable = "global_mapper" if use_global_mapper else "mapper"
    mapper_cmd = [
        "colmap",
        mapper_executable,
        "--database_path",
        db,
        "--image_path",
        img,
        "--output_path",
        out,
    ]

    # 4. Model converter (binary to text)
    submodel_dir = str(Path(out) / "0")
    convert_cmd = [
        "colmap",
        "model_converter",
        "--input_path",
        submodel_dir,
        "--output_path",
        submodel_dir,
        "--output_type",
        "TXT",
    ]

    return {
        "feature_extractor": feature_cmd,
        "matcher": match_cmd,
        "mapper": mapper_cmd,
        "model_converter": convert_cmd,
    }


def execute_colmap(
    commands: Dict[str, List[str]],
    log_dir: Path,
    timeout_s: int = 1800,
) -> bool:
    """
    Executes COLMAP CLI commands sequentially, logging stdout and stderr to log_dir.
    """
    log_dir.mkdir(parents=True, exist_ok=True)

    for stage_key in ["feature_extractor", "matcher", "mapper", "model_converter"]:
        cmd = commands.get(stage_key)
        if not cmd:
            continue

        log_file = log_dir / f"colmap_{stage_key}.log"
        print(f"[s03_poses] Running {stage_key}: {' '.join(cmd)}")

        with open(log_file, "w", encoding="utf-8") as lf:
            res = subprocess.run(cmd, stdout=lf, stderr=subprocess.STDOUT, text=True, timeout=timeout_s, check=False)
            if res.returncode != 0:
                print(f"[s03_poses] COLMAP {stage_key} failed with return code {res.returncode}. See {log_file}")
                return False

    return True


def parse_cameras_txt(file_path: Union[str, Path]) -> Dict[int, Dict[str, Any]]:
    """
    Parses COLMAP cameras.txt.
    Format: CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]
    """
    cameras: Dict[int, Dict[str, Any]] = {}
    path = Path(file_path)
    if not path.is_file():
        return cameras

    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        camera_id = int(parts[0])
        model = parts[1]
        width = int(parts[2])
        height = int(parts[3])
        params = [float(p) for p in parts[4:]]
        cameras[camera_id] = {
            "camera_id": camera_id,
            "model": model,
            "width": width,
            "height": height,
            "params": params,
        }
    return cameras


def parse_images_txt(file_path: Union[str, Path]) -> Dict[int, Dict[str, Any]]:
    """
    Parses COLMAP images.txt.
    Format:
      Line 1: IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME
      Line 2: POINTS2D[] as (X, Y, POINT3D_ID)
    """
    images: Dict[int, Dict[str, Any]] = {}
    path = Path(file_path)
    if not path.is_file():
        return images

    lines = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")]
    i = 0
    while i < len(lines):
        line1_parts = lines[i].split()
        if len(line1_parts) < 10:
            i += 1
            continue

        image_id = int(line1_parts[0])
        qw, qx, qy, qz = float(line1_parts[1]), float(line1_parts[2]), float(line1_parts[3]), float(line1_parts[4])
        tx, ty, tz = float(line1_parts[5]), float(line1_parts[6]), float(line1_parts[7])
        camera_id = int(line1_parts[8])
        name = line1_parts[9]

        points2d: List[Tuple[float, float, int]] = []
        if i + 1 < len(lines):
            line2_parts = lines[i + 1].split()
            for p_idx in range(0, len(line2_parts) - 2, 3):
                try:
                    px = float(line2_parts[p_idx])
                    py = float(line2_parts[p_idx + 1])
                    p3d_id = int(line2_parts[p_idx + 2])
                    points2d.append((px, py, p3d_id))
                except (ValueError, IndexError):
                    break
            i += 2
        else:
            i += 1

        images[image_id] = {
            "image_id": image_id,
            "qvec": [qw, qx, qy, qz],
            "tvec": [tx, ty, tz],
            "camera_id": camera_id,
            "name": name,
            "points2D": points2d,
        }

    return images


def parse_points3D_txt(file_path: Union[str, Path]) -> Dict[int, Dict[str, Any]]:
    """
    Parses COLMAP points3D.txt.
    Format: POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)
    """
    points: Dict[int, Dict[str, Any]] = {}
    path = Path(file_path)
    if not path.is_file():
        return points

    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 8:
            continue

        point3d_id = int(parts[0])
        xyz = [float(parts[1]), float(parts[2]), float(parts[3])]
        rgb = [int(parts[4]), int(parts[5]), int(parts[6])]
        error = float(parts[7])

        track: List[Tuple[int, int]] = []
        track_parts = parts[8:]
        for t_idx in range(0, len(track_parts) - 1, 2):
            try:
                img_id = int(track_parts[t_idx])
                p2d_idx = int(track_parts[t_idx + 1])
                track.append((img_id, p2d_idx))
            except (ValueError, IndexError):
                break

        points[point3d_id] = {
            "point3d_id": point3d_id,
            "xyz": xyz,
            "rgb": rgb,
            "error": error,
            "track": track,
        }

    return points


def discover_and_parse_components(sparse_dir: Path) -> List[Dict[str, Any]]:
    """
    Discovers all COLMAP submodels in sparse_dir (e.g. sparse/0, sparse/1, or root).
    Returns list of component dicts sorted by number of registered images descending.
    """
    components: List[Dict[str, Any]] = []

    # Check for subdirectories like '0', '1', etc.
    sub_dirs = [d for d in sparse_dir.iterdir() if d.is_dir() and d.name.isdigit()]
    if not sub_dirs:
        # Check if sparse_dir itself contains txt/bin files
        if (sparse_dir / "images.txt").is_file() or (sparse_dir / "images.bin").is_file():
            sub_dirs = [sparse_dir]

    for d in sub_dirs:
        cam_file = d / "cameras.txt"
        img_file = d / "images.txt"
        pts_file = d / "points3D.txt"

        cams = parse_cameras_txt(cam_file)
        imgs = parse_images_txt(img_file)
        pts = parse_points3D_txt(pts_file)

        components.append({
            "component_id": d.name,
            "dir": str(d.resolve()),
            "cameras": cams,
            "images": imgs,
            "points3D": pts,
            "num_images": len(imgs),
        })

    # Sort largest component first
    components.sort(key=lambda c: c["num_images"], reverse=True)
    return components


def compute_colmap_metrics(
    total_input_images: int,
    cameras: Dict[int, Dict[str, Any]],
    images: Dict[int, Dict[str, Any]],
    points3D: Dict[int, Dict[str, Any]],
    num_components: int = 1,
    largest_component_images: Optional[int] = None,
) -> Dict[str, Any]:
    """Computes SfM quality metrics required for Gate G3."""
    reg_count = len(images)
    total_imgs = max(total_input_images, reg_count, 1)
    registered_ratio = reg_count / total_imgs

    errors = [p["error"] for p in points3D.values()]
    mean_reproj_px = float(np.mean(errors)) if errors else 0.0

    track_lens = [len(p["track"]) for p in points3D.values()]
    mean_track_len = float(np.mean(track_lens)) if track_lens else 0.0

    kept_imgs = largest_component_images if largest_component_images is not None else reg_count
    largest_ratio = kept_imgs / total_imgs
    discarded = total_imgs - kept_imgs

    return {
        "total_input_images": total_imgs,
        "registered_images": reg_count,
        "registered_ratio": round(registered_ratio, 4),
        "num_components": num_components,
        "largest_component_images": kept_imgs,
        "largest_component_ratio": round(largest_ratio, 4),
        "discarded_frames": discarded,
        "num_3d_points": len(points3D),
        "mean_reproj_px": round(mean_reproj_px, 3),
        "mean_track_length": round(mean_track_len, 2),
    }


def evaluate_gate_g3(
    metrics: Dict[str, Any],
    min_registered_ratio: float = 0.95,
    max_reproj_px: float = 1.0,
    min_largest_component_ratio: float = 0.8,
) -> Tuple[bool, List[str]]:
    """
    Checks Gate G3 criteria per SPEC brief:
    - If 1 component: registered_ratio >= min_registered_ratio (95%)
    - If multiple components: keep the largest component; fail ONLY if it holds
      less than min_largest_component_ratio (80%) of input frames.
    - Mean reprojection error <= max_reproj_px (1.0 px).
    """
    errors: List[str] = []
    components = metrics.get("num_components", 1)
    reproj = metrics.get("mean_reproj_px", 999.0)
    largest_ratio = metrics.get("largest_component_ratio", 0.0)
    reg_ratio = metrics.get("registered_ratio", 0.0)
    discarded = metrics.get("discarded_frames", 0)

    if components == 1:
        if reg_ratio < min_registered_ratio:
            errors.append(f"Registered ratio ({reg_ratio:.2%}) is below threshold ({min_registered_ratio:.2%})")
    else:
        # Multiple components: keep largest, fail only if < min_largest_component_ratio
        if largest_ratio < min_largest_component_ratio:
            errors.append(
                f"Largest component holds only {largest_ratio:.1%} of input frames, "
                f"below required threshold ({min_largest_component_ratio:.1%}). Discarded {discarded} frames."
            )

    if reproj > max_reproj_px:
        errors.append(f"Mean reprojection error ({reproj:.3f}px) exceeds maximum ({max_reproj_px}px)")

    return len(errors) == 0, errors


def run_s03_poses(
    sparse_dir: Union[str, Path],
    total_input_images: int,
    output_dir: Union[str, Path],
    config_path: Optional[Union[str, Path]] = None,
    image_dir: Optional[Union[str, Path]] = None,
    log_dir: Optional[Union[str, Path]] = None,
) -> Dict[str, Any]:
    """
    Runs or parses sparse COLMAP model, keeps the largest component, evaluates Gate G3,
    and writes poses.json and run_report.json.
    """
    start_time = time.time()
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / "run_report.json"
    poses_json_path = out_dir / "poses.json"
    logs = Path(log_dir) if log_dir else out_dir / "logs"

    config, config_hash = load_config(config_path)
    c_cfg = config.get("colmap", {})
    min_registered_ratio = float(c_cfg.get("min_registered_ratio", 0.95))
    max_reproj_px = float(c_cfg.get("max_reproj_px", 1.0))
    min_comp_ratio = float(c_cfg.get("min_largest_component_ratio", 0.8))
    camera_model = str(c_cfg.get("camera_model", "SIMPLE_RADIAL"))
    matcher = str(c_cfg.get("matcher", "exhaustive"))
    sequential_overlap = int(c_cfg.get("sequential_overlap", 10))
    # "global" = COLMAP 4.x global_mapper (GLOMAP), much faster than incremental on 400+ frames
    use_global_mapper = str(c_cfg.get("mapper", "incremental")).lower() == "global"
    colmap_timeout_s = int(c_cfg.get("timeout_s", 1800))

    s_dir = Path(sparse_dir)

    # Real Executor: If colmap is installed and image_dir is given, run colmap
    if image_dir and Path(image_dir).is_dir() and shutil.which("colmap"):
        # colmap mapper refuses an output_path that does not exist yet
        s_dir.mkdir(parents=True, exist_ok=True)
        db_path = out_dir / "colmap.db"
        cmds = build_colmap_commands(
            database_path=db_path,
            image_path=image_dir,
            output_path=s_dir,
            camera_model=camera_model,
            matcher=matcher,
            sequential_overlap=sequential_overlap,
            use_global_mapper=use_global_mapper,
        )
        ok = execute_colmap(cmds, log_dir=logs, timeout_s=colmap_timeout_s)
        if not ok:
            fail_gate(
                gate="G3",
                stage="s03_poses",
                measured="COLMAP CLI execution failed",
                threshold="Clean COLMAP exit code 0",
                message="COLMAP reconstruction commands failed. Check logs.",
                report_path=report_path,
            )

    # Parse discovered components
    components = discover_and_parse_components(s_dir)
    if not components:
        fail_gate(
            gate="G3",
            stage="s03_poses",
            measured=0,
            threshold="At least 1 valid sparse submodel",
            message=f"No COLMAP submodels found in {s_dir}",
            report_path=report_path,
        )

    # Keep largest component
    largest = components[0]
    num_components = len(components)

    metrics = compute_colmap_metrics(
        total_input_images=total_input_images,
        cameras=largest["cameras"],
        images=largest["images"],
        points3D=largest["points3D"],
        num_components=num_components,
        largest_component_images=largest["num_images"],
    )

    passed, errors = evaluate_gate_g3(
        metrics=metrics,
        min_registered_ratio=min_registered_ratio,
        max_reproj_px=max_reproj_px,
        min_largest_component_ratio=min_comp_ratio,
    )

    elapsed = time.time() - start_time
    if not passed:
        fail_gate(
            gate="G3",
            stage="s03_poses",
            measured=metrics,
            threshold={
                "min_registered_ratio": min_registered_ratio,
                "max_reproj_px": max_reproj_px,
                "min_largest_component_ratio": min_comp_ratio,
            },
            message="; ".join(errors),
            report_path=report_path,
            duration_s=elapsed,
            metrics=metrics,
        )

    poses_data = {
        "schema_version": 1,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "metrics": metrics,
        "gate_g3": {
            "passed": True,
            "registered_ratio": metrics["registered_ratio"],
            "largest_component_ratio": metrics["largest_component_ratio"],
            "discarded_frames": metrics["discarded_frames"],
            "mean_reproj_px": metrics["mean_reproj_px"],
            "num_components": num_components,
        },
        "kept_model_dir": largest["dir"],
        "human_check_instructions": [
            "[HUMAN] Open sparse reconstruction model in COLMAP GUI or MeshLab.",
            "[HUMAN] Verify visually that the room boundaries, floor, and walls are aligned without ghost structures.",
        ],
    }

    with open(poses_json_path, "w", encoding="utf-8") as f:
        json.dump(poses_data, f, indent=2)

    record_stage_result(
        report_path=report_path,
        stage_name="s03_poses",
        gate="G3",
        status="passed",
        duration_s=elapsed,
        input_hash=str(sparse_dir),
        config_hash=config_hash,
        metrics=metrics,
        gate_result={
            "passed": True,
            "measured": metrics,
            "threshold": {
                "min_registered_ratio": min_registered_ratio,
                "min_largest_component_ratio": min_comp_ratio,
                "max_reproj_px": max_reproj_px,
            },
        },
    )

    print(
        f"[s03_poses] Gate G3 PASSED: kept component '{largest['component_id']}' with {metrics['largest_component_images']}/{metrics['total_input_images']} "
        f"({metrics['largest_component_ratio']:.1%}) frames, discarded={metrics['discarded_frames']}, reproj={metrics['mean_reproj_px']}px"
    )
    return poses_data


def main() -> int:
    parser = argparse.ArgumentParser(description="Namma Space Stage S03 - COLMAP Camera Poses & Gate G3")
    parser.add_argument("--sparse-dir", required=True, help="Path to COLMAP sparse reconstruction directory")
    parser.add_argument("--total-images", type=int, required=True, help="Total candidate frames sent to COLMAP")
    parser.add_argument("--output-dir", default="runs/dev", help="Output directory for stage artifacts")
    parser.add_argument("--config", default=None, help="Optional path to config default.yaml")
    parser.add_argument("--image-dir", default=None, help="Optional path to frames directory for real COLMAP execution")
    args = parser.parse_args()

    try:
        run_s03_poses(
            sparse_dir=args.sparse_dir,
            total_input_images=args.total_images,
            output_dir=args.output_dir,
            config_path=args.config,
            image_dir=args.image_dir,
        )
        return 0
    except GateFailure:
        return 1
    except Exception as e:
        print(f"[s03_poses ERROR] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
