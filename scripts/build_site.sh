#!/usr/bin/env bash
# Namma Space: build the public viewer site with one published scene, ready for static hosting.
# Usage: scripts/build_site.sh runs/room_v1/publish/scn_hostelroomaa [out_dir]
# The scene opens by default; other scenes are not included. Output: site/ (index.html, assets/, <scene_id>/).
set -euo pipefail
scene_dir="${1:?usage: scripts/build_site.sh <run>/publish/<scene_id> [out_dir]}"
out="${2:-site}"
scene_id="$(basename "$scene_dir")"
root="$(cd "$(dirname "$0")/.." && pwd)"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
case "$scene_dir" in /*) ;; *) scene_dir="$PWD/$scene_dir" ;; esac
[ -f "$scene_dir/manifest.json" ] || { echo "no manifest.json in $scene_dir" >&2; exit 1; }

# Build without viewer/public (it holds local test scenes), then add just this scene
(cd "$root/viewer" && NS_SITE_BUILD=1 VITE_DEFAULT_SCENE="$scene_id" npx vite build --outDir "$out.tmp" --emptyOutDir)
rm -rf "$out" && mv "$out.tmp" "$out"
mkdir -p "$out/$scene_id"
cp "$scene_dir"/manifest.json "$scene_dir"/*.spz "$out/$scene_id/"
if [ -f "$scene_dir/grid.json" ]; then cp "$scene_dir/grid.json" "$out/$scene_id/"; fi
touch "$out/.nojekyll"   # GitHub Pages: serve files as they are
du -sh "$out" "$out/$scene_id"/*
echo "Site ready in $out/ (opens $scene_id by default). Test: npx vite preview --outDir $out  or  python -m http.server -d $out"
