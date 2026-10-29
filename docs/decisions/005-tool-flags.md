# 005 · Tool flags and versions we actually verified

**Status**: Active / Partially Verified (`[U]` items flagged for GPU environment)  
**Date**: 2026-10-18  

---

## 1. Local CLI Tools (Installed in WSL)

### FFmpeg and FFprobe
- **Installed Version**: `6.1.1-3ubuntu5` (Ubuntu 24.04 noble package `7:6.1.1-3ubuntu5`)
- **Installation Method**: `wsl -u root apt-get update && apt-get install -y ffmpeg`
- **Build Configuration**:
  ```text
  configuration: --prefix=/usr --extra-version=3ubuntu5 --toolchain=hardened --libdir=/usr/lib/x86_64-linux-gnu --incdir=/usr/include/x86_64-linux-gnu --arch=amd64 --enable-gpl --disable-stripping --disable-omx --enable-gnutls --enable-libaom --enable-libass --enable-libbs2b --enable-libcaca --enable-libcdio --enable-libcodec2 --enable-libdav1d --enable-libflite --enable-libfontconfig --enable-libfreetype --enable-libfribidi --enable-libglslang --enable-libgme --enable-libgsm --enable-libharfbuzz --enable-libmp3lame --enable-libmysofa --enable-libopenjpeg --enable-libopenmpt --enable-libopus --enable-librubberband --enable-libshine --enable-libsnappy --enable-libsoxr --enable-libspeex --enable-libtheora --enable-libtwolame --enable-libvidstab --enable-libvorbis --enable-libvpx --enable-libwebp --enable-libx265 --enable-libxml2 --enable-libxvid --enable-libzimg --enable-openal --enable-opencl --enable-opengl --disable-sndio --enable-libvpl --disable-libmfx --enable-libdc1394 --enable-libdrm --enable-libiec61883 --enable-chromaprint --enable-frei0r --enable-ladspa --enable-libbluray --enable-libjack --enable-libpulse --enable-librabbitmq --enable-librist --enable-libsrt --enable-libssh --enable-libsvtav1 --enable-libx264 --enable-libzmq --enable-libzvbi --enable-lv2 --enable-sdl2 --enable-libplacebo --enable-librav1e --enable-pocketsphinx --enable-librsvg --enable-libjxl --enable-shared
  ```
- **License**: GPL-2.0+ (compiled with `--enable-gpl`).
- **Integration Boundary**: External command-line utility called via Python `subprocess.run()`. Not linked into binary, not bundled into distribution. Registered in `THIRD_PARTY_NOTICES.md`.

---

## 2. CLI Flag Verification Status

### A. Stage S01 (Video Validation) - `ffprobe`
- `ffprobe -v error -select_streams v:0 -show_entries format=duration:stream=width,height -of json <input>`
- Flags verified with `ffprobe -help long`:
  - `-v error`: Set loglevel to error only [VERIFIED]
  - `-select_streams v:0`: Filter for first video stream [VERIFIED]
  - `-show_entries format=duration:stream=width,height`: Structured field output [VERIFIED]
  - `-of json`: JSON printer [VERIFIED]

### B. Stage S02 (Frame Extraction) - `ffmpeg`
- `ffmpeg -y -i <video> -vf "fps=<candidate_fps>" -q:v 2 <output_pattern>`
- Flags verified with `ffmpeg -help`:
  - `-y`: Overwrite output files without asking [VERIFIED]
  - `-i`: Input video path [VERIFIED]
  - `-vf fps=<fps>`: Video filter for uniform framerate extraction [VERIFIED]
  - `-q:v 2`: High quality JPEG encoding [VERIFIED]

### C. Stage S03 (Camera Poses) - `colmap`
*Note: COLMAP is executed on the cloud/GPU runner; flags are verified against COLMAP 3.8/3.9/3.10 CLI specifications and marked [U] until confirmed with `colmap --help` on the GPU machine.*

- `colmap feature_extractor`:
  - `--database_path <db>` [U]
  - `--image_path <images>` [U]
  - `--ImageReader.camera_model <SIMPLE_RADIAL|OPENCV>` [U]
  - `--ImageReader.single_camera 1` [U]
- `colmap exhaustive_matcher`:
  - `--database_path <db>` [U]
- `colmap sequential_matcher`:
  - `--database_path <db>` [U]
  - `--SequentialMatching.overlap 10` [U]
- `colmap mapper` (Incremental):
  - `--database_path <db>` [U]
  - `--image_path <images>` [U]
  - `--output_path <sparse>` [U]
- `colmap hierarchical_mapper` / `global_mapper` (Retry):
  - Retries if incremental mapper yields < 95% registered images [U]

### D. Stage S04 (Gaussian Splat Training) - `ns-train splatfacto`
*Note: Flags marked [U] until verified on GPU machine via Step 0 help probe.*

#### Nerfstudio COLMAP Data Layout Requirement
Per Nerfstudio's `colmap` dataparser specification, the reconstruction input directory `<data_dir>` must be arranged as:
```text
<data_dir>/
├── images/
│   ├── frame_000001.jpg
│   ├── frame_000002.jpg
│   └── ...
└── colmap/
    └── sparse/
        └── 0/
            ├── cameras.bin (or cameras.txt)
            ├── images.bin (or images.txt)
            └── points3D.bin (or points3D.txt)
```
*Note: Some Nerfstudio versions accept `<data_dir>/sparse/0/` directly. The pipeline establishes a symlink/mirror between `sparse/0` and `colmap/sparse/0` to guarantee parser resolution.*

#### Step 0 Help Probes on GPU Machine
Before launching training on the cloud GPU runner, Step 0 runs:
1. `ns-train splatfacto --help`
2. `ns-train splatfacto colmap --help`
3. `ns-export gaussian-splat --help`
All three outputs are saved to `smoke_report.json`. The final command is built only from verified flags that appear in those outputs. If `--pipeline.model.disable-auto-scale` or `--pipeline.datamanager.dataparser.eval-interval` do not exist in that exact syntax, they are replaced with their verified equivalents.

#### Training Command Structure:
- `ns-train splatfacto --data <data_dir> --output-dir <out_dir>`:
  - `--max-num-iterations 30000` [U]
  - `--pipeline.model.disable-auto-scale True` [U]
  - `--pipeline.datamanager.camera-optimizer.mode off` [U]
  - Orientation, centering, and auto-scale disabled (to maintain coordinate alignment with COLMAP):
    - `--pipeline.datamanager.dataparser.orientation-method none` [U]
    - `--pipeline.datamanager.dataparser.center-method none` [U]
    - `--pipeline.datamanager.dataparser.auto-scale-poses False` [U]
  - Holdout evaluation:
    - `--pipeline.datamanager.dataparser.eval-interval 8` [U] (or `eval-mode fraction` / `eval-mode filename`)

### E. Stage S05 (Export) - `ns-export gaussian-splat`
- `ns-export gaussian-splat --load-config <config.yml> --output-dir <out_dir>` [U]

