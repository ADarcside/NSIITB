# 004 · Pinning the SPZ format version (v3, not v4)

## Status
Approved & Enforced

## Date
2026-10-18

---

## 1. Context & Browser Failure

During initial browser testing of the WebGL viewer (`http://localhost:5175/?scene=dev`), the manifest and asset downloaded successfully and passed SHA-256 verification, but Spark 2.3.1 failed during decoding with:
```text
Error [E_SPZ]: "Failed to decode Gaussian splat data: Invalid gzip header"
```

### Technical Root Cause
1. **Tool Default Behavior**: `@playcanvas/splat-transform@3.9.0` CLI defaults to `--spz-version 4` unless explicitly overridden.
2. **Format Discrepancy**:
   - **SPZ v4** is an uncompressed container starting directly with the ASCII magic bytes `4e 47 53 50` (`"NGSP"`).
   - **SPZ v2 & v3** are gzip-compressed containers starting with magic bytes `1f 8b 08` (`GZIP` format), wrapping the binary splat stream.
3. **Renderer Compatibility**: Spark 2.3.1 (`@sparkjsdev/spark@2.3.1`) supports SPZ write versions 2 and 3 (`export type SpzWriteVersion = 2 | 3;` in `dist/types/spz.d.ts` line 4). Its file type detector `getSplatFileType(fileBytes)` (in `dist/spark.module.js` lines 11122–11129) checks `(magic & 0x00ffffff) === 0x088b1f` and performs partial gunzip decompression (`decompressPartialGzip(fileBytes, 4)`). Its underlying Rust/Wasm decoder expects a gzip stream; when fed uncompressed SPZ v4 (`NGSP`), the decompressor throws `"Invalid gzip header"`.

---

## 2. Decision & Invariant Rules

To ensure reliable rendering across development and production:

1. **Explicit Pipeline Version Pinning**:
   - The SPZ output version is pinned to `3` in `pipeline/config/default.yaml`:
     ```yaml
     compress:
       spz_version: 3
       lite_fraction: 0.4
       max_full_mb: 100
       max_lite_mb: 30
     ```
   - In synthetic data generation (`scripts/make_dev_scene.py`), the version is pinned as a named constant:
     ```python
     SPZ_VERSION = 3
     ```
   - All invocations of `@playcanvas/splat-transform` must explicitly pass `--spz-version 3`. Tools must never be invoked relying on defaults.

2. **Defensive Client-Side Magic Byte Validation**:
   - Both the asset loader (`viewer/src/loader/manifest.ts`) and the renderer adapter (`viewer/src/renderer/spark_adapter.ts`) defensively check the first two bytes of any SPZ file before passing them to Spark.
   - If an asset starts with `NGSP` (`0x4e 0x47 0x53 0x50`) or does not start with `1f 8b`, the loader rejects with `E_SPZ` and a descriptive message:
     ```text
     "Unsupported SPZ version (found uncompressed NGSP (SPZ v4), expected gzip-compressed SPZ v2/v3 starting with 1f 8b)"
     ```
   - A format mismatch is caught cleanly with a helpful error message rather than an opaque gzip failure.

3. **Pre-Publish Verification Rule**:
   - Prior to publishing any real scene in Phase 4 / Phase 6, all generated `.spz` assets must be validated to confirm the `1f 8b` magic header.
   - Automated regression tests exist in both test suites:
     - **Vitest**: `tests/viewer/loader.test.ts` asserts that every `.spz` in `viewer/public/dev/` starts with `0x1f, 0x8b`, and verifies decompression through Spark's `transcodeSpz`.
     - **Pytest**: `tests/pipeline/test_contracts.py::TestSceneManifestContract::test_dev_scene_spz_magic_bytes` asserts that every `.spz` starts with `b"\x1f\x8b"`.

4. **Diagnostic Escape Hatch**:
   - A diagnostic parameter `?format=ply` or `?ply=true` is supported in dev mode (`isDevScene`) to load `dev_full.ply` directly through `renderer.load()`, allowing developers to isolate SPZ compression issues from renderer/WebGL pipeline issues.
