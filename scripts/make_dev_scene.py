#!/usr/bin/env python3
"""
Namma Space: Synthetic Development Scene Generator
Writes a small synthetic Gaussian splat (floor grid and 4 walls) as a PLY
using NumPy ONLY (no plyfile, per Hard Rule 3).
Converts to SPZ using @playcanvas/splat-transform@3.9.0 via npx.
Writes a valid SceneManifest (schema_version 1) with real SHA-256 and sizes.

CRITICAL:
This scene is strictly for testing viewer rendering and movement without GPU or real room.
It must NEVER be described as a real reconstruction anywhere.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys

import numpy as np

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "viewer" / "public" / "dev"


def generate_synthetic_splat(num_floor_per_side: int = 25, num_wall_points: int = 20) -> np.ndarray:
    """
    Generates synthetic 3D Gaussian Splats:
    - Floor: colored grid on [-2, 2] x [-2, 2] at y = 0.
    - 4 walls: at x = +/-2.0 and z = +/-2.0 from y = 0 to 2.5m.
    Returns structured array with exactly 62 float32 properties.
    """
    # 62 standard 3DGS properties
    fields = [
        ("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
        ("nx", "<f4"), ("ny", "<f4"), ("nz", "<f4"),
        ("f_dc_0", "<f4"), ("f_dc_1", "<f4"), ("f_dc_2", "<f4"),
    ]
    for i in range(45):
        fields.append((f"f_rest_{i}", "<f4"))
    fields.append(("opacity", "<f4"))
    fields.append(("scale_0", "<f4"))
    fields.append(("scale_1", "<f4"))
    fields.append(("scale_2", "<f4"))
    fields.append(("rot_0", "<f4"))
    fields.append(("rot_1", "<f4"))
    fields.append(("rot_2", "<f4"))
    fields.append(("rot_3", "<f4"))

    pts = []

    # 1. Floor grid
    xs = np.linspace(-2.0, 2.0, num_floor_per_side)
    zs = np.linspace(-2.0, 2.0, num_floor_per_side)
    c_inv = 1.0 / 0.28209479177387814

    for xi, x in enumerate(xs):
        for zi, z in enumerate(zs):
            # Checkerboard color pattern
            is_dark = (xi + zi) % 2 == 0
            rgb = (0.2, 0.5, 0.7) if is_dark else (0.7, 0.7, 0.8)
            f_dc = [(c - 0.5) * c_inv for c in rgb]

            row = [
                x, 0.0, z,           # position
                0.0, 1.0, 0.0,       # normal
                f_dc[0], f_dc[1], f_dc[2],
            ]
            row.extend([0.0] * 45)   # f_rest_0..44
            row.append(4.6)          # opacity ~ 0.99
            # scale: radius ~ 0.1m -> ln(0.1) ~ -2.3
            row.extend([-2.3, -2.3, -2.3])
            # rotation quaternion: w=1, x=0, y=0, z=0
            row.extend([1.0, 0.0, 0.0, 0.0])
            pts.append(row)

    # 2. Four walls
    wall_ys = np.linspace(0.1, 2.4, num_wall_points)
    wall_coords = np.linspace(-2.0, 2.0, num_floor_per_side)

    # North wall (z = 2.0) - red tint
    rgb_north = (0.8, 0.2, 0.2)
    f_dc_n = [(c - 0.5) * c_inv for c in rgb_north]
    for x in wall_coords:
        for y in wall_ys:
            row = [x, y, 2.0, 0.0, 0.0, -1.0, f_dc_n[0], f_dc_n[1], f_dc_n[2]]
            row.extend([0.0] * 45)
            row.append(4.6)
            row.extend([-2.3, -2.3, -2.3])
            row.extend([1.0, 0.0, 0.0, 0.0])
            pts.append(row)

    # South wall (z = -2.0) - green tint
    rgb_south = (0.2, 0.8, 0.2)
    f_dc_s = [(c - 0.5) * c_inv for c in rgb_south]
    for x in wall_coords:
        for y in wall_ys:
            row = [x, y, -2.0, 0.0, 0.0, 1.0, f_dc_s[0], f_dc_s[1], f_dc_s[2]]
            row.extend([0.0] * 45)
            row.append(4.6)
            row.extend([-2.3, -2.3, -2.3])
            row.extend([1.0, 0.0, 0.0, 0.0])
            pts.append(row)

    # East wall (x = 2.0) - blue tint
    rgb_east = (0.2, 0.4, 0.9)
    f_dc_e = [(c - 0.5) * c_inv for c in rgb_east]
    for z in wall_coords:
        for y in wall_ys:
            row = [2.0, y, z, -1.0, 0.0, 0.0, f_dc_e[0], f_dc_e[1], f_dc_e[2]]
            row.extend([0.0] * 45)
            row.append(4.6)
            row.extend([-2.3, -2.3, -2.3])
            row.extend([1.0, 0.0, 0.0, 0.0])
            pts.append(row)

    # West wall (x = -2.0) - yellow tint
    rgb_west = (0.8, 0.8, 0.2)
    f_dc_w = [(c - 0.5) * c_inv for c in rgb_west]
    for z in wall_coords:
        for y in wall_ys:
            row = [-2.0, y, z, 1.0, 0.0, 0.0, f_dc_w[0], f_dc_w[1], f_dc_w[2]]
            row.extend([0.0] * 45)
            row.append(4.6)
            row.extend([-2.3, -2.3, -2.3])
            row.extend([1.0, 0.0, 0.0, 0.0])
            pts.append(row)

    data = np.zeros(len(pts), dtype=fields)
    for i, pt in enumerate(pts):
        for j, (name, _) in enumerate(fields):
            data[name][i] = pt[j]

    return data


def write_ply_numpy(path: Path, data: np.ndarray) -> None:
    """
    Writes binary little-endian PLY file with 62 properties using NumPy only (no plyfile).
    """
    header = (
        "ply\n"
        "format binary_little_endian 1.0\n"
        f"element vertex {len(data)}\n"
        "property float x\n"
        "property float y\n"
        "property float z\n"
        "property float nx\n"
        "property float ny\n"
        "property float nz\n"
        "property float f_dc_0\n"
        "property float f_dc_1\n"
        "property float f_dc_2\n"
    )
    for i in range(45):
        header += f"property float f_rest_{i}\n"
    header += (
        "property float opacity\n"
        "property float scale_0\n"
        "property float scale_1\n"
        "property float scale_2\n"
        "property float rot_0\n"
        "property float rot_1\n"
        "property float rot_2\n"
        "property float rot_3\n"
        "end_header\n"
    )

    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(data.tobytes())


# Pinned SPZ format version for compatibility with Spark 2.3.1 (must match pipeline/config/default.yaml compress.spz_version)
SPZ_VERSION = 3


def convert_ply_to_spz(ply_path: Path, spz_path: Path) -> None:
    """
    Converts PLY to SPZ using splat-transform 3.9.0 via npx with explicit SPZ_VERSION (v3 = gzip-wrapped).
    Uses relative paths from repo root so both Linux and Windows node handle paths identically.
    """
    repo_root = Path(__file__).resolve().parent.parent
    try:
        rel_in = ply_path.relative_to(repo_root)
        rel_out = spz_path.relative_to(repo_root)
    except ValueError:
        rel_in = ply_path
        rel_out = spz_path

    if sys.platform == "win32":
        shell_cmd = f"cmd /c npx -y @playcanvas/splat-transform@3.9.0 {rel_in} {rel_out} -w --spz-version {SPZ_VERSION}"
        res = subprocess.run(shell_cmd, cwd=str(repo_root), shell=True, capture_output=True, text=True)
    else:
        cmd = ["npx", "-y", "@playcanvas/splat-transform@3.9.0", str(rel_in), str(rel_out), "-w", "--spz-version", str(SPZ_VERSION)]
        res = subprocess.run(cmd, cwd=str(repo_root), capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"splat-transform failed:\n{res.stderr}\n{res.stdout}")


def compute_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print("Generating full synthetic Gaussian splat (NumPy only)...")
    full_data = generate_synthetic_splat(num_floor_per_side=25, num_wall_points=20)
    full_ply = OUTPUT_DIR / "dev_full.ply"
    full_spz = OUTPUT_DIR / "dev_full.spz"
    write_ply_numpy(full_ply, full_data)
    print(f"Wrote full PLY: {full_ply} ({len(full_data)} Gaussians)")

    print("Converting full PLY to SPZ via @playcanvas/splat-transform@3.9.0...")
    convert_ply_to_spz(full_ply, full_spz)
    print(f"Wrote full SPZ: {full_spz} ({full_spz.stat().st_size} bytes)")

    print("Generating lite synthetic Gaussian splat (40% Gaussians)...")
    indices = np.random.RandomState(42).choice(len(full_data), size=int(len(full_data) * 0.4), replace=False)
    lite_data = full_data[indices]
    lite_ply = OUTPUT_DIR / "dev_lite.ply"
    lite_spz = OUTPUT_DIR / "dev_lite.spz"
    write_ply_numpy(lite_ply, lite_data)
    print(f"Wrote lite PLY: {lite_ply} ({len(lite_data)} Gaussians)")

    print("Converting lite PLY to SPZ via @playcanvas/splat-transform@3.9.0...")
    convert_ply_to_spz(lite_ply, lite_spz)
    print(f"Wrote lite SPZ: {lite_spz} ({lite_spz.stat().st_size} bytes)")

    full_sha256 = compute_sha256(full_spz)
    full_bytes = full_spz.stat().st_size
    lite_sha256 = compute_sha256(lite_spz)
    lite_bytes = lite_spz.stat().st_size

    # Build compliant manifest with strictly compliant 12-char RFC 4648 base32 IDs [a-z2-7]
    scene_id = "scn_23devsynthet"
    space_id = "spc_23devsynthet"
    job_id = "job_23devsynthet"
    full_id = "ast_23devsplatfl"
    lite_id = "ast_23devsplatlt"

    manifest = {
        "schema_version": 1,
        "scene_id": scene_id,
        "space_id": space_id,
        "version": 1,
        "created_at": "2026-10-18T00:00:00Z",
        "job_id": job_id,
        "assets": {
            "full": full_id,
            "lite": lite_id,
        },
        "asset_table": {
            full_id: {
                "schema_version": 1,
                "asset_id": full_id,
                "kind": "splat_full",
                "format": "spz",
                "uri": "dev_full.spz",
                "sha256": full_sha256,
                "bytes": full_bytes,
                "gaussians": len(full_data),
            },
            lite_id: {
                "schema_version": 1,
                "asset_id": lite_id,
                "kind": "splat_lite",
                "format": "spz",
                "uri": "dev_lite.spz",
                "sha256": lite_sha256,
                "bytes": lite_bytes,
                "gaussians": len(lite_data),
            },
        },
        "transform": {
            "world_from_splat": [
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
            ],
            "scale": 1.0,
            "method": "floor_ransac+tape_pair",
            "residuals": {
                "floor_rms_m": 0.0,
                "scale_check_error_pct": 0.0,
            },
        },
        "start_pose": {
            "x": 0.0,
            "z": 0.0,
            "yaw_deg": 0.0,
        },
        "eye_height_m": 1.5,
        "bounds": {
            "minX": -2.0,
            "maxX": 2.0,
            "minZ": -2.0,
            "maxZ": 2.0,
        },
    }

    manifest_path = OUTPUT_DIR / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    print(f"Wrote matching manifest: {manifest_path}")
    print("Dev synthetic scene successfully created!")


if __name__ == "__main__":
    main()
