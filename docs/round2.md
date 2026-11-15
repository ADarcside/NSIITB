# Round 2: how places, search and paths work

Round 2 adds POI labels, search and walkable-path navigation to the Round 1 viewer. This page explains what was built and where the code is. Live: https://adarcside.github.io/namma-space/round2/

## What a visitor sees

1. Place labels float over the room as soon as it loads. Click one (or its dot on the minimap, `N`) to open its card: category, other names, walking distance, **Look** and **Navigate**.
2. Press `/` and type. Every result shows how far it is to walk from where you stand. Typos ("dor"), word order, aliases ("almirah") and number words all work.
3. Pick a place. A gold path draws on the floor from you to the place, bending around beds and walls. It re-plans as you walk, shows metres and walking time, and says "You've arrived" within 0.6 m. **Take me there** walks you along it. The **From** picker plans a route between two places.

## The spatial index

Everything spatial reads one file the pipeline already writes: the scene's walkable grid, `grid.json` (stage S06).

| Layer | What it is | Code |
|---|---|---|
| Floor grid | 5 cm cells over the room in real metres, with 28 height slices (so "under the top bunk" is not "inside it"). The walking mask is already grown by the body radius (0.25 m), so a free cell means a person fits there. | `pipeline/stages/s06_normalize.py`, `viewer/src/collision/grid.ts` |
| Connected areas | A flood fill labels every walkable cell with its area. Two spots connect only if they share an area, so a pocket closed off by furniture is never offered as a route. | `NavPlanner._labelAreas` in `viewer/src/nav/astar.ts` |
| Clearance field | Distance from every cell to the nearest blocked cell. Paths pay more near furniture, and smoothing never goes closer than the search did. | `distanceToCells` in `viewer/src/collision/grid.ts` |
| Places | `pois.json`: name, category, aliases, a label position, and an optional standing spot (`approach`). A tag can sit on a bed or a wall; routes end at its standing spot, or at the nearest reachable floor within 6 m. | `viewer/src/nav/pois.ts`, `pipeline/schemas/pois.schema.json` |
| Walking distances | One search outward from the visitor gives the walking distance to every place at once. Search results show it, and nearer places win ties. | `NavPlanner.walkDistances` |

## Search

`viewer/src/nav/search.ts`. Small and dependency-free. It scores the query against each place's name, aliases, category and description: exact words, prefixes ("meet"), one typo per word (two for long words), number words ("four" is 4), and digits must match exactly ("Room 4" never matches "Room 14"). Ties in text score go to the nearer place, and an empty search lists the nearest places first.

## Pathfinding

`viewer/src/nav/astar.ts`, tested in `tests/viewer/nav.test.ts`.

- A* on the walking mask, 8 moves, no cutting a corner past a blocked cell.
- Steps closer than 0.45 m to an obstacle cost up to 3.5 times more, so routes keep to the middle of gaps instead of scraping past bunk posts.
- String pulling turns the cell path into a few straight lines, checked against the same clearance.
- The start snaps to the nearest walkable cell within 2 m. The route starts exactly where you stand when the first straight leg keeps as much room from furniture as the planned one.
- Work is kept between re-plans (a search field per goal), so re-planning every half second while you walk is cheap.

On K-720 a route is found from the start spot to all 14 places and between all 182 pairs of places.

## Tagging (repeatable live)

1. Open the viewer with `?tag=1` and walk to the place.
2. Press `P`, type the name, pick a category, add aliases. The tag drops where you stand.
3. `T` (Adjust mode) drags a label or its minimap dot to fix it. When a tag ends up on furniture, the floor spot you stand on becomes its standing spot, where routes end.
4. **Export** saves `pois.json`; `python -m pipeline.pois attach <scene_dir> pois.json` copies it next to the scene and adds its checksum to the manifest. On the live site the owner can **Save to live** instead (see the README).

Fourteen K-720 places took a few minutes.

## Moving furniture (Rearrange)

Visitors can slide and rotate furniture in their own browser; the owner can save a layout for everyone from tag mode (`layout.json` next to the manifest). Moved furniture updates the floor grid, so search distances and paths follow the new layout. Code: `viewer/src/layout/`.

## Tests

`npm test` in `viewer/` (after `npm run make:dev-scene`) and `python -m pytest -q` at the root. GitHub Actions runs both on every push (`.github/workflows/ci.yml`).
