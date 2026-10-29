"""
Namma Space: Pipeline Stage S05 Entrypoint
"""

import sys
from pipeline.stages.s05_export import (
    main,
    run_s05_export,
    build_ns_export_command,
    read_ply_gaussian_header,
    read_ply_gaussians_numpy,
    write_synthetic_ply,
    EXPECTED_GAUSSIAN_PROPERTY_COUNT,
)

__all__ = [
    "main",
    "run_s05_export",
    "build_ns_export_command",
    "read_ply_gaussian_header",
    "read_ply_gaussians_numpy",
    "write_synthetic_ply",
    "EXPECTED_GAUSSIAN_PROPERTY_COUNT",
]

if __name__ == "__main__":
    sys.exit(main())
