"""
Namma Space: Pipeline Stage S06 - Normalize and clean (Gate G6)
SPEC Section 6 (S6):
- world_from_splat: right-handed, +Y up, metres, floor at y=0
- Floor RANSAC on the bottom height band; scale from the 2.000 m tape pair, checked by the 1.000 m pair,
  else from the measured ceiling height (capture room_dims_m), checked against the measured length/width
- With a measured room size the walls are found, yaw is snapped to them, and cleanup + viewer bounds
  stop at the walls
- Cleanup removes Gaussians only (opacity, scale outliers, outside room box + pad); never rotates the PLY
- Gate G6: floor RMS <= max_floor_rms_m and scale check error <= max_scale_error_pct
Inputs found in the run dir: newest exported PLY, colmap/sparse/0/*.txt,
Nerfstudio dataparser_transforms.json, optional marks_2d.json.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time
from typing import Any, Dict, List, Optional, Union

import numpy as np

from pipeline.common import fail_gate, load_config, record_stage_result, sha256_file
from pipeline import normalize as nz
from pipeline import grid as navgrid
from pipeline.stages.s03_poses import parse_cameras_txt, parse_images_txt, parse_points3D_txt
from pipeline.stages.s05_export import read_ply_gaussians_numpy

# Typical chest-height hold for the capture SOP; only used when no tape pair or override exists.
CAMERA_HEIGHT_PRIOR_M = 1.35
CLEAN_PLY_NAME = "clean.ply"
NAVGRID_NAME = "navgrid.json"


def find_export_ply(run_dir: Path) -> Path:
    for name in ("raw.ply", "splat.ply"):
        if (run_dir / name).is_file():
            return run_dir / name
    found = sorted(
        (p for p in run_dir.glob("*.ply") if p.name != CLEAN_PLY_NAME),
        key=lambda p: p.stat().st_mtime,
    )
    if not found:
        raise FileNotFoundError(f"No exported PLY in {run_dir}")
    return found[-1]


def find_dataparser_transforms(run_dir: Path) -> Path:
    found = sorted(run_dir.glob("**/dataparser_transforms.json"), key=lambda p: p.stat().st_mtime)
    if not found:
        raise FileNotFoundError(f"No Nerfstudio dataparser_transforms.json under {run_dir}")
    return found[-1]


def write_ply_subset(src_ply: Path, dst_ply: Path, data: np.ndarray, keep: np.ndarray) -> None:
    """Copies the PLY header with a new vertex count and writes the kept rows unchanged."""
    raw = src_ply.read_bytes()
    end = raw.index(b"end_header") + len(b"end_header")
    end = raw.index(b"\n", end) + 1
    header_lines = raw[:end].decode("ascii").splitlines(keepends=True)
    kept = np.ascontiguousarray(data[keep]).astype("<f4")
    out_lines = []
    for line in header_lines:
        if line.startswith("element vertex"):
            line = f"element vertex {kept.shape[0]}\n"
        out_lines.append(line)
    with open(dst_ply, "wb") as f:
        f.write("".join(out_lines).encode("ascii"))
        f.write(kept.tobytes())


def metrics_scale_is_approx(scale_method: str) -> bool:
    return scale_method.startswith("camera_height_prior")


def run_s06_normalize(
    run_dir: Union[str, Path],
    capture_json_path: Optional[Union[str, Path]] = None,
    config_path: Optional[Union[str, Path]] = None,
    scale_override: Optional[float] = None,
    marks_path: Optional[Union[str, Path]] = None,
) -> Dict[str, Any]:
    start = time.time()
    r_dir = Path(run_dir)
    report_path = r_dir / "run_report.json"
    config, config_hash = load_config(config_path)
    n_cfg = config.get("normalize", {})
    band = float(n_cfg.get("floor_band_fraction", 0.25))
    max_rms = float(n_cfg.get("max_floor_rms_m", 0.03))
    max_scale_err = float(n_cfg.get("max_scale_error_pct", 2.0))
    require_tape = bool(n_cfg.get("require_tape", False))

    def fail(measured: Any, threshold: Any, message: str, metrics: Optional[Dict[str, Any]] = None) -> None:
        fail_gate(
            gate="G6", stage="s06_normalize", measured=measured, threshold=threshold,
            message=message, report_path=report_path, duration_s=time.time() - start,
            config_hash=config_hash, metrics=metrics,
        )

    # Inputs
    try:
        ply_path = find_export_ply(r_dir)
        dp_path = find_dataparser_transforms(r_dir)
    except FileNotFoundError as e:
        fail(str(e), "S05 PLY and Nerfstudio dataparser_transforms.json present", str(e))
    sparse = r_dir / "colmap" / "sparse" / "0"
    cameras = parse_cameras_txt(sparse / "cameras.txt")
    images = parse_images_txt(sparse / "images.txt")
    if not images:
        fail(f"no images.txt in {sparse}", "COLMAP TXT model from S03", "COLMAP poses not found")

    ply = read_ply_gaussians_numpy(ply_path)
    data, names = ply["data"], ply["property_names"]
    idx = {n: i for i, n in enumerate(names)}
    xyz = data[:, [idx["x"], idx["y"], idx["z"]]].astype(np.float64)
    opacity = nz.sigmoid(data[:, idx["opacity"]])

    sparse_xyz = np.asarray([p["xyz"] for p in parse_points3D_txt(sparse / "points3D.txt").values()])
    if len(sparse_xyz) < 100:
        fail(len(sparse_xyz), ">= 100 COLMAP points", "points3D.txt missing or too small")
    t_dp, s_dp, frame_name, frame_errs = nz.choose_colmap_frame(json.loads(dp_path.read_text()), sparse_xyz, xyz[opacity >= 0.5])
    frame_err = frame_errs[frame_name]
    other_err = min(v for k, v in frame_errs.items() if k != frame_name)
    if frame_err > 0.02 or frame_err > 0.5 * other_err:
        fail(frame_errs, "best <= 0.02 and clearly better than the alternative",
             "COLMAP points do not line up with the splat; cannot map poses into the splat frame")
    centers_c, ups_c, _ = nz.camera_centers_and_ups(images)
    centers = nz.colmap_to_splat_points(centers_c, t_dp, s_dp)
    up = nz.colmap_to_splat_dirs(ups_c, t_dp).mean(axis=0)
    up /= np.linalg.norm(up)

    # Floor
    solid = xyz[opacity >= 0.5]
    floor_metrics: Dict[str, Any] = {}
    # Keep cameras near the walk (a few COLMAP outliers sit far away)
    cam_med = np.median(centers, axis=0)
    cam_spread = float(np.percentile(np.linalg.norm(centers - cam_med, axis=1), 90))
    path_cams = centers[np.linalg.norm(centers - cam_med, axis=1) <= 3 * cam_spread]
    try:
        floor = nz.ransac_floor(solid, up, band)
    except ValueError as e:
        fail(str(e), "a floor plane in the bottom band", f"Floor fit failed: {e}")
    n, d = floor["normal"], floor["d"]
    if str(n_cfg.get("floor_mode", "band")) == "camera_path":
        # The floor is the strongest layer directly under the walked path: bunks, tables and
        # their tile reflections sit off to the sides or below it.
        r0 = nz.rotation_to_y_up(n, floor["inliers"])
        surf_pts = xyz[opacity >= 0.1]
        h0 = surf_pts @ n + d
        cam_h0 = float(np.median(path_cams @ n + d))
        on_path = nz.path_mask(surf_pts @ r0[[0, 2]].T, path_cams @ r0[[0, 2]].T, 0.2 * abs(cam_h0))
        floor_h = nz.strongest_layer(h0[on_path], float(np.percentile(h0[on_path], 0.5)), 0.6 * cam_h0, 0.01 * abs(cam_h0), lowest_within=0.5)
        if floor_h is not None:
            near = on_path & (np.abs(h0 - floor_h) < 0.03 * abs(cam_h0))
            try:
                floor = nz.ransac_floor(surf_pts[near], n, band_fraction=1.0, thresh=0.01 * abs(cam_h0))
                n, d = floor["normal"], floor["d"]
                floor_metrics = {"floor_layer": "camera_path", "floor_shift_camera_heights": round(floor_h / cam_h0, 3)}
            except ValueError as e:
                floor_metrics = {"floor_layer": f"camera_path failed ({e}); band fit kept"}
    cam_heights = centers @ n + d
    if np.median(cam_heights) <= 0:
        fail(float(np.median(cam_heights)), "> 0", "Cameras are below the fitted floor; plane is not the floor")

    # Scale and origin
    capture = json.loads(Path(capture_json_path).read_text()) if capture_json_path else {}
    # room_dims_mode: walls (room-size scale + wall crop/bounds), scale (scale only), off
    dims_mode = str(n_cfg.get("room_dims_mode", "walls"))
    dims = capture.get("room_dims_m") if dims_mode in ("walls", "scale") else None
    surface = opacity >= 0.1
    room_metrics: Dict[str, Any] = {}
    pairs = capture.get("scale_pairs", [])
    marks_file = Path(marks_path) if marks_path else r_dir / "marks_2d.json"
    marks_world: Dict[str, np.ndarray] = {}
    if marks_file.is_file():
        marks = json.loads(marks_file.read_text()).get("marks", {})
        by_name = {img["name"]: img for img in images.values()}
        for label, obs in marks.items():
            try:
                p = nz.triangulate_mark(obs, by_name, cameras)
            except ValueError as e:
                fail(str(e), "each mark clicked in >= 2 registered frames", f"Tape mark {label}: {e}")
            marks_world[label] = nz.colmap_to_splat_points(p.reshape(1, 3), t_dp, s_dp)[0]

    scale_pair = next((p for p in pairs if p.get("role") == "scale" and p["a"] in marks_world and p["b"] in marks_world), None)
    check_pair = next((p for p in pairs if p.get("role") == "check" and p["a"] in marks_world and p["b"] in marks_world), None)

    scale_check_error_pct: Optional[float] = None
    if scale_pair:
        dist = np.linalg.norm(marks_world[scale_pair["a"]] - marks_world[scale_pair["b"]])
        scale = float(scale_pair["distance_m"]) / dist
        scale_method = "tape_pair"
        if check_pair:
            measured = scale * np.linalg.norm(marks_world[check_pair["a"]] - marks_world[check_pair["b"]])
            scale_check_error_pct = float(abs(measured - check_pair["distance_m"]) / check_pair["distance_m"] * 100)
    elif scale_override:
        scale, scale_method = float(scale_override), "manual_override"
    else:
        if require_tape:
            fail("no tape marks", "marks_2d.json with the scale pair", "normalize.require_tape is set but no tape marks were given")
        scale = CAMERA_HEIGHT_PRIOR_M / float(np.median(cam_heights))
        scale_method = f"camera_height_prior_{CAMERA_HEIGHT_PRIOR_M}m (approximate)"

    r = nz.rotation_to_y_up(n, floor["inliers"])
    if scale_pair:
        a = marks_world[scale_pair["a"]]
        origin = a - (a @ n + d) * n
        origin_source = f"tape mark {scale_pair['a']} on floor"
    else:
        c = np.median(centers, axis=0)
        origin = c - (c @ n + d) * n
        origin_source = "median camera position on floor"
    m = nz.build_world_from_splat(r, scale, origin)
    world_cams = nz.apply(m, centers)

    # Measured room size: ceiling over the walked path and the two pairs of outermost walls give
    # three scale estimates (median wins); the walls bound cleanup and the viewer.
    room_box: Optional[Dict[str, Any]] = None
    walls_xz: Optional[Dict[int, List[float]]] = None
    if dims and scale_method.startswith("camera_height_prior"):
        world_xyz = nz.apply(m, xyz)
        wcams = nz.apply(m, path_cams)
        cam_y = float(np.median(wcams[:, 1]))
        on_path = surface & nz.path_mask(world_xyz[:, [0, 2]], wcams[:, [0, 2]], 0.2 * cam_y)
        ceiling = nz.strongest_layer(world_xyz[on_path, 1], 1.25 * cam_y, 4.0 * cam_y, 0.01 * cam_y)
        top = min(0.85 * ceiling, 1.8 * cam_y) if ceiling else 1.8 * cam_y
        horiz = np.linalg.norm(world_xyz[:, [0, 2]] - np.median(wcams[:, [0, 2]], axis=0), axis=1)
        mid = np.flatnonzero(surface & (world_xyz[:, 1] > 0.25 * cam_y) & (world_xyz[:, 1] < top) & (horiz < 6.0 * cam_y))
        if len(mid) > 300_000:
            mid = np.random.default_rng(0).choice(mid, 300_000, replace=False)
        if len(mid) >= 1000:
            yaw = nz.wall_yaw(world_xyz[mid][:, [0, 2]], np.ones(len(mid)))
            r = nz.yaw_rotation(yaw) @ r
            m = nz.build_world_from_splat(r, scale, origin)
            wv = nz.apply(m, xyz[mid])
            walls_xz = {ax: list(nz.outer_walls(wv[:, ax], 0.02 * cam_y)) for ax in (0, 2)}
            span = {ax: walls_xz[ax][1] - walls_xz[ax][0] for ax in (0, 2)}
            length_axis = 0 if span[0] >= span[2] else 2
            estimates = {
                "length": float(dims["length"]) / span[length_axis],
                "width": float(dims["width"]) / span[2 - length_axis],
            }
            if ceiling:
                estimates["ceiling"] = float(dims["height"]) / ceiling
            k = float(np.median(list(estimates.values())))
            room_metrics.update({
                "wall_yaw_deg": round(float(np.degrees(yaw)), 2),
                "length_axis": "x" if length_axis == 0 else "z",
                "room_scale_estimates": {key: round(v, 4) for key, v in estimates.items()},
                "room_dims_check_pct": {key: round(abs(v / k - 1) * 100, 2) for key, v in estimates.items()},
            })
            if not 0.5 <= k <= 2.0:
                room_metrics["room_dims_rejected"] = f"scale correction {k:.3f} outside 0.5-2.0"
                walls_xz = None
            else:
                scale *= k
                scale_method = "room_dims_median"
                m = nz.build_world_from_splat(r, scale, origin)
                walls_xz = {ax: [v * k for v in walls_xz[ax]] for ax in (0, 2)}
                height_m = float(dims["height"])
                if any(v > float(n_cfg.get("room_dims_warn_pct", 5.0)) for v in room_metrics["room_dims_check_pct"].values()):
                    room_metrics["room_dims_warning"] = "ceiling/length/width disagree beyond room_dims_warn_pct; scale is their median"
                if dims_mode == "walls":
                    room_box = {"min": [walls_xz[0][0], 0.0, walls_xz[2][0]],
                                "max": [walls_xz[0][1], max(height_m, (ceiling or 0) * k), walls_xz[2][1]]}
                else:
                    walls_xz = None
    world_cams = nz.apply(m, centers)

    floor_rms_m = floor["rms"] * scale
    world_xyz = nz.apply(m, xyz)
    keep, clean_stats = nz.cleanup_mask(
        data, names, world_xyz,
        min_opacity=float(n_cfg.get("min_opacity", 0.05)),
        scale_outlier_multiple=float(n_cfg.get("scale_outlier_multiple", 6.0)),
        room_box_pad_m=float(n_cfg.get("room_box_pad_m", 0.3)),
        room_box=room_box,
        room_height_m=room_box["max"][1] if room_box else None,
        world_scale=scale,
        scale_outlier_min_m=float(n_cfg.get("scale_outlier_min_m", 1.0)),
    )
    # cleanup: false keeps every Gaussian (removal counts are still reported). Walls in a splat
    # are partly see-through and Gaussians beyond them fill them in, so cropping opens black holes.
    clean_stats["cleanup_applied"] = bool(n_cfg.get("cleanup", True))
    if not clean_stats["cleanup_applied"]:
        keep = np.ones(len(data), dtype=bool)
        clean_stats["kept"] = int(len(data))
    clean_path = r_dir / CLEAN_PLY_NAME
    write_ply_subset(ply_path, clean_path, data, keep)

    kept_world = world_xyz[keep]
    if walls_xz:
        inset = float(config.get("grid", {}).get("agent_radius_m", 0.25))
        bounds_xz = {
            "minX": round(walls_xz[0][0] + inset, 3), "maxX": round(walls_xz[0][1] - inset, 3),
            "minZ": round(walls_xz[2][0] + inset, 3), "maxZ": round(walls_xz[2][1] - inset, 3),
        }
    else:
        bounds_xz = {
            "minX": round(float(np.percentile(kept_world[:, 0], 1)), 3),
            "maxX": round(float(np.percentile(kept_world[:, 0], 99)), 3),
            "minZ": round(float(np.percentile(kept_world[:, 2], 1)), 3),
            "maxZ": round(float(np.percentile(kept_world[:, 2], 99)), 3),
        }
    # Walkable floor grid (S09 collision): obstacles from the Gaussians in the body height band
    grid_cfg = config.get("grid", {})
    start_xz = (float(np.median(world_cams[:, 0])), float(np.median(world_cams[:, 2])))
    grid_metrics: Dict[str, Any] = {}
    if grid_cfg.get("enabled", True):
        wpath = nz.apply(m, path_cams)[:, [0, 2]]
        free, grid_meta = navgrid.build_free_mask(world_xyz, opacity, bounds_xz, start_xz, grid_cfg, wpath)
        grid_metrics = {k: v for k, v in grid_meta.items() if k.startswith("grid_")}
        min_free = float(grid_cfg.get("min_free_m2", 1.0))
        if grid_meta["grid_free_m2"] >= min_free:
            doc = {k: grid_meta[k] for k in ("cell_m", "origin", "width", "height", "agent_radius_m")}
            doc["free_bits_b64"] = navgrid.encode_free_bits(free)
            layers_cfg = grid_cfg.get("layers", {})
            if layers_cfg.get("enabled", True):
                occ, layer_meta = navgrid.build_layers(world_xyz, opacity, grid_meta, bounds_xz, layers_cfg)
                doc["layers"] = {k: layer_meta[k] for k in ("y0_m", "dy_m", "count")}
                doc["layers"]["occupied_bits_b64"] = navgrid.encode_free_bits(occ)
                grid_metrics.update({k: v for k, v in layer_meta.items() if k.startswith("grid_")})
                navgrid.write_layers_preview(r_dir / "navgrid_layers.png", occ, layer_meta["y0_m"], layer_meta["dy_m"])
            (r_dir / NAVGRID_NAME).write_text(json.dumps(doc))
            start_xz = tuple(grid_meta["grid_start_xz"])
            grid_metrics["grid_written"] = True
        else:
            (r_dir / NAVGRID_NAME).unlink(missing_ok=True)
            grid_metrics["grid_written"] = False
            grid_metrics["grid_warning"] = f"walkable area {grid_meta['grid_free_m2']} m2 < {min_free} m2: ghost mode only"
        o, c = grid_meta["origin"], grid_meta["cell_m"]
        pc = np.c_[np.floor((wpath[:, 1] - o[1]) / c), np.floor((wpath[:, 0] - o[0]) / c)].astype(np.int64)
        pc = pc[(pc[:, 0] >= 0) & (pc[:, 0] < free.shape[0]) & (pc[:, 1] >= 0) & (pc[:, 1] < free.shape[1])]
        navgrid.write_preview(r_dir / "navgrid.png", free, pc)

    metrics = {
        "input_ply": str(ply_path),
        "clean_ply": str(clean_path),
        "scale": scale,
        "scale_method": scale_method,
        "approximate_scale": metrics_scale_is_approx(scale_method),
        "floor_rms_m": round(floor_rms_m, 4),
        "floor_inliers": floor["inlier_count"],
        "floor_band_points": floor["band_count"],
        "scale_check_error_pct": None if scale_check_error_pct is None else round(scale_check_error_pct, 3),
        "origin": origin_source,
        "colmap_frame": frame_name,
        "colmap_to_splat_mismatch": {k: round(v, 5) for k, v in frame_errs.items()},
        "camera_height_median_m": round(float(np.median(world_cams[:, 1])), 3),
        "gaussians_in": int(len(data)),
        **clean_stats,
        **floor_metrics,
        **room_metrics,
        "bounds_xz": bounds_xz,
        **grid_metrics,
    }

    transform = {
        "schema_version": 1,
        "world_from_splat": nz.to_column_major(m),
        "scale": scale,
        "method": "floor_ransac+tape_pair",
        "scale_method": scale_method,
        "residuals": {
            "floor_rms_m": round(floor_rms_m, 4),
            "scale_check_error_pct": scale_check_error_pct,
        },
        "start_pose_hint": {"x": round(start_xz[0], 3), "z": round(start_xz[1], 3)},
        "bounds": metrics["bounds_xz"],
        "metrics": metrics,
    }
    (r_dir / "transform.json").write_text(json.dumps(transform, indent=2))

    # Small sample of the raw splat (splat frame) + cameras, so S06 can be tuned off the GPU machine
    rng = np.random.default_rng(0)
    pick = np.flatnonzero(opacity >= 0.05)
    pick = rng.choice(pick, min(400_000, len(pick)), replace=False)
    np.savez_compressed(
        r_dir / "s06_sample.npz",
        xyz=xyz[pick].astype(np.float32),
        opacity=opacity[pick].astype(np.float16),
        log_scales=data[pick][:, [idx["scale_0"], idx["scale_1"], idx["scale_2"]]].astype(np.float16),
        f_dc=data[pick][:, [idx["f_dc_0"], idx["f_dc_1"], idx["f_dc_2"]]].astype(np.float16),
        cameras=centers.astype(np.float32),
        up=up.astype(np.float32),
        world_from_splat=m.astype(np.float64),
    )

    errors: List[str] = []
    if floor_rms_m > max_rms:
        errors.append(f"Floor RMS {floor_rms_m:.4f} m > {max_rms} m")
    if scale_check_error_pct is not None and scale_check_error_pct > max_scale_err:
        errors.append(f"Scale check error {scale_check_error_pct:.2f}% > {max_scale_err}%")
    threshold = {"max_floor_rms_m": max_rms, "max_scale_error_pct": max_scale_err}
    if errors:
        fail(metrics, threshold, "; ".join(errors), metrics)

    record_stage_result(
        report_path=report_path, stage_name="s06_normalize", gate="G6", status="passed",
        duration_s=time.time() - start, input_hash=sha256_file(ply_path), config_hash=config_hash,
        metrics=metrics,
        gate_result={"passed": True, "measured": {"floor_rms_m": metrics["floor_rms_m"],
                     "scale_check_error_pct": metrics["scale_check_error_pct"]}, "threshold": threshold},
    )
    print(f"[s06_normalize] floor RMS {floor_rms_m * 100:.2f} cm, scale {scale:.4f} ({scale_method}), "
          f"kept {clean_stats['kept']}/{len(data)} Gaussians -> {clean_path}")
    return transform


def main() -> int:
    parser = argparse.ArgumentParser(description="S06: floor alignment, scale and cleanup (Gate G6)")
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--capture", default=None)
    parser.add_argument("--config", default=None)
    parser.add_argument("--scale", type=float, default=None, help="Manual scale override (metres per splat unit)")
    parser.add_argument("--marks", default=None, help="marks_2d.json (default: <run-dir>/marks_2d.json)")
    args = parser.parse_args()
    run_s06_normalize(args.run_dir, args.capture, args.config, args.scale, args.marks)
    return 0


if __name__ == "__main__":
    sys.exit(main())
