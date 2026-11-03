# Avatar models

Every `.glb` in this folder is a character in the multiplayer picker. The file name is its id
(`kid.glb` -> `kid`), so use letters, digits, `_`, `-` or `.` only. A new file shows up after the next
build (`npm run dev` picks it up straight away). Labels and default colours for the five built-in
characters live in `../catalog.ts`; any other file gets a label from its name.

The five built-in characters are made by `tools/avatars/build_avatars.py`. Their editable Blender
files are in `multiplayer/avatars-src/` (Blender 5.2 or newer).

## Editing in Blender

1. Open `multiplayer/avatars-src/<id>.blend`.
2. Change shapes, add parts, move things. Keep the names below.
3. File > Export > glTF 2.0: format **glTF Binary (.glb)**, Include: leave cameras and lights off,
   Transform: **+Y Up** on, Mesh: **Apply Modifiers** on. Save over `viewer/src/avatars/models/<id>.glb`.
4. `npm run dev` in `viewer/` and open `http://localhost:5173/avatars.html` to see all characters
   the way the viewer draws them (`?hat=crown` tries a hat on).

Size does not matter: the viewer scales every character to 1.55 m with its feet on the floor.
The character must face **-Y** in Blender (front view, numpad 1, looks at its face).

## Names the viewer looks for

Objects (empties work best, with the meshes as their children). The viewer rotates them to walk,
so put each one's origin at the joint:

| Name | What | Origin at |
|---|---|---|
| `body` | everything above the legs | hips |
| `head` | head, face, hair, ears (child of `body`) | neck |
| `arm_L`, `arm_R` | arms and hands (children of `body`); L is the character's left, +X | shoulder |
| `leg_L`, `leg_R` | legs and shoes (children of the root) | hip joint |
| `hat_socket` | empty where hats sit (child of `head`) | top of the head |

Missing parts are fine: that part just doesn't animate (a model with none of them still works).

Materials: players can recolour three of them, by name:

| Material name | Default use |
|---|---|
| `main` | clothes, body |
| `second` | second colour (shoes, helmet, belly) |
| `accent` | small details (belt, emblem, tail tip) |

Any other material keeps its colour (`skin`, `dark`, `white`, `glow` in the built-in ones).
Every mesh is drawn with cartoon shading and a dark outline; a mesh whose custom property
`noOutline` is set skips the outline.

Keep each character under about 6,000 triangles so six of them stay cheap on laptops.
