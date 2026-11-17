"""
Namma Space: automatic floater filter for a normalized splat (world frame: metres, +Y up, floor y=0).

Why not a position crop: walls, floor and ceiling are drawn by large flat Gaussians whose centres sit
outside the room box, so cutting by position opens black holes. Here every rule only proposes
candidates; a candidate is removed only if the room still looks solid without it from every viewpoint.

  1. Stage A (structure): centre far outside the room box, oversized. Render every viewpoint without
     them. A candidate's "hole fill score" is the largest, over all views, of sum(T_after * alpha) over its
     footprint, where T_after is how see-through the remaining scene is there (pixels at render_px).
     Score > put_back_px -> put back. Then a second look at put-backs that are barely seen with the
     put-backs in place (junk behind a wall that was itself a candidate): same remove-and-check.
  2. Stage A2: faint Gaussians, scored with stage A fixed.
  3. Stage B (air): fog over walkable cells, Gaussians hanging in open air away from every occupied
     grid layer. Same put-back check with the earlier stages fixed.
  4. Verify: every view before vs after. Gates: hole pixels and changed pixels per view.
     On failure the offending rules are put back and verify runs once more; if it still fails the
     input is returned unchanged (never a partly cleaned file).

Viewpoints: one per view_step_m block of walkable grid cells, at heights_m, six 90-degree cube faces.
The renderer is a small CPU splatter (numpy + numba, DC colour only), about 1-2 s per 256 px view.

Command for an already published scene (spz in, spz out, Lite rebuilt, manifest updated):
  python -m pipeline.floaters --scene-dir <dir with manifest.json, full.spz, grid.json> --out <dir>
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import multiprocessing as mp
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

try:
    import numba as nb
except ImportError as e:  # no silent fallback: the pure numpy path would take hours
    raise ImportError("pipeline.floaters needs numba (pip install -r requirements-tools.txt)") from e

SPLAT_TRANSFORM = "@playcanvas/splat-transform@3.10.1"

DEFAULTS: Dict[str, Any] = {
    "enabled": True,
    "faint_opacity": 0.05,        # stage A: opacity below this
    "outside_pad_m": 0.3,         # stage A: centre this far past walls, floor or ceiling
    "oversize_m": 0.5,            # stage A: largest axis (1 sigma) above this
    "walk_fog_y_m": [0.25, 1.7],  # stage B: over a walkable cell in this band. Both air rules start at 0.25 m:
                                  # below that are shoes and floor clutter the grid does not see (K-720 check)
    "free_air_dist_m": 0.15,      # stage B: 3D distance to the nearest occupied layer cell above this
    "free_air_wall_m": 0.1,       # stage B: and this far inside the walls
    "free_air_ceiling_m": 0.1,    # stage B: and this far below the ceiling
    "put_back_px": 1.0,           # hole fill score above this -> put back
    "view_step_m": 0.6,
    "heights_m": [0.6, 1.5, 2.3],
    "render_px": 256,
    "max_hole_pct": 0.05,         # verify gate per view: alpha before > 0.97 and after < 0.9
    "max_changed_pct": 5.0,       # verify gate per view: colour change > 0.1
    "refine": True,               # second look at put-backs that are hidden behind other put-backs
    "solid_patch_px": 0,          # 0 = off. Guard: keep candidates that alone cover a solid patch
    "prune_unseen": False,        # remove Gaussians no view sees (not floater removal; keep off)
    "workers": 0,                 # 0 = all cores
}

# Each stage is scored with the earlier stages' results fixed. Structure first: when walls are still out
# for scoring, faint or foggy splats in front of them look like they fill a hole and get put back.
STAGES = (("A", ("outside", "oversize")), ("A2", ("faint",)), ("B", ("walk_fog", "free_air")))
STAGE_B = STAGES[-1][1]
FACES = ((1, 0, 0), (-1, 0, 0), (0, 0, 1), (0, 0, -1), (0, 1, 0), (0, -1, 0))


def merged_config(cfg: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    out = dict(DEFAULTS)
    out.update(cfg or {})
    return out


# ----------------------------------------------------------------------------------------------- PLY

def read_ply(path: Path) -> Tuple[np.ndarray, List[str]]:
    """All-float32 binary little-endian vertex PLY -> (memmap [n, props], property names)."""
    names: List[str] = []
    n = 0
    with open(path, "rb") as f:
        if f.readline().strip() != b"ply":
            raise ValueError(f"{path} is not a PLY file")
        while True:
            line = f.readline()
            if not line:
                raise ValueError(f"{path}: no end_header")
            s = line.decode("ascii").strip()
            if s.startswith("format") and "binary_little_endian" not in s:
                raise ValueError(f"{path}: only binary_little_endian PLY is supported")
            if s.startswith("element vertex"):
                n = int(s.split()[-1])
            elif s.startswith("element") and not s.startswith("element vertex"):
                raise ValueError(f"{path}: unexpected element '{s}'")
            elif s.startswith("property"):
                parts = s.split()
                if parts[1] not in ("float", "float32"):
                    raise ValueError(f"{path}: property {parts[-1]} is {parts[1]}, expected float")
                names.append(parts[-1])
            elif s == "end_header":
                break
        offset = f.tell()
    data = np.memmap(path, dtype="<f4", mode="r", offset=offset, shape=(n, len(names)))
    return data, names


def write_ply(src: Path, dst: Path, data: np.ndarray, keep: np.ndarray) -> int:
    """Copies src's header with the new vertex count and writes the kept rows."""
    raw = open(src, "rb").read(65536)
    end = raw.index(b"end_header")
    end = raw.index(b"\n", end) + 1
    header = raw[:end].decode("ascii").splitlines(keepends=True)
    kept = np.ascontiguousarray(np.asarray(data)[keep], dtype="<f4")
    with open(dst, "wb") as f:
        for line in header:
            f.write((f"element vertex {kept.shape[0]}\n" if line.startswith("element vertex") else line).encode("ascii"))
        f.write(kept.tobytes())
    return int(kept.shape[0])


# ------------------------------------------------------------------------------------------- scene

class Scene:
    """Gaussians in world space: centres w, opacity op, world sigmas sc, 3x3 covariances, DC colour."""

    def __init__(self, w: np.ndarray, op: np.ndarray, sc: np.ndarray, cov: np.ndarray, col: np.ndarray):
        self.w = np.ascontiguousarray(w, dtype=np.float64)
        self.op = np.ascontiguousarray(op, dtype=np.float64)
        self.sc = np.ascontiguousarray(sc, dtype=np.float64)
        self.cov = np.ascontiguousarray(cov, dtype=np.float32)
        self.col = np.ascontiguousarray(np.clip(col, 0, 1), dtype=np.float32)

    def __len__(self) -> int:
        return len(self.w)

    @classmethod
    def from_splat(cls, data: np.ndarray, names: Sequence[str], world_from_splat: np.ndarray) -> "Scene":
        """world_from_splat: 4x4 similarity (row major here). Splat-frame PLY with log scales,
        logit opacity, wxyz quaternions and SH DC colour, as written by splatfacto and splat-transform."""
        ix = {k: i for i, k in enumerate(names)}
        m = np.asarray(world_from_splat, dtype=np.float64)
        k = float(np.linalg.norm(m[:3, 0]))
        rw = m[:3, :3] / k
        p = np.asarray(data[:, [ix["x"], ix["y"], ix["z"]]], dtype=np.float64)
        w = p @ m[:3, :3].T + m[:3, 3]
        op = 1.0 / (1.0 + np.exp(-np.asarray(data[:, ix["opacity"]], dtype=np.float64)))
        sc = np.exp(np.asarray(data[:, [ix[f"scale_{i}"] for i in range(3)]], dtype=np.float64)) * k
        q = np.asarray(data[:, [ix[f"rot_{i}"] for i in range(4)]], dtype=np.float64)
        col = 0.5 + 0.28209479177387814 * np.asarray(data[:, [ix[f"f_dc_{i}"] for i in range(3)]], dtype=np.float64)
        return cls(w, op, sc, covariances(q, sc, rw), col)


def covariances(quat: np.ndarray, sigma: np.ndarray, rw: Optional[np.ndarray] = None) -> np.ndarray:
    """World covariance Rw R S^2 R^T Rw^T for wxyz quaternions and per-axis sigmas (already in metres)."""
    q = quat / np.maximum(np.linalg.norm(quat, axis=1, keepdims=True), 1e-12)
    qw, qx, qy, qz = q.T
    r = np.empty((len(q), 3, 3))
    r[:, 0, 0] = 1 - 2 * (qy * qy + qz * qz); r[:, 0, 1] = 2 * (qx * qy - qw * qz); r[:, 0, 2] = 2 * (qx * qz + qw * qy)
    r[:, 1, 0] = 2 * (qx * qy + qw * qz); r[:, 1, 1] = 1 - 2 * (qx * qx + qz * qz); r[:, 1, 2] = 2 * (qy * qz - qw * qx)
    r[:, 2, 0] = 2 * (qx * qz - qw * qy); r[:, 2, 1] = 2 * (qy * qz + qw * qx); r[:, 2, 2] = 1 - 2 * (qx * qx + qy * qy)
    if rw is not None:
        r = np.einsum("ij,njk->nik", rw, r)
    a = r * sigma[:, None, :]
    return np.einsum("nij,nkj->nik", a, a)


def manifest_matrix(manifest: Dict[str, Any]) -> np.ndarray:
    return np.array(manifest["transform"]["world_from_splat"], dtype=np.float64).reshape(4, 4).T


# ---------------------------------------------------------------------------------------- renderer

@nb.njit(cache=True)
def _rast(order, px, py, ca, cb, cc, op, col, w, h, img, t_img, contrib, stop):
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
        o = op[i]; s = 0.0
        for y in range(y0, y1 + 1):
            dy = y - py[i]
            for x in range(x0, x1 + 1):
                t = t_img[y, x]
                if t < stop:
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
        contrib[i] += s


@nb.njit(cache=True)
def _fill(px, py, ca, cb, cc, op, w, h, t_img, score):
    """score[i] += sum over its footprint of T_after * alpha."""
    for i in range(px.shape[0]):
        a = ca[i]; b = cb[i]; c = cc[i]
        det = a * c - b * b
        if det <= 1e-12:
            continue
        ia = c / det; ib = -b / det; ic = a / det
        rx = 3.0 * math.sqrt(a); ry = 3.0 * math.sqrt(c)
        x0 = int(max(0, math.floor(px[i] - rx))); x1 = int(min(w - 1, math.ceil(px[i] + rx)))
        y0 = int(max(0, math.floor(py[i] - ry))); y1 = int(min(h - 1, math.ceil(py[i] + ry)))
        s = 0.0
        for y in range(y0, y1 + 1):
            dy = y - py[i]
            for x in range(x0, x1 + 1):
                dx = x - px[i]
                e = 0.5 * (ia * dx * dx + 2 * ib * dx * dy + ic * dy * dy)
                if e > 4.5:
                    continue
                al = min(0.99, op[i] * math.exp(-e))
                s += t_img[y, x] * al
        score[i] += s


def camera(eye, target) -> np.ndarray:
    eye = np.asarray(eye, float)
    f = np.asarray(target, float) - eye
    f /= np.linalg.norm(f)
    up = np.array([0, 1, 0.0]) if abs(f[1]) < 0.99 else np.array([0, 0, -1.0])
    r = np.cross(f, up); r /= np.linalg.norm(r)
    u = np.cross(r, f)
    return np.stack([r, -u, f])  # camera x right, y down, z forward


def project(scene: Scene, eye, target, w: int, h: int, fov: float, idx: np.ndarray, near: float = 0.15):
    """Indices kept (in front, near the frame), pixel centres, 2D covariance (with 0.3 px low pass), depth."""
    v = camera(eye, target)
    pc = (scene.w[idx] - np.asarray(eye, float)) @ v.T
    z = pc[:, 2]
    fl = 0.5 * h / math.tan(math.radians(fov) / 2)
    ok = z > near
    idx, pc, z = idx[ok], pc[ok], z[ok]
    px = fl * pc[:, 0] / z + w / 2
    py = fl * pc[:, 1] / z + h / 2
    ok = (px > -w) & (px < 2 * w) & (py > -h) & (py < 2 * h)
    idx, pc, z, px, py = idx[ok], pc[ok], z[ok], px[ok], py[ok]
    cv = np.einsum("ij,njk,lk->nil", v, scene.cov[idx].astype(np.float64), v)
    j = np.zeros((len(idx), 2, 3))
    j[:, 0, 0] = fl / z; j[:, 0, 2] = -fl * pc[:, 0] / z ** 2
    j[:, 1, 1] = fl / z; j[:, 1, 2] = -fl * pc[:, 1] / z ** 2
    c2 = np.einsum("nij,njk,nlk->nil", j, cv, j)
    return idx, px, py, c2[:, 0, 0] + 0.3, c2[:, 0, 1], c2[:, 1, 1] + 0.3, z


def render(scene: Scene, eye, target, size: Tuple[int, int] = (256, 256), fov: float = 90.0,
           mask: Optional[np.ndarray] = None, contrib: Optional[np.ndarray] = None, near: float = 0.15):
    """Front-to-back alpha blending. Returns (rgb [h, w, 3], alpha [h, w])."""
    w, h = size
    idx = np.flatnonzero(mask) if mask is not None else np.arange(len(scene))
    idx, px, py, ca, cb, cc, z = project(scene, eye, target, w, h, fov, idx, near)
    order = np.argsort(z, kind="stable").astype(np.int64)
    img = np.zeros((h, w, 3), np.float32)
    t_img = np.ones((h, w), np.float32)
    ctr = np.zeros(len(idx), np.float32)
    _rast(order, px, py, ca, cb, cc, scene.op[idx], scene.col[idx], w, h, img, t_img, ctr, 0.003)
    if contrib is not None:
        contrib[idx] += ctr
    return img, 1 - t_img


# -------------------------------------------------------------------------------------- grid / views

def decode_bits(b64: str, n: int) -> np.ndarray:
    return np.unpackbits(np.frombuffer(base64.b64decode(b64), np.uint8), bitorder="big")[:n].astype(bool)


def grid_arrays(grid: Dict[str, Any]) -> Tuple[np.ndarray, Optional[np.ndarray]]:
    w, h = int(grid["width"]), int(grid["height"])
    free = decode_bits(grid["free_bits_b64"], w * h).reshape(h, w)
    occ = None
    if grid.get("layers"):
        lc = int(grid["layers"]["count"])
        occ = decode_bits(grid["layers"]["occupied_bits_b64"], lc * w * h).reshape(lc, h, w)
    return free, occ


def viewpoints(grid: Dict[str, Any], step_m: float = 0.6, heights: Sequence[float] = (0.6, 1.5, 2.3)) -> List[Tuple[tuple, tuple]]:
    """One eye per step_m block of walkable cells (the middle free cell of the block), each height, six faces."""
    free, _ = grid_arrays(grid)
    c = float(grid["cell_m"]); ox, oz = grid["origin"]
    k = max(1, int(round(step_m / c)))
    pts = []
    for r in range(0, free.shape[0], k):
        for q in range(0, free.shape[1], k):
            blk = np.argwhere(free[r:r + k, q:q + k])
            if len(blk):
                rr, qq = blk[len(blk) // 2]
                pts.append((ox + (q + qq + 0.5) * c, oz + (r + rr + 0.5) * c))
    return [((x, hh, z), (x + f[0], hh + f[1], z + f[2])) for x, z in pts for hh in heights for f in FACES]


def room_box(grid: Dict[str, Any], room_height_m: float) -> Tuple[np.ndarray, np.ndarray]:
    c = float(grid["cell_m"]); ox, oz = grid["origin"]
    lo = np.array([ox, 0.0, oz])
    hi = np.array([ox + grid["width"] * c, room_height_m, oz + grid["height"] * c])
    return lo, hi


def estimate_room_height(scene: Scene) -> float:
    """Ceiling estimate when the capture gives no room_dims_m: 99th percentile height of opaque Gaussians."""
    return float(np.percentile(scene.w[scene.op > 0.5, 1], 99))


# ------------------------------------------------------------------------------------------- rules

def rule_masks(scene: Scene, grid: Dict[str, Any], room_height_m: float, cfg: Dict[str, Any]) -> Dict[str, np.ndarray]:
    from scipy import ndimage as ndi

    w, op = scene.w, scene.op
    lo, hi = room_box(grid, room_height_m)
    pad = np.max(np.maximum(lo - w, w - hi), axis=1)  # how far outside the box (negative = inside)
    rules = {
        "faint": op < float(cfg["faint_opacity"]),
        "outside": pad > float(cfg["outside_pad_m"]),
        "oversize": scene.sc.max(axis=1) > float(cfg["oversize_m"]),
    }

    free, occ = grid_arrays(grid)
    c = float(grid["cell_m"]); ox, oz = grid["origin"]
    gw, gh = int(grid["width"]), int(grid["height"])
    col = np.floor((w[:, 0] - ox) / c).astype(np.int64)
    row = np.floor((w[:, 2] - oz) / c).astype(np.int64)
    inxz = (col >= 0) & (col < gw) & (row >= 0) & (row < gh)
    infree = np.zeros(len(w), bool)
    infree[inxz] = free[row[inxz], col[inxz]]
    y = w[:, 1]
    fy0, fy1 = (float(v) for v in cfg["walk_fog_y_m"])
    rules["walk_fog"] = infree & (y > fy0) & (y < fy1)

    if occ is not None:
        lay = grid["layers"]
        dist_t = ndi.distance_transform_edt(~occ, sampling=(float(lay["dy_m"]), c, c))
        li = np.clip(np.floor((y - float(lay["y0_m"])) / float(lay["dy_m"])).astype(np.int64), 0, occ.shape[0] - 1)
        dist = np.zeros(len(w))
        dist[inxz] = dist_t[li[inxz], row[inxz], col[inxz]]
        wallgap = np.minimum.reduce([w[:, 0] - lo[0], hi[0] - w[:, 0], w[:, 2] - lo[2], hi[2] - w[:, 2]])
        rules["free_air"] = ((dist > float(cfg["free_air_dist_m"])) & (wallgap > float(cfg["free_air_wall_m"]))
                             & (y > fy0) & (y < room_height_m - float(cfg["free_air_ceiling_m"])))
    else:
        rules["free_air"] = np.zeros(len(w), bool)
    return rules


# ---------------------------------------------------------------------------------- parallel views

_G: Dict[str, Any] = {}


def _set_scene(scene: Scene, px: int) -> None:
    _G["S"] = scene
    _G["R"] = px


def _score_view(args):
    """Render with only keep, score the candidates against what stays. Returns (cand idx, score)."""
    view, keep, cand = args
    s, r = _G["S"], _G["R"]
    eye, tgt = view
    _, a1 = render(s, eye, tgt, (r, r), 90, mask=keep)
    idx, px, py, ca, cb, cc, _ = project(s, eye, tgt, r, r, 90, cand)
    sc = np.zeros(len(idx))
    _fill(px, py, ca, cb, cc, s.op[idx], r, r, (1 - a1).astype(np.float32), sc)
    return idx, sc


def _render_view(args):
    view, keep = args
    s, r = _G["S"], _G["R"]
    eye, tgt = view
    contrib = np.zeros(len(s), np.float32) if keep is None and _G.get("contrib") else None
    img, a = render(s, eye, tgt, (r, r), 90, mask=keep, contrib=contrib)
    seen = np.flatnonzero(contrib > 1e-3) if contrib is not None else None
    return img.astype(np.float16), a.astype(np.float16), seen


def _visible_view(args):
    """How much each of the given Gaussians shows in this view (sum of T * alpha at its own depth)."""
    view, keep, which = args
    s, r = _G["S"], _G["R"]
    contrib = np.zeros(len(s), np.float32)
    render(s, view[0], view[1], (r, r), 90, mask=keep, contrib=contrib)
    return which, contrib[which]


def _candidate_alpha(args):
    """Alpha of the candidates alone (for the solid patch guard): pixels > 0.9 credited to each candidate."""
    view, cand, min_px = args
    s, r = _G["S"], _G["R"]
    eye, tgt = view
    _, a = render(s, eye, tgt, (r, r), 90, mask=cand)
    solid = a > 0.9
    if solid.sum() < min_px:
        return np.zeros(0, np.int64)
    from scipy import ndimage as ndi
    lab, n = ndi.label(solid)
    sizes = np.bincount(lab.ravel())
    big = np.flatnonzero(sizes >= min_px)
    big = big[big > 0]
    if not len(big):
        return np.zeros(0, np.int64)
    patch = np.isin(lab, big)
    idx, px, py, *_ = project(s, eye, tgt, r, r, 90, np.flatnonzero(cand))
    xi = np.clip(np.round(px).astype(np.int64), 0, r - 1)
    yi = np.clip(np.round(py).astype(np.int64), 0, r - 1)
    inside = (px >= 0) & (px < r) & (py >= 0) & (py < r)
    return idx[inside & patch[yi, xi]]


class Views:
    """Runs per-view work in a fork pool that shares the scene copy-on-write."""

    def __init__(self, scene: Scene, views, px: int, workers: int):
        self.scene, self.views, self.px = scene, views, px
        self.workers = workers or os.cpu_count() or 1
        self.pool = None

    def __enter__(self):
        _set_scene(self.scene, self.px)
        if self.views:  # compile the numba kernels once before forking
            _score_view((self.views[0], np.ones(len(self.scene), bool), np.arange(min(10, len(self.scene)))))
        if self.workers > 1 and len(self.views) > 1:
            self.pool = mp.get_context("fork").Pool(self.workers)
        return self

    def __exit__(self, *exc):
        if self.pool:
            self.pool.terminate()

    def map(self, fn, args):
        if self.pool:
            return self.pool.map(fn, args, chunksize=max(1, len(args) // (self.workers * 8)))
        return [fn(a) for a in args]


def hole_fill_score(vw: Views, keep: np.ndarray, cand: np.ndarray) -> np.ndarray:
    """For every Gaussian in cand: max over views of sum(T_after * alpha). 0 for everything else."""
    cand_idx = np.flatnonzero(cand)
    score = np.zeros(len(keep))
    for idx, sc in vw.map(_score_view, [(v, keep, cand_idx) for v in vw.views]):
        np.maximum.at(score, idx, sc)
    return score


def visibility(vw: Views, keep: np.ndarray, which: np.ndarray) -> np.ndarray:
    """Max over views of how many pixels' worth each Gaussian in `which` is actually seen (front-to-back)."""
    idx = np.flatnonzero(which)
    vis = np.zeros(len(keep))
    for i, v in vw.map(_visible_view, [(view, keep, idx) for view in vw.views]):
        np.maximum.at(vis, i, v)
    return vis


def solid_patch_guard(vw: Views, cand: np.ndarray, min_px: int) -> np.ndarray:
    keep_back = np.zeros(len(cand), bool)
    if min_px <= 0 or not cand.any():
        return keep_back
    for idx in vw.map(_candidate_alpha, [(v, cand, min_px) for v in vw.views]):
        keep_back[idx] = True
    return keep_back


def compare(before, after, max_hole_pct: float, max_changed_pct: float) -> Dict[str, Any]:
    holes, changed, diffs = [], [], []
    for (i0, a0, _), (i1, a1, _) in zip(before, after):
        i0 = i0.astype(np.float32); i1 = i1.astype(np.float32)
        a0 = a0.astype(np.float32); a1 = a1.astype(np.float32)
        holes.append(float(((a0 > 0.97) & (a1 < 0.9)).mean() * 100))
        d = np.abs(i0 - i1)
        changed.append(float((d.max(axis=2) > 0.1).mean() * 100))
        diffs.append(float(d.mean()))
    holes_a, changed_a = np.array(holes), np.array(changed)
    return {
        "views": len(holes),
        "hole_pct_max": round(float(holes_a.max()), 4) if len(holes) else 0.0,
        "hole_pct_mean": round(float(holes_a.mean()), 5) if len(holes) else 0.0,
        "changed_pct_max": round(float(changed_a.max()), 3) if len(holes) else 0.0,
        "changed_pct_mean": round(float(changed_a.mean()), 4) if len(holes) else 0.0,
        "color_diff_mean": round(float(np.mean(diffs)), 5) if len(holes) else 0.0,
        "views_failing": [i for i, (h, c) in enumerate(zip(holes, changed)) if h > max_hole_pct or c > max_changed_pct],
        "passed": bool(len(holes) == 0 or (holes_a.max() <= max_hole_pct and changed_a.max() <= max_changed_pct)),
        "per_view_hole_pct": [round(v, 4) for v in holes],
        "per_view_changed_pct": [round(v, 3) for v in changed],
    }


# --------------------------------------------------------------------------------------- algorithm

def filter_floaters(scene: Scene, grid: Dict[str, Any], cfg: Optional[Dict[str, Any]] = None,
                    room_height_m: Optional[float] = None, log=print) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Returns (keep mask, stats). keep is all True when disabled or when the verify gate fails twice."""
    cfg = merged_config(cfg)
    n = len(scene)
    t0 = time.time()
    if not cfg["enabled"]:
        return np.ones(n, bool), {"enabled": False, "kept": n, "removed": 0}
    if room_height_m is None:
        room_height_m = estimate_room_height(scene)
        h_src = "99th percentile of opaque Gaussians"
    else:
        h_src = "given"
    views = viewpoints(grid, float(cfg["view_step_m"]), tuple(cfg["heights_m"]))
    px = int(cfg["render_px"])
    put_back = float(cfg["put_back_px"])
    rules = rule_masks(scene, grid, room_height_m, cfg)
    stats: Dict[str, Any] = {
        "enabled": True, "gaussians_in": n, "room_height_m": round(room_height_m, 3), "room_height_source": h_src,
        "floor_spots": len(views) // (6 * len(cfg["heights_m"])), "eye_positions": len(views) // 6, "views": len(views), "render_px": px, "rules": {},
    }
    log(f"[floaters] {n} Gaussians, {len(views)} views ({len(views) // (6 * len(cfg['heights_m']))} floor spots x {len(cfg['heights_m'])} heights x 6 directions), room height {room_height_m:.2f} m")

    with Views(scene, views, px, int(cfg["workers"])) as vw:
        removed = np.zeros(n, bool)
        removed_by: Dict[str, np.ndarray] = {}
        claimed = np.zeros(n, bool)
        for stage, names in STAGES:
            ts = time.time()
            cand = np.zeros(n, bool)
            new_of: Dict[str, np.ndarray] = {}
            for k in names:
                new_of[k] = rules[k] & ~claimed & ~removed
                claimed |= rules[k]
                cand |= new_of[k]
            score = hole_fill_score(vw, ~(removed | cand), cand)
            back = cand & (score > put_back)
            guard = solid_patch_guard(vw, cand & ~back, int(cfg["solid_patch_px"]))
            back |= guard & cand
            rem = cand & ~back
            refined = 0
            if cfg["refine"] and back.any():
                # Candidates are scored all together, so something behind a wall that is itself a candidate
                # looks like it fills a hole. With the put-back set in place, take the put-backs that are
                # barely seen (hidden behind others) and run the same remove-and-check on them.
                vis = visibility(vw, ~(removed | rem), back)
                cand2 = back & (vis <= put_back)
                if cand2.any():
                    score2 = hole_fill_score(vw, ~(removed | rem | cand2), cand2)
                    rem2 = cand2 & (score2 <= put_back)
                    back &= ~rem2
                    rem |= rem2
                    refined = int(rem2.sum())
            for k in names:
                removed_by[k] = new_of[k] & rem
                stats["rules"][k] = {
                    "stage": stage, "candidates": int(rules[k].sum()), "new_candidates": int(new_of[k].sum()),
                    "put_back": int((new_of[k] & back).sum()), "removed": int(removed_by[k].sum()),
                }
            removed |= rem
            stats[f"stage_{stage}_s"] = round(time.time() - ts, 1)
            stats[f"stage_{stage}_refined"] = refined
            log(f"[floaters] stage {stage}: candidates {int(cand.sum())}, put back {int(back.sum())}, "
                f"removed {int(rem.sum())} (of which {refined} hidden behind put-backs) ({time.time() - ts:.0f} s)")

        if cfg["prune_unseen"]:
            _G["contrib"] = True
        before = vw.map(_render_view, [(v, None) for v in vw.views])
        _G["contrib"] = False
        if cfg["prune_unseen"]:
            seen = np.zeros(n, bool)
            for _, _, s in before:
                seen[s] = True
            removed_by["unseen"] = ~seen & ~removed
            removed |= removed_by["unseen"]
            stats["rules"]["unseen"] = {"stage": "C", "candidates": int((~seen).sum()), "removed": int(removed_by["unseen"].sum())}

        def verify(rem_mask):
            after = vw.map(_render_view, [(v, ~rem_mask) for v in vw.views])
            return compare(before, after, float(cfg["max_hole_pct"]), float(cfg["max_changed_pct"]))

        ts = time.time()
        gate = verify(removed)
        stats["verify_s"] = round(time.time() - ts, 1)
        retried: List[str] = []
        if not gate["passed"]:
            # Put back every rule whose removals still fill a hole in the final scene, then verify once more
            resid = hole_fill_score(vw, ~removed, removed)

            def undo(k):
                m = removed_by[k] & removed
                removed[m] = False
                r = stats["rules"][k]
                r["put_back_after_verify"] = int(m.sum())
                r["put_back"] = r.get("put_back", 0) + int(m.sum())
                r["removed"] = 0
                retried.append(k)

            for k, m in removed_by.items():
                if k == "unseen" or (resid[m] > put_back).any():
                    undo(k)
            if not retried:  # nothing obvious: drop the air rules
                for k in STAGE_B:
                    undo(k)
            log(f"[floaters] verify failed (hole {gate['hole_pct_max']}%, changed {gate['changed_pct_max']}%), "
                f"put back rules {retried}, verifying again")
            stats["verify_first"] = {k: v for k, v in gate.items() if not k.startswith("per_view")}
            gate = verify(removed)

    stats["verify"] = gate
    stats["verify_retried_rules"] = retried
    if not gate["passed"]:
        stats.update({"status": "FAIL", "kept": n, "removed": 0})
        log(f"[floaters] FAIL: verify gate still fails (hole {gate['hole_pct_max']}%, changed {gate['changed_pct_max']}%). "
            "Input left unchanged.")
        return np.ones(n, bool), stats
    stats.update({"status": "PASS", "kept": int(n - removed.sum()), "removed": int(removed.sum()),
                  "removed_pct": round(float(removed.mean() * 100), 2), "total_s": round(time.time() - t0, 1)})
    log(f"[floaters] PASS: removed {int(removed.sum())} ({stats['removed_pct']}%), hole max {gate['hole_pct_max']}%, "
        f"changed max {gate['changed_pct_max']}%, {stats['total_s']:.0f} s")
    return ~removed, stats


# ------------------------------------------------------------------------------- published scenes

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def splat_transform(*args: str) -> None:
    cmd = ["npx", "-y", SPLAT_TRANSFORM, *args]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed:\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}")


def spz_header(path: Path) -> Tuple[int, int]:
    """(version, splat count) from an spz file (gzip of a 16-byte header: magic NGSP, version, count, ...)."""
    import gzip
    with gzip.open(path, "rb") as f:
        head = f.read(16)
    if head[:4] != b"NGSP":
        raise ValueError(f"{path}: not an spz file (magic {head[:4]!r})")
    return int.from_bytes(head[4:8], "little"), int.from_bytes(head[8:12], "little")


def clean_published_scene(scene_dir: Path, out_dir: Path, cfg: Optional[Dict[str, Any]] = None,
                          room_height_m: Optional[float] = None, lite_decimate: str = "30%",
                          work_dir: Optional[Path] = None, log=print) -> Dict[str, Any]:
    scene_dir, out_dir = Path(scene_dir), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    work = Path(work_dir) if work_dir else out_dir / "_work"
    work.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((scene_dir / "manifest.json").read_text())
    grid = json.loads((scene_dir / "grid.json").read_text())
    full_ply = work / "full_in.ply"
    if not full_ply.exists():
        splat_transform(str(scene_dir / "full.spz"), str(full_ply))
    data, names = read_ply(full_ply)
    scene = Scene.from_splat(data, names, manifest_matrix(manifest))
    keep, stats = filter_floaters(scene, grid, cfg, room_height_m, log)
    np.save(work / "keep.npy", keep)
    (work / "stats.json").write_text(json.dumps(stats, indent=1))
    if stats.get("status") != "PASS":
        for name in ("full.spz", "lite.spz", "manifest.json", "grid.json", "pois.json"):
            if (scene_dir / name).exists():
                shutil.copy2(scene_dir / name, out_dir / name)
        return stats

    clean_ply = work / "full_clean.ply"
    write_ply(full_ply, clean_ply, data, keep)
    splat_transform("-w", "--spz-version", "3", str(clean_ply), str(out_dir / "full.spz"))
    lite_ply = work / "lite_clean.ply"
    splat_transform("-w", "-g", "cpu", str(clean_ply), "--decimate-adaptive", lite_decimate, str(lite_ply))
    splat_transform("-w", "--spz-version", "3", str(lite_ply), str(out_dir / "lite.spz"))
    for name in ("grid.json", "pois.json"):
        if (scene_dir / name).exists():
            shutil.copy2(scene_dir / name, out_dir / name)

    # Manifest: only sha256 / bytes / gaussians of full and lite change. Edit the text in place so every
    # other byte (transform, bounds, start pose, grid and pois entries) stays identical.
    text = (scene_dir / "manifest.json").read_text()
    files = {}
    for kind, name in (("full", "full.spz"), ("lite", "lite.spz")):
        aid = manifest["assets"][kind]
        old = manifest["asset_table"][aid]
        ver, count = spz_header(out_dir / name)
        new = {"sha256": sha256(out_dir / name), "bytes": (out_dir / name).stat().st_size, "gaussians": count}
        files[kind] = {**new, "spz_version": ver, "old": {k: old.get(k) for k in new}}
        for key in ("sha256", "bytes", "gaussians"):
            if key in old:
                old_s = json.dumps({key: old[key]})[1:-1]
                new_s = json.dumps({key: new[key]})[1:-1]
                if text.count(old_s) != 1:
                    raise RuntimeError(f"manifest: '{old_s}' is not unique, cannot patch in place")
                text = text.replace(old_s, new_s)
    (out_dir / "manifest.json").write_text(text)
    stats["files"] = files
    (work / "stats.json").write_text(json.dumps(stats, indent=1))
    return stats


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Remove floaters from a published scene without opening holes")
    ap.add_argument("--scene-dir", required=True, help="dir with manifest.json, full.spz, grid.json (pois.json copied)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--config", default=None, help="pipeline config yaml (its floaters: block is used)")
    ap.add_argument("--room-height", type=float, default=None, help="ceiling height in metres (capture room_dims_m.height)")
    ap.add_argument("--view-step", type=float, default=None, help="metres between viewpoints (default 0.6)")
    ap.add_argument("--workers", type=int, default=0)
    ap.add_argument("--work-dir", default=None)
    a = ap.parse_args(argv)
    cfg: Dict[str, Any] = {}
    if a.config:
        from pipeline.common import load_config
        cfg = dict(load_config(a.config)[0].get("floaters", {}))
    if a.view_step:
        cfg["view_step_m"] = a.view_step
    if a.workers:
        cfg["workers"] = a.workers
    stats = clean_published_scene(Path(a.scene_dir), Path(a.out), cfg, a.room_height,
                                  work_dir=Path(a.work_dir) if a.work_dir else None)
    print(json.dumps({k: v for k, v in stats.items() if k != "verify"}, indent=1))
    return 0 if stats.get("status") in ("PASS", None) else 1


if __name__ == "__main__":
    sys.exit(main())
