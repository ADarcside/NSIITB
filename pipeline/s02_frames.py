"""
Namma Space: Pipeline Stage S02 Entrypoint
"""

import sys
from pipeline.stages.s02_frames import (
    main,
    run_s02_frames,
    extract_candidate_frames,
    filter_frames,
    compute_laplacian_sharpness,
    compute_image_difference,
)

__all__ = [
    "main",
    "run_s02_frames",
    "extract_candidate_frames",
    "filter_frames",
    "compute_laplacian_sharpness",
    "compute_image_difference",
]

if __name__ == "__main__":
    sys.exit(main())
