"""
Namma Space: walkable floor grid (NavGrid) from a normalized splat. NumPy + OpenCV only.

World frame from S06: metres, +Y up, floor at y=0. One cell per cell_m x cell_m on the floor.
  1. Every Gaussian with opacity >= min_opacity whose centre is in the body height band
     (beds, tables, walls) adds its opacity to its cell.
  2. A cell is an obstacle when that sum >= occupied_opacity_sum. Blobs smaller than
     min_obstacle_m2 are dropped (mid-air floaters in the aisle).
  3. Obstacles grow by agent_radius_m, and everything outside the viewer bounds (walls) is
     blocked.
  4. Only the free area connected to the start point is kept.
Bits are row-major (row = z, column = x) and MSB first, which is what viewer/src/collision/grid.ts reads.

Height layers (for flying/crouching with Q/E): the same cells sliced into dy-thick height layers. A cell in
a layer is occupied when the opacity of the Gaussians in that slice reaches layers.occupied_opacity_sum
(small specks dropped), and everything outside the viewer bounds is occupied in every layer. Bits are
ordered layer, row, column (MSB first). Layers are not dilated: the viewer adds its own flying radius.
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import cv2
import numpy as np


def occupancy_counts(world_xyz: np.ndarray, opacity: np.ndarray, origin: Tuple[float, float], width: int,
                     height: int, cell_m: float, band: Tuple[float, float], min_opacity: float) -> np.ndarray:
    sel = (world_xyz[:, 1] > band[0]) & (world_xyz[:, 1] < band[1]) & (opacity >= min_opacity)
    col = np.floor((world_xyz[sel, 0] - origin[0]) / cell_m).astype(np.int64)
    row = np.floor((world_xyz[sel, 2] - origin[1]) / cell_m).astype(np.int64)
    ok = (col >= 0) & (col < width) & (row >= 0) & (row < height)
    counts = np.zeros((height, width), dtype=np.float64)
    np.add.at(counts, (row[ok], col[ok]), opacity[sel][ok])
    return counts


def drop_small_blobs(occ: np.ndarray, min_blob: int, keep: Optional[np.ndarray] = None) -> np.ndarray:
    """Removes 8-connected blobs smaller than min_blob cells, except blobs touching a keep cell."""
    occ = occ.astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(occ, connectivity=8)
    small = stats[:, cv2.CC_STAT_AREA] < min_blob
    small[0] = False
    if keep is not None and small.any():
        small[np.unique(lab[keep & (occ > 0)])] = False
    occ[small[lab]] = 0
    return occ


def tall_cells(world_xyz: np.ndarray, opacity: np.ndarray, origin: Tuple[float, float], width: int, height: int,
               cell: float, layers_cfg: Dict[str, Any], band: Tuple[float, float]) -> np.ndarray:
    """Cells solid in at least tall_min_layers of the height slices inside band: thin posts and rods.
    A bunk rod is only a cell or two wide, so the area filter alone would drop it as a floater."""
    y0, dy = float(layers_cfg.get("y0_m", 0.1)), float(layers_cfg.get("dy_m", 0.1))
    thr = float(layers_cfg.get("occupied_opacity_sum", 1.5))
    min_op = float(layers_cfg.get("min_opacity", 0.2))
    need = int(layers_cfg.get("tall_min_layers", 4))
    hits = np.zeros((height, width), dtype=np.int32)
    lo = max(band[0], y0)
    k = 0
    while lo + k * dy < band[1]:
        a = lo + k * dy
        hits += occupancy_counts(world_xyz, opacity, origin, width, height, cell, (a, min(a + dy, band[1])), min_op) >= thr
        k += 1
    return hits >= need


def to_cell(x: float, z: float, origin: Tuple[float, float], cell_m: float) -> Tuple[int, int]:
    return int(np.floor((z - origin[1]) / cell_m)), int(np.floor((x - origin[0]) / cell_m))


def build_free_mask(
    world_xyz: np.ndarray,
    opacity: np.ndarray,
    bounds: Dict[str, float],
    start_xz: Tuple[float, float],
    cfg: Dict[str, Any],
    path_xz: Optional[np.ndarray] = None,
) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Returns (free mask [height, width] bool, grid metadata + stats)."""
    cell = float(cfg.get("cell_m", 0.05))
    band = tuple(float(v) for v in cfg.get("height_band_m", [0.2, 1.7]))
    radius = float(cfg.get("agent_radius_m", 0.25))
    thr = float(cfg.get("occupied_opacity_sum", 6.0))
    min_op = float(cfg.get("min_opacity", 0.2))
    min_blob = max(1, int(round(float(cfg.get("min_obstacle_m2", 0.05)) / (cell * cell))))

    # Grid covers the bounds plus the agent radius (bounds are already inset from the walls)
    origin = (bounds["minX"] - radius, bounds["minZ"] - radius)
    width = int(np.ceil((bounds["maxX"] - bounds["minX"] + 2 * radius) / cell))
    height = int(np.ceil((bounds["maxZ"] - bounds["minZ"] + 2 * radius) / cell))

    counts = occupancy_counts(world_xyz, opacity, origin, width, height, cell, band, min_op)
    tall = tall_cells(world_xyz, opacity, origin, width, height, cell, cfg.get("layers", {}), band)
    occ = drop_small_blobs((counts >= thr) | tall, min_blob, tall)

    r = max(1, int(round(radius / cell)))
    blocked = cv2.dilate(occ, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))) > 0
    xs = origin[0] + (np.arange(width) + 0.5) * cell
    zs = origin[1] + (np.arange(height) + 0.5) * cell
    inside = ((xs >= bounds["minX"]) & (xs <= bounds["maxX"]))[None, :] & \
             ((zs >= bounds["minZ"]) & (zs <= bounds["maxZ"]))[:, None]
    free = (~blocked) & inside

    # Keep the free area connected to the start (nearest free cell if the start itself is blocked)
    sr, sc = to_cell(start_xz[0], start_xz[1], origin, cell)
    start_free = bool(0 <= sr < height and 0 <= sc < width and free[sr, sc])
    if not start_free and free.any():
        rr, cc = np.nonzero(free)
        i = int(np.argmin((rr - sr) ** 2 + (cc - sc) ** 2))
        sr, sc = int(rr[i]), int(cc[i])
    if free.any():
        _, comp = cv2.connectedComponents(free.astype(np.uint8), connectivity=4)
        free = comp == comp[sr, sc]

    meta: Dict[str, Any] = {
        "cell_m": cell,
        "origin": [round(origin[0], 4), round(origin[1], 4)],
        "width": width,
        "height": height,
        "agent_radius_m": radius,
        "grid_free_m2": round(float(free.sum()) * cell * cell, 2),
        "grid_obstacle_m2": round(float(occ.sum()) * cell * cell, 2),
        "grid_start_free": start_free,
        "grid_start_xz": [round(origin[0] + (sc + 0.5) * cell, 3), round(origin[1] + (sr + 0.5) * cell, 3)],
    }
    if path_xz is not None and len(path_xz):
        pr = np.floor((path_xz[:, 1] - origin[1]) / cell).astype(np.int64)
        pc = np.floor((path_xz[:, 0] - origin[0]) / cell).astype(np.int64)
        ok = (pr >= 0) & (pr < height) & (pc >= 0) & (pc < width)
        meta["grid_path_free_pct"] = round(100.0 * float(free[pr[ok], pc[ok]].mean()) if ok.any() else 0.0, 1)
    return free, meta


def build_layers(world_xyz: np.ndarray, opacity: np.ndarray, meta: Dict[str, Any], bounds: Dict[str, float],
                 cfg: Dict[str, Any]) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Returns (occupied [layers, height, width] bool, layer metadata) on the same cells as build_free_mask."""
    cell, width, height = float(meta["cell_m"]), int(meta["width"]), int(meta["height"])
    origin = (float(meta["origin"][0]), float(meta["origin"][1]))
    y0 = float(cfg.get("y0_m", 0.1))
    dy = float(cfg.get("dy_m", 0.1))
    count = max(1, int(round((float(cfg.get("top_m", 2.9)) - y0) / dy)))
    thr = float(cfg.get("occupied_opacity_sum", 1.5))
    min_op = float(cfg.get("min_opacity", 0.2))
    min_blob = max(1, int(round(float(cfg.get("min_obstacle_m2", 0.02)) / (cell * cell))))

    xs = origin[0] + (np.arange(width) + 0.5) * cell
    zs = origin[1] + (np.arange(height) + 0.5) * cell
    inside = ((xs >= bounds["minX"]) & (xs <= bounds["maxX"]))[None, :] & \
             ((zs >= bounds["minZ"]) & (zs <= bounds["maxZ"]))[:, None]
    raw = np.stack([occupancy_counts(world_xyz, opacity, origin, width, height, cell,
                                     (y0 + i * dy, y0 + (i + 1) * dy), min_op) >= thr for i in range(count)])
    # Vertically persistent cells (rods, posts, bed legs) survive the speck filter in every layer
    need = int(cfg.get("tall_min_layers", 4))
    run = np.zeros((height, width), dtype=np.int32)
    longest = np.zeros((height, width), dtype=np.int32)
    for i in range(count):
        run = np.where(raw[i], run + 1, 0)
        longest = np.maximum(longest, run)
    tall = longest >= need
    occ = np.zeros((count, height, width), dtype=bool)
    for i in range(count):
        layer = drop_small_blobs(raw[i], min_blob, tall)
        occ[i] = (layer > 0) | ~inside
    occupied_in = occ[:, inside].mean(axis=1) if inside.any() else np.zeros(count)
    layer_meta = {"y0_m": round(y0, 4), "dy_m": round(dy, 4), "count": count}
    stats_out = {"grid_layers": count,
                 "grid_layer_occupied_pct": [round(100.0 * float(v), 1) for v in occupied_in]}
    return occ, {**layer_meta, **stats_out}


def write_layers_preview(path: Path, occ: np.ndarray, y0: float, dy: float, heights=(0.3, 0.6, 0.9, 1.2, 1.5, 1.8, 2.1, 2.4),
                         px: int = 2) -> None:
    """Top-down tiles of the height layers: white = occupied, black = open. Labelled with the slice height."""
    tiles = []
    for h in heights:
        i = int(np.floor((h - y0) / dy))
        if not 0 <= i < len(occ):
            continue
        t = np.where(occ[i], 255, 0).astype(np.uint8)
        t = cv2.resize(cv2.cvtColor(t, cv2.COLOR_GRAY2BGR), None, fx=px, fy=px, interpolation=cv2.INTER_NEAREST)
        cv2.putText(t, f"{y0 + i * dy:.1f}-{y0 + (i + 1) * dy:.1f} m", (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 200, 255), 1)
        tiles.append(cv2.copyMakeBorder(t, 2, 2, 2, 2, cv2.BORDER_CONSTANT, value=(80, 80, 80)))
    if not tiles:
        return
    while len(tiles) % 4:
        tiles.append(np.zeros_like(tiles[0]))
    rows = [np.hstack(tiles[k:k + 4]) for k in range(0, len(tiles), 4)]
    cv2.imwrite(str(path), np.vstack(rows))


def encode_free_bits(free: np.ndarray) -> str:
    return base64.b64encode(np.packbits(free.astype(np.uint8).ravel(), bitorder="big").tobytes()).decode("ascii")


def decode_free_bits(b64: str, width: int, height: int) -> np.ndarray:
    bits = np.unpackbits(np.frombuffer(base64.b64decode(b64), dtype=np.uint8), bitorder="big")
    return bits[: width * height].reshape(height, width).astype(bool)


def write_preview(path: Path, free: np.ndarray, path_cells: Optional[np.ndarray] = None, px: int = 4) -> None:
    """Top-down picture: grey = walkable, black = blocked, green = where the camera went. Row 0 at the top (z grows down)."""
    img = np.zeros(free.shape + (3,), dtype=np.uint8)
    img[free] = (150, 150, 150)
    if path_cells is not None and len(path_cells):
        img[path_cells[:, 0], path_cells[:, 1]] = (0, 220, 0)
    cv2.imwrite(str(path), cv2.resize(img, None, fx=px, fy=px, interpolation=cv2.INTER_NEAREST))
