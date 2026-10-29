"""
Namma Space: Colab Smoke Test Notebook Audit Tests (Phase 3)
Tests:
- Loads notebooks/smoke_test_colab.ipynb JSON structure
- Compiles every code cell with compile() to ensure syntax correctness
- Verifies that no cell contains a '!' shell command
- Verifies that no cell contains a bare [U] outside a comment
- Performs AST analysis to ensure all referenced modules are properly imported
"""

import ast
import json
from pathlib import Path
import pytest

NOTEBOOK_PATH = Path(__file__).resolve().parent.parent.parent / "notebooks" / "smoke_test_colab.ipynb"


class TestColabSmokeNotebook:
    def test_notebook_exists_and_loads_valid_json(self):
        assert NOTEBOOK_PATH.is_file(), f"Notebook not found at: {NOTEBOOK_PATH}"
        data = json.loads(NOTEBOOK_PATH.read_text(encoding="utf-8"))
        assert "cells" in data
        assert len(data["cells"]) >= 5

    def test_no_shell_exclamation_commands(self):
        """Asserts that no code cell contains a '!' shell command."""
        data = json.loads(NOTEBOOK_PATH.read_text(encoding="utf-8"))
        for cell_idx, cell in enumerate(data["cells"]):
            if cell.get("cell_type") != "code":
                continue
            source_lines = cell.get("source", [])
            for line_idx, line in enumerate(source_lines):
                stripped = line.strip()
                # Check for ! shell command invocation
                assert not stripped.startswith("!"), (
                    f"Cell {cell_idx}, line {line_idx} contains a shell '!' command: '{stripped}'"
                )

    def test_no_bare_unverified_u_markers_outside_comments(self):
        """Asserts that no code cell contains a bare [U] outside a comment."""
        data = json.loads(NOTEBOOK_PATH.read_text(encoding="utf-8"))
        for cell_idx, cell in enumerate(data["cells"]):
            if cell.get("cell_type") != "code":
                continue
            source_lines = cell.get("source", [])
            for line_idx, line in enumerate(source_lines):
                if "[U]" in line:
                    # [U] must only appear in a comment (after #)
                    comment_pos = line.find("#")
                    u_pos = line.find("[U]")
                    assert comment_pos != -1 and comment_pos < u_pos, (
                        f"Cell {cell_idx}, line {line_idx} contains a bare [U] outside a comment: '{line}'"
                    )

    def test_all_code_cells_compile_cleanly(self):
        """Compiles every code cell with compile() to catch Python syntax errors."""
        data = json.loads(NOTEBOOK_PATH.read_text(encoding="utf-8"))
        code_cells = [c for c in data["cells"] if c.get("cell_type") == "code"]
        assert len(code_cells) >= 5, "Expected at least 5 code cells in notebook"

        for idx, cell in enumerate(code_cells):
            source = "".join(cell.get("source", []))
            try:
                compiled = compile(source, f"<notebook_cell_{idx}>", "exec")
                assert compiled is not None
            except SyntaxError as e:
                pytest.fail(f"Syntax error in notebook code cell {idx}: {e}")

    def test_ast_imports_and_undefined_module_check(self):
        """Checks AST across all cells to verify required modules are imported."""
        data = json.loads(NOTEBOOK_PATH.read_text(encoding="utf-8"))
        code_cells = [c for c in data["cells"] if c.get("cell_type") == "code"]

        # Collect all imported names across cells
        imported_names = set()
        for cell in code_cells:
            source = "".join(cell.get("source", []))
            tree = ast.parse(source)
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        imported_names.add(alias.asname or alias.name)
                elif isinstance(node, ast.ImportFrom):
                    for alias in node.names:
                        imported_names.add(alias.asname or alias.name)

        # Essential standard library modules used in the notebook
        essential_modules = {"os", "sys", "json", "time", "subprocess", "Path", "shutil"}
        for mod in essential_modules:
            assert mod in imported_names, f"Essential module/class '{mod}' was not imported across notebook cells"


def _load_notebook_helper_namespace():
    """Extracts and execs the pure helper function cell from the notebook source."""
    data = json.loads(NOTEBOOK_PATH.read_text(encoding="utf-8"))
    code_cells = [c for c in data["cells"] if c.get("cell_type") == "code"]
    target_source = None
    for cell in code_cells:
        src = "".join(cell.get("source", []))
        if "def parse_colmap_cuda_support" in src:
            target_source = src
            break
    assert target_source is not None, "Could not find helper functions cell in notebook"
    ns = {}
    exec(compile(target_source, "<notebook_helpers>", "exec"), ns)
    return ns


class TestNotebookPureHelpers:
    """Requirement 1 & 9: Pure helper function execution tests with sample strings."""

    @pytest.fixture(autouse=True)
    def setup_helpers(self):
        self.helpers = _load_notebook_helper_namespace()

    def test_parse_colmap_cuda_support_explicit_cases(self):
        """
        Requirement 1: 'without CUDA' means no CUDA, 'with CUDA' means CUDA.
        Do not test for the substring 'CUDA' alone.
        """
        parse_colmap_cuda_support = self.helpers["parse_colmap_cuda_support"]

        # Valid with CUDA strings
        assert parse_colmap_cuda_support("COLMAP 3.8 -- Structure-from-Motion and Multi-View Stereo\n(with CUDA)") is True
        assert parse_colmap_cuda_support("COLMAP 3.9.1 (Commit 1a2b3c with CUDA)") is True
        assert parse_colmap_cuda_support("COLMAP 3.10 (with CUDA)") is True
        assert parse_colmap_cuda_support("colmap 3.8 (with cuda)") is True

        # Valid without CUDA strings
        assert parse_colmap_cuda_support("COLMAP 3.8 -- Structure-from-Motion and Multi-View Stereo\n(without CUDA)") is False
        assert parse_colmap_cuda_support("COLMAP 3.9.1 (without CUDA)") is False
        assert parse_colmap_cuda_support("COLMAP 3.10 (without CUDA)") is False
        assert parse_colmap_cuda_support("colmap 3.8 (without cuda)") is False

        # Substring "CUDA" alone must NOT indicate CUDA support
        assert parse_colmap_cuda_support("COLMAP installed on CUDA host") is False
        assert parse_colmap_cuda_support("CUDA runtime available") is False
        assert parse_colmap_cuda_support("System detected CUDA 12.1 drivers") is False
        assert parse_colmap_cuda_support("") is False
        assert parse_colmap_cuda_support(None) is False

    def test_parse_subcommands_list(self):
        """Requirement 4: Subcommand list parsed from help output without line-equality tests."""
        parse_subcommands_list = self.helpers["parse_subcommands_list"]

        sample_usage_help = (
            "usage: ns-train splatfacto [OPTIONS] {nerfstudio-data,colmap,blender} ...\n"
            "Train a nerfstudio model.\n"
        )
        assert parse_subcommands_list(sample_usage_help) == ["nerfstudio-data", "colmap", "blender"]

        sample_box_help = (
            "╭─ subcommands ───────────────────────────────────────────╮\n"
            "│ {nerfstudio-data,colmap}                                │\n"
            "│   nerfstudio-data     Nerfstudio dataparser             │\n"
            "│   colmap              COLMAP dataparser                 │\n"
            "╰─────────────────────────────────────────────────────────╯\n"
        )
        assert parse_subcommands_list(sample_box_help) == ["nerfstudio-data", "colmap"]

    def test_viewer_exit_flag_selection(self):
        """Requirement 6: Accept only quit-on-train-completion or viewer disabling; reject make-share-url."""
        determine_viewer_exit_flag = self.helpers["determine_viewer_exit_flag"]

        # 1. Quit on completion
        help_quit = "Options:\n  --viewer.quit-on-train-completion BOOL  Quit on complete\n"
        assert determine_viewer_exit_flag(help_quit) == ("--viewer.quit-on-train-completion", "True")

        # 2. Disabled via --vis
        help_vis_none = "Options:\n  --vis {none,viewer,wandb}  Visualizer to use\n"
        assert determine_viewer_exit_flag(help_vis_none) == ("--vis", "none")

        help_vis_tb = "Options:\n  --vis {tensorboard,viewer}  Visualizer to use\n"
        assert determine_viewer_exit_flag(help_vis_tb) == ("--vis", "tensorboard")

        # 3. Only make-share-url fallback present must fail
        help_share = "Options:\n  --viewer.make-share-url BOOL  Make share url\n"
        with pytest.raises(ValueError, match="No valid viewer exit option"):
            determine_viewer_exit_flag(help_share)

        # 4. Neither present must fail
        with pytest.raises(ValueError, match="No valid viewer exit option"):
            determine_viewer_exit_flag("Options:\n  --data PATH  Data\n")

    def test_build_ns_train_command_ordering_and_structure(self, tmp_path):
        """
        Requirement 4 & 9: All trainer options first (in help appearance order),
        then dataparser subcommand name, then dataparser options (in help appearance order).
        """
        build_ns_train_command = self.helpers["build_ns_train_command"]

        sample_splat_help = (
            "usage: ns-train splatfacto [OPTIONS] {colmap,nerfstudio-data} ...\n\n"
            "Options:\n"
            "  --data PATH                                       Input data\n"
            "  --max-num-iterations INT                          Max train steps\n"
            "  --output-dir PATH                                 Output directory\n"
            "  --pipeline.model.disable-auto-scale BOOL          Disable auto scale\n"
            "  --viewer.quit-on-train-completion BOOL            Auto quit viewer\n\n"
            "subcommands:\n"
            "  {colmap,nerfstudio-data}\n"
        )

        sample_colmap_help = (
            "Dataparser options:\n"
            "  --pipeline.datamanager.dataparser.center-method {none,center}\n"
            "  --pipeline.datamanager.dataparser.orientation-method {none,up}\n"
            "  --pipeline.datamanager.dataparser.auto-scale-poses BOOL\n"
        )

        data_dir = tmp_path / "data"
        out_dir = tmp_path / "out"

        cmd, meta = build_ns_train_command(
            splat_help=sample_splat_help,
            colmap_help=sample_colmap_help,
            ns_train_bin="/bin/ns-train",
            data_dir=data_dir,
            output_dir=out_dir,
            max_iterations=10,
        )

        # Base executable
        assert cmd[:2] == ["/bin/ns-train", "splatfacto"]

        # Subcommand name must appear in the command
        assert "colmap" in cmd
        subcmd_idx = cmd.index("colmap")

        # All trainer options must be BEFORE 'colmap'
        trainer_args = cmd[2:subcmd_idx]
        assert "--data" in trainer_args
        assert "--max-num-iterations" in trainer_args
        assert "--output-dir" in trainer_args
        assert "--pipeline.model.disable-auto-scale" in trainer_args
        assert "--viewer.quit-on-train-completion" in trainer_args

        # Relative order of trainer options must match sample_splat_help
        data_pos = trainer_args.index("--data")
        iter_pos = trainer_args.index("--max-num-iterations")
        out_pos = trainer_args.index("--output-dir")
        scale_pos = trainer_args.index("--pipeline.model.disable-auto-scale")
        viewer_pos = trainer_args.index("--viewer.quit-on-train-completion")
        assert data_pos < iter_pos < out_pos < scale_pos < viewer_pos

        # All dataparser options must be AFTER 'colmap'
        dp_args = cmd[subcmd_idx + 1:]
        assert "--pipeline.datamanager.dataparser.center-method" in dp_args
        assert "--pipeline.datamanager.dataparser.orientation-method" in dp_args
        assert "--pipeline.datamanager.dataparser.auto-scale-poses" in dp_args

        # Relative order of dataparser options must match sample_colmap_help
        center_pos = dp_args.index("--pipeline.datamanager.dataparser.center-method")
        orient_pos = dp_args.index("--pipeline.datamanager.dataparser.orientation-method")
        autoscale_pos = dp_args.index("--pipeline.datamanager.dataparser.auto-scale-poses")
        assert center_pos < orient_pos < autoscale_pos

    def test_build_ns_train_command_fails_when_unrecognized(self, tmp_path):
        """Requirement 4: Fails with a clear message and includes usage lines when structure unknown."""
        build_ns_train_command = self.helpers["build_ns_train_command"]
        invalid_help = (
            "usage: ns-train splatfacto [OPTIONS]\n"
            "No subcommands available.\n"
        )
        with pytest.raises(RuntimeError) as exc_info:
            build_ns_train_command(
                splat_help=invalid_help,
                colmap_help="",
                ns_train_bin="/bin/ns-train",
                data_dir=tmp_path / "data",
                output_dir=tmp_path / "out",
            )
        assert "Could not determine dataparser subcommand" in str(exc_info.value)
        assert "usage: ns-train splatfacto [OPTIONS]" in str(exc_info.value)

    def test_build_colmap_step_commands_cpu_and_cuda(self, tmp_path):
        """Requirement 2: If COLMAP has no CUDA, add CPU options from help."""
        build_colmap_step_commands = self.helpers["build_colmap_step_commands"]

        db = tmp_path / "db.db"
        img = tmp_path / "imgs"
        sparse = tmp_path / "sparse"

        # CPU mode (colmap_cuda_support=False)
        feat_cpu, match_cpu, map_cpu = build_colmap_step_commands(
            database_path=db,
            image_path=img,
            sparse_path=sparse,
            colmap_cuda_support=False,
            feat_help="Options:\n  --SiftExtraction.use_gpu BOOL\n",
            match_help="Options:\n  --SiftMatching.use_gpu BOOL\n",
        )
        assert "--SiftExtraction.use_gpu" in feat_cpu
        assert feat_cpu[feat_cpu.index("--SiftExtraction.use_gpu") + 1] == "0"
        assert "--SiftMatching.use_gpu" in match_cpu
        assert match_cpu[match_cpu.index("--SiftMatching.use_gpu") + 1] == "0"

        # CUDA mode (colmap_cuda_support=True)
        feat_cuda, match_cuda, map_cuda = build_colmap_step_commands(
            database_path=db,
            image_path=img,
            sparse_path=sparse,
            colmap_cuda_support=True,
        )
        assert "--SiftExtraction.use_gpu" not in feat_cuda
        assert "--SiftMatching.use_gpu" not in match_cuda
