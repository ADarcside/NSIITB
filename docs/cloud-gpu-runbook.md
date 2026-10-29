# Cloud GPU runbook: Google Colab (T4) and RunPod

**Status**: Active Operations Runbook  
**Target Environments**: Google Colab (Primary, Free Tier T4 GPU) & RunPod (Fallback, RTX 3090 / 4090)  
**Date**: 2026-10-18  

---

## 1. Overview and Operational Strategy

The Namma Space pipeline is structured so that data contract validation, frame filtering, coordinate normalization, SPZ compression, and web viewer delivery run on local development machines without a dedicated GPU.

Stages S03 (COLMAP dense pose estimation) and S04 (Nerfstudio Splatfacto 3DGS training) require an NVIDIA GPU with CUDA.
- **Primary Platform**: **Google Colab (Free Tier T4 GPU)**. Provides ~15 GB VRAM and ~12 hours runtime.
- **Fallback Platform**: **RunPod (Community Cloud)**. Use a single RTX 3090 (24 GB VRAM) or RTX 4090 (~$0.30 - $0.45/hr) if Colab runs out of GPU units or experiences CUDA OOM.

---

## 2. Google Colab Runbook (Primary)

### Step 0: Local Stage S01 & S02 Frame Extraction (Before Cloud Run)
Run video validation and frame selection locally in WSL without needing a cloud GPU:
```bash
# In WSL: run S01 and S02 on your real room video, stopping before S03:
./env-tools/bin/python pipeline/run_pipeline.py \
  --video sample/my_room.mp4 \
  --capture sample/capture.json \
  --run-dir runs/test_room \
  --stop-after s02

# Optional: downscale kept frames to max 1600 px for faster smoke tests:
./env-tools/bin/python pipeline/run_pipeline.py \
  --video sample/my_room.mp4 \
  --capture sample/capture.json \
  --run-dir runs/test_room \
  --stop-after s02 \
  --max-width 1600
```
Copy the resulting `runs/test_room/frames/` folder to your Google Drive (e.g. `MyDrive/namma_space_runs/frames`). This folder will be set as `DRIVE_FRAMES_DIR` in the notebook.

### Step 1: Initialize Notebook & Attach GPU
1. Open Google Colab (https://colab.research.google.com).
2. Upload `notebooks/smoke_test_colab.ipynb` from this repository.
3. In the Colab menu, select **Runtime -> Change runtime type**.
4. Set **Hardware accelerator** to **T4 GPU**. Click **Save**.
5. Execute the first cell to verify GPU attachment:
   ```python
   # The notebook automatically stops execution if no GPU is detected
   import torch
   assert torch.cuda.is_available(), "No GPU attached! Select T4 GPU in Runtime settings."
   ```

### Step 2: Mount Google Drive for Artifact Persistence
Colab runtime disks are ephemeral. All outputs are saved directly to Google Drive:
```python
from google.colab import drive
drive.mount('/content/drive')
OUT_DIR = "/content/drive/MyDrive/namma_space_runs"
```

### Step 3: Run the 4-Step Smoke Test
The notebook automatically executes:
1. **[1/4] Environment & Tool Inspection**: Checks `nvidia-smi`, installs COLMAP and Nerfstudio 1.1.5, checks CUDA.
2. **[2/4] COLMAP Camera Poses**: Extracts features, runs exhaustive matching, and computes camera poses on sample footage.
3. **[3/4] Splatfacto Training**: Trains 2,000 iterations for smoke test (or 30,000 iterations for real room reconstruction) with orientation, centering, and auto-scale disabled `[U]`.
4. **[4/4] Gaussian Splat Export**: Runs `ns-export gaussian-splat` to generate `raw.ply` and validates the 62 float32 properties.

### Step 4: Verify Smoke Report (`smoke_report.json`)
Check the generated `smoke_report.json` in Google Drive:
- `step_1_env`: `"passed"`
- `step_2_colmap`: `"passed"` (registered ratio >= 95%, reprojection error <= 1.0 px)
- `step_3_train`: `"passed"` (PSNR >= 24 dB, coordinate verification < 1 cm)
- `step_4_export`: `"passed"` (valid PLY with 62 float32 properties)

---

## 3. RunPod Fallback Runbook

If Google Colab GPU allocation is exhausted:
1. Log in to RunPod (https://www.runpod.io).
2. Deploy a **Community Cloud** instance:
   - GPU: 1x RTX 3090 (24 GB) or RTX 4090 (24 GB).
   - Template: **RunPod PyTorch 2.1.0** (Ubuntu 22.04, CUDA 11.8 or 12.1).
3. Connect via Web Terminal or SSH:
   ```bash
   git clone https://github.com/<team>/namma-space.git
   cd namma-space
   bash scripts/cloud_setup.sh
   ```
4. Run the smoke test or pipeline stages:
   ```bash
   bash scripts/smoke_test.sh
   ```
5. Download output artifacts (`splat.ply`, `poses.json`, `run_report.json`) using `scp` or RunPod file manager.

---

## 4. Human Verification Checkpoints `[HUMAN]`

Per SPEC.md Section 8, the following steps must be visually inspected by the human operator:
- **Gate G3 Visual Inspection**: Open COLMAP sparse cloud (`sparse/0/points3D.txt`) in MeshLab or COLMAP GUI. Ensure room geometry is coherent without floating multi-room duplicate walls.
- **Gate G4 Visual Inspection**: Inspect Nerfstudio test renders in Colab/RunPod. Verify absence of major visual artifacts or cloud collapse.

---

## 5. Troubleshooting & Diagnostics

### CUDA Out of Memory (OOM)
- Splatfacto adapter detects OOM and issues diagnostic warnings.
- Remedy 1: Add `--pipeline.model.num-downscales 2` to downscale training images.
- Remedy 2: Switch from Colab T4 (15 GB) to RunPod RTX 3090/4090 (24 GB).

### COLMAP Reconstruction Failure
- If incremental mapper reconstructs < 95% of frames or splits into multiple components, `pipeline/stages/s03_poses.py` specifies retry with `global_mapper` `[U]`.
- Ensure room video has slow, steady panning motion with 70–80% overlap between adjacent frames.
