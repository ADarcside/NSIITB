# 003 · Viewer notes: lite splats, URLs, and removing debug options

**Status**: Recorded / Deferred to Phase 4 (Normalize, Compress, Manifest, Publish)  
**Date**: 2026-10-18  

---

## 1. Lite Splat Selection: Opacity Times Volume (SPEC Section 8, S7)
In the development synthetic test scene (`scripts/make_dev_scene.py`), the lite asset was created using random subsetting purely to verify that the client-side lite fallback mechanism, hash verification, and UI retry pathways function end-to-end.

For real room reconstructions (Phase 4):
- The lite asset (< 30 MB, ~40% Gaussians) must **NOT** be selected randomly.
- Per SPEC.md Section 8 (Stage 7 Compression), Gaussians must be ranked by **opacity times volume** ($\alpha \times s_x s_y s_z$), retaining the top 40% most visually significant Gaussians while discarding low-contribution and translucent Gaussians.
- Random selection causes severe visual spatter in real splat models; opacity-volume culling preserves geometric silhouettes and surfaces.

---

## 2. Production URL Hierarchy Reconciliation
- In Phase 2, the viewer loader accepts `?scene=<sceneId>` and resolves manifests via `${baseUrl}/${sceneId}/manifest.json` (or `/dev/manifest.json` for synthetic dev scenes).
- Per SPEC.md Section 8 (Stage 9 Publish), production asset publishing will use immutable versioned prefixes on public buckets:
  ```text
  spaces/<space_id>/scenes/<scene_id>/vNNN/manifest.json
  ```
- Before publishing in Phase 4/6, the manifest loader URL resolution pattern will be reconciled with the production bucket hierarchy (e.g. allowing full hierarchical scene paths `?scene=spaces/<spc>/scenes/<scn>/v001` or structured query parameters `?space=<spc>&scene=<scn>&version=1`).

---

## 3. Removal of Diagnostic Dev Options (?format=ply)
- Phase 2 acceptance confirmed: the dev scene renders cleanly in Chrome with Spark using SPZ v3.
- The temporary diagnostic query parameter `?format=ply` (and `?ply=true`) added to `viewer/src/main.ts` during SPZ version debugging allows loading raw PLY assets directly for rendering isolation.
- **Rule**: This diagnostic option is restricted to development scenes and must be completely removed from `viewer/src/main.ts` before final project submission.

