"""
Namma Space: floor backing for a normalized splat (world frame: metres, +Y up, floor y=0).

The low-angle "fog" on splat floors comes from Gaussians below the floor (blobs where the person filming
stood, junk under a thin floor layer) showing through floor splats that are thin and partly see-through.
Pressing them flat smears the floor; deleting them opens small holes. Instead:

  1. Backing: a sheet of flat, opaque Gaussians just under the floor (backing_y_m), one per backing_step_m,
     coloured from a near-orthographic top-down render of the floor layer alone (the sharpest view the splat
     has of its floor). Gaps in that render are filled from the nearest floor pixel. Nothing below the floor
     can show through it, and it sits under shoes and legs instead of covering them.
  2. Below-floor Gaussians inside the room box (centre under -remove_below_m) are candidates for removal.
     The floater put-back check (pipeline/floaters.py) runs with the backing in place: any candidate whose
     removal still leaves a see-through pixel in any view goes back.
  3. Verify: every view before (original scene) vs after (backing + removals). Gate: hole pixels per view.
     Changed pixels are reported but not gated, because removing the fog is meant to change low views.

Command for an already published scene:
  python -m pipeline.floor --scene-dir <dir with manifest.json, full.spz, grid.json> --out <dir>
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional, Sequence, Tuple

import numpy as np
from scipy import ndimage as ndi

from pipeline import floaters as fl

DEFAULTS: Dict[str, Any] = {
    "enabled": True,
    "backing_y_m": -0.012,      # sheet height (just under the floor surface)
    "backing_step_m": 0.01,     # one backing Gaussian per 1 cm
    "backing_sigma_m": 0.007,
    "backing_thick_m": 0.002,
    "backing_opacity": 0.99,
    "floor_band_m": [-0.03, 0.03],  # Gaussians that make the floor surface, used for the backing colour
    "floor_alpha": 0.2,         # top-down floor-layer alpha that counts as floor
    "floor_fill_m": 0.0,        # backing covers seen floor plus gaps up to this far; 0 = the whole room floor
                                # (edges sit under walls and furniture, where nobody sees them)
    "colour_blur_px": 1.0,      # smoothing of the top-down floor colour, in backing steps
    "remove_below_m": 0.02,     # candidates: centre lower than this under the floor
    "wall_margin_m": 0.05,      # and this far inside the walls
    "put_back_px": 1.0,
    "view_step_m": 0.6,
    "heights_m": [0.6, 1.5, 2.3],
    "render_px": 256,
    "max_hole_pct": 0.05,
    "workers": 0,
}


def merged_config(cfg: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    out = dict(DEFAULTS)
    out.update(cfg or {})
    return out


def backing(scene: fl.Scene, grid: Dict[str, Any], cfg: Dict[str, Any]) -> Tuple[np.ndarray, np.ndarray]:
    """Backing sheet: world positions [n, 3] and RGB colours [n, 3]."""
    c = float(grid["cell_m"]); ox, oz = grid["origin"]
    x0, z0, x1, z1 = ox, oz, ox + grid["width"] * c, oz + grid["height"] * c
    res = float(cfg["backing_step_m"])
    w_px, h_px = int(math.ceil((x1 - x0) / res)), int(math.ceil((z1 - z0) / res))
    height = 60.0  # far above: close to orthographic
    fov = 2 * math.degrees(math.atan((z1 - z0) / 2 / height))
    eye, tgt = ((x0 + x1) / 2, height, (z0 + z1) / 2), ((x0 + x1) / 2, 0.0, (z0 + z1) / 2)
    y = scene.w[:, 1]
    b0, b1 = (float(v) for v in cfg["floor_band_m"])
    img, alpha = fl.render(scene, eye, tgt, (w_px, h_px), fov, mask=(y > b0) & (y < b1), near=1.0)
    seen = alpha > float(cfg["floor_alpha"])
    if not seen.any():
        return np.zeros((0, 3)), np.zeros((0, 3))
    # Alpha-weighted smoothing (normalised convolution): faint, noisy floor pixels count little, gaps are
    # filled smoothly from their surroundings instead of in flat patches. Wider passes fill bigger gaps.
    colour = np.zeros_like(img)
    filled = np.zeros(alpha.shape, bool)
    for px in (float(cfg["colour_blur_px"]), 4 * float(cfg["colour_blur_px"]), 16 * float(cfg["colour_blur_px"])):
        wsum = ndi.gaussian_filter(alpha, px)
        csum = np.stack([ndi.gaussian_filter(img[..., k], px) for k in range(3)], -1)
        ok = (wsum > 0.05) & ~filled
        colour[ok] = csum[ok] / wsum[ok, None]
        filled |= ok
    if not filled.all():
        _, (iy, ix) = ndi.distance_transform_edt(~filled, return_indices=True)
        colour = colour[iy, ix]
    colour = np.clip(colour, 0, 1)
    fill = float(cfg["floor_fill_m"])
    cover = ndi.binary_dilation(seen, iterations=int(round(fill / res))) if fill > 0 else np.ones_like(seen)

    xs = x0 + (np.arange(w_px) + 0.5) * res
    zs = z0 + (np.arange(h_px) + 0.5) * res
    xx, zz = np.meshgrid(xs, zs)
    p = np.c_[xx.ravel(), np.full(xx.size, float(cfg["backing_y_m"])), zz.ravel()]
    # pixel of each sheet point in the top-down render
    v = fl.camera(eye, tgt)
    pc = (p - np.asarray(eye)) @ v.T
    f = 0.5 * h_px / math.tan(math.radians(fov) / 2)
    xi = np.clip((f * pc[:, 0] / pc[:, 2] + w_px / 2).astype(np.int64), 0, w_px - 1)
    yi = np.clip((f * pc[:, 1] / pc[:, 2] + h_px / 2).astype(np.int64), 0, h_px - 1)
    ok = cover[yi, xi]
    return p[ok], colour[yi[ok], xi[ok]]


def backing_scene(scene: fl.Scene, p: np.ndarray, col: np.ndarray, cfg: Dict[str, Any]) -> fl.Scene:
    """Original Gaussians followed by the backing sheet (flat, axis aligned)."""
    s = float(cfg["backing_sigma_m"]); t = float(cfg["backing_thick_m"])
    sig = np.tile([s, t, s], (len(p), 1))
    cov = fl.covariances(np.tile([1.0, 0, 0, 0], (len(p), 1)), sig)
    return fl.Scene(np.r_[scene.w, p], np.r_[scene.op, np.full(len(p), float(cfg["backing_opacity"]))],
                    np.r_[scene.sc, sig], np.r_[scene.cov, cov], np.r_[scene.col, col])


def backing_rows(p: np.ndarray, col: np.ndarray, names: Sequence[str], world_from_splat: np.ndarray,
                 cfg: Dict[str, Any]) -> np.ndarray:
    """PLY rows (splat frame) for the backing: position, rotation, log scale, logit opacity, SH DC; f_rest 0."""
    m = np.asarray(world_from_splat, dtype=np.float64)
    k = float(np.linalg.norm(m[:3, 0]))
    rw = m[:3, :3] / k
    ps = (p - m[:3, 3]) @ rw / k            # inverse similarity
    q = quat_wxyz(rw.T)                      # world-axis-aligned disc in the splat frame
    rows = np.zeros((len(p), len(names)), dtype="<f4")
    ix = {n: i for i, n in enumerate(names)}
    for a, key in enumerate("xyz"):
        rows[:, ix[key]] = ps[:, a]
    for a in range(4):
        rows[:, ix[f"rot_{a}"]] = q[a]
    s = float(cfg["backing_sigma_m"]); t = float(cfg["backing_thick_m"])
    for a, v in enumerate((s, t, s)):
        rows[:, ix[f"scale_{a}"]] = math.log(v / k)
    o = float(cfg["backing_opacity"])
    rows[:, ix["opacity"]] = math.log(o / (1 - o))
    for a in range(3):
        rows[:, ix[f"f_dc_{a}"]] = (col[:, a] - 0.5) / 0.28209479177387814
    return rows


def quat_wxyz(r: np.ndarray) -> np.ndarray:
    """Unit quaternion (w, x, y, z) of a 3x3 rotation matrix."""
    tr = r[0, 0] + r[1, 1] + r[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        q = [0.25 * s, (r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s]
    elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
        s = math.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2]) * 2
        q = [(r[2, 1] - r[1, 2]) / s, 0.25 * s, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s]
    elif r[1, 1] > r[2, 2]:
        s = math.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2]) * 2
        q = [(r[0, 2] - r[2, 0]) / s, (r[0, 1] + r[1, 0]) / s, 0.25 * s, (r[1, 2] + r[2, 1]) / s]
    else:
        s = math.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1]) * 2
        q = [(r[1, 0] - r[0, 1]) / s, (r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, 0.25 * s]
    q = np.array(q)
    return q / np.linalg.norm(q)


def floor_backing(scene: fl.Scene, grid: Dict[str, Any], cfg: Optional[Dict[str, Any]] = None,
                  room_height_m: Optional[float] = None, log=print):
    """Returns (keep mask for the original Gaussians, backing positions, backing colours, stats).
    On a failed verify, keep is all True and the backing is empty (the input is left unchanged)."""
    cfg = merged_config(cfg)
    n = len(scene)
    if not cfg["enabled"]:
        return np.ones(n, bool), np.zeros((0, 3)), np.zeros((0, 3)), {"enabled": False}
    t0 = time.time()
    if room_height_m is None:
        room_height_m = fl.estimate_room_height(scene)
    p, col = backing(scene, grid, cfg)
    both = backing_scene(scene, p, col, cfg)
    nb = len(p)
    original = np.r_[np.ones(n, bool), np.zeros(nb, bool)]
    lo, hi = fl.room_box(grid, room_height_m)
    w = scene.w
    wallgap = np.minimum.reduce([w[:, 0] - lo[0], hi[0] - w[:, 0], w[:, 2] - lo[2], hi[2] - w[:, 2]])
    cand = (w[:, 1] < -float(cfg["remove_below_m"])) & (wallgap > float(cfg["wall_margin_m"]))
    cand2 = np.r_[cand, np.zeros(nb, bool)]
    views = fl.viewpoints(grid, float(cfg["view_step_m"]), tuple(cfg["heights_m"]))
    stats: Dict[str, Any] = {"enabled": True, "gaussians_in": n, "backing": nb,
                             "backing_m2": round(nb * float(cfg["backing_step_m"]) ** 2, 2),
                             "candidates": int(cand.sum()), "views": len(views)}
    log(f"[floor] backing {nb} Gaussians ({stats['backing_m2']} m2), {int(cand.sum())} below-floor candidates, {len(views)} views")
    with fl.Views(both, views, int(cfg["render_px"]), int(cfg["workers"])) as vw:
        score = fl.hole_fill_score(vw, ~cand2, cand2)
        back = cand2 & (score > float(cfg["put_back_px"]))
        removed = cand2 & ~back
        before = vw.map(fl._render_view, [(v, original) for v in views])
        after = vw.map(fl._render_view, [(v, ~removed) for v in views])
    gate = fl.compare(before, after, float(cfg["max_hole_pct"]), 100.0)
    stats.update({"put_back": int(back.sum()), "removed": int(removed.sum()),
                  "verify": {k: v for k, v in gate.items() if not k.startswith("per_view")},
                  "per_view_changed_pct": gate["per_view_changed_pct"], "per_view_hole_pct": gate["per_view_hole_pct"],
                  "total_s": round(time.time() - t0, 1)})
    if not gate["passed"]:
        stats["status"] = "FAIL"
        log(f"[floor] FAIL: hole pixels {gate['hole_pct_max']}% in the worst view. Input left unchanged.")
        return np.ones(n, bool), np.zeros((0, 3)), np.zeros((0, 3)), stats
    stats["status"] = "PASS"
    log(f"[floor] PASS: removed {int(removed.sum())} below-floor Gaussians (put back {int(back.sum())}), "
        f"hole max {gate['hole_pct_max']}%, changed max {gate['changed_pct_max']}%, {stats['total_s']:.0f} s")
    return ~removed[:n], p, col, stats


def clean_published_scene(scene_dir: Path, out_dir: Path, cfg: Optional[Dict[str, Any]] = None,
                          room_height_m: Optional[float] = None, work_dir: Optional[Path] = None,
                          log=print) -> Dict[str, Any]:
    scene_dir, out_dir = Path(scene_dir), Path(out_dir)
    work = Path(work_dir) if work_dir else out_dir / "_work"
    work.mkdir(parents=True, exist_ok=True)
    cfg = merged_config(cfg)
    manifest = json.loads((scene_dir / "manifest.json").read_text())
    grid = json.loads((scene_dir / "grid.json").read_text())
    full_ply = work / "full_in.ply"
    if not full_ply.exists():
        fl.splat_transform(str(scene_dir / "full.spz"), str(full_ply))
    data, names = fl.read_ply(full_ply)
    m = fl.manifest_matrix(manifest)
    scene = fl.Scene.from_splat(data, names, m)
    keep, p, col, stats = floor_backing(scene, grid, cfg, room_height_m, log)
    np.save(work / "keep.npy", keep)
    np.savez(work / "backing.npz", p=p, col=col)
    clean = work / "full_clean.ply"
    if stats.get("status") != "PASS":
        stats.update(fl.write_published(scene_dir, out_dir, None, work))
    else:
        fl.write_ply(full_ply, clean, data, keep)
        append_rows(clean, backing_rows(p, col, names, m, cfg))
        lite = write_lite(full_ply, data, keep, p, col, names, m, cfg, work)
        stats.update(fl.write_published(scene_dir, out_dir, clean, work, lite_ply=lite))
    (work / "stats.json").write_text(json.dumps(stats, indent=1))
    return stats


def write_lite(full_ply: Path, data: np.ndarray, keep: np.ndarray, p: np.ndarray, col: np.ndarray,
               names: Sequence[str], m: np.ndarray, cfg: Dict[str, Any], work: Path,
               decimate: str = "30%") -> Path:
    """Lite = the kept room splats decimated on their own, plus the backing at twice the step. The CPU decimator
    only takes about 2.1 M splats in one block, and decimating the flat sheet wastes Lite's budget anyway."""
    kept, lite = work / "lite_kept_in.ply", work / "lite_clean.ply"
    fl.write_ply(full_ply, kept, data, keep)
    fl.splat_transform("-w", "-g", "cpu", str(kept), "--decimate-adaptive", decimate, str(lite))
    append_rows(lite, lite_backing_rows(p, col, ply_names(lite), m, cfg))
    return lite


def lite_backing_rows(p: np.ndarray, col: np.ndarray, names: Sequence[str], world_from_splat: np.ndarray,
                      cfg: Dict[str, Any]) -> np.ndarray:
    """The backing for Lite: every other point each way, twice as wide, so it stays closed at a quarter the count."""
    if not len(p):
        return np.zeros((0, len(names)), dtype="<f4")
    step = 2 * float(cfg["backing_step_m"])
    cell = np.floor((p[:, [0, 2]] - p[:, [0, 2]].min(0)) / step + 1e-6).astype(np.int64)
    _, first = np.unique(cell, axis=0, return_index=True)
    coarse = {**cfg, "backing_step_m": step, "backing_sigma_m": 2 * float(cfg["backing_sigma_m"])}
    return backing_rows(p[first], col[first], names, world_from_splat, coarse)


def ply_names(ply: Path) -> list:
    """Vertex property names of a binary PLY (the decimator may reorder or drop columns)."""
    raw = open(ply, "rb").read(65536)
    header = raw[:raw.index(b"end_header")].decode("ascii")
    return [l.split()[-1] for l in header.splitlines() if l.startswith("property float")]


def append_rows(ply: Path, rows: np.ndarray) -> None:
    """Appends float32 rows to a binary PLY and fixes its vertex count."""
    raw = open(ply, "rb").read(65536)
    end = raw.index(b"\n", raw.index(b"end_header")) + 1
    header = raw[:end].decode("ascii")
    count = int(next(l for l in header.splitlines() if l.startswith("element vertex")).split()[-1])
    new_header = header.replace(f"element vertex {count}\n", f"element vertex {count + len(rows)}\n")
    body = open(ply, "rb").read()[end:]
    with open(ply, "wb") as f:
        f.write(new_header.encode("ascii"))
        f.write(body)
        f.write(np.ascontiguousarray(rows, dtype="<f4").tobytes())


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Floor backing: clear the low-angle floor fog without opening holes")
    ap.add_argument("--scene-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--config", default=None, help="pipeline config yaml (its floor: block is used)")
    ap.add_argument("--room-height", type=float, default=None)
    ap.add_argument("--work-dir", default=None)
    a = ap.parse_args(argv)
    cfg: Dict[str, Any] = {}
    if a.config:
        from pipeline.common import load_config
        cfg = dict(load_config(a.config)[0].get("floor", {}))
    stats = clean_published_scene(Path(a.scene_dir), Path(a.out), cfg, a.room_height,
                                  Path(a.work_dir) if a.work_dir else None)
    print(json.dumps({k: v for k, v in stats.items() if not k.startswith("per_view")}, indent=1))
    return 0 if stats.get("status") == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
