"""
Namma Space: one-pass automatic room fixer, step 1 "photo judge" (plan: project files auto-fixer/plan.md).

The real photos decide what is wrong. Every 8th frame was held out of training (S04 holdout_every), so the model
was never fitted to it. For each held-out photo:

  1. Render the model from that photo's own camera (CPU splatter from pipeline/floaters.py, DC colour).
  2. Match the render's colours to the photo with one 3x4 colour transform per photo (the phone's exposure and
     white balance change from photo to photo; the model learnt that per photo with the bilateral grid).
  3. Error image: per pixel, how far the matched render is from the photo (both lightly blurred), minus a noise
     floor.
  4. Blame: every Gaussian collects error x its own share of each pixel (front-to-back weight), so a blob in
     front of a wall that the photo shows clear collects a lot.

Then:
  5. Suspects: Gaussians whose average blame is high. They are grouped into 3D clusters (5 cm voxels).
  6. One cluster at a time (worst first), the photos where it causes the most error are rendered again without
     it, cropped to its footprint. The cluster is removed only if those photos then match better by at least
     accept_gain and no hole opens (removing a real but blurry surface shows what is behind it or black, which
     matches worse, so real things stay). This replaces hand-picked boxes.
  7. Report: clusters.json (every cluster, its box, why kept or removed), keep.npy, a before/after sheet.
     A removed cluster can be put back by id (--restore) without rendering again.

Nothing is tuned per room and nothing is picked by hand (no boxes, no protected areas, no colours): thresholds are
relative to the room's own error spread and every cluster is found fresh, so this stays automatic clean-up.

Commands
  python -m pipeline.autofix judge --ply clean.ply --transform transform.json --colmap <sparse/0> \
         --frames <frames> --out <work dir>
  python -m pipeline.autofix restore --work <work dir> --ply clean.ply --ids 3,7 --out fixed.ply
     (undo only: puts removed clusters back; nothing is ever added that the model did not have)
"""

from __future__ import annotations

import argparse
import json
import math
import multiprocessing as mp
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numba as nb
import numpy as np
from scipy import ndimage as ndi

from pipeline import floaters as fl

DEFAULTS: Dict[str, Any] = {
    "enabled": False,
    "holdout_every": 8,        # S04 eval interval: sorted frame index % this == 0 are the held-out photos
    "max_photos": 400,         # judge at most this many held-out photos (evenly spread)
    "render_div": 4,           # render at 1/4 of the COLMAP image size
    "blur_px": 1.0,            # both images blurred this much before comparing (pose noise, resampling)
    "err_floor": 0.03,         # per-pixel colour error below this is noise (after the 1-pixel shift tolerance)
    "min_mass_px": 3.0,        # a suspect must cover at least this many (weighted) pixels over all photos
    "blame_pct": 98.0,         # suspects: average blame above this percentile of the room's Gaussians ...
    "blame_min": 0.10,         # ... and above this absolute value
    "voxel_m": 0.05,           # suspects within one voxel of each other form one cluster
    "min_cluster": 8,          # smaller clusters are not tested alone (they ride with a neighbour or stay)
    "max_clusters": 400,
    "test_views": 6,           # photos used to test one cluster (the ones where it causes most error)
    "accept_gain": 0.08,       # removal must cut the photo error in the cluster's footprint by this share
    "max_hole_pct": 1.0,       # and open holes (solid -> see-through) in at most this share of its footprint
    "crop_margin_px": 6,
    "min_depth_m": 0.8,        # a photo blames / tests only Gaussians at least this far from its camera (close-ups
                               # show detail the walk-through never gets that close to; the model is weakest there)
    "min_gain": 2.0,           # and the removal must fix at least this much error in total (error x render pixels),
                               # so a 30% gain on a 20-pixel speck does not count
    "workers": 0,
}


def merged_config(cfg: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    out = dict(DEFAULTS)
    out.update(cfg or {})
    return out


# ------------------------------------------------------------------------------------------- cameras

def load_cameras(colmap_dir: Path, transform: Dict[str, Any], dataparser: Optional[Dict[str, Any]] = None,
                 frame: Optional[str] = None, splat_xyz: Optional[np.ndarray] = None) -> Dict[str, Any]:
    """COLMAP cameras in the world frame. frame: the COLMAP->splat mapping S06 recorded (transform.json
    metrics.colmap_frame); else chosen from points3D like floor_paint.world_cameras."""
    from pipeline import normalize as nz
    from pipeline.stages.s03_poses import parse_cameras_txt
    colmap_dir = Path(colmap_dir)
    cams = parse_cameras_txt(colmap_dir / "cameras.txt")
    images = read_images_txt(colmap_dir / "images.txt")
    dp = dataparser or {"transform": np.eye(4)[:3].tolist(), "scale": 1.0}
    frame = frame or (transform.get("metrics") or {}).get("colmap_frame")
    ident = {"transform": np.eye(4)[:3].tolist(), "scale": 1.0}
    table = {"dataparser+flip": (dp, True), "dataparser": (dp, False), "flip_only": (ident, True), "colmap_raw": (ident, False)}
    if frame in table:
        t, s = nz.dataparser_matrix(*table[frame])
    else:
        from pipeline.stages.s03_poses import parse_points3D_txt
        pts = np.asarray([p["xyz"] for p in parse_points3D_txt(colmap_dir / "points3D.txt").values()])
        t, s, frame, _ = nz.choose_colmap_frame(dp, pts, splat_xyz)
    a = np.eye(4)
    a[:3, :4] = s * t
    wfs = np.array(transform["world_from_splat"], float).reshape(4, 4).T
    wc = wfs @ a
    k = float(np.cbrt(abs(np.linalg.det(wc[:3, :3]))))
    q = wc[:3, :3] / k
    if len(cams) != 1:
        raise ValueError("one shared COLMAP camera expected")
    cam = next(iter(cams.values()))
    p = cam["params"]
    if cam["model"] in ("SIMPLE_RADIAL", "SIMPLE_PINHOLE"):
        fx = fy = float(p[0]); cx, cy = float(p[1]), float(p[2]); k1 = float(p[3]) if len(p) > 3 else 0.0
    elif cam["model"] in ("PINHOLE", "OPENCV", "RADIAL"):
        fx, fy, cx, cy = map(float, p[:4]); k1 = float(p[4]) if len(p) > 4 else 0.0
    else:
        raise ValueError(f"camera model {cam['model']} not supported")
    out = {"frame": frame, "w": int(cam["width"]), "h": int(cam["height"]), "fx": fx, "fy": fy, "cx": cx, "cy": cy,
           "k1": k1, "cams": {}}
    for im in images.values():
        r = nz.qvec_to_rotmat(im["qvec"])
        tv = np.asarray(im["tvec"], float)
        out["cams"][im["name"]] = {"c": wc[:3, :3] @ (-r.T @ tv) + wc[:3, 3], "R": r @ q.T}
    return out


def read_images_txt(path: Path) -> Dict[int, Dict[str, Any]]:
    """COLMAP images.txt pose lines only. Tolerates empty POINTS2D lines (a poses-only copy), which the
    two-lines-per-image parser in s03_poses would pair up wrongly."""
    out: Dict[int, Dict[str, Any]] = {}
    expect_pose = True
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.startswith("#"):
            continue
        parts = line.split()
        if expect_pose:
            if len(parts) >= 10:
                try:
                    vals = [float(x) for x in parts[1:8]]
                except ValueError:
                    continue
                out[int(parts[0])] = {"qvec": vals[:4], "tvec": vals[4:7], "camera_id": int(parts[8]), "name": " ".join(parts[9:])}
                expect_pose = False
        else:
            expect_pose = True   # the POINTS2D line (possibly empty) that follows every pose line
    return out


def heldout_names(names: Sequence[str], every: int) -> List[str]:
    """Nerfstudio --eval-mode interval: images sorted by name, index % every == 0 are the eval images."""
    s = sorted(names)
    return [n for i, n in enumerate(s) if i % every == 0]


# ------------------------------------------------------------------------------------------ renderer

@nb.njit(cache=True)
def _rast(order, px, py, ca, cb, cc, op, col, w, h, img, t_img, err, blame, mass):
    """floaters._rast plus, when err is given (size > 1), blame[i] += sum(weight * err), mass[i] += sum(weight)."""
    use_err = err.shape[0] > 1
    for ii in range(order.shape[0]):
        i = order[ii]
        a = ca[i]; b = cb[i]; c = cc[i]
        det = a * c - b * b
        if det <= 1e-12:
            continue
        ia = c / det; ib = -b / det; ic = a / det
        rx = 3.0 * math.sqrt(a); ry = 3.0 * math.sqrt(c)
        x0 = int(max(0, math.floor(px[i] - rx))); x1 = int(min(w - 1, math.ceil(px[i] + rx)))
        y0 = int(max(0, math.floor(py[i] - ry))); y1 = int(min(h - 1, math.ceil(py[i] + ry)))
        if x1 < x0 or y1 < y0:
            continue
        o = op[i]; s = 0.0; sb = 0.0
        for y in range(y0, y1 + 1):
            dy = y - py[i]
            for x in range(x0, x1 + 1):
                t = t_img[y, x]
                if t < 0.003:
                    continue
                dx = x - px[i]
                e = 0.5 * (ia * dx * dx + 2 * ib * dx * dy + ic * dy * dy)
                if e > 4.5:
                    continue
                al = o * math.exp(-e)
                if al < 0.004:
                    continue
                if al > 0.99:
                    al = 0.99
                wgt = t * al
                img[y, x, 0] += wgt * col[i, 0]; img[y, x, 1] += wgt * col[i, 1]; img[y, x, 2] += wgt * col[i, 2]
                t_img[y, x] = t * (1 - al)
                s += wgt
                if use_err:
                    sb += wgt * err[y, x]
        mass[i] += s
        blame[i] += sb


def project_cam(scene: fl.Scene, cam: Dict[str, Any], intr: Dict[str, float], idx: np.ndarray,
                crop: Tuple[int, int, int, int], near: float = 0.1):
    """Pinhole projection with the photo's intrinsics (already divided by render_div) into a crop (x0, y0, w, h)."""
    r = np.asarray(cam["R"], float)
    pc = (scene.w[idx] - np.asarray(cam["c"], float)) @ r.T
    z = pc[:, 2]
    ok = z > near
    idx, pc, z = idx[ok], pc[ok], z[ok]
    x0, y0, w, h = crop
    px = intr["fx"] * pc[:, 0] / z + intr["cx"] - x0
    py = intr["fy"] * pc[:, 1] / z + intr["cy"] - y0
    ok = (px > -w - 50) & (px < 2 * w + 50) & (py > -h - 50) & (py < 2 * h + 50)
    idx, pc, z, px, py = idx[ok], pc[ok], z[ok], px[ok], py[ok]
    cv = np.einsum("ij,njk,lk->nil", r, scene.cov[idx].astype(np.float64), r)
    j = np.zeros((len(idx), 2, 3))
    j[:, 0, 0] = intr["fx"] / z; j[:, 0, 2] = -intr["fx"] * pc[:, 0] / z ** 2
    j[:, 1, 1] = intr["fy"] / z; j[:, 1, 2] = -intr["fy"] * pc[:, 1] / z ** 2
    c2 = np.einsum("nij,njk,nlk->nil", j, cv, j)
    return idx, px, py, c2[:, 0, 0] + 0.3, c2[:, 0, 1], c2[:, 1, 1] + 0.3, z


def rasterize(scene: fl.Scene, proj, crop, sel: Optional[np.ndarray] = None, err: Optional[np.ndarray] = None):
    """Render already projected Gaussians (project_cam output), optionally only those where sel is True."""
    idx, px, py, ca, cb, cc, z = proj
    if sel is not None:
        idx, px, py, ca, cb, cc, z = (a[sel] for a in proj)
    order = np.argsort(z, kind="stable").astype(np.int64)
    cw, ch = crop[2], crop[3]
    img = np.zeros((ch, cw, 3), np.float32)
    t_img = np.ones((ch, cw), np.float32)
    bl = np.zeros(len(idx), np.float64)
    ms = np.zeros(len(idx), np.float64)
    e = err.astype(np.float32) if err is not None else np.zeros((1, 1), np.float32)
    _rast(order, px, py, ca, cb, cc, scene.op[idx], scene.col[idx], cw, ch, img, t_img, e, bl, ms)
    return img, 1 - t_img, idx, bl, ms, z


def render_cam(scene: fl.Scene, cam, intr, size: Tuple[int, int], keep: Optional[np.ndarray] = None,
               crop: Optional[Tuple[int, int, int, int]] = None, err: Optional[np.ndarray] = None,
               blame: Optional[np.ndarray] = None, mass: Optional[np.ndarray] = None, min_depth: float = 0.0):
    w, h = size
    crop = crop or (0, 0, w, h)
    idx = np.flatnonzero(keep) if keep is not None else np.arange(len(scene))
    img, a, idx, bl, ms, z = rasterize(scene, project_cam(scene, cam, intr, idx, crop), crop, err=err)
    if min_depth > 0:
        near = z < min_depth
        bl[near] = 0.0; ms[near] = 0.0
    if blame is not None:
        blame[idx] += bl
    if mass is not None:
        mass[idx] += ms
    return img, a, idx, bl, ms


# --------------------------------------------------------------------------------------- photo match

def load_photo(path: Path, cams: Dict[str, Any], size: Tuple[int, int], div: int, blur: float) -> np.ndarray:
    """The photo resampled onto the render's pinhole grid (radial distortion applied), blurred."""
    import cv2
    bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if bgr is None:
        raise FileNotFoundError(path)
    im = bgr[:, :, ::-1].astype(np.float32) / 255.0
    sx = im.shape[1] / cams["w"]
    w, h = size
    u, v = np.meshgrid((np.arange(w) + 0.5) * div, (np.arange(h) + 0.5) * div)
    x = (u - cams["cx"]) / cams["fx"]; y = (v - cams["cy"]) / cams["fy"]
    d = 1 + cams["k1"] * (x * x + y * y)
    pu = (cams["fx"] * x * d + cams["cx"]) * sx - 0.5
    pv = (cams["fy"] * y * d + cams["cy"]) * sx - 0.5
    sig = max(0.0, div * sx / 2.0 - 0.5)
    if sig > 0:
        im = ndi.gaussian_filter(im, (sig, sig, 0))
    out = np.stack([ndi.map_coordinates(im[..., k], [pv, pu], order=1, mode="nearest") for k in range(3)], -1)
    return ndi.gaussian_filter(out, (blur, blur, 0)) if blur > 0 else out


def colour_match(rgb: np.ndarray, alpha: np.ndarray, photo: np.ndarray, iters: int = 3) -> np.ndarray:
    """4x3 matrix M so that [rgb, alpha] @ M ~ photo, fitted on solid pixels, worst 25% dropped each round."""
    m = (alpha > 0.95).ravel()
    a = np.concatenate([rgb.reshape(-1, 3), alpha.reshape(-1, 1)], 1)[m]
    b = photo.reshape(-1, 3)[m]
    if len(a) > 40000:
        sel = np.random.default_rng(0).choice(len(a), 40000, replace=False)
        a, b = a[sel], b[sel]
    M0 = np.vstack([np.eye(3), np.zeros((1, 3))]).astype(np.float64)
    M = M0
    for _ in range(iters):
        if len(a) < 200:
            break
        # ridge pull towards "no change" keeps M sane when a view shows only a few colours
        lam = 0.02 * len(a)
        M = np.linalg.solve(a.T @ a + lam * np.eye(4), a.T @ b + lam * M0)
        r = np.abs(a @ M - b).sum(1)
        keep = r <= np.quantile(r, 0.75)
        a, b = a[keep], b[keep]
    return M


def apply_match(rgb: np.ndarray, alpha: np.ndarray, M: np.ndarray) -> np.ndarray:
    return np.clip(rgb @ M[:3] + alpha[..., None] * M[3], 0, 1)


def error_image(matched: np.ndarray, photo: np.ndarray, blur: float, floor: float, shift_px: int = 1) -> np.ndarray:
    """Per-pixel colour error, shift tolerant: the render only counts as wrong where it is outside the range of
    the photo's colours within shift_px (a sub-pixel pose error moves edges; a blob or haze is wrong everywhere)."""
    r = ndi.gaussian_filter(matched, (blur, blur, 0)) if blur > 0 else matched
    if shift_px > 0:
        k = (2 * shift_px + 1, 2 * shift_px + 1, 1)
        hi = ndi.maximum_filter(photo, k); lo = ndi.minimum_filter(photo, k)
        e = (np.maximum(r - hi, 0) + np.maximum(lo - r, 0)).mean(-1)
    else:
        e = np.abs(r - photo).mean(-1)
    return np.maximum(e - floor, 0.0).astype(np.float32)


# ------------------------------------------------------------------------------------------- workers

_G: Dict[str, Any] = {}


def _judge_view(name: str):
    g = _G
    cams, cfg, scene = g["cams"], g["cfg"], g["scene"]
    div = int(cfg["render_div"])
    size = (cams["w"] // div, cams["h"] // div)
    intr = g["intr"]
    cam = cams["cams"][name]
    photo = load_photo(g["frames"] / name, cams, size, div, float(cfg["blur_px"]))
    rgb, alpha, _, _, _ = render_cam(scene, cam, intr, size, keep=g["keep"])
    M = colour_match(rgb, alpha, photo)
    err = error_image(apply_match(rgb, alpha, M), photo, float(cfg["blur_px"]), float(cfg["err_floor"]))
    _, _, idx, bl, ms = render_cam(scene, cam, intr, size, keep=g["keep"], err=err, min_depth=float(cfg["min_depth_m"]))
    seen = ms > 1e-3
    big = bl > 0.05
    return (name, M, float(err.mean()), idx[big].astype(np.int32), bl[big].astype(np.float32),
            idx[seen].astype(np.int32), bl[seen].astype(np.float32), ms[seen].astype(np.float32))


def _init(scene, cams, intr, frames, cfg, keep):
    _G.update(scene=scene, cams=cams, intr=intr, frames=Path(frames), cfg=cfg, keep=keep)


def pool_imap(fn, items, workers: int, init_args):
    _init(*init_args)   # forked children inherit _G
    if workers <= 1:
        for x in items:
            yield fn(x)
        return
    with mp.get_context("fork").Pool(workers) as pool:
        yield from pool.imap_unordered(fn, items, chunksize=1)


def pool_map(fn, items, workers: int, init_args):
    return list(pool_imap(fn, items, workers, init_args))


# ------------------------------------------------------------------------------------------ clusters

def clusters_of(w: np.ndarray, sel: np.ndarray, voxel: float) -> np.ndarray:
    """Label (>=1) per selected Gaussian: 26-connected 5 cm voxels; 0 for unselected."""
    lab = np.zeros(len(w), np.int32)
    idx = np.flatnonzero(sel)
    if not len(idx):
        return lab
    v = np.floor(w[idx] / voxel).astype(np.int64)
    lo = v.min(0)
    v -= lo
    dims = v.max(0) + 1
    if np.prod(dims) > 4e8:
        raise ValueError("suspects spread too far for the voxel grid")
    grid = np.zeros(tuple(dims), bool)
    grid[v[:, 0], v[:, 1], v[:, 2]] = True
    lg, _ = ndi.label(grid, structure=np.ones((3, 3, 3), bool))
    lab[idx] = lg[v[:, 0], v[:, 1], v[:, 2]]
    return lab


def footprint(scene: fl.Scene, cam, intr, size, members: np.ndarray, margin: int):
    """Crop box (x0, y0, w, h) around the cluster's 3-sigma footprint in a photo, or None if not in view."""
    w, h = size
    idx, px, py, ca, _, cc, _ = project_cam(scene, cam, intr, members, (0, 0, w, h))
    if not len(idx):
        return None
    rx = 3 * np.sqrt(ca); ry = 3 * np.sqrt(cc)
    x0 = int(max(0, np.floor((px - rx).min()) - margin)); x1 = int(min(w, np.ceil((px + rx).max()) + margin))
    y0 = int(max(0, np.floor((py - ry).min()) - margin)); y1 = int(min(h, np.ceil((py + ry).max()) + margin))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    return x0, y0, x1 - x0, y1 - y0


def _test_cluster(args):
    """Photo error and holes in the cluster's footprint, with and without it, over its test photos."""
    cid, members, views = args
    g = _G
    cams, cfg, scene, keep = g["cams"], g["cfg"], g["scene"], g["keep"]
    div = int(cfg["render_div"])
    size = (cams["w"] // div, cams["h"] // div)
    without = keep.copy()
    without[members] = False
    e0 = e1 = 0.0
    holes = solid = 0
    used = []
    for name in views:
        cam = cams["cams"][name]
        crop = footprint(scene, cam, g["intr"], size, members, int(cfg["crop_margin_px"]))
        if crop is None:
            continue
        x0, y0, cw, ch = crop
        photo = g["photos"][name][y0:y0 + ch, x0:x0 + cw]
        M = g["M"][name]
        proj = project_cam(scene, cam, g["intr"], np.flatnonzero(keep), crop)
        r0, a0, *_ = rasterize(scene, proj, crop)
        r1, a1, *_ = rasterize(scene, proj, crop, sel=without[proj[0]])
        bl, fl_ = float(cfg["blur_px"]), float(cfg["err_floor"])
        d0 = error_image(apply_match(r0, a0, M), photo, bl, fl_)
        d1 = error_image(apply_match(r1, a1, M), photo, bl, fl_)
        e0 += float(d0.sum()); e1 += float(d1.sum())
        solid += int((a0 > 0.97).sum()); holes += int(((a0 > 0.97) & (a1 < 0.9)).sum())
        used.append(name)
    gain = (e0 - e1) / e0 if e0 > 0 else 0.0
    hole_pct = 100.0 * holes / max(solid, 1)
    return cid, gain, hole_pct, e0, e1, used


# --------------------------------------------------------------------------------------------- judge

def judge(scene: fl.Scene, cams: Dict[str, Any], frames: Path, cfg: Optional[Dict[str, Any]] = None,
          keep: Optional[np.ndarray] = None, log=print) -> Tuple[np.ndarray, Dict[str, Any], np.ndarray]:
    """Returns (keep mask, report, cluster label per Gaussian)."""
    cfg = merged_config(cfg)
    t0 = time.time()
    n = len(scene)
    keep = np.ones(n, bool) if keep is None else keep.copy()
    frames = Path(frames)
    div = int(cfg["render_div"])
    size = (cams["w"] // div, cams["h"] // div)
    intr = {"fx": cams["fx"] / div, "fy": cams["fy"] / div, "cx": cams["cx"] / div, "cy": cams["cy"] / div}
    names = heldout_names(list(cams["cams"]), int(cfg["holdout_every"]))
    names = [x for x in names if (frames / x).exists()]
    if len(names) > int(cfg["max_photos"]):
        names = [names[i] for i in np.linspace(0, len(names) - 1, int(cfg["max_photos"])).round().astype(int)]
    if not names:
        raise FileNotFoundError(f"no held-out photos found in {frames}")
    workers = int(cfg["workers"]) or max(1, (os.cpu_count() or 2))
    log(f"[autofix] {n} Gaussians, {len(names)} held-out photos at {size[0]}x{size[1]}, {workers} workers")

    init = (scene, cams, intr, frames, cfg, keep)
    blame = np.zeros(n); mass = np.zeros(n)
    per_view: Dict[str, Tuple[np.ndarray, np.ndarray]] = {}
    Ms: Dict[str, np.ndarray] = {}
    view_err: Dict[str, float] = {}
    for k, (name, M, e, bi, bv, si, sb, sm) in enumerate(pool_imap(_judge_view, names, workers, init)):
        np.add.at(blame, si, sb); np.add.at(mass, si, sm)
        per_view[name] = (bi, bv); Ms[name] = M; view_err[name] = e
        if (k + 1) % 25 == 0:
            log(f"[autofix]   {k + 1}/{len(names)} photos, {time.time() - t0:.0f} s")
    t1 = time.time()
    avg = np.where(mass > 0, blame / np.maximum(mass, 1e-9), 0.0)
    seen = keep & (mass >= float(cfg["min_mass_px"]))
    thr = max(float(cfg["blame_min"]), float(np.percentile(avg[seen], float(cfg["blame_pct"])))) if seen.any() else 1e9
    sus = seen & (avg >= thr)
    lab = clusters_of(scene.w, sus, float(cfg["voxel_m"]))
    ids, counts = np.unique(lab[lab > 0], return_counts=True)
    cl_blame = ndi.sum(blame, lab, ids) if len(ids) else np.array([])
    order = np.argsort(-cl_blame)
    order = [k for k in order if counts[k] >= int(cfg["min_cluster"])][: int(cfg["max_clusters"])]
    log(f"[autofix] judged in {t1 - t0:.0f} s; blame threshold {thr:.3f}; {int(sus.sum())} suspects in "
        f"{len(ids)} clusters, testing {len(order)}")

    # test photos per cluster: where its members collected the most blame
    members = {int(ids[k]): np.flatnonzero(lab == ids[k]) for k in order}
    owner = np.zeros(n, np.int32)
    for cid, mem in members.items():
        owner[mem] = cid
    view_score: Dict[int, Dict[str, float]] = {cid: {} for cid in members}
    for name, (bi, bv) in per_view.items():
        o = owner[bi]
        hit = o > 0
        if hit.any():
            s = np.bincount(o[hit], weights=bv[hit])
            for cid in np.flatnonzero(s):
                view_score[int(cid)][name] = float(s[cid])
    tests = []
    for cid in members:
        vs = sorted(view_score[cid].items(), key=lambda kv: -kv[1])[: int(cfg["test_views"])]
        tests.append((cid, members[cid], [v for v, _ in vs]))
    need = sorted({v for _, _, vs in tests for v in vs})
    photos = {v: load_photo(frames / v, cams, size, div, float(cfg["blur_px"])) for v in need}
    _G.update(photos=photos, M=Ms)

    # every cluster tested against the same starting model (independent), in parallel
    out = pool_map(_test_cluster, tests, workers, init) if tests else []
    _G.update(photos=photos, M=Ms)
    report_cl = []
    removed = np.zeros(n, bool)
    for cid, gain, hole_pct, e0, e1, used in out:
        mem = members[cid]
        ok = (gain >= float(cfg["accept_gain"]) and (e0 - e1) >= float(cfg["min_gain"])
              and hole_pct <= float(cfg["max_hole_pct"]) and len(used) > 0)
        if ok:
            removed[mem] = True
        report_cl.append({
            "id": int(cid), "gaussians": int(len(mem)), "removed": bool(ok),
            "why": ("photos match better without it" if ok else
                    "no test photo" if not used else
                    f"hole {hole_pct:.1f}%" if hole_pct > float(cfg["max_hole_pct"]) else
                    "too small to see" if gain >= float(cfg["accept_gain"]) else
                    "photos do not match better without it"),
            "gain_pct": round(100 * gain, 1), "fixed_error": round(e0 - e1, 2), "hole_pct": round(hole_pct, 2),
            "min": np.round(scene.w[mem].min(0), 3).tolist(), "max": np.round(scene.w[mem].max(0), 3).tolist(),
            "centre": np.round(np.median(scene.w[mem], 0), 3).tolist(),
            "avg_blame": round(float(avg[mem].mean()), 3), "opacity_median": round(float(np.median(scene.op[mem])), 3),
            "size_median_m": round(float(np.median(scene.sc[mem].max(1))), 4),
            "colour_median": np.round(np.median(scene.col[mem], 0), 3).tolist(),
            "test_photos": used,
        })
    report_cl.sort(key=lambda c: -c["gain_pct"])
    keep_out = keep & ~removed
    t2 = time.time()
    report = {
        "gaussians_in": n, "photos": len(names), "render_size": list(size), "blame_threshold": round(thr, 4),
        "suspects": int(sus.sum()), "clusters_found": int(len(ids)), "clusters_tested": len(order),
        "clusters_removed": int(sum(c["removed"] for c in report_cl)), "gaussians_removed": int(removed.sum()),
        "photo_error_mean": round(float(np.mean(list(view_err.values()))), 5),
        "seconds": {"judge": round(t1 - t0), "test": round(t2 - t1)},
        "photo_names": names, "config": cfg, "clusters": report_cl,
    }
    _G["last_avg"], _G["last_mass"] = avg.astype(np.float32), mass.astype(np.float32)
    log(f"[autofix] removed {report['clusters_removed']} of {len(order)} clusters "
        f"({report['gaussians_removed']} Gaussians) in {t2 - t0:.0f} s")
    return keep_out, report, lab


# ------------------------------------------------------------------------------------- unseen (stage 2)
#
# What the photos never really saw. A Gaussian can match every photo and still be junk: a thin sheet of haze
# seen edge-on from wherever the phone was looks like a milky wall from a spot the phone never stood. For every
# Gaussian: its largest visible area (m2, distance-free: weight x depth^2 / focal^2) in ANY photo (training and
# held-out) vs in the walk-through views (floater filter viewpoints). Much larger from the walk-through than any
# photo ever showed = not reconstructed from the photos. Clusters of those go, unless removal opens a hole
# in a walk-through view or makes a held-out photo match worse.

def _area_view(args):
    """Per-Gaussian visible area (m2) in one view: (idx, area)."""
    cam, intr, size = args
    g = _G
    img, a, idx, bl, ms, z = rasterize(g["scene"], project_cam(g["scene"], cam, intr, np.flatnonzero(g["keep"]),
                                                              (0, 0, size[0], size[1])), (0, 0, size[0], size[1]))
    area = ms * (z / intr["fx"]) ** 2
    big = area > 1e-6
    return idx[big].astype(np.int32), area[big].astype(np.float32)


def walk_cams(grid: Dict[str, Any], room_height_m: float, step_m: float, heights: Sequence[float], px: int):
    views = fl.viewpoints(grid, step_m, tuple(fl.room_heights(heights, room_height_m)))
    f = px / 2.0   # 90 degree field of view
    intr = {"fx": f, "fy": f, "cx": px / 2.0, "cy": px / 2.0}
    return [({"c": np.asarray(e, float), "R": fl.camera(e, t)}, intr, (px, px)) for e, t in views]


def _test_unseen(args):
    cid, members, wviews = args
    g = _G
    scene, keep = g["scene"], g["keep"]
    without = keep.copy(); without[members] = False
    holes = solid = 0
    for cam, intr, size in wviews:
        crop = footprint(scene, cam, intr, size, members, 4)
        if crop is None:
            continue
        proj = project_cam(scene, cam, intr, np.flatnonzero(keep), crop)
        _, a0, *_ = rasterize(scene, proj, crop)
        _, a1, *_ = rasterize(scene, proj, crop, sel=without[proj[0]])
        solid += int((a0 > 0.97).sum()); holes += int(((a0 > 0.97) & (a1 < 0.9)).sum())
    return cid, 100.0 * holes / max(solid, 1)


UNSEEN_DEFAULTS: Dict[str, Any] = {
    "ratio": 8.0,              # walk-through area / best photo area above this = never really seen
    "min_walk_area_m2": 4e-4,  # and at least 2 x 2 cm visible somewhere in the walk-through
    "view_step_m": 0.6, "heights_m": [0.6, 1.5, 2.3], "render_px": 256,
    "test_views": 6, "max_hole_pct": 0.5, "max_photo_worse_pct": 2.0, "min_cluster": 8, "max_clusters": 600,
}


def unseen(scene: fl.Scene, cams: Dict[str, Any], frames: Path, grid: Dict[str, Any], room_height_m: float,
           keep: np.ndarray, judge_cfg: Dict[str, Any], log=print) -> Tuple[np.ndarray, List[Dict[str, Any]], np.ndarray]:
    cfg = dict(UNSEEN_DEFAULTS)
    jc = merged_config(judge_cfg)
    t0 = time.time()
    n = len(scene)
    div = int(jc["render_div"])
    size = (cams["w"] // div, cams["h"] // div)
    intr = {"fx": cams["fx"] / div, "fy": cams["fy"] / div, "cx": cams["cx"] / div, "cy": cams["cy"] / div}
    photos = sorted(x for x in cams["cams"] if (Path(frames) / x).exists())
    workers = int(jc["workers"]) or max(1, os.cpu_count() or 2)
    init = (scene, cams, intr, frames, jc, keep)
    a_photo = np.zeros(n, np.float32)
    for idx, area in pool_imap(_area_view, [(cams["cams"][x], intr, size) for x in photos], workers, init):
        np.maximum.at(a_photo, idx, area)
    wv = walk_cams(grid, room_height_m, float(cfg["view_step_m"]), cfg["heights_m"], int(cfg["render_px"]))
    a_walk = np.zeros(n, np.float32)
    best_view = np.full(n, -1, np.int32)
    per_walk = []
    for k, (idx, area) in enumerate(pool_map(_area_view, wv, workers, init)):
        better = area > a_walk[idx]
        a_walk[idx[better]] = area[better]
        per_walk.append((idx, area))
    t1 = time.time()
    ratio = a_walk / np.maximum(a_photo, 1e-7)
    sus = keep & (a_walk >= float(cfg["min_walk_area_m2"])) & (ratio >= float(cfg["ratio"]))
    lab = clusters_of(scene.w, sus, float(jc["voxel_m"]))
    ids, counts = np.unique(lab[lab > 0], return_counts=True)
    w_area = ndi.sum(a_walk, lab, ids) if len(ids) else np.array([])
    order = [k for k in np.argsort(-w_area) if counts[k] >= int(cfg["min_cluster"])][: int(cfg["max_clusters"])]
    members = {int(ids[k]): np.flatnonzero(lab == ids[k]) for k in order}
    owner = np.zeros(n, np.int32)
    for cid, mem in members.items():
        owner[mem] = cid
    score: Dict[int, Dict[int, float]] = {cid: {} for cid in members}
    for vi, (idx, area) in enumerate(per_walk):
        o = owner[idx]; hit = o > 0
        if hit.any():
            sc = np.bincount(o[hit], weights=area[hit])
            for cid in np.flatnonzero(sc):
                score[int(cid)][vi] = float(sc[cid])
    tests = [(cid, members[cid], [wv[v] for v, _ in sorted(score[cid].items(), key=lambda kv: -kv[1])[: int(cfg["test_views"])]])
             for cid in members]
    log(f"[autofix] unseen: {len(photos)} photos + {len(wv)} walk-through views in {t1 - t0:.0f} s; "
        f"{int(sus.sum())} suspects in {len(ids)} clusters, testing {len(order)}")
    res = pool_map(_test_unseen, tests, workers, init) if tests else []
    removed = np.zeros(n, bool)
    rows = []
    for cid, hole in res:
        mem = members[cid]
        ok = hole <= float(cfg["max_hole_pct"])
        if ok:
            removed[mem] = True
        rows.append({"id": int(cid), "stage": "unseen", "gaussians": int(len(mem)), "removed": bool(ok),
                     "why": "never seen this way by any photo" if ok else f"hole {hole:.1f}% in a walk-through view",
                     "hole_pct": round(hole, 2), "walk_area_m2": round(float(a_walk[mem].sum()), 4),
                     "ratio_median": round(float(np.median(ratio[mem])), 1),
                     "min": np.round(scene.w[mem].min(0), 3).tolist(), "max": np.round(scene.w[mem].max(0), 3).tolist(),
                     "centre": np.round(np.median(scene.w[mem], 0), 3).tolist(),
                     "opacity_median": round(float(np.median(scene.op[mem])), 3),
                     "size_median_m": round(float(np.median(scene.sc[mem].max(1))), 4),
                     "colour_median": np.round(np.median(scene.col[mem], 0), 3).tolist(), "test_photos": []})
    rows.sort(key=lambda r: -r["walk_area_m2"])
    log(f"[autofix] unseen: removed {int(sum(r['removed'] for r in rows))} of {len(rows)} clusters "
        f"({int(removed.sum())} Gaussians) in {time.time() - t0:.0f} s")
    _G["last_area"] = (a_photo, a_walk)
    return keep & ~removed, rows, lab


# --------------------------------------------------------------------------------------------- sheet

def sheet(scene: fl.Scene, cams, frames: Path, keep_before: np.ndarray, keep_after: np.ndarray, report: Dict[str, Any],
          out_png: Path, cfg: Optional[Dict[str, Any]] = None, max_rows: int = 12) -> None:
    """One picture: per removed cluster (biggest gain first) its best photo crop: photo | before | after."""
    from PIL import Image, ImageDraw
    cfg = merged_config(cfg if cfg is not None else report.get("config"))
    div = int(cfg["render_div"])
    size = (cams["w"] // div, cams["h"] // div)
    intr = {"fx": cams["fx"] / div, "fy": cams["fy"] / div, "cx": cams["cx"] / div, "cy": cams["cy"] / div}
    rows = [c for c in report["clusters"] if c["removed"] and c["test_photos"]][:max_rows]
    tile = 220
    canvas = Image.new("RGB", (tile * 3 + 10, max(1, len(rows)) * (tile + 24) + 30), (20, 20, 24))
    d = ImageDraw.Draw(canvas)
    d.text((6, 6), "photo (held out)  |  model before  |  model after", fill=(230, 230, 230))
    for r_i, c in enumerate(rows):
        name = c["test_photos"][0]
        cam = cams["cams"][name]
        photo = load_photo(frames / name, cams, size, div, 0.0)
        r0, a0, *_ = render_cam(scene, cam, intr, size, keep=keep_before)
        r1, a1, *_ = render_cam(scene, cam, intr, size, keep=keep_after)
        M = colour_match(r0, a0, photo)
        mem = np.zeros(len(scene), bool)
        lo, hi = np.array(c["min"]), np.array(c["max"])
        mem_idx = np.flatnonzero(np.all((scene.w >= lo) & (scene.w <= hi), 1) & keep_before & ~keep_after)
        crop = footprint(scene, cam, intr, size, mem_idx, 30) if len(mem_idx) else None
        x0, y0, cw, ch = crop or (0, 0, size[0], size[1])
        side = max(cw, ch)
        cx, cy = x0 + cw // 2, y0 + ch // 2
        x0 = int(np.clip(cx - side // 2, 0, max(0, size[0] - side))); y0 = int(np.clip(cy - side // 2, 0, max(0, size[1] - side)))
        imgs = [photo, apply_match(r0, a0, M), apply_match(r1, a1, M)]
        y = 30 + r_i * (tile + 24)
        for k, im in enumerate(imgs):
            sub = (np.clip(im[y0:y0 + side, x0:x0 + side], 0, 1) * 255).astype(np.uint8)
            canvas.paste(Image.fromarray(sub).resize((tile, tile)), (k * (tile + 5), y))
        d.text((4, y + tile + 4), f"#{c['id']}  better by {c['gain_pct']}%  {c['gaussians']} Gaussians  "
                                   f"centre {c['centre']}", fill=(230, 230, 230))
    canvas.save(out_png)


# --------------------------------------------------------------------------------------------- verify

def _verify_view(v):
    g = _G
    (eye, target) = v
    out = []
    for keep in (g["before"], g["after"]):
        img, a = fl.render(g["scene"], eye, target, (g["px"], g["px"]), 90.0, mask=keep)
        out.append((img, a, None))
    return out


def verify(scene: fl.Scene, before: np.ndarray, after: np.ndarray, grid: Dict[str, Any], room_height_m: float,
           step_m: float = 0.6, heights: Sequence[float] = (0.6, 1.5, 2.3), px: int = 256, workers: int = 0,
           max_hole_pct: float = 0.05, max_changed_pct: float = 5.0) -> Dict[str, Any]:
    """The floater filter's checks on the result: every walk-through viewpoint (cube faces at three heights)
    before vs after, holes and changed pixels per view; plus the walk-band occupancy the walkable grid is
    built from, so grid and tag paths stay as published."""
    from pipeline import grid as navgrid
    hs = fl.room_heights(heights, room_height_m)
    views = fl.viewpoints(grid, step_m, tuple(hs))
    _G.update(scene=scene, before=before, after=after, px=px)
    workers = workers or max(1, os.cpu_count() or 2)
    if workers > 1:
        with mp.get_context("fork").Pool(workers) as pool:
            pairs = pool.map(_verify_view, views, chunksize=4)
    else:
        pairs = [_verify_view(v) for v in views]
    res = fl.compare([p[0] for p in pairs], [p[1] for p in pairs], max_hole_pct, max_changed_pct)
    res = {k: v for k, v in res.items() if not k.startswith("per_view")}
    cell = float(grid["cell_m"]); o = tuple(grid["origin"]); w, h = int(grid["width"]), int(grid["height"])
    occ = []
    for keep in (before, after):
        c = navgrid.occupancy_counts(scene.w[keep], scene.op[keep], o, w, h, cell, (0.2, 1.7), 0.2)
        occ.append(c >= 6.0)
    # Removal can only free cells. A cluster the held-out photos disprove that blocked a cell was a fake obstacle,
    # so freed cells don't fail the check: the caller rebuilds the grid (rebuild_grid) and reports them.
    res["walk_band_cells_differing"] = int((occ[0] != occ[1]).sum())
    res["passed"] = bool(res["passed"])
    return res


def put_back_failures(scene: fl.Scene, before: np.ndarray, after: np.ndarray, labels: np.ndarray, grid: Dict[str, Any],
                      room_height_m: float, result: Dict[str, Any], step_m: float = 0.6,
                      heights: Sequence[float] = (0.6, 1.5, 2.3), px: int = 256, max_hole_pct: float = 0.05,
                      max_changed_pct: float = 5.0) -> Tuple[np.ndarray, List[int]]:
    """Clusters whose own removal fails a failing view (hole or too much change; if none does alone, every
    cluster seen in that view) go back whole. The caller re-runs verify on the result. Returns (new keep,
    cluster ids put back)."""
    removed = before & ~after
    back: set = set()
    views = fl.viewpoints(grid, step_m, tuple(fl.room_heights(heights, room_height_m)))
    for vi in result.get("views_failing", []):
        eye, target = views[vi]
        ctr = np.zeros(len(scene), np.float32)
        fl.render(scene, eye, target, (px, px), 90.0, mask=before, contrib=ctr)
        seen = removed & (ctr > 0.5)
        cands = [int(c) for c in np.unique(labels[seen]) if c > 0]
        ref = (*fl.render(scene, eye, target, (px, px), 90.0, mask=before), None)
        guilty = []
        for cid in cands:   # only the clusters whose own removal fails this view go back
            alone = before & ~(removed & (labels == cid))
            got = (*fl.render(scene, eye, target, (px, px), 90.0, mask=alone), None)
            if not fl.compare([ref], [got], max_hole_pct, max_changed_pct)["passed"]:
                guilty.append(cid)
        back |= set(guilty or cands)   # no single culprit: the whole view's clusters go back
    back.discard(0)
    keep = after.copy()
    for cid in back:
        keep |= labels == cid
    return keep, sorted(int(c) for c in back)


def rebuild_grid(scene: fl.Scene, before: np.ndarray, after: np.ndarray, grid: Dict[str, Any],
                 metrics: Dict[str, Any], room_height_m: float) -> Tuple[Dict[str, Any], Dict[str, int]]:
    """The walkable grid after removal. Both versions are rebuilt with the grid code on the same cells and only
    the difference is applied to the published grid, so a cell can only become free (walk band) or empty (flying
    layers), never blocked, and settings the room was built with carry over. Returns (grid doc, cells changed)."""
    from pipeline import grid as navgrid
    cell, w, h = float(grid["cell_m"]), int(grid["width"]), int(grid["height"])
    r = float(grid.get("agent_radius_m", 0.25))
    o = grid["origin"]
    b = metrics.get("bounds_xz") or {"minX": o[0] + r, "minZ": o[1] + r,
                                      "maxX": o[0] + w * cell - r, "maxZ": o[1] + h * cell - r}
    start = tuple(metrics.get("grid_start_xz") or ((b["minX"] + b["maxX"]) / 2, (b["minZ"] + b["maxZ"]) / 2))
    cfg = {"cell_m": cell, "agent_radius_m": r}
    free = []
    for keep in (before, after):
        f, meta = navgrid.build_free_mask(scene.w[keep], scene.op[keep], b, start, cfg)
        free.append(f)
    out = dict(grid)
    old = navgrid.decode_free_bits(grid["free_bits_b64"], w, h)
    changed = {"walk_cells_freed": 0, "layer_cells_emptied": 0}
    if free[0].shape == old.shape:
        new = old | (free[1] & ~free[0])
        changed["walk_cells_freed"] = int((new & ~old).sum())
        out["free_bits_b64"] = navgrid.encode_free_bits(new)
    if grid.get("layers"):
        lay = grid["layers"]
        lcfg = navgrid.layers_for_room({"y0_m": lay["y0_m"], "dy_m": lay["dy_m"],
                                        "top_m": lay["y0_m"] + lay["count"] * lay["dy_m"]}, room_height_m)
        occ = [navgrid.build_layers(scene.w[k], scene.op[k], meta, b, lcfg)[0] for k in (before, after)]
        old_l = fl.decode_bits(lay["occupied_bits_b64"], lay["count"] * w * h).reshape(lay["count"], h, w)
        if occ[0].shape == old_l.shape:
            new_l = old_l & ~(occ[0] & ~occ[1])
            changed["layer_cells_emptied"] = int((old_l & ~new_l).sum())
            out["layers"] = dict(lay, occupied_bits_b64=navgrid.encode_free_bits(new_l))
    return out, changed


# ---------------------------------------------------------------------------------------------- CLI

def load_scene(ply: Path, transform: Dict[str, Any]):
    data, names = fl.read_ply(Path(ply))
    wfs = np.array(transform["world_from_splat"], float).reshape(4, 4).T
    return data, names, fl.Scene.from_splat(data, names, wfs)


def splat_xyz(data: np.ndarray, names: Sequence[str], min_opacity: float = 0.5) -> np.ndarray:
    """Splat-frame centres of the solid Gaussians (to choose the COLMAP->splat frame from points3D)."""
    ix = {k: i for i, k in enumerate(names)}
    op = 1 / (1 + np.exp(-data[:, ix["opacity"]]))
    return np.asarray(data[:, [ix["x"], ix["y"], ix["z"]]], np.float64)[op >= min_opacity]


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    j = sub.add_parser("judge")
    j.add_argument("--ply", required=True, type=Path)
    j.add_argument("--transform", required=True, type=Path, help="transform.json or manifest.json (world_from_splat)")
    j.add_argument("--colmap", required=True, type=Path)
    j.add_argument("--dataparser", type=Path)
    j.add_argument("--frame", help="COLMAP->splat frame (default: from transform.json metrics, else from points3D)")
    j.add_argument("--frames", required=True, type=Path)
    j.add_argument("--out", required=True, type=Path)
    j.add_argument("--workers", type=int, default=0, help="CPU processes (0 = all cores); the only setting: every "
                   "threshold is fixed so each room gets the same automatic clean-up")
    j.add_argument("--grid", type=Path, help="grid.json: walk-through check (holes, changed pixels); writes a rebuilt "
                   "grid.json to --out when removals free walkable cells; "
                   "clusters in a failing view go back whole")
    j.add_argument("--no-sheet", action="store_true")
    r = sub.add_parser("restore")
    r.add_argument("--work", required=True, type=Path)
    r.add_argument("--ply", required=True, type=Path)
    r.add_argument("--ids", default="", help="cluster ids to put back, comma separated")
    r.add_argument("--out", required=True, type=Path)
    a = ap.parse_args(argv)


    if a.cmd == "restore":
        keep = np.load(a.work / "keep.npy")
        lab = np.load(a.work / "labels.npy")
        for s in filter(None, a.ids.split(",")):
            keep |= lab == int(s)
        data, _ = fl.read_ply(a.ply)
        fl.write_ply(a.ply, a.out, data, keep)
        print(f"[autofix] wrote {a.out}: {int(keep.sum())} of {len(keep)} Gaussians")
        return 0

    cfg: Dict[str, Any] = {"workers": a.workers}
    tr = json.loads(a.transform.read_text())
    tr = tr.get("transform", tr) if "world_from_splat" not in tr else tr
    a.out.mkdir(parents=True, exist_ok=True)
    data, names, scene = load_scene(a.ply, tr)
    dp = json.loads(a.dataparser.read_text()) if a.dataparser else None
    cams = load_cameras(a.colmap, tr, dp, a.frame, splat_xyz(data, names))
    print(f"[autofix] cameras: {len(cams['cams'])} ({cams['frame']}), {cams['w']}x{cams['h']}")
    keep, report, lab = judge(scene, cams, a.frames, cfg)
    if a.grid:
        grid = json.loads(a.grid.read_text())
        h = fl.estimate_room_height(scene)
        before = np.ones(len(scene), bool)
        res = verify(scene, before, keep, grid, h, workers=a.workers)
        back: List[int] = []
        if not res["passed"]:
            keep, back = put_back_failures(scene, before, keep, lab, grid, h, res)
            res = verify(scene, before, keep, grid, h, workers=a.workers)
        if not res["passed"]:
            keep = before.copy()   # never a partly checked result
        for c in report["clusters"]:
            if c["id"] in back:
                c["removed"] = False; c["why"] = "put back: walk-through check"
        report["verify"] = res; report["put_back"] = back
        report["gaussians_removed"] = int((~keep).sum())
        if res["passed"] and res["walk_band_cells_differing"]:
            new_grid, changed = rebuild_grid(scene, before, keep, grid, tr.get("metrics", {}), h)
            (a.out / "grid.json").write_text(json.dumps(new_grid))
            report["grid_rebuilt"] = changed
            print(f"[autofix] walkable grid rebuilt ({a.out / 'grid.json'}): {changed['walk_cells_freed']} walk cells "
                  f"freed, {changed['layer_cells_emptied']} flying-layer cells emptied; re-check tag paths before publishing")
        print(f"[autofix] walk-through check {'PASS' if res['passed'] else 'FAIL (nothing removed)'}: worst hole "
              f"{res['hole_pct_max']}%, worst changed {res['changed_pct_max']}%, walk-band cells changed "
              f"{res['walk_band_cells_differing']}; {len(back)} clusters put back")
    np.save(a.out / "keep.npy", keep)
    np.save(a.out / "labels.npy", lab)
    np.savez_compressed(a.out / "blame.npz", avg=_G["last_avg"], mass=_G["last_mass"])
    (a.out / "clusters.json").write_text(json.dumps(report, indent=1))
    fl.write_ply(a.ply, a.out / "fixed.ply", data, keep)
    if not a.no_sheet:
        sheet(scene, cams, a.frames, np.ones(len(scene), bool), keep, report, a.out / "sheet.png", cfg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
