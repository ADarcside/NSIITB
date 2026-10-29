"""
Namma Space: A/B variants of a published scene to find where black blotches come from (not a pipeline stage).

Writes three extra viewer scenes next to the published one, each with the same transform:
  <scene>_sh0   clean.ply with view-dependent colour (f_rest_*) zeroed: tests SH going dark from new angles
  <scene>_opa0  splat.ply cut to S06's room box only, no opacity/size cleanup: tests the cleanup filters
  <scene>_raw   splat.ply untouched: what training produced

Usage: python -m pipeline.diag_variants --run-dir runs/room_v1 --viewer-public viewer/public
Open http://localhost:5173/?scene=<scene>_sh0 (etc.) and compare the same spot.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Optional

import numpy as np

from pipeline import normalize as nz
from pipeline.stages.s05_export import read_ply_gaussians_numpy
from pipeline.stages.s07_compress import convert_ply_to_spz, write_ply_subset
from pipeline.common import sha256_file


def publish_variant(scene_dir: Path, out_dir: Path, ply: Path, gaussians: int) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    spz = out_dir / "full.spz"
    convert_ply_to_spz(ply, spz)
    man = json.loads((scene_dir / "manifest.json").read_text())
    entry = {"sha256": sha256_file(spz), "bytes": spz.stat().st_size, "gaussians": gaussians, "uri": "full.spz"}
    for asset_id in man["asset_table"]:
        man["asset_table"][asset_id].update(entry)  # lite points at the same file
    (out_dir / "manifest.json").write_text(json.dumps(man, indent=2))
    print(f"[diag] {out_dir.name}: {gaussians:,} Gaussians, {entry['bytes'] / 1e6:.1f} MB")


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="A/B variants of a published scene")
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--viewer-public", default="viewer/public")
    args = ap.parse_args(argv)

    run = Path(args.run_dir)
    scene_dir = next((run / "publish").iterdir())
    public = Path(args.viewer_public)
    work = run / "diag"
    work.mkdir(exist_ok=True)

    # sh0: clean.ply without view-dependent colour
    ply = read_ply_gaussians_numpy(run / "clean.ply")
    data, names = ply["data"].copy(), ply["property_names"]
    rest = [i for i, n in enumerate(names) if n.startswith("f_rest_")]
    data[:, rest] = 0.0
    write_ply_subset(run / "clean.ply", work / "sh0.ply", data, np.arange(len(data)))
    publish_variant(scene_dir, public / f"{scene_dir.name}_sh0", work / "sh0.ply", len(data))

    # opa0 and raw: from splat.ply
    tr = json.loads((run / "transform.json").read_text())
    m = np.asarray(tr["world_from_splat"], dtype=np.float64).reshape(4, 4).T
    ply = read_ply_gaussians_numpy(run / "splat.ply")
    data, names = ply["data"], ply["property_names"]
    idx = {n: i for i, n in enumerate(names)}
    xyz = nz.apply(m, data[:, [idx["x"], idx["y"], idx["z"]]].astype(np.float64))
    lo = np.asarray(tr["metrics"]["room_box_min"])
    hi = np.asarray(tr["metrics"]["room_box_max"])
    keep = np.flatnonzero(np.all((xyz >= lo) & (xyz <= hi), axis=1))
    write_ply_subset(run / "splat.ply", work / "opa0.ply", data, keep)
    publish_variant(scene_dir, public / f"{scene_dir.name}_opa0", work / "opa0.ply", len(keep))
    publish_variant(scene_dir, public / f"{scene_dir.name}_raw", run / "splat.ply", len(data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
