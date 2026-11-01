"""
Namma Space: Points of Interest (POI) Tool (Round 2)
Provides CLI subcommands:
  - attach: attach pois.json to a published scene and register it in manifest.json
  - check:  validate and inspect POIs in a scene, checking walkability against grid.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any, Dict

from pipeline.common import sha256_file
from pipeline.grid import decode_free_bits, to_cell
from pipeline.validator import (
    ValidationError,
    load_and_validate_manifest,
    load_and_validate_pois,
    validate_manifest,
    validate_pois,
)


def _format_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f} MB"


def attach_pois(scene_dir: str | Path, pois_path: str | Path, fix_scene_id: bool = False) -> None:
    scene_dir = Path(scene_dir).resolve()
    pois_path = Path(pois_path).resolve()

    if not scene_dir.is_dir():
        sys.exit(f"Error: Scene directory '{scene_dir}' does not exist.")
    manifest_path = scene_dir / "manifest.json"
    if not manifest_path.is_file():
        sys.exit(f"Error: manifest.json not found in '{scene_dir}'.")
    if not pois_path.is_file():
        sys.exit(f"Error: POI file '{pois_path}' does not exist.")

    manifest = load_and_validate_manifest(manifest_path)
    pois_data = load_and_validate_pois(pois_path)

    manifest_scene_id = manifest["scene_id"]
    pois_scene_id = pois_data.get("scene_id")

    if pois_scene_id != manifest_scene_id:
        if fix_scene_id:
            pois_data["scene_id"] = manifest_scene_id
            for poi in pois_data.get("pois", []):
                poi["scene_id"] = manifest_scene_id
            validate_pois(pois_data)
        else:
            sys.exit(
                f"Error: Scene ID mismatch: pois.json has '{pois_scene_id}' but manifest has '{manifest_scene_id}'. "
                "Pass --fix-scene-id to rewrite."
            )

    dest_pois_path = scene_dir / "pois.json"
    with open(dest_pois_path, "w", encoding="utf-8") as f:
        json.dump(pois_data, f, indent=2)
        f.write("\n")

    file_bytes = dest_pois_path.stat().st_size
    file_hash = sha256_file(dest_pois_path)

    # Reuse existing asset id or generate new one matching ast_[a-z2-7]{12}
    existing_asset_id = manifest.get("assets", {}).get("pois")
    if existing_asset_id and existing_asset_id in manifest.get("asset_table", {}):
        pois_asset_id = existing_asset_id
    else:
        # e.g. scn_hostelroomac -> body is hostelroomac (12 chars) -> ast_hostelroomps (16 chars)
        scene_body = manifest_scene_id[4:]
        pois_asset_id = f"ast_{scene_body[:10]}ps"

    if "assets" not in manifest:
        manifest["assets"] = {}
    manifest["assets"]["pois"] = pois_asset_id

    if "asset_table" not in manifest:
        manifest["asset_table"] = {}
    manifest["asset_table"][pois_asset_id] = {
        "schema_version": 1,
        "asset_id": pois_asset_id,
        "kind": "pois",
        "format": "json",
        "uri": "pois.json",
        "sha256": file_hash,
        "bytes": file_bytes,
    }

    validate_manifest(manifest)

    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    num_pois = len(pois_data.get("pois", []))
    size_str = _format_size(file_bytes)
    print(f"attached {num_pois} POIs to {manifest_scene_id} (pois.json {size_str})")


def check_pois(scene_dir: str | Path) -> None:
    scene_dir = Path(scene_dir).resolve()
    if not scene_dir.is_dir():
        sys.exit(f"Error: Scene directory '{scene_dir}' does not exist.")

    manifest_path = scene_dir / "manifest.json"
    if not manifest_path.is_file():
        sys.exit(f"Error: manifest.json not found in '{scene_dir}'.")
    manifest = load_and_validate_manifest(manifest_path)

    pois_path = scene_dir / "pois.json"
    if not pois_path.is_file():
        sys.exit(f"Error: pois.json not found in '{scene_dir}'.")
    pois_data = load_and_validate_pois(pois_path)

    grid_path = scene_dir / "grid.json"
    grid_data: Dict[str, Any] | None = None
    free_mask = None
    if grid_path.is_file():
        with open(grid_path, "r", encoding="utf-8") as f:
            grid_data = json.load(f)
        try:
            free_mask = decode_free_bits(
                grid_data["free_bits_b64"],
                grid_data["width"],
                grid_data["height"],
            )
        except Exception as e:
            print(f"Warning: Failed to decode grid.json: {e}", file=sys.stderr)

    scene_id = manifest["scene_id"]
    pois = pois_data.get("pois", [])
    print(f"Scene: {scene_id} ({len(pois)} POIs)")

    for poi in pois:
        name = poi.get("name", "<unnamed>")
        pos = poi.get("position", {})
        x = pos.get("x", 0.0)
        z = pos.get("z", 0.0)

        if grid_data is not None and free_mask is not None:
            if isinstance(grid_data["origin"], (list, tuple)):
                origin = (grid_data["origin"][0], grid_data["origin"][1])
            else:
                origin = (grid_data["origin"]["x"], grid_data["origin"]["z"])
            cell_m = grid_data.get("cell_size_m", grid_data.get("cell_m", 0.05))
            row, col = to_cell(x, z, origin, cell_m)
            height, width = free_mask.shape
            if 0 <= row < height and 0 <= col < width and free_mask[row, col]:
                status = "walkable"
            else:
                status = "not on walkable floor"
        else:
            status = "no grid"

        print(f"  - {name} ({x:.2f}, {z:.2f}) [{status}]")


def main() -> None:
    parser = argparse.ArgumentParser(description="Points of Interest (POI) management tool.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Subcommand: attach
    attach_parser = subparsers.add_parser("attach", help="Attach pois.json to a scene.")
    attach_parser.add_argument("scene_dir", help="Path to published scene directory containing manifest.json")
    attach_parser.add_argument("pois_path", help="Path to pois.json file to attach")
    attach_parser.add_argument(
        "--fix-scene-id",
        action="store_true",
        help="Rewrite scene_id in pois.json and each POI if it does not match manifest",
    )

    # Subcommand: check
    check_parser = subparsers.add_parser("check", help="Check and inspect POIs in a scene.")
    check_parser.add_argument("scene_dir", help="Path to published scene directory containing manifest.json and pois.json")

    args = parser.parse_args()

    if args.command == "attach":
        attach_pois(args.scene_dir, args.pois_path, fix_scene_id=args.fix_scene_id)
    elif args.command == "check":
        check_pois(args.scene_dir)


if __name__ == "__main__":
    main()
