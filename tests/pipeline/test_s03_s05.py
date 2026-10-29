"""
Namma Space: Unit Tests for Pipeline Stages S03, S04, and S05 (Phase 3)
Tests:
- S03 COLMAP command builder, text parsers (cameras, images, points3D), metrics, Gate G3
- S04 Splatfacto Trainer adapter, CUDA OOM detection, coordinate-frame verification (< 1 cm error), Gate G4
- S05 Pure NumPy PLY reader (no plyfile), 62 float32 properties check, Gate G5
"""

import json
from pathlib import Path
import shutil
import tempfile
import pytest
import numpy as np

from pipeline.common import GateFailure
from pipeline.stages.s03_poses import (
    build_colmap_commands,
    parse_cameras_txt,
    parse_images_txt,
    parse_points3D_txt,
    compute_colmap_metrics,
    evaluate_gate_g3,
    run_s03_poses,
)
from pipeline.stages.s04_train import (
    verify_coordinate_frame,
    run_s04_train,
)
from pipeline.trainers.base import MockTrainer
from pipeline.trainers.splatfacto import SplatfactoTrainer
from pipeline.stages.s05_export import (
    build_ns_export_command,
    read_ply_gaussian_header,
    read_ply_gaussians_numpy,
    write_synthetic_ply,
    run_s05_export,
    EXPECTED_GAUSSIAN_PROPERTY_COUNT,
)


@pytest.fixture
def temp_dir():
    tmp = tempfile.mkdtemp(prefix="namma_test_s03_s05_")
    yield Path(tmp)
    shutil.rmtree(tmp, ignore_errors=True)


class TestStage03Poses:
    def test_build_colmap_commands(self):
        cmds = build_colmap_commands(
            database_path="run/colmap.db",
            image_path="run/frames",
            output_path="run/sparse",
            camera_model="SIMPLE_RADIAL",
            matcher="exhaustive",
            use_global_mapper=False,
        )
        assert "feature_extractor" in cmds
        assert "matcher" in cmds
        assert "mapper" in cmds
        assert "model_converter" in cmds

        # Check single camera flag
        assert "--ImageReader.single_camera" in cmds["feature_extractor"]
        assert "1" in cmds["feature_extractor"]

        # Check sequential matcher option
        cmds_seq = build_colmap_commands(
            database_path="db.db",
            image_path="imgs",
            output_path="sparse",
            matcher="sequential",
        )
        assert "sequential_matcher" in cmds_seq["matcher"][1]

        # Check global mapper retry
        cmds_global = build_colmap_commands(
            database_path="db.db",
            image_path="imgs",
            output_path="sparse",
            use_global_mapper=True,
        )
        assert "global_mapper" in cmds_global["mapper"][1]

    def test_colmap_text_parsers_with_handmade_fixtures(self, temp_dir):
        # 1. Create cameras.txt
        cam_file = temp_dir / "cameras.txt"
        cam_file.write_text(
            "# Camera list with one line of data per camera:\n"
            "#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n"
            "1 SIMPLE_RADIAL 1920 1080 1200.0 960.0 540.0 0.015\n"
        )

        cameras = parse_cameras_txt(cam_file)
        assert 1 in cameras
        assert cameras[1]["model"] == "SIMPLE_RADIAL"
        assert cameras[1]["width"] == 1920
        assert cameras[1]["height"] == 1080
        assert len(cameras[1]["params"]) == 4

        # 2. Create images.txt
        img_file = temp_dir / "images.txt"
        img_file.write_text(
            "# Image list with two lines of data per image:\n"
            "#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n"
            "1 1.0 0.0 0.0 0.0 0.0 0.0 0.0 1 frame_000001.jpg\n"
            "100.5 200.5 1 300.2 400.1 2\n"
            "2 0.999 0.0 0.04 0.0 0.1 0.0 0.05 1 frame_000002.jpg\n"
            "102.0 201.0 1 305.0 402.0 2\n"
        )

        images = parse_images_txt(img_file)
        assert len(images) == 2
        assert images[1]["name"] == "frame_000001.jpg"
        assert len(images[1]["points2D"]) == 2
        assert images[2]["tvec"] == [0.1, 0.0, 0.05]

        # 3. Create points3D.txt
        pts_file = temp_dir / "points3D.txt"
        pts_file.write_text(
            "# 3D point list with one line of data per point:\n"
            "#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)\n"
            "1 0.1 0.2 1.5 255 128 64 0.45 1 0 2 0\n"
            "2 0.3 0.4 1.8 128 255 32 0.75 1 1 2 1\n"
        )

        pts = parse_points3D_txt(pts_file)
        assert len(pts) == 2
        assert pts[1]["error"] == 0.45
        assert len(pts[1]["track"]) == 2
        assert pts[2]["rgb"] == [128, 255, 32]

        # 4. Compute metrics
        metrics = compute_colmap_metrics(
            total_input_images=2,
            cameras=cameras,
            images=images,
            points3D=pts,
            num_components=1,
        )
        assert metrics["registered_images"] == 2
        assert metrics["registered_ratio"] == 1.0
        assert metrics["mean_reproj_px"] == 0.60
        assert metrics["mean_track_length"] == 2.0

        # 5. Gate G3 evaluation
        passed, errors = evaluate_gate_g3(metrics, min_registered_ratio=0.95, max_reproj_px=1.0)
        assert passed is True
        assert len(errors) == 0

        # Test failure cases
        passed_fail_reproj, errs = evaluate_gate_g3(metrics, max_reproj_px=0.5)
        assert passed_fail_reproj is False

        passed_fail_reg, errs = evaluate_gate_g3(
            compute_colmap_metrics(10, cameras, images, pts),
            min_registered_ratio=0.95,
        )
        assert passed_fail_reg is False

    def test_gate_g3_multi_component_evaluations(self):
        # Brief 9: Test 1 component, 2 components with largest at 90%, and 2 components with largest at 60%
        # 1 component: 100/100 (100% >= 95% threshold)
        m_1comp = {
            "num_components": 1,
            "registered_ratio": 1.0,
            "largest_component_ratio": 1.0,
            "discarded_frames": 0,
            "mean_reproj_px": 0.5,
        }
        passed_1, errs_1 = evaluate_gate_g3(m_1comp, min_registered_ratio=0.95, min_largest_component_ratio=0.8, max_reproj_px=1.0)
        assert passed_1 is True
        assert len(errs_1) == 0

        # 2 components: largest holds 90% (>= 80% threshold)
        m_2comp_90 = {
            "num_components": 2,
            "registered_ratio": 1.0,
            "largest_component_ratio": 0.90,
            "discarded_frames": 10,
            "mean_reproj_px": 0.5,
        }
        passed_90, errs_90 = evaluate_gate_g3(m_2comp_90, min_registered_ratio=0.95, min_largest_component_ratio=0.8, max_reproj_px=1.0)
        assert passed_90 is True
        assert len(errs_90) == 0

        # 2 components: largest holds 60% (< 80% threshold -> fails Gate G3)
        m_2comp_60 = {
            "num_components": 2,
            "registered_ratio": 1.0,
            "largest_component_ratio": 0.60,
            "discarded_frames": 40,
            "mean_reproj_px": 0.5,
        }
        passed_60, errs_60 = evaluate_gate_g3(m_2comp_60, min_registered_ratio=0.95, min_largest_component_ratio=0.8, max_reproj_px=1.0)
        assert passed_60 is False
        assert len(errs_60) == 1
        assert "60.0%" in errs_60[0]
        assert "Discarded 40 frames" in errs_60[0]

    def test_run_s03_poses_end_to_end_multi_component(self, temp_dir):
        # Component 0: 9 images
        s0 = temp_dir / "sparse" / "0"
        s0.mkdir(parents=True)
        (s0 / "cameras.txt").write_text("1 SIMPLE_RADIAL 1920 1080 1200 960 540 0.01\n")
        lines_0 = [f"{i} 1.0 0.0 0.0 0.0 0.0 0.0 0.0 1 frame_{i:03d}.jpg\n10 10 1\n" for i in range(1, 10)]
        (s0 / "images.txt").write_text("".join(lines_0))
        (s0 / "points3D.txt").write_text("1 0 0 1 255 255 255 0.5 1 0 2 0\n")

        # Component 1: 1 image
        s1 = temp_dir / "sparse" / "1"
        s1.mkdir(parents=True)
        (s1 / "cameras.txt").write_text("1 SIMPLE_RADIAL 1920 1080 1200 960 540 0.01\n")
        (s1 / "images.txt").write_text("10 1.0 0.0 0.0 0.0 0.0 0.0 0.0 1 frame_010.jpg\n10 10 1\n")
        (s1 / "points3D.txt").write_text("2 0 0 1 255 255 255 0.5 10 0\n")

        out = run_s03_poses(
            sparse_dir=temp_dir / "sparse",
            total_input_images=10,
            output_dir=temp_dir / "out",
        )
        assert out["gate_g3"]["passed"] is True
        assert out["gate_g3"]["num_components"] == 2
        assert out["gate_g3"]["largest_component_ratio"] == 0.9
        assert out["gate_g3"]["discarded_frames"] == 1
        assert (temp_dir / "out" / "poses.json").is_file()


class TestStage04Train:
    def test_splatfacto_command_builder(self):
        trainer = SplatfactoTrainer()
        cmd = trainer.build_train_command(
            data_dir="/tmp/data",
            output_dir="/tmp/output",
            iterations=30000,
            holdout_every=8,
        )
        assert cmd[0] == "ns-train"
        assert cmd[1] == "splatfacto"
        # Dataparser options must follow the colmap subcommand
        ci = cmd.index("colmap")
        dp = cmd[ci + 1:]
        assert dp[dp.index("--orientation-method") + 1] == "none"
        assert dp[dp.index("--center-method") + 1] == "none"
        assert dp[dp.index("--auto-scale-poses") + 1] == "False"
        assert dp[dp.index("--images-path") + 1] == "frames"
        assert dp[dp.index("--colmap-path") + 1] == "colmap/sparse/0"
        assert dp[dp.index("--eval-interval") + 1] == "8"
        assert "--max-num-iterations" in cmd[:ci]
        assert "--pipeline.model.disable-auto-scale" not in cmd
        assert not any(a.startswith("--pipeline.datamanager.dataparser") for a in cmd)

    def test_splatfacto_model_args_go_before_colmap(self):
        cmd = SplatfactoTrainer().build_train_command(
            data_dir="/tmp/data",
            output_dir="/tmp/output",
            model_args=["--pipeline.model.use-scale-regularization", "True"],
        )
        ci = cmd.index("colmap")
        i = cmd.index("--pipeline.model.use-scale-regularization")
        assert i < ci and cmd[i + 1] == "True"

    def test_cuda_oom_detection(self):
        trainer = SplatfactoTrainer()
        assert trainer.handle_cuda_oom("torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB")
        assert not trainer.handle_cuda_oom("FileNotFoundError: images not found")

    def test_coordinate_frame_verification(self):
        # 3 camera centers in COLMAP space
        colmap_centers = [
            [0.0, 0.0, 0.0],
            [1.5, 0.2, 0.8],
            [-0.5, 1.2, 2.0],
        ]

        # Case 1: Exact rigid transform (rotation 90 deg around Y + translation)
        # R_y(90 deg): x' = z, y' = y, z' = -x
        # T: dx=2.0, dy=1.0, dz=-1.0
        T = np.array([
            [0.0, 0.0, 1.0, 2.0],
            [0.0, 1.0, 0.0, 1.0],
            [-1.0, 0.0, 0.0, -1.0],
            [0.0, 0.0, 0.0, 1.0],
        ])

        transformed_centers = []
        for c in colmap_centers:
            p_h = T @ np.array([c[0], c[1], c[2], 1.0])
            transformed_centers.append(list(p_h[:3]))

        passed, max_err, residuals = verify_coordinate_frame(
            colmap_camera_centers=colmap_centers,
            transformed_camera_centers=transformed_centers,
            transform_matrix_4x4=T,
            max_error_m=0.01,
        )
        assert passed is True
        assert max_err < 1e-4

        # Case 2: Transform with drift (2 cm error on point 2)
        drifted_centers = [c.copy() for c in transformed_centers]
        drifted_centers[1][0] += 0.02  # 2 cm drift (> 1 cm threshold)

        passed_drift, max_err_drift, _ = verify_coordinate_frame(
            colmap_camera_centers=colmap_centers,
            transformed_camera_centers=drifted_centers,
            transform_matrix_4x4=T,
            max_error_m=0.01,
        )
        assert passed_drift is False
        assert max_err_drift >= 0.02

    def test_run_s04_train_dependency_injection_success(self, temp_dir):
        # Pass using dependency injection with MockTrainer
        mock_trainer = MockTrainer(psnr=26.5)
        out = run_s04_train(
            data_dir=temp_dir,
            output_dir=temp_dir / "train_out",
            trainer=mock_trainer,
        )
        assert out["gate_g4"]["passed"] is True
        assert out["gate_g4"]["psnr_db"] == 26.5
        assert out["gate_g4"]["psnr_warning"] is False

    def test_run_s04_train_missing_metric_fails_with_exact_message(self, temp_dir):
        # Item 10: If no PSNR metric can be found, fail with "metric not found" (never convert to 0.0)
        mock_trainer = MockTrainer(psnr=None)
        with pytest.raises(GateFailure) as exc:
            run_s04_train(
                data_dir=temp_dir,
                output_dir=temp_dir / "train_out",
                trainer=mock_trainer,
            )
        assert exc.value.gate == "G4"
        assert exc.value.message == "metric not found"

    def test_run_s04_train_psnr_warning_mode(self, temp_dir):
        # Item 10: Make PSNR threshold a warning, not a failure, when train.psnr_gate: warn
        mock_trainer = MockTrainer(psnr=21.0)
        out = run_s04_train(
            data_dir=temp_dir,
            output_dir=temp_dir / "train_out",
            trainer=mock_trainer,
        )
        assert out["gate_g4"]["passed"] is True
        assert out["gate_g4"]["psnr_db"] == 21.0
        assert out["gate_g4"]["psnr_warning"] is True

    def test_run_s04_train_psnr_hard_gate_mode(self, temp_dir):
        # When train.psnr_gate is 'hard', low PSNR fails Gate G4
        cfg_file = temp_dir / "hard_config.yaml"
        cfg_file.write_text("train:\n  psnr_target_db: 24.0\n  psnr_gate: hard\n")
        mock_trainer = MockTrainer(psnr=21.0)
        with pytest.raises(GateFailure) as exc:
            run_s04_train(
                data_dir=temp_dir,
                output_dir=temp_dir / "train_out",
                trainer=mock_trainer,
                config_path=cfg_file,
            )
        assert exc.value.gate == "G4"
        assert "below threshold" in exc.value.message

    def test_run_s04_train_coordinate_frame_hard_gate(self, temp_dir):
        # Item 10: Coordinate-frame check stays a hard gate
        mock_trainer = MockTrainer(psnr=28.0)
        bad_coord_data = {
            "colmap_centers": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            "transformed_centers": [[0.0, 0.0, 0.0], [1.05, 0.0, 0.0], [0.0, 1.0, 0.0]], # 5cm error > 1cm
            "matrix": np.eye(4),
        }
        with pytest.raises(GateFailure) as exc:
            run_s04_train(
                data_dir=temp_dir,
                output_dir=temp_dir / "train_out",
                trainer=mock_trainer,
                coordinate_test_data=bad_coord_data,
            )
        assert exc.value.gate == "G4"
        assert "Coordinate verification failed" in exc.value.message


class TestStage05Export:
    def test_ns_export_command_builder(self):
        cmd = build_ns_export_command("config.yml", "export_dir")
        assert cmd[0] == "ns-export"
        assert cmd[1] == "gaussian-splat"
        assert "--load-config" in cmd
        assert "--output-dir" in cmd

    def test_pure_numpy_ply_writer_and_reader(self, temp_dir):
        ply_file = temp_dir / "synthetic_raw.ply"
        write_synthetic_ply(ply_file, num_gaussians=50)

        # 1. Header parsing
        header = read_ply_gaussian_header(ply_file)
        assert header["format"] == "binary_little_endian"
        assert header["num_vertices"] == 50
        assert len(header["properties"]) == EXPECTED_GAUSSIAN_PROPERTY_COUNT

        # 2. NumPy data loading (Shape N, 62)
        parsed = read_ply_gaussians_numpy(ply_file)
        assert parsed["num_gaussians"] == 50
        assert parsed["data"].shape == (50, 62)
        assert parsed["data"].dtype == np.float32

        # 3. Gate G5 execution
        out = run_s05_export(ply_path=ply_file, output_dir=temp_dir / "export_out")
        assert out["gate_g5"]["passed"] is True
        assert out["gate_g5"]["num_gaussians"] == 50
        assert (temp_dir / "export_out" / "export.json").is_file()

    def test_ply_rejection_on_invalid_properties(self, temp_dir):
        # Create invalid PLY with only 3 properties
        bad_ply = temp_dir / "bad.ply"
        bad_ply.write_bytes(
            b"ply\n"
            b"format binary_little_endian 1.0\n"
            b"element vertex 10\n"
            b"property float x\n"
            b"property float y\n"
            b"property float z\n"
            b"end_header\n" + (b"\x00" * 120)
        )

        with pytest.raises(GateFailure) as exc:
            run_s05_export(ply_path=bad_ply, output_dir=temp_dir / "bad_out")
        assert exc.value.gate == "G5"
        assert "62 properties" in exc.value.message or "Failed to parse PLY" in exc.value.message
