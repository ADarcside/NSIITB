"""
Namma Space: Pipeline Stage S01 Entrypoint
"""

import sys
from pipeline.stages.s01_validate import main, run_s01_validate, probe_video

__all__ = ["main", "run_s01_validate", "probe_video"]

if __name__ == "__main__":
    sys.exit(main())
