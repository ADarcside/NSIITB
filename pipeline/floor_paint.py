"""
Namma Space: repaint the floor from the capture photos (step 2 of the floor clean-up, after pipeline/floor.py).

The splat floor is a soft average of many frames. The photos themselves show it sharp. This module:

  1. Maps every COLMAP camera into the world frame (metres, +Y up, floor y=0) with the same COLMAP->splat
     mapping S06 uses, then world_from_splat.
  2. Lays a flat sheet of small opaque Gaussians at paint_y_m over the room floor (paint_step_m apart) and,
     for each photo, projects the sheet points into it (SIMPLE_RADIAL distortion). A point counts as seen when
     the solid splats above the floor (opacity > occluder_opacity, y > occluder_y_m) leave it visible, rendered
     from that camera with the CPU renderer. Rays that hit the floor pass above-floor splats first, so no depth
     test is needed.
  3. Each point keeps its best top_views samples, ranked by sharpness on the floor (pixels per metre, squared,
     times cos^2 so steep views win, times frame sharpness). The colour is their median, so things standing on
     the floor, which land on different floor spots from different views, drop out.
  4. Unseen floor (under beds) is filled from nearby painted colour (1, 10, 30 cm), then from the floor.py
     backing colour, matched in brightness.
  5. The thin floor skin (splats in floor_skin_m, thinner than skin_thick_m) is removed only where the photos
     painted the floor. Objects, legs and everything under the beds stay.

Command for an already published scene (after pipeline.floor):
  python -m pipeline.floor_paint --scene-dir <published dir> --floor-work <pipeline.floor work dir>
      --run-dir <run with frames/, colmap/sparse/0/, dataparser_transforms.json> --out <dir>
"""

from __future__ import annotations

import argparse
import json
import math
import multiprocessing as mp
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional, Sequence, Tuple

import numpy as np
from scipy import ndimage as ndi
from scipy.spatial import cKDTree

from pipeline import floaters as fl
from pipeline import floor as fb

DEFAULTS: Dict[str, Any] = {
    "enabled": True,
    "paint_y_m": -0.002,         # sheet height: the floor surface
    "paint_step_m": 0.007,
    "paint_sigma_m": 0.005,
    "occluder_y_m": 0.03,        # splats above this and more opaque than occluder_opacity hide the floor
    "occluder_opacity": 0.5,
    "max_occlusion": 0.5,        # a view counts if the occluders cover less than this at the point
    "min_cos": 0.3,              # and the ray is at least this steep onto the floor
    "top_views": 6,
    "render_div": 4,             # occluder render at 1/4 of the photo size
    "frame_every": 1,
    "floor_skin_m": [-0.03, 0.02],
    "skin_thick_m": 0.01,
    "workers": 0,
}


def merged_config(cfg: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    out = dict(DEFAULTS)
    out.update(cfg or {})
    return out


# ---------------------------------------------------------------- cameras

def world_cameras(run_dir: Path, world_from_splat: np.ndarray, splat_xyz: np.ndarray) -> Dict[str, Any]:
    """COLMAP cameras in the world frame: {name: {c, R (world->camera, x right, y down, z forward)}} + intrinsics."""
    from pipeline import normalize as nz
    from pipeline.stages.s03_poses import parse_cameras_txt, parse_images_txt, parse_points3D_txt
    sp = run_dir / "colmap" / "sparse" / "0"
    cams = parse_cameras_txt(sp / "cameras.txt")
    images = parse_images_txt(sp / "images.txt")
    pts = np.asarray([p["xyz"] for p in parse_points3D_txt(sp / "points3D.txt").values()])
    dp_path = next(iter(sorted(run_dir.rglob("dataparser_transforms.json"))), None)
    if dp_path is None:
        raise FileNotFoundError(f"no dataparser_transforms.json under {run_dir}")
    t, s, frame, errs = nz.choose_colmap_frame(json.loads(dp_path.read_text()), pts, splat_xyz)
    a = np.eye(4)
    a[:3, :4] = s * t
    wc = np.asarray(world_from_splat, float) @ a
    k = float(np.cbrt(abs(np.linalg.det(wc[:3, :3]))))
    q = wc[:3, :3] / k
    if len(cams) != 1:
        raise ValueError("one shared COLMAP camera expected")
    cam = next(iter(cams.values()))
    if cam["model"] not in ("SIMPLE_RADIAL", "SIMPLE_PINHOLE"):
        raise ValueError(f"camera model {cam['model']} not supported")
    p = cam["params"]
    out = {"frame": frame, "frame_err": errs[frame], "w": int(cam["width"]), "h": int(cam["height"]),
           "f": float(p[0]), "cx": float(p[1]), "cy": float(p[2]), "k1": float(p[3]) if len(p) > 3 else 0.0,
           "cams": {}}
    for im in images.values():
        r = nz.qvec_to_rotmat(im["qvec"])
        tv = np.asarray(im["tvec"], float)
        out["cams"][im["name"]] = {"c": wc[:3, :3] @ (-r.T @ tv) + wc[:3, 3], "R": r @ q.T}
    return out


def project(cams: Dict[str, Any], name: str, p: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Pixel (u, v) of world points in a photo, and a mask of points in front and inside the frame."""
    cam = cams["cams"][name]
    pc = (p - cam["c"]) @ np.asarray(cam["R"]).T
    z = pc[:, 2]
    ok = z > 0.2
    zs = np.where(ok, z, 1.0)
    x, y = pc[:, 0] / zs, pc[:, 1] / zs
    dist = 1 + cams["k1"] * (x * x + y * y)
    u = cams["f"] * x * dist + cams["cx"]
    v = cams["f"] * y * dist + cams["cy"]
    ok &= (u > 2) & (u < cams["w"] - 3) & (v > 2) & (v < cams["h"] - 3)
    return u, v, ok


# ---------------------------------------------------------------- painting

_G: Dict[str, Any] = {}


def _view(name: str):
    import cv2
    g = _G
    cams, cfg, p = g["cams"], g["cfg"], g["p"]
    u, v, ok = project(cams, name, p)
    i = np.flatnonzero(ok)
    if not len(i):
        return name, None
    cam = cams["cams"][name]
    r, e = np.asarray(cam["R"]), np.asarray(cam["c"])
    div = int(cfg["render_div"])
    w, h = cams["w"] // div, cams["h"] // div
    fov = 2 * math.degrees(math.atan((h / 2) / (cams["f"] / div)))
    _, a = fl.render(g["scene"], e, e + r[2], (w, h), fov, mask=g["occ"], rot=r)
    occ = a[np.clip((v[i] / div).astype(int), 0, h - 1), np.clip((u[i] / div).astype(int), 0, w - 1)]
    ray = p[i] - e
    dd = np.linalg.norm(ray, axis=1)
    cos = np.abs(ray[:, 1]) / dd
    good = (occ < float(cfg["max_occlusion"])) & (cos > float(cfg["min_cos"]))
    i, occ, dd, cos, u, v = i[good], occ[good], dd[good], cos[good], u[i][good], v[i][good]
    if not len(i):
        return name, None
    img = cv2.imread(str(g["frames"] / name), cv2.IMREAD_COLOR)[..., ::-1].astype(np.float32) / 255.0
    sharp = float(ndi.laplace(img.mean(-1)[::2, ::2]).var())
    col = np.stack([ndi.map_coordinates(img[..., k], [v, u], order=1) for k in range(3)], -1)
    wt = (cams["f"] * cos / dd) ** 2 * cos ** 2 * (1 - occ) ** 2
    return name, (i.astype(np.int32), wt.astype(np.float32), (col * 255).round().astype(np.uint8), sharp)


def sheet_points(grid: Dict[str, Any], cfg: Dict[str, Any]) -> Tuple[np.ndarray, Tuple[int, int]]:
    c = float(grid["cell_m"]); ox, oz = grid["origin"]; st = float(cfg["paint_step_m"])
    xs = np.arange(ox + st / 2, ox + grid["width"] * c, st)
    zs = np.arange(oz + st / 2, oz + grid["height"] * c, st)
    xx, zz = np.meshgrid(xs, zs)
    return np.c_[xx.ravel(), np.full(xx.size, float(cfg["paint_y_m"])), zz.ravel()], (len(zs), len(xs))


def paint_colours(scene: fl.Scene, keep: np.ndarray, grid: Dict[str, Any], cams: Dict[str, Any], frames: Path,
                  cfg: Dict[str, Any], log=print) -> Tuple[np.ndarray, np.ndarray, Tuple[int, int]]:
    """Sheet points, their photo colour, and which points the photos saw."""
    p, shape = sheet_points(grid, cfg)
    occ = keep & (scene.w[:, 1] > float(cfg["occluder_y_m"])) & (scene.op > float(cfg["occluder_opacity"]))
    _G.update(scene=scene, occ=occ, p=p, cams=cams, cfg=cfg, frames=Path(frames))
    names = sorted(n for n in cams["cams"] if (Path(frames) / n).exists())[::int(cfg["frame_every"])]
    fl.render(scene, (0, 1.5, 0), (1, 1.5, 0), (16, 16))  # compile before fork
    t = time.time()
    workers = int(cfg["workers"]) or os.cpu_count() or 1
    with mp.get_context("fork").Pool(workers) as pool:
        out = [r for r in pool.imap_unordered(_view, names, chunksize=2) if r[1] is not None]
    log(f"[floor_paint] {len(out)} of {len(names)} photos see the floor ({time.time() - t:.0f} s)")
    if not out:
        return p, np.zeros((len(p), 3)), np.zeros(len(p), bool), shape
    sm = float(np.median([r[1][3] for r in out]))
    idx = np.concatenate([r[1][0] for r in out])
    wt = np.concatenate([r[1][1] * min(2.0, r[1][3] / max(sm, 1e-12)) for r in out])
    cl = np.concatenate([r[1][2] for r in out])
    o = np.lexsort((-wt, idx)); idx, wt, cl = idx[o], wt[o], cl[o]
    first = np.r_[0, np.flatnonzero(np.diff(idx)) + 1]
    rank = np.arange(len(idx)) - np.repeat(first, np.diff(np.r_[first, len(idx)]))
    top = int(cfg["top_views"])
    sel = rank < top
    idx, wt, cl, rank = idx[sel], wt[sel], cl[sel].astype(np.float64) / 255, rank[sel]
    stack = np.full((len(p), top, 3), np.nan)
    stack[idx, rank] = cl
    nn = np.bincount(idx, minlength=len(p))
    seen = nn > 0
    col = np.zeros((len(p), 3))
    many = nn >= 3
    col[many] = np.nanmedian(stack[many], axis=1)
    few = seen & ~many
    wsum = np.bincount(idx, wt, len(p))
    wc = np.stack([np.bincount(idx, wt * cl[:, k], len(p)) for k in range(3)], -1)
    col[few] = wc[few] / wsum[few, None]
    return p, col, seen, shape


def finish_colours(p: np.ndarray, col: np.ndarray, seen: np.ndarray, shape: Tuple[int, int],
                   fallback_p: np.ndarray, fallback_col: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Fill unseen floor from nearby painted colour, then the brightness-matched fallback. Returns (colour, painted)."""
    gh, gw = shape
    if len(fallback_p):
        _, j = cKDTree(fallback_p[:, [0, 2]]).query(p[:, [0, 2]])
        old = fallback_col[j]
    else:
        old = np.full((len(p), 3), 0.5)
    if seen.any():
        old = np.clip(old * (np.median(col[seen], 0) / np.maximum(np.median(old[seen], 0), 1e-3)), 0, 1)
    sm = ndi.binary_opening(seen.reshape(gh, gw), iterations=1)
    img = col.reshape(gh, gw, 3)
    final = np.where(sm[..., None], img, 0.0)
    done = sm.copy()
    for sg in (2.0, 15.0, 45.0):
        wgt = ndi.gaussian_filter(sm.astype(float), sg)
        blur = np.stack([ndi.gaussian_filter(img[..., k] * sm, sg) for k in range(3)], -1)
        ok = (wgt > 0.05) & ~done
        final[ok] = blur[ok] / wgt[ok, None]
        done |= ok
    final[~done] = old.reshape(gh, gw, 3)[~done]
    return np.clip(final, 0, 1).reshape(-1, 3), sm.ravel()


def skin_mask(scene: fl.Scene, keep: np.ndarray, p: np.ndarray, painted: np.ndarray, shape: Tuple[int, int],
              cfg: Dict[str, Any]) -> np.ndarray:
    """Thin floor-surface splats lying where the photos painted the floor (to be replaced by the sheet)."""
    gh, gw = shape
    st = float(cfg["paint_step_m"])
    x0, z0 = p[0, 0], p[0, 2]
    y = scene.w[:, 1]
    sy = np.sqrt(scene.cov[:, 1, 1])
    b0, b1 = (float(v) for v in cfg["floor_skin_m"])
    skin = keep & (y > b0) & (y < b1) & (sy < float(cfg["skin_thick_m"]))
    ix = np.clip(((scene.w[:, 0] - x0) / st).round().astype(int), 0, gw - 1)
    iz = np.clip(((scene.w[:, 2] - z0) / st).round().astype(int), 0, gh - 1)
    inner = ndi.binary_erosion(painted.reshape(gh, gw), iterations=2)
    return skin & inner[iz, ix]


def sheet_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """floor.py backing parameters for the painted sheet (backing_rows / lite_backing_rows)."""
    return fb.merged_config({"backing_y_m": cfg["paint_y_m"], "backing_step_m": cfg["paint_step_m"],
                             "backing_sigma_m": cfg["paint_sigma_m"]})


def floor_paint(scene: fl.Scene, keep: np.ndarray, grid: Dict[str, Any], cams: Dict[str, Any], frames: Path,
                fallback_p: np.ndarray, fallback_col: np.ndarray, cfg: Optional[Dict[str, Any]] = None,
                log=print) -> Tuple[np.ndarray, np.ndarray, np.ndarray, Dict[str, Any]]:
    """Returns (keep without the repainted skin, sheet points, sheet colours, stats)."""
    cfg = merged_config(cfg)
    p, col, seen, shape = paint_colours(scene, keep, grid, cams, frames, cfg, log)
    final, painted = finish_colours(p, col, seen, shape, fallback_p, fallback_col)
    skin = skin_mask(scene, keep, p, painted, shape, cfg)
    stats = {"sheet": int(len(p)), "painted_pct": round(100 * float(painted.mean()), 1),
             "skin_removed": int(skin.sum()), "camera_frame": cams.get("frame")}
    log(f"[floor_paint] sheet {len(p)} points, {stats['painted_pct']}% painted from photos, "
        f"{stats['skin_removed']} floor-skin Gaussians replaced")
    return keep & ~skin, p, final, stats


# ---------------------------------------------------------------- published scene

def clean_published_scene(scene_dir: Path, floor_work: Path, run_dir: Path, out_dir: Path,
                          cfg: Optional[Dict[str, Any]] = None, log=print) -> Dict[str, Any]:
    """Uses pipeline.floor's work dir (full_in.ply, keep.npy, backing.npz) and writes full/lite like it does."""
    cfg = merged_config(cfg)
    scene_dir, floor_work, run_dir, out_dir = Path(scene_dir), Path(floor_work), Path(run_dir), Path(out_dir)
    work = out_dir / "_work"
    work.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((scene_dir / "manifest.json").read_text())
    grid = json.loads((scene_dir / "grid.json").read_text())
    data, names = fl.read_ply(floor_work / "full_in.ply")
    m = fl.manifest_matrix(manifest)
    scene = fl.Scene.from_splat(data, names, m)
    keep = np.load(floor_work / "keep.npy")
    bk = np.load(floor_work / "backing.npz")
    ix = {n: i for i, n in enumerate(names)}
    xyz = data[:, [ix["x"], ix["y"], ix["z"]]].astype(np.float64)
    op = 1 / (1 + np.exp(-data[:, ix["opacity"]]))
    cams = world_cameras(run_dir, m, xyz[op >= 0.5])
    log(f"[floor_paint] cameras: {len(cams['cams'])} ({cams['frame']}, mismatch {cams['frame_err']:.4f})")
    keep2, p, col, stats = floor_paint(scene, keep, grid, cams, run_dir / "frames", bk["p"], bk["col"], cfg, log)
    np.savez(work / "paint.npz", keep=keep2, p=p, col=col)
    sc = sheet_config(cfg)
    clean = work / "full_clean.ply"
    fl.write_ply(floor_work / "full_in.ply", clean, data, keep2)
    fb.append_rows(clean, fb.backing_rows(p, col, names, m, sc))
    lite = fb.write_lite(floor_work / "full_in.ply", data, keep2, p, col, names, m, sc, work)
    stats.update(fl.write_published(scene_dir, out_dir, clean, work, lite_ply=lite))
    (work / "stats.json").write_text(json.dumps(stats, indent=1))
    return stats


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Repaint the floor from the capture photos")
    ap.add_argument("--scene-dir", required=True)
    ap.add_argument("--floor-work", required=True, help="pipeline.floor --work-dir (full_in.ply, keep.npy, backing.npz)")
    ap.add_argument("--run-dir", required=True, help="frames/, colmap/sparse/0/, dataparser_transforms.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--config", default=None, help="pipeline config yaml (its floor_paint: block is used)")
    a = ap.parse_args(argv)
    cfg: Dict[str, Any] = {}
    if a.config:
        from pipeline.common import load_config
        cfg = dict(load_config(a.config)[0].get("floor_paint", {}))
    stats = clean_published_scene(Path(a.scene_dir), Path(a.floor_work), Path(a.run_dir), Path(a.out), cfg)
    print(json.dumps(stats, indent=1, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
