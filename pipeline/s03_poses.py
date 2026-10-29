"""
Namma Space: Pipeline Stage S03 Entrypoint
"""

import sys
from pipeline.stages.s03_poses import (
    main,
    run_s03_poses,
    build_colmap_commands,
    parse_cameras_txt,
    parse_images_txt,
    parse_points3D_txt,
    compute_colmap_metrics,
    evaluate_gate_g3,
)

__all__ = [
    "main",
    "run_s03_poses",
    "build_colmap_commands",
    "parse_cameras_txt",
    "parse_images_txt",
    "parse_points3D_txt",
    "compute_colmap_metrics",
    "evaluate_gate_g3",
]

if __name__ == "__main__":
    sys.exit(main())
