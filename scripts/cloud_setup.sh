#!/usr/bin/env bash
# ==============================================================================
# Namma Space: Cloud GPU Environment Setup Script (Phase 3)
# Supported environments: Google Colab (T4), RunPod (Ubuntu 22.04 with CUDA 11.8 / 12.1)
# Creates a Python 3.10 virtual environment at /content/ns-env using uv.
# Note: DO NOT run locally on Windows or non-GPU development machines.
# All unverified commands/flags are commented with # [U].
# ==============================================================================
set -euo pipefail

echo "=========================================================="
echo "      NAMMA SPACE CLOUD GPU SETUP (COLAB / RUNPOD)        "
echo "=========================================================="

# 1. Verify NVIDIA GPU
if ! command -v nvidia-smi &> /dev/null; then
    echo "ERROR: nvidia-smi not found. This script requires an NVIDIA GPU runtime."
    exit 1
fi

echo "[1/6] Detected GPU:"
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader

# 2. Install System Dependencies (COLMAP, FFmpeg, Ninja)
echo "[2/6] Installing COLMAP and FFmpeg via apt..."
export DEBIAN_FRONTEND=noninteractive
# [U] Unverified apt package availability across different cloud images
apt-get update -y
# [U] Unverified apt package set for Colab/RunPod base images
apt-get install -y colmap ffmpeg ninja-build libopenblas-dev

# 3. Setup uv & Python 3.10 Virtual Environment
echo "[3/6] Setting up uv and Python 3.10 virtual environment..."
VENV_DIR="/content/ns-env"
if [ ! -d "/content" ]; then
    VENV_DIR="./ns-env"
fi

if ! command -v uv &> /dev/null; then
    # [U] Install uv via pip or official installer
    python3 -m pip install --quiet uv
fi

# Create Python 3.10 venv at /content/ns-env
# [U] uv Python download and environment creation
uv venv "$VENV_DIR" --python 3.10
ENV_PYTHON="$VENV_DIR/bin/python"
ENV_PIP="$VENV_DIR/bin/pip"
echo "Using virtual environment Python: $($ENV_PYTHON --version) at $ENV_PYTHON"

# 4. Install PyTorch with CUDA support (Nerfstudio 1.1.5 compatibility)
echo "[4/6] Installing PyTorch with CUDA in $VENV_DIR..."
# [U] PyTorch 2.1.2 + cu118 wheel availability
uv pip install --python "$ENV_PYTHON" torch==2.1.2+cu118 torchvision==0.16.2+cu118 --extra-index-url https://download.pytorch.org/whl/cu118

# 5. Install Nerfstudio 1.1.5 and audited pycolmap
echo "[5/6] Installing Nerfstudio 1.1.5..."
# [U] Nerfstudio 1.1.5 installation wheel / build dependencies
uv pip install --python "$ENV_PYTHON" nerfstudio==1.1.5

# Probe COLMAP CUDA support: if apt colmap lacks CUDA, install pycolmap==4.2.1
if colmap -h 2>&1 | grep -q -i "with CUDA"; then
    echo "COLMAP CLI has native CUDA support."
else
    echo "APT COLMAP build has NO CUDA support. Installing audited pycolmap==4.2.1..."
    # [U] Audited pycolmap wheel
    uv pip install --python "$ENV_PYTHON" pycolmap==4.2.1
fi

# 6. Verification and Runtime Restart Note
echo "=========================================================="
echo "               VERIFICATION OF INSTALLED TOOLS            "
echo "=========================================================="
$ENV_PYTHON -c "import torch; print(f'PyTorch {torch.__version__}, CUDA available: {torch.cuda.is_available()}')"
colmap -h | head -n 3 || echo "COLMAP install check failed"
"$VENV_DIR/bin/ns-train" --help | head -n 5 || echo "ns-train install check failed"

if [ -d "/content" ]; then
    echo ""
    echo "******************************************************************************"
    echo "* NOTE: If you upgraded PyTorch in the base Colab kernel, restart runtime via *"
    echo "* 'Runtime' -> 'Restart runtime' before executing notebook code cells.       *"
    echo "******************************************************************************"
fi

echo "Cloud setup complete!"
