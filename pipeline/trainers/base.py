"""
Namma Space: Trainer Protocol & Base Definitions (Phase 3)
Defines the interface for Gaussian Splat training engines (Splatfacto, gsplat, Brush).
"""

from typing import Any, Dict, List, Optional, Protocol, Tuple, Union
from pathlib import Path
import subprocess


class Trainer(Protocol):
    """Protocol for reconstruction training adapters."""

    name: str

    def build_train_command(
        self,
        data_dir: Union[str, Path],
        output_dir: Union[str, Path],
        iterations: int = 30000,
        holdout_every: int = 8,
        **kwargs: Any,
    ) -> List[str]:
        """Builds the training CLI command."""
        ...

    def parse_metrics(self, output_dir: Union[str, Path]) -> Dict[str, Any]:
        """Parses held-out PSNR and training metrics from logs/reports. Returns None for psnr if not found."""
        ...

    def handle_cuda_oom(self, error_message: str) -> bool:
        """Inspects error output to detect and diagnose CUDA Out-Of-Memory conditions."""
        ...


class MockTrainer:
    """Mock trainer for testing and synthetic validation runs via dependency injection."""

    name: str = "mock_trainer"

    def __init__(self, psnr: Optional[float] = 26.5):
        self.psnr = psnr

    def build_train_command(
        self,
        data_dir: Union[str, Path],
        output_dir: Union[str, Path],
        iterations: int = 30000,
        holdout_every: int = 8,
        **kwargs: Any,
    ) -> List[str]:
        return ["echo", "mock_train"]

    def parse_metrics(self, output_dir: Union[str, Path]) -> Dict[str, Any]:
        return {"psnr": self.psnr, "mock": True}

    def handle_cuda_oom(self, error_message: str) -> bool:
        return False
