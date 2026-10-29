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
| **NumPy** | BSD-3-Clause | Fast numerical arrays & custom PLY I/O | https://github.com/numpy/numpy |
| **SciPy** (1.18.1) | BSD-3-Clause | Scientific algorithms & spatial filtering | https://github.com/scipy/scipy |
| **OpenCV** (opencv-python-headless 4.14.0.94) | Apache-2.0 | Frame validation & Laplacian sharpness | https://github.com/opencv/opencv |
| **Vite** | MIT | Frontend build tool and development server | https://github.com/vitejs/vite |
| **Vitest** | MIT | Frontend unit and contract testing | https://github.com/vitest-dev/vitest |
| **TypeScript** (5.9.3) | Apache-2.0 | Type safety and schema contract generation | https://github.com/microsoft/TypeScript |
| **@types/three** (0.186.0) | MIT | TypeScript type definitions for Three.js | https://github.com/DefinitelyTyped/DefinitelyTyped |
| **@types/node** (22.20.5) | MIT | TypeScript type definitions for Node.js | https://github.com/DefinitelyTyped/DefinitelyTyped |
| **FFmpeg / FFprobe** (6.1.1-3ubuntu5) | GPL-2.0+ (build configured with `--enable-gpl`) | External CLI tool called via subprocess; not linked, bundled, or redistributed | https://ffmpeg.org |
| **Brush** | Apache-2.0 | Fallback visual reconstruction engine (F1) | https://github.com/ArthurBrussee/brush |
| **Recast Navigation** (Round 2+) | zlib / MIT | Navigation mesh generation upgrade | https://github.com/recastnavigation/recastnavigation |
| **FastAPI / Pydantic** (Round 2+) | MIT | HTTP API service contracts | https://github.com/fastapi/fastapi |

---

## 2. Forbidden Dependencies Register (Explicitly Excluded)

The following libraries are **strictly excluded** from Namma Space to prevent license contamination and maintain commercial / permissive compliance:

1. **OpenMVS** - Excluded due to AGPL license.
2. **OpenSplat** - Excluded due to AGPL-3.0 license.
3. **plyfile** - Excluded due to GPLv3 license. (PLY parsing and serialization is implemented purely using NumPy).
4. **MASt3R / DUSt3R** - Excluded due to CC BY-NC-SA 4.0 non-commercial restrictions.
5. **VGGT** - Excluded due to custom non-open-source license restrictions.
6. **Inria 3DGS Reference Code** - Excluded due to research-only / commercial prohibition terms.
