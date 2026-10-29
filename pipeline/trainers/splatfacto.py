"""
Namma Space: Splatfacto Trainer Adapter for Nerfstudio 1.1.5 (Phase 3)
SPEC Section 8:
- Builds ns-train splatfacto CLI command
- Orientation, centering, and auto-scale disabled
- Held-out PSNR evaluation every 8th frame
- Clear handling of CUDA Out-Of-Memory errors
"""

import json
from pathlib import Path
import re
from typing import Any, Dict, List, Optional, Union


class SplatfactoTrainer:
    """Adapter for Nerfstudio splatfacto training."""

    name: str = "splatfacto"

    def build_train_command(
        self,
        data_dir: Union[str, Path],
        output_dir: Union[str, Path],
        iterations: int = 30000,
        holdout_every: int = 8,
        experiment_name: str = "splatfacto_run",
        images_path: str = "frames",
        colmap_path: str = "colmap/sparse/0",
        model_args: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> List[str]:
        """
        Builds the ns-train splatfacto command.
        Orientation, centering and auto-scale are explicitly disabled to preserve
        the exact COLMAP coordinate frame for Stage S06 alignment.
        Flags checked against Nerfstudio 1.1.5 ColmapDataParserConfig.
        """
        data_p = Path(data_dir).resolve()
        out_p = Path(output_dir).resolve()

        # Nerfstudio 1.1.5 layout: ns-train splatfacto [trainer/model opts] colmap [dataparser opts].
        # Dataparser options go after the `colmap` subcommand, without the --pipeline prefix.
        # Run dir layout from S02/S03: <run>/frames and <run>/colmap/sparse/0.
        cmd = [
            "ns-train",
            "splatfacto",
            "--output-dir",
            str(out_p),
            "--experiment-name",
            experiment_name,
            "--max-num-iterations",
            str(iterations),
            "--vis",
            "tensorboard",
            "--viewer.quit-on-train-completion",
            "True",
            # Extra trainer/model options from config train.model_args (must come before `colmap`)
            *[str(a) for a in (model_args or [])],
            "colmap",
            "--data",
            str(data_p),
            "--images-path",
            images_path,
            "--colmap-path",
            colmap_path,
            "--downscale-factor",
            "1",
            # Turn off coordinate centering and orientation transforms:
            "--orientation-method",
            "none",
            "--center-method",
            "none",
            "--auto-scale-poses",
            "False",
            # Held-out evaluation configuration:
            "--eval-mode",
            "interval",
            "--eval-interval",
            str(holdout_every),
        ]

        return cmd

    def parse_metrics(self, output_dir: Union[str, Path]) -> Dict[str, Any]:
        """
        Parses Nerfstudio metrics.json or training logs from output_dir.
        """
        out_p = Path(output_dir)
        metrics_candidates = list(out_p.glob("**/metrics.json")) + list(out_p.glob("**/eval_metrics.json"))
        if metrics_candidates:
            try:
                with open(metrics_candidates[0], "r", encoding="utf-8") as f:
                    data = json.load(f)
                    psnr = data.get("psnr") or data.get("eval_psnr") or data.get("results", {}).get("psnr")
                    return {
                        "psnr": float(psnr) if psnr is not None else None,
                        "raw_metrics": data,
                        "metrics_file": str(metrics_candidates[0]),
                    }
            except Exception:
                pass

        # Inspect log files for PSNR
        log_candidates = list(out_p.glob("**/*.log")) + list(out_p.glob("**/stdout.txt"))
        psnr_val = None
        for log_file in log_candidates:
            try:
                content = log_file.read_text(encoding="utf-8", errors="ignore")
                matches = re.findall(r"psnr\s*[:=]\s*([0-9]+\.?[0-9]*)", content, re.IGNORECASE)
                if matches:
                    psnr_val = float(matches[-1])
                    break
            except Exception:
                continue

        return {
            "psnr": psnr_val,
            "raw_metrics": {},
            "metrics_file": None,
        }

    def handle_cuda_oom(self, error_message: str) -> bool:
        """
        Checks if an error output string indicates a CUDA out-of-memory failure
        and prints diagnostic guidance.
        """
        oom_patterns = [
            "CUDA out of memory",
            "OutOfMemoryError",
            "torch.cuda.OutOfMemoryError",
            "CUDA error: out of memory",
        ]
        is_oom = any(pattern.lower() in error_message.lower() for pattern in oom_patterns)
        if is_oom:
            print(
                "\n[DIAGNOSTIC - CUDA OUT OF MEMORY]:\n"
                "GPU memory was exhausted during splatfacto training.\n"
                "Remediations:\n"
                "1. Add `--pipeline.model.num-downscales 2` to downscale training images.\n"
                "2. Reduce `--pipeline.model.sh-degree` to 1 or 2 during early steps.\n"
                "3. Decrease batch size or maximum training Gaussians cap.\n",
                flush=True,
            )
        return is_oom
