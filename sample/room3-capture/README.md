# Sample data: Room 3

A second real hostel room, filmed on 19 Nov 2026 (iPhone 16e, owner's consent ref room3-own-room-2026-11-19) and published by the same pipeline. It is the second room in the live site's Room dropdown.

| File | What it is |
|---|---|
| `scn_hostelroom3f/manifest.json` | the scene manifest (S08): asset hashes, metric transform, start pose, room bounds |
| `scn_hostelroom3f/full.spz` | the full Gaussian splat, 2,752,587 Gaussians, 59 MB (S07) |
| `scn_hostelroom3f/lite.spz` | the phone version, top 12% of Gaussians, 6 MB (S07) |
| `scn_hostelroom3f/grid.json` | the 5 cm walkable collision grid with height layers (S06) |
| `scn_hostelroom3f/pois.json` | 9 tagged places: door, window, two bunks, two desks, table, two cupboards |

How it was made: trained with more splitting so the soft haze turns into real surfaces ([`pipeline/config/room3/lab_dense_antifog.yaml`](../../pipeline/config/room3/lab_dense_antifog.yaml), which also skips two short clips with a foot and a thumb in shot), then cleaned automatically with the floater filter ([`pipeline/floaters.py`](../../pipeline/floaters.py)) and the photo-checked fixer ([`pipeline/autofix.py`](../../pipeline/autofix.py)). The floater filter and the photo-checked fixer only remove splats that held-out photos show are not there. Nothing was painted or added by hand.

These are the same files that are live at https://adarcside.github.io/namma-space/round2/?scene=scn_hostelroom3f .
