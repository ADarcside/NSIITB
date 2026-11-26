"""
Tape marks without the COLMAP desktop GUI: writes and checks runs/<run>/marks_2d.json.

S06 takes the scale from the "scale" tape pair in capture.json and measures the "check" pair
against it. Until now the marks could only be clicked in `colmap gui`, so on room 2 the tape
check never ran and a 1.8x stretch along the room went unnoticed.

  # Printed ArUco markers (fully automatic). Print the sheet, put each marker's centre on a
  # tape cross (A, B, C, D), film them from 2+ angles, then after S03:
  python -m pipeline.tools.marks sheet --out marker_sheet
  python -m pipeline.tools.marks aruco --run-dir runs/<run>

  # Plain masking-tape crosses: read the pixel (u, v) of the cross centre in any image viewer
  # (Paint, GIMP, Photos) in 2+ registered frames each, and add them one by one:
  python -m pipeline.tools.marks add --run-dir runs/<run> --label A --frame frame_000123.jpg --u 812 --v 640

  # Measure every tape pair in the model (after S06 for metres, any time after S03 for ratios):
  python -m pipeline.tools.marks check --run-dir runs/<run> --capture capture.json

Lay one pair along the room's length and one across it: a stretch along one axis then shows up
as a check error. Re-run S06 (--stages s06,s07,s08) after writing marks.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any, Dict, List, Optional

import numpy as np

from pipeline import normalize as nz
from pipeline.stages.s03_poses import parse_cameras_txt, parse_images_txt

MARKS_NAME = "marks_2d.json"
DEFAULT_LABELS = {0: "A", 1: "B", 2: "C", 3: "D"}


def _sparse(run_dir: Path):
    sparse = run_dir / "colmap" / "sparse" / "0"
    cameras = parse_cameras_txt(sparse / "cameras.txt")
    images = parse_images_txt(sparse / "images.txt")
    if not images:
        raise SystemExit(f"No COLMAP model in {sparse}: run S03 first")
    return cameras, {img["name"]: img for img in images.values()}


def load_marks(path: Path) -> Dict[str, List[Dict[str, Any]]]:
    if path.is_file():
        return json.loads(path.read_text()).get("marks", {})
    return {}


def save_marks(path: Path, marks: Dict[str, List[Dict[str, Any]]]) -> None:
    path.write_text(json.dumps({"schema_version": 1, "marks": marks}, indent=1))


def add_mark(run_dir: Path, label: str, frame: str, u: float, v: float) -> Dict[str, List[Dict[str, Any]]]:
    cameras, by_name = _sparse(run_dir)
    img = by_name.get(frame)
    if img is None:
        raise SystemExit(f"{frame} is not a registered frame (COLMAP skipped it); pick another frame")
    cam = cameras[img["camera_id"]]
    if not (0 <= u < cam["width"] and 0 <= v < cam["height"]):
        raise SystemExit(f"({u}, {v}) is outside the {cam['width']}x{cam['height']} frame")
    path = run_dir / MARKS_NAME
    marks = load_marks(path)
    obs = [o for o in marks.get(label, []) if o["frame"] != frame]
    obs.append({"frame": frame, "u": float(u), "v": float(v)})
    marks[label] = obs
    save_marks(path, marks)
    return marks


def detect_aruco(run_dir: Path, labels: Dict[int, str], dictionary: str = "DICT_4X4_50",
                 max_per_mark: int = 8, min_side_px: float = 30.0) -> Dict[str, List[Dict[str, Any]]]:
    """Finds printed ArUco markers in the registered frames; each marker's centre becomes a mark."""
    import cv2

    _, by_name = _sparse(run_dir)
    frames_dir = run_dir / "frames"
    detector = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, dictionary)),
                                       cv2.aruco.DetectorParameters())
    found: Dict[str, List[Dict[str, Any]]] = {}
    for name in sorted(by_name):
        img = cv2.imread(str(frames_dir / name), cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        corners, ids, _ = detector.detectMarkers(img)
        if ids is None:
            continue
        for c, i in zip(corners, ids.ravel()):
            label = labels.get(int(i))
            if label is None:
                continue
            pts = c.reshape(4, 2).astype(np.float64)
            side = float(np.mean(np.linalg.norm(pts - np.roll(pts, 1, axis=0), axis=1)))
            if side < min_side_px:
                continue
            centre = pts.mean(axis=0)
            found.setdefault(label, []).append({"frame": name, "u": float(centre[0]), "v": float(centre[1]), "side_px": side})
    marks: Dict[str, List[Dict[str, Any]]] = {}
    for label, obs in found.items():
        # Largest views first, then spread over the video (different angles triangulate better)
        obs.sort(key=lambda o: -o["side_px"])
        keep = obs[:max_per_mark * 3]
        keep.sort(key=lambda o: o["frame"])
        step = max(1, len(keep) // max_per_mark)
        marks[label] = [{k: o[k] for k in ("frame", "u", "v")} for o in keep[::step][:max_per_mark]]
    return marks


def write_sheet(out_dir: Path, ids: List[int], labels: Dict[int, str], size_px: int = 1200,
                dictionary: str = "DICT_4X4_50") -> List[Path]:
    import cv2

    out_dir.mkdir(parents=True, exist_ok=True)
    d = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, dictionary))
    paths = []
    for i in ids:
        marker = cv2.aruco.generateImageMarker(d, i, size_px)
        pad = size_px // 6
        page = np.full((size_px + 3 * pad, size_px + 2 * pad), 255, np.uint8)
        page[pad:pad + size_px, pad:pad + size_px] = marker
        text = f"{labels.get(i, str(i))}  (ArUco {i}) - centre on the tape cross, flat on the floor"
        cv2.putText(page, text, (pad, size_px + 2 * pad), cv2.FONT_HERSHEY_SIMPLEX, size_px / 1100, 0, 3)
        p = out_dir / f"marker_{labels.get(i, str(i))}_{i}.png"
        cv2.imwrite(str(p), page)
        paths.append(p)
    return paths


def measure_pairs(run_dir: Path, capture: Dict[str, Any],
                  marks: Optional[Dict[str, List[Dict[str, Any]]]] = None) -> Dict[str, Any]:
    """
    Triangulates every mark and measures every tape pair. Metres come from S06's transform.json
    (if present); otherwise only the ratios between pairs are known, which is enough to see a stretch.
    """
    cameras, by_name = _sparse(run_dir)
    marks = marks if marks is not None else load_marks(run_dir / MARKS_NAME)
    pts: Dict[str, np.ndarray] = {}
    problems: List[str] = []
    for label, obs in marks.items():
        try:
            pts[label] = nz.triangulate_mark(obs, by_name, cameras)
        except ValueError as e:
            problems.append(f"{label}: {e}")
    to_m = None
    tr_path = run_dir / "transform.json"
    if tr_path.is_file():
        tr = json.loads(tr_path.read_text())
        frame = tr.get("metrics", {}).get("colmap_frame")
        dps = sorted(run_dir.glob("**/dataparser_transforms.json"), key=lambda p: p.stat().st_mtime)
        if frame and dps:
            dp = json.loads(dps[-1].read_text())
            ident = {"transform": np.eye(4)[:3].tolist(), "scale": 1.0}
            src, flip = {"dataparser+flip": (dp, True), "dataparser": (dp, False),
                         "flip_only": (ident, True), "colmap_raw": (ident, False)}[frame]
            t, s = nz.dataparser_matrix(src, flip)
            m = np.asarray(tr["world_from_splat"], dtype=np.float64).reshape(4, 4).T
            to_m = lambda p: nz.apply(m, nz.colmap_to_splat_points(p.reshape(1, 3), t, s))[0]
    rows = []
    for pair in capture.get("scale_pairs", []):
        a, b = pair["a"], pair["b"]
        if a not in pts or b not in pts:
            rows.append({**pair, "status": "missing marks"})
            continue
        row = {**pair, "model_units": float(np.linalg.norm(pts[a] - pts[b]))}
        if to_m is not None:
            row["measured_m"] = round(float(np.linalg.norm(to_m(pts[a]) - to_m(pts[b]))), 3)
            row["error_pct"] = round(abs(row["measured_m"] - pair["distance_m"]) / pair["distance_m"] * 100, 2)
        rows.append(row)
    # Ratio check without metres: every pair against the scale pair
    ref = next((r for r in rows if r.get("role") == "scale" and "model_units" in r), None)
    if ref:
        k = ref["distance_m"] / ref["model_units"]
        for r in rows:
            if "model_units" in r:
                r["vs_scale_pair_m"] = round(k * r["model_units"], 3)
                r["vs_scale_pair_error_pct"] = round(abs(k * r["model_units"] - r["distance_m"]) / r["distance_m"] * 100, 2)
    return {"pairs": rows, "problems": problems, "metres_from_transform": to_m is not None}


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Tape marks for S06 without the COLMAP GUI")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add", help="add one mark observation (pixel read off a frame)")
    a.add_argument("--run-dir", required=True)
    a.add_argument("--label", required=True)
    a.add_argument("--frame", required=True)
    a.add_argument("--u", type=float, required=True)
    a.add_argument("--v", type=float, required=True)
    r = sub.add_parser("aruco", help="detect printed ArUco markers in the frames and write marks_2d.json")
    r.add_argument("--run-dir", required=True)
    r.add_argument("--labels", default="0=A,1=B,2=C,3=D", help="marker id to tape label")
    r.add_argument("--max-per-mark", type=int, default=8)
    s = sub.add_parser("sheet", help="write printable marker PNGs")
    s.add_argument("--out", required=True)
    s.add_argument("--labels", default="0=A,1=B,2=C,3=D")
    s.add_argument("--size-px", type=int, default=1200)
    c = sub.add_parser("check", help="measure every tape pair in the model")
    c.add_argument("--run-dir", required=True)
    c.add_argument("--capture", required=True)
    args = ap.parse_args(argv)

    def labels(text: str) -> Dict[int, str]:
        return {int(k): v for k, v in (p.split("=") for p in text.split(","))}

    if args.cmd == "add":
        marks = add_mark(Path(args.run_dir), args.label, args.frame, args.u, args.v)
        print(json.dumps({k: len(v) for k, v in marks.items()}), "frames per mark (each needs 2+)")
    elif args.cmd == "aruco":
        run = Path(args.run_dir)
        marks = detect_aruco(run, labels(args.labels), max_per_mark=args.max_per_mark)
        short = [k for k, v in marks.items() if len(v) < 2]
        missing = [v for v in labels(args.labels).values() if v not in marks]
        for k in short:
            marks.pop(k)
        save_marks(run / MARKS_NAME, marks)
        print(json.dumps({k: len(v) for k, v in marks.items()}), "frames per mark ->", run / MARKS_NAME)
        if short or missing:
            print(f"Not usable (seen in < 2 frames or never): {short + missing}", file=sys.stderr)
            return 1
    elif args.cmd == "sheet":
        for p in write_sheet(Path(args.out), sorted(labels(args.labels)), labels(args.labels), args.size_px):
            print(p)
        print("Print at 100% (one per A4 page). Keep them flat and still while filming.")
    elif args.cmd == "check":
        out = measure_pairs(Path(args.run_dir), json.loads(Path(args.capture).read_text()))
        print(json.dumps(out, indent=1))
        bad = [p for p in out["pairs"] if p.get("error_pct", p.get("vs_scale_pair_error_pct", 0)) > 2.0
               or p.get("status")]
        return 1 if bad or out["problems"] else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
