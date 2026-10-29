"""
Namma Space: S06 normalization math (NumPy only).

Builds world_from_splat: right-handed, +Y up, metres, floor at y=0.
- Up direction comes from the COLMAP cameras (phone held upright), mapped into the
  splat frame with Nerfstudio's dataparser_transforms.json.
- Floor: RANSAC plane on Gaussians in the bottom height band, normal near up.
- Scale: tape pair (marks_2d.json triangulated with COLMAP poses), else a manual
  override, else a labelled camera-height prior (approximate).
- Floor (camera_path mode): the strongest layer directly under the walked path, where only
  floor can be (bunks, tables and their reflections are off to the sides).
- Measured room size (capture room_dims_m): ceiling over the walked path and the outermost
  walls give three scale estimates; the median is used, and the walls bound cleanup + viewer.
- Yaw: dominant floor axis along +X. Origin: tape mark A on the floor if present,
  else the median camera position dropped onto the floor.
Per Hard Rule 8 the PLY is never rotated or scaled; cleanup only removes Gaussians.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import numpy as np


# ---------------------------------------------------------------- COLMAP helpers

def qvec_to_rotmat(q: List[float]) -> np.ndarray:
    w, x, y, z = q
    return np.array(
        [
            [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y],
            [2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x],
            [2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y],
        ]
    )


def camera_centers_and_ups(images: Dict[int, Dict[str, Any]]) -> Tuple[np.ndarray, np.ndarray, List[str]]:
    """World-space camera centres and 'up' vectors (COLMAP/OpenCV: image y points down)."""
    centers, ups, names = [], [], []
    for img in images.values():
        r = qvec_to_rotmat(img["qvec"])
        t = np.asarray(img["tvec"], dtype=np.float64)
        centers.append(-r.T @ t)
        ups.append(-r[1, :])
        names.append(img["name"])
    return np.asarray(centers), np.asarray(ups), names


def undistort_simple_radial(u: float, v: float, params: List[float], model: str) -> Tuple[float, float]:
    """Returns normalized image coordinates for SIMPLE_PINHOLE / SIMPLE_RADIAL / PINHOLE."""
    if model == "PINHOLE":
        fx, fy, cx, cy = params[:4]
        return (u - cx) / fx, (v - cy) / fy
    f, cx, cy = params[:3]
    k = params[3] if model == "SIMPLE_RADIAL" and len(params) > 3 else 0.0
    xd, yd = (u - cx) / f, (v - cy) / f
    x, y = xd, yd
    for _ in range(10):
        r2 = x * x + y * y
        x, y = xd / (1 + k * r2), yd / (1 + k * r2)
    return x, y


def triangulate_mark(
    observations: List[Dict[str, Any]],
    images_by_name: Dict[str, Dict[str, Any]],
    cameras: Dict[int, Dict[str, Any]],
) -> np.ndarray:
    """Linear (DLT) triangulation of one tape mark clicked in >= 2 frames."""
    rows = []
    for obs in observations:
        img = images_by_name.get(obs["frame"])
        if img is None:
            raise ValueError(f"Frame '{obs['frame']}' is not registered in COLMAP")
        cam = cameras[img["camera_id"]]
        x, y = undistort_simple_radial(float(obs["u"]), float(obs["v"]), cam["params"], cam["model"])
        r = qvec_to_rotmat(img["qvec"])
        p = np.hstack([r, np.asarray(img["tvec"], dtype=np.float64).reshape(3, 1)])
        rows.append(x * p[2] - p[0])
        rows.append(y * p[2] - p[1])
    if len(rows) < 4:
        raise ValueError("Each tape mark needs clicks in at least 2 frames")
    _, _, vt = np.linalg.svd(np.asarray(rows))
    xh = vt[-1]
    return xh[:3] / xh[3]


# ---------------------------------------------------------------- frames

# Nerfstudio's colmap dataparser (assume_colmap_world_coordinate_convention=True) swaps
# y/z and negates the new z before its own transform; that swap is not stored in
# dataparser_transforms.json.
COLMAP_WORLD_FLIP = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])


def dataparser_matrix(dp: Dict[str, Any], flip: bool = False) -> Tuple[np.ndarray, float]:
    """Nerfstudio dataparser_transforms.json -> (3x4 transform from COLMAP world, scale). splat = s * (T @ [p;1])."""
    t = np.asarray(dp["transform"], dtype=np.float64)
    if t.shape == (4, 4):
        t = t[:3]
    if flip:
        t = np.hstack([t[:, :3] @ COLMAP_WORLD_FLIP, t[:, 3:]])
    return t, float(dp.get("scale", 1.0))


def colmap_to_splat_points(p: np.ndarray, t: np.ndarray, s: float) -> np.ndarray:
    return s * (p @ t[:, :3].T + t[:, 3])


def colmap_to_splat_dirs(d: np.ndarray, t: np.ndarray) -> np.ndarray:
    out = d @ t[:, :3].T
    return out / np.linalg.norm(out, axis=-1, keepdims=True)


def frame_mismatch(mapped_sparse: np.ndarray, splat_xyz: np.ndarray, n_sparse: int = 1500, n_splat: int = 40000) -> float:
    """
    Median nearest-splat distance of the mapped COLMAP points, relative to the splat extent.
    Splatfacto starts from the SfM points, so the right mapping puts most of them on a Gaussian.
    """
    rng = np.random.default_rng(0)
    a = mapped_sparse[rng.choice(len(mapped_sparse), min(n_sparse, len(mapped_sparse)), replace=False)]
    b = splat_xyz[rng.choice(len(splat_xyz), min(n_splat, len(splat_xyz)), replace=False)]
    best = np.full(len(a), np.inf)
    for i in range(0, len(b), 4000):
        chunk = b[i:i + 4000]
        d2 = ((a[:, None, :] - chunk[None, :, :]) ** 2).sum(axis=2)
        best = np.minimum(best, d2.min(axis=1))
    extent = np.linalg.norm(np.percentile(splat_xyz, 95, axis=0) - np.percentile(splat_xyz, 5, axis=0))
    return float(np.median(np.sqrt(best)) / max(extent, 1e-9))


def choose_colmap_frame(dp: Dict[str, Any], sparse_xyz: np.ndarray, splat_xyz: np.ndarray) -> Tuple[np.ndarray, float, str, Dict[str, float]]:
    """
    Picks the COLMAP->splat mapping that matches the trained splat: Nerfstudio's dataparser
    transform with or without the COLMAP world flip, or (if an exporter undid the dataparser
    transform) the flip alone or the raw COLMAP frame.
    """
    ident = {"transform": np.eye(4)[:3].tolist(), "scale": 1.0}
    candidates = {
        "dataparser+flip": dataparser_matrix(dp, True),
        "dataparser": dataparser_matrix(dp, False),
        "flip_only": dataparser_matrix(ident, True),
        "colmap_raw": dataparser_matrix(ident, False),
    }
    # Drop candidates that are the same mapping (e.g. an identity dataparser transform)
    unique: Dict[str, Tuple[np.ndarray, float]] = {}
    for k, (t, s) in candidates.items():
        if not any(np.allclose(t, t2) and np.isclose(s, s2) for t2, s2 in unique.values()):
            unique[k] = (t, s)
    candidates = unique
    errs = {k: frame_mismatch(colmap_to_splat_points(sparse_xyz, t, s), splat_xyz) for k, (t, s) in candidates.items()}
    name = min(errs, key=errs.get)
    t, s = candidates[name]
    return t, s, name, errs


# ---------------------------------------------------------------- floor

def fit_plane_svd(pts: np.ndarray) -> Tuple[np.ndarray, float]:
    c = pts.mean(axis=0)
    _, _, vt = np.linalg.svd(pts - c, full_matrices=False)
    n = vt[-1]
    return n, -float(n @ c)


def ransac_floor(
    points: np.ndarray,
    up: np.ndarray,
    band_fraction: float,
    max_tilt_deg: float = 25.0,
    iterations: int = 600,
    seed: int = 0,
    thresh: Optional[float] = None,
) -> Dict[str, Any]:
    """
    RANSAC floor plane among points in the bottom band along `up`.
    Returns normal (pointing along up), offset d (n.p + d = 0), inlier mask over `points`.
    """
    up = up / np.linalg.norm(up)
    h = points @ up
    lo_rob, hi_rob = float(np.percentile(h, 2)), float(np.percentile(h, 90))
    extent = max((hi_rob - lo_rob) / 0.88, 1e-9)
    lo = lo_rob
    band = (h >= lo - 0.05 * extent) & (h <= lo + band_fraction * extent)
    cand = points[band]
    if len(cand) < 50:
        raise ValueError(f"Too few floor candidates ({len(cand)}) in the bottom band")
    if thresh is None:
        thresh = 0.01 * extent
    cos_max = np.cos(np.radians(max_tilt_deg))
    rng = np.random.default_rng(seed)

    best_count, best = -1, None
    for _ in range(iterations):
        s = cand[rng.choice(len(cand), 3, replace=False)]
        n = np.cross(s[1] - s[0], s[2] - s[0])
        norm = np.linalg.norm(n)
        if norm < 1e-12:
            continue
        n /= norm
        if abs(n @ up) < cos_max:
            continue
        d = -n @ s[0]
        count = int(np.count_nonzero(np.abs(cand @ n + d) < thresh))
        if count > best_count:
            best_count, best = count, (n, d)
    if best is None:
        raise ValueError("RANSAC found no plane close to the up direction")

    n, d = best
    inl = np.abs(cand @ n + d) < thresh
    n, d = fit_plane_svd(cand[inl])
    if n @ up < 0:
        n, d = -n, -d
    inl = np.abs(cand @ n + d) < thresh
    resid = cand[inl] @ n + d
    return {
        "normal": n,
        "d": float(d),
        "inliers": cand[inl],
        "rms": float(np.sqrt(np.mean(resid ** 2))),
        "band_count": int(len(cand)),
        "inlier_count": int(inl.sum()),
        "threshold": float(thresh),
    }


def rotation_to_y_up(n: np.ndarray, floor_pts: np.ndarray) -> np.ndarray:
    """Rotation R (rows = world X, Y, Z axes in splat frame) with n -> +Y and the dominant floor axis -> +X."""
    y = n / np.linalg.norm(n)
    proj = floor_pts - floor_pts.mean(axis=0)
    proj = proj - np.outer(proj @ y, y)
    _, _, vt = np.linalg.svd(proj, full_matrices=False)
    x = vt[0] - (vt[0] @ y) * y
    x /= np.linalg.norm(x)
    z = np.cross(x, y)
    return np.vstack([x, y, z])


def build_world_from_splat(r: np.ndarray, scale: float, origin: np.ndarray) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3] = scale * r
    m[:3, 3] = -scale * (r @ origin)
    return m


def to_column_major(m: np.ndarray) -> List[float]:
    return [float(v) for v in m.T.reshape(-1)]


def apply(m: np.ndarray, p: np.ndarray) -> np.ndarray:
    return p @ m[:3, :3].T + m[:3, 3]


# ---------------------------------------------------------------- cleanup

def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def cleanup_mask(
    data: np.ndarray,
    names: List[str],
    world_xyz: np.ndarray,
    min_opacity: float,
    scale_outlier_multiple: float,
    room_box_pad_m: float,
    room_box: Optional[Dict[str, float]] = None,
    room_height_m: Optional[float] = None,
    world_scale: float = 1.0,
    scale_outlier_min_m: float = 0.0,
) -> Tuple[np.ndarray, Dict[str, int]]:
    """
    Keep mask: opacity, scale outliers, and outside the room box + pad (world metres).
    A scale outlier must be both scale_outlier_multiple x the median size and larger than
    scale_outlier_min_m in world metres: plain floors, ceilings and walls are drawn with a few
    large Gaussians, and dropping them leaves black holes.
    """
    idx = {n: i for i, n in enumerate(names)}
    opacity = sigmoid(data[:, idx["opacity"]])
    max_scale = np.exp(data[:, [idx["scale_0"], idx["scale_1"], idx["scale_2"]]]).max(axis=1)

    keep_op = opacity >= min_opacity
    size_limit = max(scale_outlier_multiple * float(np.median(max_scale)), scale_outlier_min_m / world_scale)
    keep_sc = max_scale <= size_limit

    if room_box is None:
        lo = np.percentile(world_xyz[keep_op], 0.5, axis=0)
        hi = np.percentile(world_xyz[keep_op], 99.5, axis=0)
        room_box = {"min": lo.tolist(), "max": hi.tolist()}
    lo = np.asarray(room_box["min"], dtype=np.float64) - room_box_pad_m
    hi = np.asarray(room_box["max"], dtype=np.float64) + room_box_pad_m
    # Nothing real sits under the floor: keep only a thin band below y=0
    lo[1] = -0.1
    if room_height_m:
        hi[1] = min(hi[1], room_height_m + room_box_pad_m)
    keep_box = np.all((world_xyz >= lo) & (world_xyz <= hi), axis=1)

    keep = keep_op & keep_sc & keep_box
    stats = {
        "removed_low_opacity": int((~keep_op).sum()),
        "removed_scale_outlier": int((keep_op & ~keep_sc).sum()),
        "removed_outside_box": int((keep_op & keep_sc & ~keep_box).sum()),
        "kept": int(keep.sum()),
        "room_box_min": [round(float(v), 3) for v in lo],
        "room_box_max": [round(float(v), 3) for v in hi],
    }
    return keep, stats


# ---------------------------------------------------------------- measured room

def gaussian_area_weights(data: np.ndarray, names: List[str]) -> np.ndarray:
    """Opacity x footprint (two largest axes): sums approximate surface area, so plain surfaces drawn with few large Gaussians still count."""
    idx = {n: i for i, n in enumerate(names)}
    s = np.sort(data[:, [idx["scale_0"], idx["scale_1"], idx["scale_2"]]].astype(np.float64), axis=1)
    return sigmoid(data[:, idx["opacity"]].astype(np.float64)) * np.exp(s[:, 1] + s[:, 2])


def _peakiness(v: np.ndarray, w: np.ndarray, bin_m: float) -> float:
    edges = np.arange(v.min(), v.max() + bin_m, bin_m)
    if len(edges) < 2:
        return 0.0
    hist, _ = np.histogram(v, bins=edges, weights=w)
    return float((hist ** 2).sum() / max(hist.sum(), 1e-12) ** 2)


def wall_yaw(xz: np.ndarray, w: np.ndarray, max_deg: float = 45.0, step_deg: float = 0.5, bin_m: float = 0.02) -> float:
    """
    Yaw (radians, about +Y) that lines walls up with the X and Z axes: walls become the sharpest
    histogram peaks. +-45 degrees covers every wall direction (walls repeat every 90 degrees).
    """
    best, best_a = -1.0, 0.0
    for a in np.radians(np.arange(-max_deg, max_deg + 1e-9, step_deg)):
        c, s = np.cos(a), np.sin(a)
        x = xz[:, 0] * c + xz[:, 1] * s
        z = -xz[:, 0] * s + xz[:, 1] * c
        score = _peakiness(x, w, bin_m) + _peakiness(z, w, bin_m)
        if score > best:
            best, best_a = score, float(a)
    return best_a


def yaw_rotation(a: float) -> np.ndarray:
    """Rotation about +Y matching wall_yaw: x' = x cos a + z sin a, z' = -x sin a + z cos a."""
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def path_mask(points_xz: np.ndarray, path_xz: np.ndarray, radius: float) -> np.ndarray:
    """Points within ~radius (horizontally) of the walked camera path; grid dilation, NumPy only."""
    cell = radius / 4
    lo = np.percentile(path_xz, 1, axis=0) - 2 * radius
    hi = np.percentile(path_xz, 99, axis=0) + 2 * radius
    shape = np.ceil((hi - lo) / cell).astype(int) + 1
    grid = np.zeros(shape, dtype=bool)
    ij = np.floor((path_xz - lo) / cell).astype(int)
    ij = ij[np.all((ij >= 0) & (ij < shape), axis=1)]
    grid[ij[:, 0], ij[:, 1]] = True
    k = 4
    dil = np.zeros_like(grid)
    for di in range(-k, k + 1):
        for dj in range(-k, k + 1):
            if di * di + dj * dj <= k * k:
                dil |= np.roll(np.roll(grid, di, axis=0), dj, axis=1)
    pij = np.floor((points_xz - lo) / cell).astype(int)
    ok = np.all((pij >= 0) & (pij < shape), axis=1)
    out = np.zeros(len(points_xz), dtype=bool)
    out[ok] = dil[pij[ok, 0], pij[ok, 1]]
    return out


def profile_peaks(v: np.ndarray, bin_size: float, lo: float, hi: float) -> Tuple[np.ndarray, np.ndarray]:
    """Smoothed count histogram of v on [lo, hi]: (bin centres, counts)."""
    edges = np.arange(lo, hi + bin_size, bin_size)
    hist, _ = np.histogram(v, bins=edges)
    hist = np.convolve(hist.astype(np.float64), [0.25, 0.5, 0.25], mode="same")
    return (edges[:-1] + edges[1:]) / 2, hist


def strongest_layer(h: np.ndarray, lo: float, hi: float, bin_size: float, lowest_within: float = 1.0) -> Optional[float]:
    """
    Centre of the most populated height bin in [lo, hi]. With lowest_within < 1, the lowest
    local peak holding at least that fraction of the maximum wins (floor under a table edge).
    """
    if np.count_nonzero((h >= lo) & (h <= hi)) < 50:
        return None
    centres, hist = profile_peaks(h, bin_size, lo, hi)
    floor_level = lowest_within * hist.max()
    for i in range(len(hist)):
        if hist[i] >= floor_level and hist[i] >= hist[max(i - 1, 0)] and hist[i] >= hist[min(i + 1, len(hist) - 1)]:
            return float(centres[i])
    return float(centres[int(np.argmax(hist))])


def outer_walls(v: np.ndarray, bin_size: float, min_fraction: float = 0.25) -> Tuple[float, float]:
    """Outermost strong peaks of a wall profile: the two room walls along this axis."""
    lo, hi = np.percentile(v, 0.5), np.percentile(v, 99.5)
    pad = 0.05 * (hi - lo)  # walls sit at the extremes; keep them inside the profile
    lo, hi = lo - pad, hi + pad
    centres, hist = profile_peaks(v, bin_size, lo, hi)
    strong = hist >= min_fraction * hist.max()
    peaks = [i for i in range(1, len(hist) - 1) if strong[i] and hist[i] >= hist[i - 1] and hist[i] >= hist[i + 1]]
    if len(peaks) < 2:
        return float(lo), float(hi)
    return float(centres[peaks[0]]), float(centres[peaks[-1]])
