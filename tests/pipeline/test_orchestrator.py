"""
Namma Space: Unit Tests for Pipeline Orchestrator (Phase 3)
Tests:
- End-to-end execution of stages S01 through S05
- Quality gate enforcement and one-screen summary generation
- Halt on first gate failure
- Idempotence across multiple runs
"""

from pathlib import Path
import shutil
import subprocess
import tempfile
import pytest

from pipeline.common import load_run_report
from pipeline.run_pipeline import run_pipeline

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"


@pytest.fixture
def temp_run_dir():
    tmp = tempfile.mkdtemp(prefix="test_orch_")
    yield Path(tmp)
    shutil.rmtree(tmp, ignore_errors=True)


@pytest.fixture
def synthetic_video(temp_run_dir):
    """Generates a temporary 2-second 1080p synthetic test video."""
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
    return video_path


class TestPipelineOrchestrator:
    def test_run_pipeline_end_to_end_success(self, synthetic_video, temp_run_dir):
        capture_fixture = FIXTURES_DIR / "capture_valid.json"

        success = run_pipeline(
            video_path=synthetic_video,
            capture_json_path=capture_fixture,
            run_dir=temp_run_dir,
            allow_test_shortcuts=True,
        )
        assert success is True

        # Check run_report.json
        report_path = temp_run_dir / "run_report.json"
        assert report_path.is_file()
        report = load_run_report(report_path)

        # Item 8: Must record synthetic: true
        assert report.get("synthetic") is True

        stages = report.get("stages", {})
        assert "s01_validate" in stages
        assert "s02_frames" in stages
        assert "s03_poses" in stages
        assert "s04_train" in stages
        assert "s05_export" in stages

        for st_name in ["s01_validate", "s02_frames", "s03_poses", "s04_train", "s05_export"]:
            assert stages[st_name]["status"] == "passed"

        # Check output artifacts
        assert (temp_run_dir / "capture_ok.json").is_file()
        assert (temp_run_dir / "frames.json").is_file()
        assert (temp_run_dir / "poses.json").is_file()
        assert (temp_run_dir / "train.json").is_file()
        assert (temp_run_dir / "export.json").is_file()

        # Re-run: verify idempotence without error
        success_rerun = run_pipeline(
            video_path=synthetic_video,
            capture_json_path=capture_fixture,
            run_dir=temp_run_dir,
            allow_test_shortcuts=True,
        )
        assert success_rerun is True

    def test_run_pipeline_halts_at_first_gate_failure(self, synthetic_video, temp_run_dir):
        bad_capture = FIXTURES_DIR / "capture_invalid_id.json"

        success = run_pipeline(
            video_path=synthetic_video,
            capture_json_path=bad_capture,
            run_dir=temp_run_dir,
            allow_test_shortcuts=True,
        )
        assert success is False

        report = load_run_report(temp_run_dir / "run_report.json")
        assert report.get("synthetic") is True
        stages = report.get("stages", {})
        assert stages["s01_validate"]["status"] == "failed"
        # Subsequent stages must not have executed
        assert "s02_frames" not in stages
        assert "s03_poses" not in stages
        assert "s04_train" not in stages
        assert "s05_export" not in stages

    def test_shortcuts_refused_without_test_dir_prefix(self, synthetic_video, temp_run_dir):
        # Item 8: Refuse test shortcut flags unless run directory starts with "test_"
        non_test_dir = temp_run_dir.parent / "production_run_dir"
        non_test_dir.mkdir(parents=True, exist_ok=True)
        try:
            with pytest.raises(ValueError) as exc:
                run_pipeline(
                    video_path=synthetic_video,
                    capture_json_path=FIXTURES_DIR / "capture_valid.json",
                    run_dir=non_test_dir,
                    allow_test_shortcuts=True,
                )
            assert "starts with 'test_'" in str(exc.value)
        finally:
            shutil.rmtree(non_test_dir, ignore_errors=True)

    def test_run_pipeline_stop_after_s02(self, synthetic_video, temp_run_dir):
        # Item 8: Test stopping pipeline after s02 and optionally downscaling with max_width
        capture_fixture = FIXTURES_DIR / "capture_valid.json"
        success = run_pipeline(
            video_path=synthetic_video,
            capture_json_path=capture_fixture,
            run_dir=temp_run_dir,
            allow_test_shortcuts=True,
            stop_after="s02",
            max_width=1600,
        )
        assert success is True

        report = load_run_report(temp_run_dir / "run_report.json")
        stages = report.get("stages", {})
        assert "s01_validate" in stages
        assert "s02_frames" in stages
        assert stages["s01_validate"]["status"] == "passed"
        assert stages["s02_frames"]["status"] == "passed"
        assert "s03_poses" not in stages
        assert "s04_train" not in stages
        assert "s05_export" not in stages
        assert (temp_run_dir / "frames.json").is_file()

