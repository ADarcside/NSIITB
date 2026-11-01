# Round 2 plan: POI labels, search, walkable-path navigation

Due 30 Nov 2026. Same viewer, same scene layout. Nothing here changes the published Round 1 site until we decide to publish.

## What a user sees

1. Open the viewer. Floating labels show the tagged places ("Top bunk", "Study desk", "Exit door").
2. Press `/` (or tap the search icon) and type "desk". Results appear as you type; typos, word order and "four" for 4 all work.
3. Pick a result. A glowing line appears on the floor from where you stand to the place, bending around beds and walls. It updates as you walk, shows the metres left, and says "You've arrived" within 0.6 m.

## Data: `pois.json` (one per scene)

Schema: `pipeline/schemas/pois.schema.json`, types `PoiSet` / `POI` in `viewer/src/contracts/types.ts`.

```json
{
  "schema_version": 1,
  "scene_id": "scn_hostelroomac",
  "updated_at": "2026-11-02T10:00:00Z",
  "pois": [
    { "schema_version": 1, "poi_id": "poi_k3m2q7aa4bcd", "scene_id": "scn_hostelroomac",
      "name": "Study desk", "category": "furniture", "aliases": ["table"],
      "position": { "x": 1.20, "y": 1.2, "z": -0.85 } }
  ]
}
```

- `position.x/z` = floor spot in world metres (same frame as `grid.json`); `y` = label height (default 1.2 m).
- The manifest lists it like the grid: `assets.pois` -> an `asset_table` entry with `kind: "pois"`, `format: "json"`, sha256 and bytes. The manifest stays the only entry point.
- Navigation goes to the nearest walkable cell to (x, z), within 2 m, so a POI may sit on furniture.

## Tagging flow (repeatable live, target ~30 s per POI)

1. Open the viewer with `?tag=1`. Walk to the spot (Free roam or Walk).
2. Press `P`, type the name, pick a category, Enter. The POI drops where you stand. The draft is saved in the browser, so a reload loses nothing.
3. Click **Export** to save `pois.json`.
4. `python -m pipeline.pois attach <run>/publish/<scene_id> pois.json` copies it in and updates the manifest's hash entry.
5. `scripts/build_site.sh` copies `pois.json` with the scene.

For the finale: 10 POIs in about 5 minutes, done while the scene trains on a frame preview, or right after.

## Pathing

`viewer/src/nav/astar.ts` (done, tested in `tests/viewer/nav.test.ts`):

- A* on the walking mask `free_bits_b64` (already grown by the agent radius), 8-connected, no corner cutting.
- Steps closer than 0.45 m to an obstacle cost up to 3.5x more, so routes keep to the middle of gaps.
- String pulling with line-of-sight, never going closer to obstacles than A* did.
- Start and goal snap to the nearest walkable cell (2 m max). Returns null if not connected.
- The K-720 grid is about 80 x 125 cells, so a full search takes a few ms; re-plan every 0.5 s while walking.

`viewer/src/nav/search.ts` (done, tested): token match over name, aliases, category and description; prefix, one typo per word (two for long words), number words, and digits must match exactly ("Room 4" is not "Room 14").

## Increments (Antigravity briefs in the project folder)

| Brief | What | Done when |
|---|---|---|
| 18 | Viewer: load `pois.json`, floating labels, search box, path line + distance + arrival | Search for a tagged POI on the dev or K-720 scene draws a path that never crosses a wall |
| 19 | Tag mode (`?tag=1`, `P`, edit/delete, Export) + `pipeline/pois.py attach` + build_site copy | 5 POIs tagged, exported, attached, reloaded from the manifest |
| 20 | Tag K-720 for real, time it, screenshots, local test on laptop and phone | 8-10 POIs, timing written into the SOP |
| later | Multi-room venue capture test, mobile search UI polish, AR uses the same `NavPlanner` | |

Out of scope for now: backend, accounts, multi-floor. AR guidance stays in its own thread and reuses `NavPlanner`.
