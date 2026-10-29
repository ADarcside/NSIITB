# Namma Space: Round 1 Specification and Standing Rules

Source: Namma Space Final Technical Report (17 Oct 2026), Techfest IIT Bombay Round 1.
Slice gate: end of 23 Oct. Code freeze: end of 29 Oct. Submit: 30 Oct. 31 Oct is buffer only.

---

## 0. How to Use This Brief
1. Save sections 1 to 5 in the repo root as `SPEC.md` (or Antigravity's rules file) so every task sees them.
2. Give Antigravity one phase from section 6 at a time. Section 15 has ready prompts.
3. After each phase, make it run that phase's tests and show real output before moving on.
4. Anything marked `[HUMAN]` cannot be done by Antigravity. It must stop and print exact instructions for the person.
5. Values tagged `[U]` in the report (CLI flags, thresholds, some versions) are unverified. Antigravity must check them with `--help`, `npm view <pkg> versions` or `pip index versions <pkg>` before use, and record what it actually used.

---

## 1. Mission and Definition of Done
Build a phone-capture-to-browser pipeline: smartphone video of one real room, then frame selection, COLMAP camera poses, Gaussian-splat training, normalization, compression, publication, and a public zero-install web viewer with first-person WASD plus mouse-look.

Two representations are kept separate. The Gaussian splat provides appearance only. A separate occupancy grid provides collision and is optional. If the grid is not validated, the viewer ships in ghost mode (walk through walls, but not out of the room bounds).

Round 1 is done only when all of these hold:
- A real room captured by the team is reconstructed (no stock or sample scene as the final result).
- The scene loads from a public URL in a clean browser, no install.
- Mouse-look, WASD, reset, and loading/error feedback work.
- Load time and fps are measured and recorded, never asserted.
- A second person reproduces the walkthrough on another device.
- The repo has setup instructions, config, a license/notice register, and no private data or credentials.
- Abstract (5 pages) and a 3 to 5 minute demo video exist.

**Out of scope for Round 1**: POI search, routing, navmesh, AR, multi-floor, real-time reconstruction, accounts, backend service. Interfaces for these may be defined as types only.

---

## 2. Hard Rules for Antigravity
1. **Never invent results.** Every metric (registered ratio, reprojection error, PSNR, scale error, file size, load time, fps) must be produced by code and written to `run_report.json`. Placeholder numbers must be labelled as placeholders.
2. **Pin exact versions and commit lockfiles.** Do not install any package published in the last 14 days. If a pinned version does not exist or conflicts, stop and report instead of silently changing it.
3. **Forbidden dependencies:** OpenMVS (AGPL), OpenSplat (AGPL), plyfile (GPLv3, read PLY with NumPy instead), MASt3R/DUSt3R (non-commercial), VGGT (custom license), the original Inria Gaussian Splatting code. Record every dependency and license in `THIRD_PARTY_NOTICES.md`.
4. **Pipeline and viewer talk only through files and JSON that carry `schema_version`.** The viewer never imports pipeline code and the pipeline never imports viewer code.
5. **`manifest.json` is the only entry point the viewer knows.** Everything the viewer loads is named in it by asset id and sha256.
6. **Every stage is idempotent:** same input hash plus config hash gives the same output path, so finished stages are skipped on re-run.
7. **Every stage fails loudly:** non-zero exit code and a `run_report.json` entry with stage, gate, measured value, threshold.
8. **Do not rewrite the splat file to rotate or scale it.** Apply `world_from_splat` at runtime on the renderer object (a Three.js `Object3D`).
9. **No backend, React, database, POI, A\*, or AR code in Round 1** (empty `backend/` folder only).
10. **Never commit:** `*.mp4`, `*.mov`, `frames/`, `*.ply`, `*.spz` over 20 MB, `runs/`, `*.db`, `.env`, `node_modules/`, `env-*/`. Provide `.env.example` only.
11. **Never write the phrase "fully automatic" in any doc or UI.** Capture, scale marks, three visual checks and later POI placement are human steps.
12. **Ask before substituting any technology listed in section 4.**

---

## 3. Who Does What
- **`[HUMAN]` only:** capturing the video with tape marks, space owner consent, GPU access or rental, creating accounts (storage bucket, static host, GitHub), clicking the scale points if no automatic marker detection, the visual checks at gates G3, G4, G6, recording the demo, final submission, and checking the official challenge PDF.
- **Antigravity:** all code, scripts, config, schemas, tests, README, SOP and checklist docs, notices, abstract draft structure, verification scripts. When it reaches a human step it stops and prints a short numbered instruction list.

---

## 4. Stack and Pins
| Layer | Choice |
| :--- | :--- |
| **Viewer** | Vanilla TypeScript 5.9.3, Vite 8.3.4, Three.js 0.186.1, Spark (`@sparkjsdev/spark`) 2.3.1, Vitest 5.0.5, Node 22.12+ |
| **Viewer fallback pair** | three 0.180.0 + Spark 2.1.0 (untested, use only if primary pair fails) |
| **Tools env (Python 3.12)** | numpy 2.5.4, scipy 1.18.1, opencv-python-headless 4.14.0.94, open3d 0.20.0 (check compatibility, separate venv if needed), pycolmap 4.2.1 |
| **Training env (Python 3.10)** | nerfstudio 1.1.5 (pulls gsplat 1.4.0), torch/CUDA wheel per Nerfstudio docs |
| **Poses** | COLMAP 4.1.x CLI, `global_mapper` as retry |
| **Compression** | `@playcanvas/splat-transform` 3.10.1 (PLY to SPZ) |
| **Storage** | Cloudflare R2 (or any S3 bucket), static site on any free static host |
| **Later only (Round 2+)** | FastAPI 0.143.3, Pydantic 2.14.1, recast-navigation 0.43.1 |

*Note*: Two Python environments on purpose: `env-train` and `env-tools`. They exchange files only. Trainer sits behind a `Trainer` protocol with adapters (`splatfacto` primary, `gsplat` or `brush` fallback). Renderer sits behind a `SceneRenderer` adapter so Spark can be swapped for native three.js splats in one file.

---

## 5. Repository Layout
```
namma-space/
  README.md  LICENSE  THIRD_PARTY_NOTICES.md  .env.example  .gitignore
  docs/  sop.md  field-checklist.md  architecture.md  abstract.md  limitations.md  decisions/
  pipeline/
    run_pipeline.py            # orchestrator, stages 1-9, gates, run_report.json
    stages/                    # s01_validate.py ... s09_publish.py
    trainers/                  # base.py (Trainer protocol), splatfacto.py, gsplat.py
    normalize.py  grid.py
    schemas/                   # JSON Schema generated from the TS types
    config/default.yaml
  viewer/
    src/ renderer/ controls/ collision/ ui/ main.ts
    index.html  vite.config.ts  package.json  package-lock.json
  backend/                     # empty in Round 1
  tests/ pipeline/ viewer/ fixtures/
  sample/test-capture/         # tiny consented clip or frames + capture.json
  scripts/ smoke_test.sh  verify_urls.py  measure_load.md
```

---

## 6. Build Phases Summary
- **Phase 0:** Scaffold and smoke test (17 to 18 Oct)
- **Phase 1:** Data contracts (day 1 to 2)
- **Phase 2:** Viewer (19 to 20 Oct)
- **Phase 3:** Pipeline stages 1 to 5 (19 to 21 Oct)
- **Phase 4:** Normalize, compress, manifest, publish (20 to 22 Oct)
- **Phase 5:** Integration (22 Oct)
- **Phase 6:** Deploy (21 to 23 Oct)
- **Phase 7:** P1 quality work, only after slice gate (24 to 26 Oct)
- **Phase 8:** Tests, docs, freeze (26 to 29 Oct)

---

## 7. Viewer Specification
Modules (one-way dependencies):
```typescript
interface SceneRenderer {
  load(asset: AssetRef, onProgress: (p: number) => void): Promise<void>;
  setWorldFromSplat(m: Matrix4Tuple): void;
  render(camera: PerspectiveCamera): void;
  dispose(): void;
}
interface CollisionProvider { // ghost | grid
  isFree(x: number, z: number): boolean;
  bounds(): { minX: number; maxX: number; minZ: number; maxZ: number };
}
interface MovementController {
  update(dt: number): void;
  reset(): void; // to manifest.start_pose
  readonly pose: { x: number; y: number; z: number; yaw: number; pitch: number };
}
interface AppUI {
  showProgress(p: number): void;
  showError(code: string, msg: string): void;
  toggleHelp(): void;
  setFps(v: number): void;
}
```
- **Loading flow:** read `?scene=` param, fetch `manifest.json` from configured public base URL, validate against schema, refuse if `schema_version` unsupported, stream SPZ with progress bar, apply `world_from_splat` to splat object, place camera at `start_pose` and `eye_height_m`.
- **Errors:** `E_MANIFEST`, `E_ASSET`, `E_WEBGL`, `E_SPZ`. Offer lite asset if available. Check WebGL2 before loading. Handle `webglcontextlost`. `antialias: false` on WebGLRenderer. Dispose renderer and GPU buffers on reset/reload.
- **Controls:** Pointer lock (click to lock, Esc releases, click re-locks; yaw/pitch mouse-look, pitch clamped ±85°). Keys: W/A/S/D move, Shift faster, H toggles help, R resets. Speed: walk 1.4 m/s, fast 2.5 m/s, 0.15s smoothing. Frame independence: velocity * dt, dt clamped to 0.05s. Camera y locked to `eye_height_m` (default 1.5m). Bounds clamped. Focus loss clears keys. Fallback: drag-to-look.
- **Wall sliding movement step:**
```typescript
function step(p: Pose, wish: Vec2, speed: number, dt: number, col: CollisionProvider): Pose {
  const d = Math.min(dt, 0.05);
  const nx = p.x + wish.x * speed * d, nz = p.z + wish.z * speed * d;
  if (col.isFree(nx, nz)) return { ...p, x: nx, z: nz };
  if (col.isFree(nx, p.z)) return { ...p, x: nx };
  if (col.isFree(p.x, nz)) return { ...p, z: nz };
  return p;
}
```

---

## 8. Pipeline Specification and Gates
- **S1 Validate (gate G1):** ffprobe checks. Video opens, >=90s, >=1080p, `capture.json` valid. Output `capture_ok.json`.
- **S2 Frames (gate G2):** ffmpeg at 4 fps. Pass 1: Laplacian-variance sharpness (drop < 0.6x median). Pass 2: drop near-duplicates. Pass 3: min spacing for 70-80% overlap. Kept frames 150-600. Output `frames/` and `frames.json`.
- **S3 Poses (gate G3):** COLMAP with single shared camera (`SIMPLE_RADIAL` or `OPENCV`). Exhaustive or sequential matching. Incremental mapper, retry with `global_mapper`. Gate: >=95% registered in 1 component, mean reprojection error <= 1.0 px, human views sparse cloud `[HUMAN]`.
- **S4 Train (gate G4):** `ns-train splatfacto` with orientation/center/auto-scale disabled. 30k iters. Hold out every 8th frame, record PSNR. Coordinate verification: project 3 COLMAP camera centres through transform chain, error < 1 cm.
- **S5 Export (gate G5):** `ns-export gaussian-splat` writes `raw.ply`. Check header: 62 float32 properties. Confirm loads in Spark.
- **S6 Normalize and clean (gate G6):** `normalize.py`. Right-handed, +Y up, metres, floor at y=0, origin at first floor tape mark. Floor RANSAC fit. Tape pair (2.000m) sets scale, second pair (1.000m) checks scale. Cleanup: remove opacity < 0.05, scale outliers, outside room box + 0.3m. Pass: floor residual <= 3cm RMS, scale check error <= 2%, floaters removed, human check `[HUMAN]`. NumPy only for PLY I/O.
- **S7 Compress (gate G7):** `splat-transform` PLY to SPZ. Full (< 100 MB) and lite (< 30 MB, ~40% Gaussians).
- **S8 Manifest (gate G8):** Write `manifest.json` with hashes, sizes, `world_from_splat`, `start_pose`, `eye_height_m`, bounds. Validate schema.
- **S9 Publish (gate G9):** Upload to immutable `vNNN/` prefix on bucket. Verify URLs with `scripts/verify_urls.py`. Clean browser test `[HUMAN]`.

---

## 9. Data Model and Types
```typescript
type Id = string; // prefix + 12 lowercase base32 chars (spc_, flr_, rom_, cap_, job_, ast_, scn_, poi_, nav_)
type Mat4 = number[]; // 16 numbers, column-major

interface Capture {
  schema_version: 1; capture_id: Id; space_id?: Id; space_name: string;
  device_model: string; os_version: string;
  resolution: { w: number; h: number }; fps: number;
  captured_at: string; operator: string; sop_version: string; lighting: string;
  scale_pairs: { a: string; b: string; distance_m: number; role: 'scale' | 'check' }[];
  room_dims_m?: { width: number; length: number; height: number };
  consent: { granted: boolean; reference: string }; notes?: string;
}
interface Asset {
  schema_version: 1; asset_id: Id;
  kind: 'splat_full' | 'splat_lite' | 'grid' | 'video' | 'report';
  format: 'spz' | 'ply' | 'json' | 'mp4'; uri: string;
  sha256: string; bytes: number; gaussians?: number;
}
interface SpatialTransform {
  world_from_splat: Mat4; scale: number; method: 'floor_ransac+tape_pair';
  residuals: { floor_rms_m: number; scale_check_error_pct: number | null };
}
interface SceneManifest {
  schema_version: 1; scene_id: Id; space_id: Id; version: number;
  created_at: string; job_id: Id;
  assets: { full: Id; lite?: Id; grid?: Id };
  asset_table: Record<Id, Asset>;
  transform: SpatialTransform;
  start_pose: { x: number; z: number; yaw_deg: number };
  eye_height_m: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}
interface NavGrid {
  schema_version: 1; nav_id: Id; transform_scene: Id;
  cell_m: number; origin: [number, number];
  width: number; height: number; agent_radius_m: number; free_bits_b64: string;
}
```

---

## 10. Default Config Thresholds (`pipeline/config/default.yaml`)
```yaml
validate: { min_duration_s: 90, min_height_px: 1080 }
frames: { candidate_fps: 4, blur_factor: 0.6, keep_min: 150, keep_max: 600, keep_target: [200, 400] }
colmap: { camera_model: SIMPLE_RADIAL, matcher: exhaustive, min_registered_ratio: 0.95, max_reproj_px: 1.0, min_largest_component_ratio: 0.8 }
train: { trainer: splatfacto, iterations: 30000, holdout_every: 8, psnr_target_db: 24 }
normalize: { floor_band_fraction: 0.25, max_floor_rms_m: 0.03, max_scale_error_pct: 2.0, min_opacity: 0.05, scale_outlier_multiple: 6.0, room_box_pad_m: 0.3 }
compress: { lite_fraction: 0.4, max_full_mb: 100, max_lite_mb: 30 }
grid: { cell_m: 0.05, height_band_m: [0.2, 1.7], n_min: 3, agent_radius_m: 0.25 }
```

---

## 11. Environment Variables
`NS_BUCKET`, `NS_ENDPOINT`, `NS_ACCESS_KEY_ID`, `NS_SECRET_ACCESS_KEY` (never committed), `NS_PUBLIC_BASE_URL`, `NS_CORS_ORIGIN`, `NS_TRAINER` (`splatfacto`, `gsplat`, `brush`). Round 2 only: `NS_API_TOKEN`, `NS_DB_URL`.

---

## 12. Fallback Ladder
- **F0:** Splatfacto on COLMAP dataset.
- **F1:** Nerfstudio fails/crashes -> train COLMAP dataset with `gsplat` directly or `Brush` (Apache-2.0).
- **F2:** No GPU or COLMAP fails twice -> Scaniverse on phone, export SPZ, run S6-S9 (disclosed).
