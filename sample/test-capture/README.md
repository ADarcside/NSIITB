# Sample data: hostel room K-720

This folder is the sample data for the repo. It holds the real room we reconstructed for Round 1, exactly as our pipeline published it, so you can open it in the viewer and check it without a GPU.

| File | What it is |
|---|---|
| `scn_hostelroomac/manifest.json` | the scene manifest written by S08: asset hashes, metric transform, start pose, room bounds |
| `scn_hostelroomac/full.spz` | the full Gaussian splat, 2,005,123 Gaussians, 45 MB (S07) |
| `scn_hostelroomac/lite.spz` | the phone version, top 12% of Gaussians, 5 MB (S07) |
| `scn_hostelroomac/grid.json` | the 5 cm walkable collision grid with 28 height layers (S06) |

These are the same files that are live at https://adarcside.github.io/namma-space/ .

## Open the sample room in the viewer (no GPU)

Needs Node 22.12 or newer.

```bash
git clone https://github.com/ADarcside/NSIITB.git aR
cd aR
mkdir -p viewer/public && cp -r sample/test-capture/scn_hostelroomac viewer/public/
cd viewer && npm ci && npm run dev
# open http://localhost:5173/?scene=scn_hostelroomac
```

Click the canvas, then WASD to move and the mouse to look. Q / E fly down and up, F switches to Walk mode, R resets.

## Check the sample against its manifest

```bash
python -m pytest -q tests/pipeline/test_sample_scene.py
```

This validates the manifest and grid against the schemas in `pipeline/schemas/` and checks every file's size and sha256.

## Reconstruct a room from a video

The K-720 source video is 54 minutes of 4K footage (several GB), which is too large for git, so the input clip is not stored here. To run the full pipeline on your own capture, put the phone video and its `capture.json` in this folder and follow section 3 of the main [README](../../README.md):

```bash
cp ~/Downloads/IMG_XXXX.MOV sample/test-capture/room.mov
cp tests/fixtures/capture_valid.json sample/test-capture/room_capture.json   # then fill it in, see docs/sop.md
python -m pipeline.run_pipeline --video sample/test-capture/room.mov \
  --capture sample/test-capture/room_capture.json \
  --run-dir runs/room_v1 --config pipeline/config/room.yaml
```

S08 writes a folder shaped exactly like `scn_hostelroomac/` above into `runs/room_v1/publish/<scene_id>/`.
