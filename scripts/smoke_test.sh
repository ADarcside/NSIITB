#!/usr/bin/env bash
# ==============================================================================
# Namma Space: Day-1 GPU Smoke Test Script (Section 8.9)
# DO NOT RUN THIS SCRIPT UNTIL GPU ENVIRONMENT, FLAGS, AND DATA LAYOUT ARE VERIFIED.
# Target: Complete all 4 steps in < 2 hours on the chosen GPU.
#
# UNVERIFIED [U] FLAGS AND REQUIREMENTS TO CHECK ON GPU MACHINE BEFORE RUNNING:
# 1. COLMAP 4.x CLI subcommands and flags:
#    - `colmap feature_extractor --help`: verify `--ImageReader.camera_model SIMPLE_RADIAL`
#      and `--ImageReader.single_camera 1`.
#    - `colmap exhaustive_matcher --help`: verify `--database_path`.
#    - `colmap mapper --help`: verify `--output_path` and directory structure.
# 2. Nerfstudio Splatfacto CLI flags:
#    - `ns-train splatfacto --help`: verify exact parameter paths:
#      `--pipeline.datamanager.dataparser.orientation-method none`
#      `--pipeline.datamanager.dataparser.center-method none`
#      `--pipeline.datamanager.dataparser.auto-scale-poses False`
#      `--max-num-iterations 2000`
# 3. Nerfstudio Export CLI flags:
#    - `ns-export gaussian-splat --help`: verify `--load-config` and `--output-dir`.
# 4. COLMAP Dataset Layout for Nerfstudio:
#    - Nerfstudio COLMAP dataparser expects images located in `images/` and sparse
#      reconstruction in `sparse/0/` (cameras.bin/txt, images.bin/txt, points3D.bin/txt).
#      Verify and ensure this directory layout before executing `ns-train`.
# ==============================================================================
set -euo pipefail

echo "=== [1/4] Checking GPU and Environment ==="
if ! command -v nvidia-smi &> /dev/null; then
  echo "ERROR: nvidia-smi not found. GPU driver missing."
  exit 1
fi
nvidia-smi

# Check Python environment
python -c "import torch; print(f'PyTorch {torch.__version__}, CUDA available: {torch.cuda.is_available()}')"
if ! python -c "import torch; assert torch.cuda.is_available()"; then
  echo "ERROR: PyTorch cannot access CUDA GPU."
  exit 1
fi

SMOKE_DIR="runs/smoke_test"
DATA_DIR="sample/test-capture"
mkdir -p "$SMOKE_DIR"

echo "=== [2/4] Running COLMAP on Sample Footage (30 frames) ==="
mkdir -p "$SMOKE_DIR/colmap"
colmap feature_extractor \
  --database_path "$SMOKE_DIR/colmap/database.db" \
  --image_path "$DATA_DIR/frames" \
  --ImageReader.camera_model SIMPLE_RADIAL \
  --ImageReader.single_camera 1

colmap exhaustive_matcher \
  --database_path "$SMOKE_DIR/colmap/database.db"

mkdir -p "$SMOKE_DIR/colmap/sparse"
colmap mapper \
  --database_path "$SMOKE_DIR/colmap/database.db" \
  --image_path "$DATA_DIR/frames" \
  --output_path "$SMOKE_DIR/colmap/sparse"

echo "=== [3/4] Training Splatfacto (2,000 iterations) ==="
ns-train splatfacto \
  --data "$SMOKE_DIR/colmap" \
  --pipeline.datamanager.dataparser.orientation-method none \
  --pipeline.datamanager.dataparser.center-method none \
  --pipeline.datamanager.dataparser.auto-scale-poses False \
  --max-num-iterations 2000 \
  --output-dir "$SMOKE_DIR/nerfstudio_models"

LATEST_CONFIG=$(find "$SMOKE_DIR/nerfstudio_models" -name "config.yml" | head -n 1)
if [ -z "$LATEST_CONFIG" ]; then
  echo "ERROR: Splatfacto training output config.yml not found."
  exit 1
fi

echo "=== [4/4] Exporting Gaussian Splat PLY ==="
ns-export gaussian-splat \
  --load-config "$LATEST_CONFIG" \
  --output-dir "$SMOKE_DIR/exports"

if [ -f "$SMOKE_DIR/exports/splat.ply" ]; then
  echo "SUCCESS: Smoke test passed! PLY generated at $SMOKE_DIR/exports/splat.ply"
else
  echo "ERROR: Exported splat.ply not found."
  exit 1
fi
