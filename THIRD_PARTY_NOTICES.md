# Third-Party Notices and License Register

This document registers all third-party software components, libraries, and tools used by Namma Space, along with their licenses and roles, in compliance with project rules and challenge requirements.

---

## 1. Third-Party Software Register

| Component | License | Role / Subsystem | Source / Repository |
| :--- | :--- | :--- | :--- |
| **Nerfstudio** (1.1.5) | Apache-2.0 | Visual reconstruction (Splatfacto) | https://github.com/nerfstudio-project/nerfstudio |
| **gsplat** (1.4.0) | Apache-2.0 | CUDA rasterizer under Splatfacto | https://github.com/nerfstudio-project/gsplat |
| **COLMAP** (4.1.x) | BSD-3-Clause | Camera poses & sparse reconstruction (SfM) | https://github.com/colmap/colmap |
| **pycolmap** (4.2.1) | BSD-3-Clause | Python bindings for COLMAP | https://github.com/colmap/pycolmap |
| **Three.js** (0.186.1) | MIT | WebGL 3D scene graph & rendering | https://github.com/mrdoob/three.js |
| **Spark** (@sparkjsdev/spark 2.3.1) | MIT | High-performance Gaussian Splat WebGL2 renderer | https://github.com/sparkjsdev/spark |
| **splat-transform** (@playcanvas/splat-transform) | MIT | PLY to SPZ compression tool | https://github.com/playcanvas/splat-transform |
| **Open3D** (0.20.0) | MIT | RANSAC floor plane fitting & point picking | https://github.com/isl-org/Open3D |
| **PyTorch** (2.1.2, cu118) and torchvision (0.16.2) | BSD-3-Clause | Training backend under Nerfstudio | https://github.com/pytorch/pytorch |
| **NumPy** | BSD-3-Clause | Fast numerical arrays & custom PLY I/O | https://github.com/numpy/numpy |
| **SciPy** (1.18.1) | BSD-3-Clause | Scientific algorithms & spatial filtering | https://github.com/scipy/scipy |
| **OpenCV** (opencv-python-headless 4.14.0.94) | Apache-2.0 | Frame validation & Laplacian sharpness | https://github.com/opencv/opencv |
| **jsonschema** (4.23.0) | MIT | Checks `capture.json`, the manifest and `pois.json` against their schemas | https://github.com/python-jsonschema/jsonschema |
| **PyYAML** | MIT | Reads the pipeline config files | https://github.com/yaml/pyyaml |
| **pytest** | MIT | Pipeline tests | https://github.com/pytest-dev/pytest |
| **uqr** (0.1.2) | MIT | QR codes in the Share dialog (loaded only when someone shares) | https://github.com/unjs/uqr |
| **Vite** | MIT | Frontend build tool and development server | https://github.com/vitejs/vite |
| **Vitest** | MIT | Frontend unit and contract testing | https://github.com/vitest-dev/vitest |
| **TypeScript** (5.9.3) | Apache-2.0 | Type safety and schema contract generation | https://github.com/microsoft/TypeScript |
| **@types/three** (0.186.0) | MIT | TypeScript type definitions for Three.js | https://github.com/DefinitelyTyped/DefinitelyTyped |
| **@types/node** (22.20.5) | MIT | TypeScript type definitions for Node.js | https://github.com/DefinitelyTyped/DefinitelyTyped |
| **FFmpeg / FFprobe** (6.1.1-3ubuntu5) | GPL-2.0+ (build configured with `--enable-gpl`) | External CLI tool called via subprocess; not linked, bundled, or redistributed | https://ffmpeg.org |
| **Brush** | Apache-2.0 | Fallback visual reconstruction engine (F1) | https://github.com/ArthurBrussee/brush |
| **Wrangler** (4.151.2) and **@cloudflare/workers-types** | MIT OR Apache-2.0 | Build and deploy tool for the multiplayer relay (development only) | https://github.com/cloudflare/workers-sdk |
| **Blender** (bpy 5.2.3) | GPL-3.0-or-later | Offline tool that builds our five original avatar models (`tools/avatars/build_avatars.py`); not linked, bundled or redistributed, and the models it writes are our own work | https://www.blender.org |
| **Space Grotesk** font (variable 300-700, latin subset, woff2) | SIL OFL 1.1 (`viewer/src/assets/fonts/OFL-SpaceGrotesk.txt`) | Viewer UI typeface, self-hosted and bundled by Vite | https://github.com/floriankarsten/space-grotesk (woff2 via Google Fonts) |
| **Rye** font (Regular, latin subset, woff2) | SIL OFL 1.1, Reserved Font Name "Rye" (`viewer/src/assets/fonts/OFL-Rye.txt`) | Display face for the loading-screen room name, unmodified | https://github.com/google/fonts/tree/main/ofl/rye (woff2 via Google Fonts) |

---

## 2. Hosted Services and Browser Features

No paid API is used. A cost table is in the README under "Who made this".

| Service | Plan | Role | Terms |
| :--- | :--- | :--- | :--- |
| **GitHub Pages** | free | Hosts the static viewer and scene files | https://docs.github.com/en/pages |
| **GitHub REST API** | free, owner's own token | "Save to live" in tag mode (owner only) | https://docs.github.com/en/rest |
| **Cloudflare Workers** | free plan | Multiplayer room relay (`multiplayer/relay/`), stores nothing | https://developers.cloudflare.com/workers/ |
| **STUN servers** (`stun.cloudflare.com`, `stun.l.google.com`) | free, public | Lets two browsers find each other for voice chat; no audio passes through them | public STUN endpoints |
| **Web Speech, WebRTC, WebXR, Web Audio** | built into the browser | Voice guide, voice chat, AR guide, footsteps | W3C web standards |
| **Shields.io** | free | README badges only | https://shields.io |

All avatar models, sounds (generated in the browser with Web Audio), the banner and the K-720 scene are our own work.

---

## 3. Evaluated, Not Used

Listed in earlier plans but not part of the code: **Recast Navigation** (zlib; pathfinding is our own A* on the walkable grid) and **FastAPI / Pydantic** (MIT; the site is static, so there is no API server).

---

## 4. Forbidden Dependencies Register (Explicitly Excluded)

The following libraries are **strictly excluded** from Namma Space to prevent license contamination and maintain commercial / permissive compliance:

1. **OpenMVS** - Excluded due to AGPL license.
2. **OpenSplat** - Excluded due to AGPL-3.0 license.
3. **plyfile** - Excluded due to GPLv3 license. (PLY parsing and serialization is implemented purely using NumPy).
4. **MASt3R / DUSt3R** - Excluded due to CC BY-NC-SA 4.0 non-commercial restrictions.
5. **VGGT** - Excluded due to custom non-open-source license restrictions.
6. **Inria 3DGS Reference Code** - Excluded due to research-only / commercial prohibition terms.
