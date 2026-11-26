"""
Namma Space: drop COLMAP cameras that were placed far away from the walk (S03, after Gate G3).

A global mapper can register a few frames with wild poses: hundreds of metres from a room a few metres
across (room 3: 55 of 1,384). Training then fits junk to them, and the far junk and blurred room cost
sharpness. A camera is "far" when it sits past a jump in the sorted distances from the median camera
(see far_cameras). Distances are relative to the median distance, so it works in COLMAP's arbitrary units,
the median stays put even when many poses are wild, and a long real walk (a corridor) has no jump.
K-720 and room 3: the real walk reaches 1.7x and 2.1x the median; wild poses start at 3.3x (10 of 1,390)
and 5.1x (56 of 1,384).

The model is edited as text (cameras.txt, images.txt, points3D.txt, frames.txt):
  - far images are removed; kept images keep their lines, with POINT3D_IDs of dropped points set to -1;
  - their observations leave every point track, and points seen by fewer than 2 kept images are dropped;
  - .bin files are removed from the edited folder so every reader uses the edited text model.
The untouched model is kept first in <colmap>/sparse_unpruned/<name>.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple, Union

import numpy as np


def _qvec_to_R(q: List[float]) -> np.ndarray:
    w, x, y, z = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def _image_pairs(lines: List[str]) -> Tuple[List[str], List[Tuple[str, str]]]:
    """(header comment lines, [(pose line, points line)]) from images.txt lines."""
    head = [ln for ln in lines if ln.startswith("#")]
    body = [ln for ln in lines if not ln.startswith("#")]
    pairs = []
    i = 0
    while i < len(body):
        if not body[i].strip():
            i += 1
            continue
        pose = body[i]
        pts = body[i + 1] if i + 1 < len(body) else ""
        pairs.append((pose, pts))
        i += 2
    return head, pairs


def far_cameras(centres: np.ndarray, factor: float = 3.0, gap: float = 1.5) -> np.ndarray:
    """Boolean mask of wild camera poses: past a jump in the sorted distances from the median camera.

    The real walk is continuous, so its sorted distances rise smoothly, even down a long corridor. Wild poses
    sit apart: K-720 jumps from 1.7x to 3.3x the median distance, room 3 from 2.1x to 5.1x. A camera is far
    when it lies beyond the first jump of more than gap (1.5x) between neighbouring sorted distances
    that lands past factor (3x) the median."""
    n = len(centres)
    if n < 10:
        return np.zeros(n, bool)
    r = np.linalg.norm(centres - np.median(centres, axis=0), axis=1)
    med = float(np.median(r))
    rs = np.sort(r)
    for i in range(1, n):
        if rs[i - 1] >= med and rs[i] > factor * med and rs[i] > gap * max(rs[i - 1], 1e-12):
            return r >= rs[i]
    return np.zeros(n, bool)


def prune_far_cameras(model_dir: Union[str, Path], factor: float = 3.0, max_ratio: float = 0.10) -> Dict[str, Any]:
    """Drops far cameras in place (see the module doc). More than max_ratio of them far: the model is left
    untouched and stats["refused"] is True (S03 stops: that is a broken model, not a few stray poses)."""
    model = Path(model_dir)
    images_txt = model / "images.txt"
    lines = images_txt.read_text(encoding="utf-8").splitlines()
    head, pairs = _image_pairs(lines)
    ids, centres = [], []
    for pose, _ in pairs:
        p = pose.split()
        q = [float(v) for v in p[1:5]]
        t = np.array([float(v) for v in p[5:8]])
        ids.append(int(p[0]))
        centres.append(-_qvec_to_R(q).T @ t)
    centres_a = np.asarray(centres)
    far = far_cameras(centres_a, factor)
    stats: Dict[str, Any] = {"far_camera_factor": factor, "cameras_in": len(ids), "far_cameras_dropped": int(far.sum())}
    if not far.any():
        return stats
    if far.sum() > max_ratio * len(ids):
        stats["refused"] = True
        return stats
    r = np.linalg.norm(centres_a - np.median(centres_a, axis=0), axis=1)
    stats["far_distance_ratio_min"] = round(float(r[far].min() / np.median(r)), 2)
    drop: Set[int] = {i for i, f in zip(ids, far) if f}

    backup = model.parent.parent / f"{model.parent.name}_unpruned" / model.name
    if not backup.exists():
        shutil.copytree(model, backup)
    stats["unpruned_copy"] = str(backup)

    # points3D: remove dropped images from tracks, drop points left with fewer than 2 views
    p3_txt = model / "points3D.txt"
    dead: Set[int] = set()
    out_pts: List[str] = []
    n_pts = 0
    for ln in p3_txt.read_text(encoding="utf-8").splitlines():
        if ln.startswith("#") or not ln.strip():
            out_pts.append(ln)
            continue
        p = ln.split()
        n_pts += 1
        tr = p[8:]
        keep = [(tr[k], tr[k + 1]) for k in range(0, len(tr) - 1, 2) if int(tr[k]) not in drop]
        if len(keep) < 2:
            dead.add(int(p[0]))
            continue
        out_pts.append(" ".join(p[:8] + [v for pair in keep for v in pair]))
    stats.update({"points_in": n_pts, "points_dropped": len(dead)})

    # images: remove far images, unlink dropped points from kept ones
    out_img = list(head)
    for (pose, pts), iid in zip(pairs, ids):
        if iid in drop:
            continue
        v = pts.split()
        for k in range(2, len(v), 3):
            if v[k] != "-1" and int(v[k]) in dead:
                v[k] = "-1"
        out_img += [pose, " ".join(v)]
    images_txt.write_text("\n".join(out_img) + "\n", encoding="utf-8")
    p3_txt.write_text("\n".join(out_pts) + "\n", encoding="utf-8")

    # COLMAP 4 frames.txt: FRAME_ID RIG_ID NUM_DATA_IDS (SENSOR_TYPE SENSOR_ID DATA_ID)*
    fr = model / "frames.txt"
    if fr.is_file():
        out_fr = []
        for ln in fr.read_text(encoding="utf-8").splitlines():
            p = ln.split()
            if ln.startswith("#") or len(p) < 6:
                out_fr.append(ln)
                continue
            data = p[3:]
            cams = {int(data[k + 2]) for k in range(0, len(data) - 2, 3) if data[k].upper() == "CAMERA"}
            if cams & drop:
                continue
            out_fr.append(ln)
        fr.write_text("\n".join(out_fr) + "\n", encoding="utf-8")

    for b in model.glob("*.bin"):
        b.unlink()
    stats["cameras_kept"] = len(ids) - len(drop)
    return stats
