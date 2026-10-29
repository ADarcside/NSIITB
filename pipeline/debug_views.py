"""
Namma Space: debug pictures of a normalized splat (not a pipeline stage).

Writes PNGs in world metres (after S06's world_from_splat) so a person can check the floor,
ceiling, walls and crop by eye:
  topdown_color.png   view from above, below the ceiling: a floor plan in the scene's colours
  topdown_density.png how much surface sits at each spot between 0.3 m and 2.0 m (walls light up)
  side_x.png / side_z.png  side views (height against X / Z)
Grid every 1 m with labels; green = viewer bounds; yellow = S06 crop box.

Usage: python -m pipeline.debug_views --run-dir runs/room_v1 [--ply splat.ply]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Optional, Tuple

import cv2
import numpy as np

from pipeline import normalize as nz
from pipeline.stages.s05_export import read_ply_gaussians_numpy

PX_PER_M = 50  # 2 cm per pixel


class Canvas:
    def __init__(self, u_range: Tuple[float, float], v_range: Tuple[float, float], flip_v: bool):
        self.u0, self.u1 = u_range
        self.v0, self.v1 = v_range
        self.flip_v = flip_v
        self.w = int((self.u1 - self.u0) * PX_PER_M) + 1
        self.h = int((self.v1 - self.v0) * PX_PER_M) + 1

    def px(self, u: np.ndarray, v: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        c = ((u - self.u0) * PX_PER_M).astype(np.int64)
        r = ((v - self.v0) * PX_PER_M).astype(np.int64)
        if self.flip_v:
            r = self.h - 1 - r
        return c, r

    def inside(self, c: np.ndarray, r: np.ndarray) -> np.ndarray:
        return (c >= 0) & (c < self.w) & (r >= 0) & (r < self.h)

    def grid(self, img: np.ndarray, u_name: str, v_name: str) -> None:
        for u in range(int(np.ceil(self.u0)), int(np.floor(self.u1)) + 1):
            c, _ = self.px(np.array([u]), np.array([self.v0]))
            colour = (255, 255, 255) if u == 0 else (90, 90, 90)
            cv2.line(img, (int(c[0]), 0), (int(c[0]), self.h - 1), colour, 1)
            cv2.putText(img, f"{u_name}={u}", (int(c[0]) + 3, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
        for v in range(int(np.ceil(self.v0)), int(np.floor(self.v1)) + 1):
            _, r = self.px(np.array([self.u0]), np.array([v]))
            colour = (255, 255, 255) if v == 0 else (90, 90, 90)
            cv2.line(img, (0, int(r[0])), (self.w - 1, int(r[0])), colour, 1)
            cv2.putText(img, f"{v_name}={v}", (3, int(r[0]) - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)

    def rect(self, img: np.ndarray, u_lo: float, u_hi: float, v_lo: float, v_hi: float, colour: Tuple[int, int, int]) -> None:
        c, r = self.px(np.array([u_lo, u_hi]), np.array([v_lo, v_hi]))
        cv2.rectangle(img, (int(c[0]), int(r[0])), (int(c[1]), int(r[1])), colour, 2)


def density_image(cv: Canvas, u: np.ndarray, v: np.ndarray, w: np.ndarray) -> np.ndarray:
    c, r = cv.px(u, v)
    ok = cv.inside(c, r)
    acc = np.zeros((cv.h, cv.w))
    np.add.at(acc, (r[ok], c[ok]), w[ok])
    acc = cv2.GaussianBlur(acc, (0, 0), 1.0)
    top = np.percentile(acc[acc > 0], 99.5) if (acc > 0).any() else 1.0
    norm = np.clip(np.log1p(acc) / np.log1p(top), 0, 1)
    return cv2.applyColorMap((norm * 255).astype(np.uint8), cv2.COLORMAP_INFERNO)


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="Debug pictures of a normalized splat")
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--ply", default="splat.ply", help="PLY inside the run dir (splat.ply = before cleanup, clean.ply = after)")
    ap.add_argument("--out-dir", default=None, help="default: <run-dir>/debug_views")
    args = ap.parse_args(argv)

    run = Path(args.run_dir)
    out = Path(args.out_dir) if args.out_dir else run / "debug_views"
    out.mkdir(parents=True, exist_ok=True)
    tr = json.loads((run / "transform.json").read_text())
    m = np.asarray(tr["world_from_splat"], dtype=np.float64).reshape(4, 4).T
    met = tr.get("metrics", {})

    ply = read_ply_gaussians_numpy(run / args.ply)
    data, names = ply["data"], ply["property_names"]
    idx = {n: i for i, n in enumerate(names)}
    xyz = nz.apply(m, data[:, [idx["x"], idx["y"], idx["z"]]].astype(np.float64))
    opacity = nz.sigmoid(data[:, idx["opacity"]].astype(np.float64))
    keep = opacity >= 0.1
    xyz, data, opacity = xyz[keep], data[keep], opacity[keep]
    area = nz.gaussian_area_weights(data, names)
    rgb = np.clip(0.5 + 0.28209479 * data[:, [idx["f_dc_0"], idx["f_dc_1"], idx["f_dc_2"]]], 0, 1)

    ceiling = float((met.get("room_box_max") or [0, 3.0, 0])[1])
    ceiling = ceiling if 1.5 < ceiling < 6 else 3.0
    lo = np.maximum(np.percentile(xyz, 1, axis=0) - 0.5, -15)
    hi = np.minimum(np.percentile(xyz, 99, axis=0) + 0.5, 15)
    b = tr.get("bounds", {})
    box_lo, box_hi = met.get("room_box_min"), met.get("room_box_max")

    def overlays(img: np.ndarray, cv: Canvas, u_ax: int, v_ax: int) -> None:
        keys = {0: ("minX", "maxX"), 2: ("minZ", "maxZ")}
        if b and u_ax in keys and v_ax in keys:
            cv.rect(img, b[keys[u_ax][0]], b[keys[u_ax][1]], b[keys[v_ax][0]], b[keys[v_ax][1]], (0, 255, 0))
        if box_lo and box_hi:
            cv.rect(img, box_lo[u_ax], box_hi[u_ax], box_lo[v_ax], box_hi[v_ax], (0, 255, 255))

    # Top-down colour: highest Gaussian below the ceiling wins each pixel
    top = Canvas((lo[0], hi[0]), (lo[2], hi[2]), flip_v=False)
    sel = np.flatnonzero((xyz[:, 1] > -0.05) & (xyz[:, 1] < ceiling - 0.25))
    sel = sel[np.argsort(xyz[sel, 1])]
    c, r = top.px(xyz[sel, 0], xyz[sel, 2])
    ok = top.inside(c, r)
    img = np.zeros((top.h, top.w, 3), dtype=np.uint8)
    img[r[ok], c[ok]] = (rgb[sel][ok][:, ::-1] * 255).astype(np.uint8)
    top.grid(img, "x", "z")
    overlays(img, top, 0, 2)
    cv2.imwrite(str(out / "topdown_color.png"), img)

    band = (xyz[:, 1] > 0.3) & (xyz[:, 1] < 2.0)
    img = density_image(top, xyz[band, 0], xyz[band, 2], area[band])
    top.grid(img, "x", "z")
    overlays(img, top, 0, 2)
    cv2.imwrite(str(out / "topdown_density.png"), img)

    y_lo = float(max(np.percentile(xyz[:, 1], 0.5) - 0.5, -6.0))
    y_hi = float(min(np.percentile(xyz[:, 1], 99.5) + 0.5, 10.0))
    for ax, name in ((0, "x"), (2, "z")):
        cv = Canvas((lo[ax], hi[ax]), (y_lo, y_hi), flip_v=True)
        img = density_image(cv, xyz[:, ax], xyz[:, 1], area)
        cv.grid(img, name, "y")
        overlays(img, cv, ax, 1)
        cv2.imwrite(str(out / f"side_{name}.png"), img)

    # Height profile: surface area at each height (floor, mattresses, tables, ceiling show as peaks)
    edges = np.arange(y_lo, y_hi + 0.02, 0.02)
    hist, _ = np.histogram(xyz[:, 1], bins=edges, weights=area)
    hist = np.log1p(hist / max(np.percentile(hist[hist > 0], 50), 1e-12)) if (hist > 0).any() else hist
    h_img, w_img = len(hist), 600
    img = np.zeros((h_img, w_img, 3), dtype=np.uint8)
    top_v = max(hist.max(), 1e-12)
    for i, v in enumerate(hist):
        cv2.line(img, (0, h_img - 1 - i), (int(v / top_v * (w_img - 80)), h_img - 1 - i), (80, 180, 255), 1)
    for yv in range(int(np.ceil(y_lo)), int(np.floor(y_hi)) + 1):
        r = h_img - 1 - int((yv - y_lo) / 0.02)
        cv2.line(img, (0, r), (w_img - 1, r), (255, 255, 255) if yv == 0 else (90, 90, 90), 1)
        cv2.putText(img, f"y={yv}", (w_img - 70, r - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
    cv2.imwrite(str(out / "height_profile.png"), img)

    print(f"[debug_views] wrote {sorted(p.name for p in out.glob('*.png'))} to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
