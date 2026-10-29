"""
Namma Space: Unit Tests for Pipeline Common, Stage S01, and Stage S02 (Phase 3)
Tests:
- Config loading & hash calculation
- run_report.json logging & idempotence helpers
- S01 validation (Gate G1) with ffprobe & contract validation
- S02 frame extraction (Gate G2) & 3-pass filtering with synthetic video
"""

import json
from pathlib import Path
import subprocess
import shutil
import tempfile
import pytest
import numpy as np
import cv2

from pipeline.common import (
    load_config,
    load_run_report,
    record_stage_result,
    should_skip_stage,
    sha256_file,
    fail_gate,
    GateFailure,
)
from pipeline.stages.s01_validate import run_s01_validate, probe_video
from pipeline.stages.s02_frames import (
    run_s02_frames,
    compute_laplacian_sharpness,
    compute_image_difference,
    filter_frames,
)

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"


@pytest.fixture
def temp_run_dir():
    tmp = tempfile.mkdtemp(prefix="namma_test_run_")
    yield Path(tmp)
    shutil.rmtree(tmp, ignore_errors=True)


@pytest.fixture
def synthetic_video(temp_run_dir):
    """
    Creates a temporary 2-second synthetic 1920x1080 test video via ffmpeg testsrc.
    No video files are checked into git.
    """
    video_path = temp_run_dir / "synthetic_test.mp4"
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=2:size=1920x1080:rate=10",
        "-pix_fmt",
        "yuv420p",
        str(video_path),
    ]
    subprocess.run(cmd, capture_output=True, text=True, check=True)
    assert video_path.is_file() and video_path.stat().st_size > 0
    return video_path


@pytest.fixture
def synthetic_lowres_video(temp_run_dir):
    """Creates a temporary 720p test video to test resolution gate failure."""
    video_path = temp_run_dir / "synthetic_720p.mp4"
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=2:size=1280x720:rate=10",
        "-pix_fmt",
        "yuv420p",
        str(video_path),
    ]
    subprocess.run(cmd, capture_output=True, text=True, check=True)
    return video_path


class TestPipelineCommon:
    def test_load_default_config(self):
        config, config_hash = load_config()
        assert "validate" in config
        assert "frames" in config
        assert "colmap" in config
        assert "train" in config
        assert len(config_hash) == 64  # SHA-256

    def test_run_report_lifecycle_and_idempotence(self, temp_run_dir):
        report_path = temp_run_dir / "run_report.json"
        dummy_out = temp_run_dir / "output.txt"

        # Not yet run -> should not skip
        assert not should_skip_stage(report_path, "test_stage", "in_123", "cfg_456", [dummy_out])

        # Record success
        record_stage_result(
            report_path=report_path,
            stage_name="test_stage",
            gate="G0",
            status="passed",
            duration_s=1.23,
            input_hash="in_123",
            config_hash="cfg_456",
            metrics={"count": 10},
            gate_result={"passed": True},
        )

        # Output does not exist yet -> should not skip
        assert not should_skip_stage(report_path, "test_stage", "in_123", "cfg_456", [dummy_out])

        # Create output file -> should now skip
        dummy_out.write_text("done")
        assert should_skip_stage(report_path, "test_stage", "in_123", "cfg_456", [dummy_out])

        # Different input hash -> should not skip
        assert not should_skip_stage(report_path, "test_stage", "in_999", "cfg_456", [dummy_out])

    def test_gate_failure_records_and_raises(self, temp_run_dir):
        report_path = temp_run_dir / "run_report.json"
        with pytest.raises(GateFailure) as exc_info:
            fail_gate(
                gate="G1",
                stage="s01_validate",
                measured=45.0,
                threshold=90.0,
                message="Video too short",
                report_path=report_path,
                duration_s=0.5,
                input_hash="hash_1",
                config_hash="hash_2",
            )
        assert exc_info.value.gate == "G1"
        assert exc_info.value.measured == 45.0

        # Check recorded report
        report = load_run_report(report_path)
        assert report["stages"]["s01_validate"]["status"] == "failed"
        assert report["stages"]["s01_validate"]["gate"] == "G1"


class TestStage01Validate:
    def test_probe_synthetic_video(self, synthetic_video):
        meta = probe_video(synthetic_video)
        assert meta["width"] == 1920
        assert meta["height"] == 1080
        assert 1.8 <= meta["duration_s"] <= 2.2

    def test_s01_success_with_testing_flag(self, synthetic_video, temp_run_dir):
        capture_fixture = FIXTURES_DIR / "capture_valid.json"
        res = run_s01_validate(
            video_path=synthetic_video,
            capture_json_path=capture_fixture,
            output_dir=temp_run_dir,
            allow_short_video_for_testing=True,
        )
        assert res["gate_g1"]["passed"] is True
        assert (temp_run_dir / "capture_ok.json").is_file()

        # Check idempotence skip
        res2 = run_s01_validate(
            video_path=synthetic_video,
            capture_json_path=capture_fixture,
            output_dir=temp_run_dir,
            allow_short_video_for_testing=True,
        )
        assert res2["schema_version"] == 1

    def test_s01_fails_on_duration(self, synthetic_video, temp_run_dir):
        capture_fixture = FIXTURES_DIR / "capture_valid.json"
        with pytest.raises(GateFailure) as exc:
            run_s01_validate(
                video_path=synthetic_video,
                capture_json_path=capture_fixture,
                output_dir=temp_run_dir,
                allow_short_video_for_testing=False,  # Enforces default 90s minimum
            )
        assert exc.value.gate == "G1"
        assert "duration" in exc.value.message.lower()

    def test_s01_fails_on_low_resolution(self, synthetic_lowres_video, temp_run_dir):
        capture_fixture = FIXTURES_DIR / "capture_valid.json"
        with pytest.raises(GateFailure) as exc:
            run_s01_validate(
                video_path=synthetic_lowres_video,
                capture_json_path=capture_fixture,
                output_dir=temp_run_dir,
                allow_short_video_for_testing=True,  # Bypass duration to test height
            )
        assert exc.value.gate == "G1"
        assert "resolution" in exc.value.message.lower() or "height" in exc.value.message.lower()

    def test_s01_fails_on_invalid_capture_json(self, synthetic_video, temp_run_dir):
        bad_capture = FIXTURES_DIR / "capture_invalid_id.json"
        with pytest.raises(GateFailure) as exc:
            run_s01_validate(
                video_path=synthetic_video,
                capture_json_path=bad_capture,
                output_dir=temp_run_dir,
                allow_short_video_for_testing=True,
            )
        assert exc.value.gate == "G1"
        assert "capture" in exc.value.message.lower()


class TestStage02Frames:
    def test_sharpness_and_difference_metrics(self):
        # Create sharp checkerboard vs blurred image
        sharp = np.zeros((100, 100, 3), dtype=np.uint8)
        sharp[::10, :] = 255
        sharp[:, ::10] = 255

        blurred = cv2.GaussianBlur(sharp, (15, 15), 0)

        score_sharp = compute_laplacian_sharpness(sharp)
        score_blur = compute_laplacian_sharpness(blurred)
        assert score_sharp > score_blur * 2.0

        # Difference between identical images is 0
        diff_same = compute_image_difference(sharp, sharp)
        assert diff_same == 0.0

        # Difference between distinct images > 0
        diff_diff = compute_image_difference(sharp, blurred)
        assert diff_diff > 1.0

    def test_s02_frame_extraction_and_filtering(self, synthetic_video, temp_run_dir):
        out = run_s02_frames(
            video_path=synthetic_video,
            output_dir=temp_run_dir,
            allow_low_frame_count_for_testing=True,
        )
        assert out["gate_g2"]["passed"] is True
        assert out["gate_g2"]["kept_frames"] > 0
        assert (temp_run_dir / "frames.json").is_file()
        assert (temp_run_dir / "frames").is_dir()

        kept_files = list((temp_run_dir / "frames").glob("*.jpg"))
        assert len(kept_files) == out["gate_g2"]["kept_frames"]

        # Check idempotence skip
        out2 = run_s02_frames(
            video_path=synthetic_video,
            output_dir=temp_run_dir,
            allow_low_frame_count_for_testing=True,
        )
        assert out2["schema_version"] == 1
