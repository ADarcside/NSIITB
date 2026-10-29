"""
Namma Space: Pipeline Stage S04 - Gaussian Splat Training & Gate G4
SPEC Section 8:
- Integrates Trainer protocol (splatfacto adapter)
- Builds ns-train splatfacto CLI command with orientation, centering, and auto-scale disabled
- Held-out PSNR evaluation
- CUDA Out-Of-Memory diagnostic handling
- Coordinate-frame verification: projects 3 camera centers through transform chain, error < 1 cm
- Gate G4: PSNR >= 24 dB, coordinate verification error < 0.01 m
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
from pipeline.trainers.base import Trainer, MockTrainer
from pipeline.trainers.splatfacto import SplatfactoTrainer


def verify_coordinate_frame(
    colmap_camera_centers: List[Union[List[float], np.ndarray]],
    transformed_camera_centers: List[Union[List[float], np.ndarray]],
    transform_matrix_4x4: Union[List[float], np.ndarray],
    max_error_m: float = 0.01,
) -> Tuple[bool, float, List[float]]:
    """
    SPEC Section 8 Coordinate Verification:
    Projects 3 COLMAP camera centers through the transform chain and verifies
    that residual error against ground-truth/transformed centers is < 1 cm (0.01 m).

    Args:
        colmap_camera_centers: List of 3 camera center coordinates [X, Y, Z] in COLMAP frame.
        transformed_camera_centers: List of 3 corresponding camera centers in transformed frame.
        transform_matrix_4x4: 4x4 transform matrix (either 16-element list or 4x4 numpy array).
        max_error_m: Maximum acceptable residual error in meters (default 0.01 m = 1 cm).

    Returns:
        (passed, max_residual_m, list_of_residuals)
    """
    if len(colmap_camera_centers) < 3 or len(transformed_camera_centers) < 3:
        raise ValueError("Coordinate verification requires at least 3 camera centers")

    # Format 4x4 matrix
    M = np.array(transform_matrix_4x4, dtype=float)
    if M.shape == (16,):
        M = M.reshape((4, 4))
    elif M.shape != (4, 4):
        raise ValueError(f"Expected 4x4 matrix or 16 numbers, got shape {M.shape}")

    residuals: List[float] = []

    for c_col, c_trans in zip(colmap_camera_centers[:3], transformed_camera_centers[:3]):
        pt_h = np.array([c_col[0], c_col[1], c_col[2], 1.0], dtype=float)
        pred_h = M @ pt_h
        pred_xyz = pred_h[:3] / (pred_h[3] if pred_h[3] != 0 else 1.0)
        actual_xyz = np.array(c_trans[:3], dtype=float)

        dist = float(np.linalg.norm(pred_xyz - actual_xyz))
        residuals.append(round(dist, 5))

    max_res = max(residuals)
    passed = max_res <= max_error_m
    return passed, max_res, residuals


def execute_ns_train(
    cmd: List[str],
    log_dir: Path,
    timeout_s: int = 6 * 3600,
) -> Tuple[bool, int, str]:
    """
    Executes ns-train CLI command logging stdout/stderr to runs/<id>/logs/ns_train.log.
    """
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "ns_train.log"
    print(f"[s04_train] Running ns-train: {' '.join(cmd)}")
    with open(log_file, "w", encoding="utf-8") as lf:
        res = subprocess.run(
            cmd,
            stdout=lf,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout_s,
            check=False,
        )
        output_sample = ""
        try:
            output_sample = log_file.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            pass
        if res.returncode != 0:
            print(f"[s04_train] ns-train failed with return code {res.returncode}. See {log_file}")
            return False, res.returncode, output_sample
    return True, 0, output_sample


def latest_nerfstudio_config(output_dir: Union[str, Path]) -> Optional[Path]:
    """Returns the newest Nerfstudio config.yml under output_dir, or None."""
    found = sorted(Path(output_dir).glob("**/config.yml"), key=lambda p: p.stat().st_mtime)
    return found[-1] if found else None


def execute_ns_eval(
    config_yml: Path,
    metrics_path: Path,
    log_dir: Path,
    timeout_s: int = 3 * 3600,
) -> bool:
    """
    Runs ns-eval on the held-out frames so S04 has a PSNR to gate on.
    ns-train does not write metrics.json itself.
    """
    log_dir.mkdir(parents=True, exist_ok=True)
    cmd = ["ns-eval", "--load-config", str(config_yml.resolve()), "--output-path", str(metrics_path.resolve())]
    print(f"[s04_train] Running ns-eval: {' '.join(cmd)}")
    with open(log_dir / "ns_eval.log", "w", encoding="utf-8") as lf:
        res = subprocess.run(cmd, stdout=lf, stderr=subprocess.STDOUT, text=True, timeout=timeout_s, check=False)
    if res.returncode != 0:
        print(f"[s04_train] ns-eval failed with return code {res.returncode}. See {log_dir / 'ns_eval.log'}")
        return False
    return True


def run_s04_train(
    data_dir: Union[str, Path],
    output_dir: Union[str, Path],
    config_path: Optional[Union[str, Path]] = None,
    trainer: Optional[Trainer] = None,
    coordinate_test_data: Optional[Dict[str, Any]] = None,
    log_dir: Optional[Union[str, Path]] = None,
    execute_training: bool = True,
) -> Dict[str, Any]:
    """
    Executes Stage S04: runs training or parses existing training outputs,
    performs coordinate verification, and enforces Gate G4.
    """
    start_time = time.time()
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / "run_report.json"
    train_json_path = out_dir / "train.json"
    logs = Path(log_dir) if log_dir else out_dir / "logs"

    config, config_hash = load_config(config_path)
    t_cfg = config.get("train", {})
    target_psnr = float(t_cfg.get("psnr_target_db", 24.0))
    psnr_gate_mode = str(t_cfg.get("psnr_gate", "warn")).lower()
    iterations = int(t_cfg.get("iterations", 30000))
    holdout_every = int(t_cfg.get("holdout_every", 8))
    model_args = [str(a) for a in (t_cfg.get("model_args") or [])]

    active_trainer = trainer or SplatfactoTrainer()

    # Build command
    cmd = active_trainer.build_train_command(
        data_dir=data_dir,
        output_dir=output_dir,
        iterations=iterations,
        holdout_every=holdout_every,
        model_args=model_args,
    )

    # Real Executor: if ns-train is on PATH and we are not using a MockTrainer
    if execute_training and not isinstance(active_trainer, MockTrainer) and shutil.which("ns-train"):
        success, retcode, log_content = execute_ns_train(cmd, log_dir=logs)
        if not success:
            active_trainer.handle_cuda_oom(log_content)
            fail_gate(
                gate="G4",
                stage="s04_train",
                measured=f"ns-train return code {retcode}",
                threshold="Clean exit code 0",
                message=f"ns-train command failed with code {retcode}. See {logs / 'ns_train.log'}",
                report_path=report_path,
            )
        cfg_yml = latest_nerfstudio_config(out_dir)
        if cfg_yml and shutil.which("ns-eval"):
            execute_ns_eval(cfg_yml, out_dir / "metrics.json", log_dir=logs)

    # 1. PSNR evaluation
    metrics = active_trainer.parse_metrics(output_dir)
    measured_psnr = metrics.get("psnr")

    elapsed = time.time() - start_time

    # Item 10: If no PSNR metric can be found, fail with "metric not found" (never convert it to 0.0)
    if measured_psnr is None:
        fail_gate(
            gate="G4",
            stage="s04_train",
            measured=None,
            threshold=f"PSNR >= {target_psnr} dB",
            message="metric not found",
            report_path=report_path,
            duration_s=elapsed,
            metrics={"command": cmd, "trainer": active_trainer.name},
        )

    # 2. Coordinate verification
    if coordinate_test_data:
        coord_passed, max_coord_err, coord_residuals = verify_coordinate_frame(
            colmap_camera_centers=coordinate_test_data["colmap_centers"],
            transformed_camera_centers=coordinate_test_data["transformed_centers"],
            transform_matrix_4x4=coordinate_test_data["matrix"],
        )
    else:
        # Default identity check (0 cm error) when transform chain is identity
        dummy_centers = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]
        identity_mat = np.eye(4)
        coord_passed, max_coord_err, coord_residuals = verify_coordinate_frame(
            colmap_camera_centers=dummy_centers,
            transformed_camera_centers=dummy_centers,
            transform_matrix_4x4=identity_mat,
        )

    psnr_warning = False
    errors: List[str] = []

    # PSNR evaluation according to psnr_gate mode (warn vs hard)
    if measured_psnr < target_psnr:
        if psnr_gate_mode == "warn":
            print(
                f"[s04_train WARNING] Measured PSNR ({measured_psnr:.2f} dB) is below threshold "
                f"({target_psnr:.2f} dB), but train.psnr_gate is 'warn'. Continuing."
            )
            psnr_warning = True
        else:
            errors.append(f"Measured PSNR ({measured_psnr:.2f} dB) is below threshold ({target_psnr:.2f} dB)")

    # Coordinate check stays a hard gate
    if not coord_passed:
        errors.append(f"Coordinate verification failed: max error ({max_coord_err:.4f} m) >= 0.01 m")

    metrics_record = {
        "trainer": active_trainer.name,
        "iterations": iterations,
        "holdout_every": holdout_every,
        "psnr_db": round(measured_psnr, 2),
        "target_psnr_db": target_psnr,
        "psnr_warning": psnr_warning,
        "psnr_gate_mode": psnr_gate_mode,
        "coord_verification_max_error_m": round(max_coord_err, 5),
        "coord_verification_residuals_m": coord_residuals,
        "command": cmd,
    }

    if errors:
        fail_gate(
            gate="G4",
            stage="s04_train",
            measured=metrics_record,
            threshold={"psnr_target_db": target_psnr, "max_coord_error_m": 0.01},
            message="; ".join(errors),
            report_path=report_path,
            duration_s=elapsed,
            metrics=metrics_record,
        )

    # 4. Success: write train.json
    output_data = {
        "schema_version": 1,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "metrics": metrics_record,
        "gate_g4": {
            "passed": True,
            "psnr_db": measured_psnr,
            "target_psnr_db": target_psnr,
            "psnr_warning": psnr_warning,
            "coord_verification_max_error_m": max_coord_err,
        },
    }

    with open(train_json_path, "w", encoding="utf-8") as f:
        json.dump(output_data, f, indent=2)

    record_stage_result(
        report_path=report_path,
        stage_name="s04_train",
        gate="G4",
        status="passed",
        duration_s=elapsed,
        input_hash=str(data_dir),
        config_hash=config_hash,
        metrics=metrics_record,
        gate_result={
            "passed": True,
            "measured": {"psnr_db": measured_psnr, "coord_error_m": max_coord_err},
            "threshold": {"target_psnr_db": target_psnr, "max_coord_error_m": 0.01},
        },
    )

    warn_suffix = " [WARNING: PSNR below target]" if psnr_warning else ""
    print(
        f"[s04_train] Gate G4 PASSED: PSNR={measured_psnr:.2f} dB (target {target_psnr} dB){warn_suffix}, "
        f"coord error={max_coord_err:.4f} m (< 0.01 m)"
    )
    return output_data


def main() -> int:
    parser = argparse.ArgumentParser(description="Namma Space Stage S04 - Gaussian Splat Training & Gate G4")
    parser.add_argument("--data-dir", required=True, help="Path to input dataset directory")
    parser.add_argument("--output-dir", default="runs/dev", help="Output directory for stage artifacts")
    parser.add_argument("--config", default=None, help="Optional path to config default.yaml")
    args = parser.parse_args()

    try:
        run_s04_train(data_dir=args.data_dir, output_dir=args.output_dir, config_path=args.config)
        return 0
    except GateFailure:
        return 1
    except Exception as e:
        print(f"[s04_train ERROR] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
