# Antigravity Standing Rules for Namma Space

Source: SPEC.md in workspace root.

## Hard Rules
1. Never invent results. All metrics must be produced by code and written to run_report.json. Placeholder numbers must be labelled as placeholders.
2. Pin exact versions and commit lockfiles. Do not install any package published in the last 14 days. If a pinned version does not exist or conflicts, stop and report.
3. Forbidden dependencies: OpenMVS (AGPL), OpenSplat (AGPL), plyfile (GPLv3), MASt3R/DUSt3R (non-commercial), VGGT (custom license), original Inria Gaussian Splatting code. Record every dependency in THIRD_PARTY_NOTICES.md.
4. Pipeline and viewer talk only through files and JSON with schema_version. The viewer never imports pipeline code and vice versa.
5. manifest.json is the only entry point for the viewer.
6. Every stage is idempotent.
7. Every stage fails loudly with non-zero exit code and run_report.json entry.
8. Do not rewrite splat file to rotate/scale it; apply world_from_splat at runtime on Three.js Object3D.
9. No backend, React, database, POI, A*, or AR code in Round 1 (empty backend/ folder only).
10. Never commit: *.mp4, *.mov, frames/, *.ply, *.spz over 20 MB, runs/, *.db, .env, node_modules/, env-*/. Provide .env.example only.
11. Never write "fully automatic" in any doc or UI.
12. Ask before substituting any technology listed in Section 4.
