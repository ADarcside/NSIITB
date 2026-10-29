# 002 · Checking every version pin (the 14-day rule)

## Status
Resolved / Pins Adjusted (14-Day Rule)

## Date
2026-10-17 (Updated 2026-10-18)

## Context
Per Hard Rule 2 in `SPEC.md`:
> "Pin exact versions and commit lockfiles. Do not install any package published in the last 14 days. If a pinned version does not exist or conflicts, stop and report instead of silently changing it."

Audit timestamp: **2026-10-17T15:32:00Z**. Threshold for 14-day rule: published on or before **2026-10-03T00:00:00Z** (>= 14 days old).

---

## 1. NPM Packages Verification

| Package | Version | Publish Date (UTC) | Age (Days as of 2026-10-17) | Status |
| :--- | :--- | :--- | :--- | :--- |
| `three` | `0.186.1` | 2026-09-24T14:42:21Z | 23 | **OK** |
| `@sparkjsdev/spark` | `2.3.1` | 2026-10-01T17:29:15Z | 16 | **OK** |
| `vite` | `8.3.4` | 2026-10-08T12:07:04Z | 9 | ⚠️ **FLAG: PROBLEM** (< 14 days) |
| `vitest` | `5.0.5` | 2026-10-15T14:29:01Z | 2 | ⚠️ **FLAG: PROBLEM** (< 14 days) |
| `typescript` | `5.9.3` | 2025-09-30T21:19:38Z | 382 | **OK** |
| `@types/three` | `0.186.0` | 2026-09-11T18:07:29Z | 37 | **OK** (devDependency) |
| `@playcanvas/splat-transform` | `3.10.1` | 2026-10-09T11:08:38Z | 8 | ⚠️ **FLAG: PROBLEM** (< 14 days) |

---

## 2. PyPI Packages Verification

| Package | Version | Publish Date (UTC) | Age (Days as of 2026-10-17) | Status |
| :--- | :--- | :--- | :--- | :--- |
| `numpy` | `2.5.4` | 2026-10-10T20:02:40Z | 7 | ⚠️ **FLAG: PROBLEM** (< 14 days) |
| `scipy` | `1.18.1` | 2026-08-21T23:23:44Z | 57 | **OK** |
| `opencv-python-headless` | `4.14.0.94` | 2026-07-29T03:52:11Z | 80 | **OK** |
| `pycolmap` | `4.2.1` | 2026-09-29T17:04:12Z | 18 | **OK** |
| `open3d` | `0.20.0` | 2026-09-16T21:08:26Z | 31 | **OK** |
| `nerfstudio` | `1.1.5` | 2024-11-11T21:22:44Z | 705 | **OK** |
| `pytest` | `9.1.1` | 2026-06-19T10:58:31Z | 120 | **OK** |
| `jsonschema` | `4.23.0` | 2024-07-08T18:40:00Z | 831 | **OK** |

---

## 3. Findings and Flagged Pins

Four packages violate the 14-day freeze rule as of 2026-10-17:
1. `vite@8.3.4` (9 days old)
2. `vitest@5.0.5` (2 days old)
3. `@playcanvas/splat-transform@3.10.1` (8 days old)
4. `numpy==2.5.4` (7 days old)

Per Hard Rule 2, these are flagged for user review and approval before substituting with older stable releases (e.g., `numpy==2.5.3` or `2.5.2`, older `vite` / `vitest` / `splat-transform` releases >= 14 days old) or accepting them explicitly.

---

## 4. Resolution

Per user decision enforcing Hard Rule 2, all 4 flagged pins are downgraded to the newest release in the same major line published on or before 2026-10-03 (>= 14 days old). Newer releases published within the 14-day freeze window were not accepted.

| Package | Original Pin | Adjusted Pin | Publish Date (UTC) | Age (Days) | Compatibility & Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `vite` | `8.3.4` | `8.3.2` | 2026-10-01T10:17:44Z | 16 | Compatible with `vitest@5.0.3` (`^8.0.0` peer requirement satisfied). |
| `vitest` | `5.0.5` | `5.0.3` | 2026-09-30T11:30:42Z | 17 | Requires `vite` `^6.4.0 \|\| ^7.0.0 \|\| ^8.0.0`, satisfied by `vite@8.3.2`. |
| `@playcanvas/splat-transform` | `3.10.1` | `3.9.0` | 2026-10-02T12:53:51Z | 15 | Compression CLI tool. Peer dependency `playcanvas@^2.0.0` satisfied. |
| `numpy` | `2.5.4` | `2.5.3` | 2026-09-06T16:24:29Z | 41 | Verified compatibility with `scipy==1.18.1`, `opencv-python-headless==4.14.0.94`, and `open3d==0.20.0`. |

`SPEC.md` and the initial project report remain unchanged as historical records; the adjusted pins are enforced in `viewer/package.json`, `viewer/package-lock.json`, and `requirements-tools.txt`.

### 4.1 Phase 2 Types Resolution (@types/three)
During Phase 2, ambient handwritten declarations for Three.js and Spark were replaced with exact-pinned type packages. `@types/three@0.186.0` was audited against the 14-day rule prior to installation:
- **Version**: `0.186.0` (matching `three@0.186.1`)
- **Published**: 2026-09-11T18:07:29.669Z (37 days old as of 2026-10-18, published on or before 2026-10-03)
- **Status**: PASSED 14-day rule. Installed as exact devDependency (`npm install --save-dev --save-exact @types/three@0.186.0`).
- **Spark Types**: With `@types/three` present, Spark's own bundled types (`@sparkjsdev/spark/dist/types/index.d.ts`) resolve cleanly without requiring ambient module declarations.

