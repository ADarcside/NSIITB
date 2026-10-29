"""
Namma Space: Pipeline Stage S04 Entrypoint
"""

import sys
from pipeline.stages.s04_train import main, run_s04_train, verify_coordinate_frame

__all__ = ["main", "run_s04_train", "verify_coordinate_frame"]

if __name__ == "__main__":
    sys.exit(main())
