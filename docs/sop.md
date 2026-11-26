# Capture SOP (v1.8)

This is how one person with one phone captures an indoor space so the pipeline can turn it into a walkable 3D scene. It is written to be repeated on an unseen venue under time pressure, so every step is short and has a reason.

The goal is **one continuous video of one still, well-lit room**, plus **three tape-measured room dimensions**. Everything else is optional backup.

**Which plan:** at the Round 3 finale or any unseen venue, use the **finale plan (section 2.3, 15 to 20 min of filming)**. The full plan (section 2.2, 30 to 35 min) is for practice rooms where time does not matter.

| | |
|---|---|
| Time on site | finale plan: about 35 min (3 walk-through, 7 setup, 15 to 20 filming, 5 checks); full plan: about 45 min |
| People | 1 operator (a second person helps keep the room clear and measures) |
| Kit | phone with at least 25 GB free and a full battery, tape measure (5 m or longer) or laser meter, masking tape and a marker, a few matte objects or sticky notes for plain walls, this SOP and the [field checklist](field-checklist.md) |
| Output | `room.mov` (original file, not converted) and `capture.json` |

Version history is at the bottom.

---

## 1. Before filming (10 min)

1. **Walk the venue first (3 min, no filming).** List the places people will search for (rooms, desks, exits, notice boards). Those are the POIs you will tag, and each gets close passes in the finale plan (pass 9). Note plain walls, mirrors, glass, backlit windows and anything that will move. At a busy venue, ask the organisers for a quiet slot and film when nobody is walking through.
2. **Consent.** Get the space owner's permission and write down a short reference, for example `k720-own-room-2026-10-25`. It goes in `capture.json`.
3. **Clear the room.** No people or pets in shot. Close swinging doors and cupboards. Put away anything that will move (fans off, curtains still).
4. **Light it.** Turn every light on, with no very dark corners (room 2 lost frames in its darkest pass). Draw curtains or lower blinds on windows with direct sun or a bright view behind them: a backlit window turns into haze (Room 3).
5. **Reduce trouble surfaces.** Mirrors, glass and screens confuse the reconstruction. Cover a mirror with a sheet if you can, and turn screens off.
6. **Give plain walls something to hold on to (if the venue allows).** Long bare walls, ceilings and floors reconstruct as cloud and let the model stretch. Put a few distinct matte objects (a bag, a box, a poster) along each bare wall, or 6 to 10 sticky notes or tape crosses at chest height and near the ceiling edge. Avoid shiny objects. Leave them in place until filming ends, then take them away.
7. **Tape marks (backup scale, 2 min).** Stick two pairs of masking-tape crosses on the floor where the walk path will see them:
   - A to B exactly **2.000 m** apart, along the main walking line.
   - C to D exactly **1.000 m** apart, roughly at right angles to A–B.

   Label the crosses A, B, C, D with a marker and take one photo of the tape measure along each pair. Also tape and write down two more distances as checks: **door to the far wall**, and **one large piece of furniture** (for example a table's length). The pipeline currently takes scale from the room measurements (step 4.3), and the tape pairs are the fallback and a cross-check.
8. **Phone settings.**
   - Charge to 100 % (or carry a power bank), free at least 25 GB, turn on Do Not Disturb.
   - iPhone: Camera > Video, **4K, 30 fps**, 1x lens, no zoom. Action mode, Cinematic and Night mode off. Settings > Camera > Formats: "Most Compatible" is fine. Settings > Camera > Record Video: **HDR Video off**, so brightness stays steady. Use the stock Camera app.
   - Android: rear main camera, 4K 30 fps, stabilisation on, no zoom, no beauty or AI scene modes.
   - Hold the phone in **landscape**. Before pressing record, touch and hold a mid-grey patch of wall until **AE/AF Lock** appears, so brightness and focus stay fixed.

## 2. Filming (one continuous video: 15 to 20 min finale plan, 30 to 35 min full plan)

Do not stop and restart the recording. Pausing is fine; cutting is not. A 20 min 4K video is about 7 to 12 GB and a 35 min one 12 to 20 GB, so free at least **25 GB** on the phone and start with a full battery (or a power bank).

### 2.1 The five rules that matter most for Gaussian splatting

1. **Move your feet, not your wrist.** The reconstruction gets depth from the phone *changing position* between frames. Turning on the spot gives no depth and leaves floaters. Except for the start and end pans, always walk while you film.
2. **Slow and steady.** In the full plan walk at about **0.2 m/s (one small step every 1.5 s)** and turn no faster than **10° per second** (a full circle in at least 36 s). Each second of video should still show about three quarters of what the previous second showed.
3. **Every surface 4 times, from 4 different places** (heights or angles). More passes from *new positions* is what makes a long video worth it; repeating the same path at the same height adds little.
4. **Keep your distance.** Never get closer than **0.5 m** to anything (it goes out of focus and loses context), and don't film anything only from farther than about **5 m**.
5. **Vary the viewing direction.** Don't only walk forward and back along the room looking where you walk: that gives almost no depth along the walking line, and room 2 came out 1.3 to 2x too long. Walk **sideways (crabwise) along each long wall facing the opposite wall**, take **wide shots from both ends** that show the whole room, and circle objects in **inward arcs** with the phone aimed at the object.

Phone height names used below: **high** = arms up above your head, about 1.9 m; **chest** = about 1.3 m; **waist** = about 0.9 m; **low** = crouching, about 0.5 m.

### 2.2 Full plan (practice rooms): hostel room K-720 (6.4 × 3.9 m, bunks), 30 to 35 min

Do the passes in this order. "Lap" means once round the whole room (about 20 m, about 2 min at this speed). K-720 is narrow, so "far side" shots are taken **along the length** of the room (6.4 m), and side walls are filmed from across the aisle.

| # | Part | Distance from the subject | Passes | How to film it | About |
|---|---|---|---|---|---|
| 1 | **Start pan** | stand on mark A | 2 turns | Turn a full circle at chest height, level. Then a second circle tilted down 30°. | 1.5 min |
| 2 | **Whole room, end to end** | 4 to 6 m to the far end wall | **4 lengths each way** (8 total) | Walk the aisle from the door end to the far end and back, facing the end wall you are walking toward, then turn round at the end slowly. Heights: chest level, chest tilted up 30°, waist tilted down 30°, high tilted down 20°. | 5 min |
| 3 | **Side walls and bunks from across the aisle** | as far back as the room allows (1.5 to 2.5 m or more) | **4 laps** | Back against one side, face the opposite wall, crab-walk the full length; then swap sides. Lap 1: chest level. Lap 2: high, tilted up 30° (wall tops, upper bunk, ceiling edge). Lap 3: waist, tilted down 40° (floor-wall line, lower bunk). Lap 4: low (0.5 m), level (under bunks, bed fronts). | 8 min |
| 4 | **Corners** (all 4) | 1.5 m back, on the diagonal | **4 sweeps** per corner | Two small sideways steps while sweeping wall, corner, wall (about 90°): level, up 30°, down 30°, then low and level. | 4 min |
| 5 | **Ceiling** | about 1.0 m (phone high, ceiling 2.84 m) | **3 lines** | Walk the aisle with the phone held high: once pointed **straight up**, once tilted 45° toward the left wall top, once 45° toward the right wall top. Include lights, fans and the area above the upper bunks. | 2.5 min |
| 6 | **Floor** | about 1 m ahead | **2 lines** | Waist height, phone aimed at the floor **about 1 m ahead, not straight down**, so your feet, shoes and shadow stay out of frame. Walk along the aisle and back on the other half. Keep the main light behind the phone, not behind you. | 1.5 min |
| 7 | **Lower bunk and bunk frame** (each bunk) | 1.0 to 1.5 m | **3 heights + inside** | Slow side-to-side arc in front of each bunk: chest level, then low looking up at the underside of the top bunk. Then a slow slide along the lower bunk at 0.7 to 1.0 m, phone pointed in (this also covers the top bunk's underside). | 3 min |
| 7b | **Top bunk** (each one) | 1.0 to 1.5 m from the aisle | **3 passes + 2 end arcs** | Stand in the aisle and hold the phone **as high as you can reach**, arms straight up. Walk the full length of the bunk three times: once level with the mattress edge, then twice tilted **down about 30°** onto the mattress surface (once nearer, once a step farther back). Then at each end of the bunk, a short arc of about 60° around the corner, one step per 15°. The top-bunk view from 2.5 m or more across the room comes from the high, tilted-up lap of pass 3. Optional: stand 2 or 3 rungs up the ladder for one extra pass. **Never stand on the bunks.** | 2.5 min per bunk |
| 8 | **Under the bunks and desks** | 0.5 to 1.0 m | **2 passes** | Crouch low and slide sideways past the gap, once level, once tilted slightly down. Keep some of the room in the frame edge. | 2 min |
| 9 | **Desks, cupboards, shelves** | 1.0 m | **3 heights** | Half-circle arc in front of each: chest, high looking down at the top, waist looking straight in. | 2 min |
| 10 | **Door, window, small detail** | 0.7 to 1.0 m | **2 arcs** each | 60° sideways arc at chest height, then at waist. Angle across the window, never straight into bright light. Include the door wall: it is the one most often missed. | 1.5 min |
| 10b | **Trouble spots** (high corners above cupboards, AC vents and other shiny parts, curtains) | 1 to 2 m, looking straight at it | **3 slow passes** each | Stand in front of it and do short slow side-to-side passes facing it square on, at the height that sees it straight (high for ceiling corners). Close windows first so curtains hang still. These spots stay soft or streaky when seen only from far away or at a grazing angle. | 2 min |
| 11 | **Tape marks** | 1 to 2 m | **2 angles** per pair | Chest height tilted down, from two sides. | 0.5 min |
| 12 | **End pan** | back on mark A | 2 turns | Repeat the start pan exactly. Returning to the start lets the reconstruction close the loop. | 1.5 min |
| | **Total** | | | | **about 35 min** |

If you finish under 30 min, you walked too fast: do lap 3 again at half the speed rather than adding new paths.

### 2.3 Finale plan (any room, 15 to 20 min)

For the live finale, any unseen venue, or a quick re-capture. Same rules, but walk at about **0.3 m/s** and do **2 to 3 passes** per surface. Frame budget stays the same as the full plan (1,200 to 1,400 kept frames), so the shorter video mainly saves filming time and copying time.

| # | Part | Distance | Passes | How | About |
|---|---|---|---|---|---|
| 1 | **Start at the door** | in the doorway | 1 | Hold still 3 s looking in. Then a **5 s wide shot** showing the whole room, far end in frame. | 15 s |
| 2 | Start pan | on mark A | 1 | Full circle, chest height, level | 30 s |
| 3 | **Sideways along each long wall** | as far back as the room allows | 2 per long wall | Back to one long wall, face the opposite wall, crab-walk the full length; then swap sides. Chest level, then waist tilted down 30° | 3 to 4 min |
| 4 | **Wide shot from the far end** | at the far end | 1 | Hold still 5 s with the **door end in frame**, then turn slowly to the side walls | 15 s |
| 5 | Walls, close | 1.0 to 1.5 m | 2 laps | Facing the wall: chest level, then high tilted up 30° (wall tops, ceiling edge) | 2 to 3 min |
| 6 | Corners | 1.5 m back, on the diagonal | 3 sweeps | Level, up, down, with small side steps | 1 to 2 min |
| 7 | **Look-up pass (ceiling)** | phone high | 2 lines | Walk **slowly**: straight up, then 45° toward the wall tops. Include lights and fans (fans off) | 1 to 2 min |
| 8 | Floor | about 1 m ahead | 2 lines | Waist, aimed 1 m ahead (never at your feet), along then across | 1 min |
| 9 | **POIs and furniture** | 1.0 to 1.5 m | 3 heights | **Inward arcs** around each place you will tag and each large piece: chest, high looking down, waist. Film the floor around movable pieces too | 2 to 4 min |
| 10 | Inside and under things | 0.5 to 1.0 m | 1 or 2 | Crouch and slide past, some of the room in the frame edge | 1 min |
| 11 | Doors and windows | 0.7 to 1.0 m | 1 arc | 60° arc, **side-on**. Film the door edges and top from inside. Never a long look out of the door or straight at a bright window | 30 s |
| 12 | Tape marks | 1 to 2 m | 2 angles | Chest height tilted down, from two sides | 15 s |
| 13 | **End at the door** | on mark A, then the doorway | 1 | Repeat the start pan, walk back to the doorway, hold still 3 s | 45 s |
| | **Total** | | | | **15 to 20 min** |

If a pass goes wrong (feet in shot, thumb over the lens, someone walks in), say "skip" and the time out loud, keep the recording going, and redo the pass. Write the times down so that area can be checked in the model.

### 2.4 Throughout the video

- Hold the phone with **both hands**, elbows tucked in, in **landscape**. Use the **1x** lens only. Never zoom, never change settings, never cover the lens.
- **Watch the AE/AF Lock label.** If it disappears (a tap or a long pause can release it), pause, touch and hold the same mid-grey wall patch again, then carry on. Steady exposure matters: Room 3 needed extra training work to undo brightness changes.
- **No long looks out of the room.** Whatever shows through the door, a window or a mirror ends up in the model and confuses the wall finder (room 2). Glance past, don't stare.
- When you change height or tilt between laps, do it slowly over two or three steps, not with a jerk.
- **Keep yourself out of shot.** Your feet, shoes and shadow move with you and turn into dark see-through blobs just above the floor. Never point the phone straight down at your feet, and keep the main light behind the phone.
- **Close windows** before filming so curtains and loose fabric stay still.
- In a long shoot, rest your arms between passes **by pausing, not by lowering the phone fast or stopping the recording**. Hold still for a few seconds, then carry on.
- If something moves (a person walks in, a curtain swings) or your feet or thumb get in shot, say the time out loud on the video or note it, and film that area again before you finish.
- **For moving furniture later:** film the floor and the wall behind each piece that may be moved (around and between legs, and the wall strip just above it) from at least two angles. The viewer fills a moved piece's old spot from the floor and wall around it, so those must be in the scan. After publishing, open tag mode, then Layout, then Fix boxes, and check each furniture box (about 5 min).
- The room config takes 2 candidate frames per second (about 2,400 from 20 min, 4,200 from 35 min), drops blurry ones and keeps 1,200 to 1,400 spread over the whole video. Slower walking means more of those frames are sharp.

## 3. Optional second clip (3 to 5 min)

If the playback check in step 4 shows a weak area, film a short separate clip of just that area with the same settings. Keep it as a separate file; the pipeline takes one video per run, so it is a reshoot source, not an add-on.

## 4. Before leaving the room (5 min)

1. **Playback check.** Scrub through the video. Look for long blurry stretches, dark corners, and parts of the room that never appear (ceiling, behind furniture, the door wall). Reshoot those now. Coming back later costs far more.
2. **Back up the original.** Copy the file off the phone without converting it (see section 5). Keep the phone copy until the run passes S03.
3. **Measure the room.** These three numbers set the scale of the model, so measure carefully, wall to wall at floor level:
   - **length** (long axis), **width** (short axis), **height** (floor to ceiling).
   - Measure each twice. If the two readings differ by more than 2 cm, measure a third time.
4. **Write down** the device model and OS version, the time you started filming, the lighting ("all room lights on, curtains drawn"), the two check distances (door to far wall, one furniture size), any skip times, and anything odd (a mirror, a person walked through at 6:40).
5. **Sketch the floor plan (2 min).** On one sheet of paper, draw the room from above. It does not need to be to scale, but it must show:
   - the outline of the walls with the **length and width** written on them, and the **height** in a corner;
   - every **door and window**, and the large furniture (beds, tables, cupboards);
   - the tape marks **A, B, C, D** and where you started and ended the video (mark A);
   - an arrow for **north** or for the main entrance, so the sketch can be matched to the model.

   For more than one room, draw **one sketch per floor**, number the rooms in the order you filmed them, and mark each doorway and staircase you walked through. Photograph the sketch and keep it with `capture.json`. The pipeline does not read it: it builds its own floor plan (the walkable grid and the minimap) from the video. The sketch is the human check that the model's shape, size and doorways are right at gate G6, and it is what you tag places against.

## 5. Getting the video to the GPU machine

- **iPhone:** Settings > Photos > Transfer to Mac or PC > **Keep Originals**. Then AirDrop to a Mac, use a cable, or upload to Google Drive and download on the GPU machine.
- USB drives must be **exFAT or NTFS**. FAT32 cannot hold files over 4 GB, and a 15 min 4K video is larger than that.
- Copy it into the repo as `sample/room.mov` (or any name; pass the path to the pipeline). Videos are gitignored and must never be committed.

## 6. Fill in capture.json (2 min)

Copy `tests/fixtures/capture_valid.json` and edit it. Every field below is checked against `pipeline/schemas/capture.schema.json` at stage S01.

```json
{
  "schema_version": 1,
  "capture_id": "cap_hostelroomaa",
  "space_id": "spc_hostelroomaa",
  "space_name": "Hostel room K-720",
  "device_model": "iPhone 16e",
  "os_version": "iOS 26.5",
  "resolution": {"w": 3840, "h": 2160},
  "fps": 30.0,
  "captured_at": "2026-10-25T10:00:00Z",
  "operator": "Team Namma Space",
  "sop_version": "v1.8.0",
  "lighting": "All room lights on",
  "scale_pairs": [
    {"a": "A", "b": "B", "distance_m": 2.0, "role": "scale"},
    {"a": "C", "b": "D", "distance_m": 1.0, "role": "check"}
  ],
  "room_dims_m": {"width": 3.93, "length": 6.39, "height": 2.84},
  "consent": {"granted": true, "reference": "k720-own-room-2026-10-25"},
  "notes": "Round 1 room capture, tape pairs A-B 2 m, C-D 1 m"
}
```

- `capture_id` and `space_id` are a prefix (`cap_`, `spc_`) plus exactly 12 characters from `a`–`z` and `2`–`7`. No `0`, `1`, `8` or `9`.
- Read `resolution`, `fps` and the true recording time from the file:
  ```bash
  ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of csv=p=0 sample/room.mov
  ffprobe -v error -show_entries format_tags=creation_time -of csv=p=0 sample/room.mov
  ```
- Validate before running anything:
  ```bash
  python -c "import json,jsonschema;jsonschema.validate(json.load(open('sample/capture.json')),json.load(open('pipeline/schemas/capture.schema.json')));print('capture OK')"
  ```

Then run the pipeline as described in the [README](../README.md#3-reconstruct-a-room).

## 7. What the pipeline checks, and what to do when a gate fails

Every stage has a measured pass/fail gate. A failed gate means reshoot or reprocess. Never edit a number to make it pass.

| Gate | Stage | Passes when | If it fails |
|---|---|---|---|
| G1 | S01 validate | video at least 90 s and at least 1080p, valid `capture.json` | fix `capture.json`, or film a longer video |
| G2 | S02 frames | 150 or more sharp frames kept (room config targets 1,000–1,200) | reshoot slower, in brighter light |
| G3 | S03 camera poses (COLMAP) | 95 % or more of frames registered, mean reprojection error 1.0 px or less, one main model; **plus a human look at the sparse cloud** | reshoot the weak area; try `colmap.mapper: incremental` |
| G4 | S04 training | PSNR 24 dB or more (warning only); **plus a human look at the renders** | retrain with more frames or iterations |
| G5 | S05 export | valid splat PLY | re-export |
| G6 | S06 normalize | floor flat to 3 cm or less, scale check within 2 %; **plus a human look at the top and side views and `navgrid.png`** | recheck room measurements, adjust crop |
| G7 | S07 compress | full SPZ under 100 MB, lite under 30 MB | lower the Gaussian count |
| G8 | S08 manifest | manifest validates against the schema | fix the manifest writer |

## 8. Known limits

- **Scale depends on the human measurements.** A phone without LiDAR has no true scale; a 5 cm error on a 6 m wall is under 1 %, but a misread tape is not.
- **Mirrors, glass, screens and blank single-colour walls** reconstruct poorly and can leave holes or ghost copies.
- **Anything that moves** during filming leaves smears, including the operator's own feet and shadow and curtains in a draught.
- **Views below waist height** show the floor edge-on and look fuzzy, so the viewer limits eye height to 0.7 to 2.7 m.
- **Under-filmed areas** (most often the ceiling and the wall you entered by) come out blotchy or missing. The ceiling passes exist for this reason.
- **Moving furniture** shows only what was filmed. The old spot is filled with made-up floor and wall, and an object's unseen back or underside stays thin.
- **People at a public venue.** You may not be able to clear an unseen venue. Film in a quiet slot, redo any pass someone walked through, and note the times.
- **One room per scene so far.** For several rooms on one floor, the plan is one continuous walk through the doorways; this is not yet tested on a real multi-room space. Separate floors are not joined: each floor is its own scene.
- The human steps are: consent, clearing the room, filming, measuring, the floor-plan sketch, the playback check, and the three visual checks at G3, G4 and G6. The rest is run by the pipeline.

## 9. Lessons from real captures

- The 18 min walkthrough gave 800 usable frames, but parts of the room were seen from only one or two positions. v1.2 doubles the passes at a slower speed (30 to 35 min) for the reshoot.
- The **ceiling was under-filmed**, which showed up as gaps and floaters above head height. Straight-up ceiling passes were added in v1.1.
- Stray Gaussians outside the walls (floaters) threw off the first scale estimate, so the pipeline now takes scale from the measured room size. Measuring the room is therefore required, not optional.
- Cropping the splat at the walls opened black holes, because splat walls are partly see-through. The room config now keeps every Gaussian, and the viewer's room bounds and walkable grid keep visitors inside instead.

- Reshoot (room_v2, 28 Oct): floor passes aimed straight down caught the operator's feet and shadow, which became dark blobs above the floor. The ceiling corner above the cupboards by the door, the shiny AC vent and the curtain stayed soft. v1.3 aims floor passes 1 m ahead and adds a trouble-spot pass.
- Room 2 (narrow sharing room, 17 Nov, dropped): the model came out 1.3 to 2x too long along the room while width and height were right. Nearly every view looked along the walking line in a narrow room with plain walls, and nothing tied the two ends together. The run passed on a warning. v1.8 adds sideways passes, wide shots from both ends and texture on plain walls to the finale plan. Its darkest pass also lost frames (darkness, not blur). Lesson: number gates are not enough, always look at the model in the viewer.
- Room 3 (19 Nov, 51 min): the backlit mesh window and shiny dark surfaces turned into haze, and brightness changed during the long walk. Two short windows had feet in shot and a thumb over the lens, left out of the run. v1.8 adds HDR video off, re-tapping the exposure lock, side-on windows and saying skip times out loud.

## 10. AR guide at a venue

The AR guide is a bonus on top of the 3D room. Skip this section if there is no time.

**Needs:** an Android phone on Google's ARCore list (tested: Realme Narzo), Chrome, Google Play Services for AR updated the day before, a full battery, two strips of masking tape and the tape measure.

**After the room is published (about 10 min):**
1. Stick two tape crosses on open floor about 2 m apart, near where visitors start, away from mirrors and shiny floor.
2. Measure the distance between the crosses and write it down.
3. Open the site with `?tag=1`. Add a tag named `Mark 1A`, then `Mark 1B`. To put each one exactly on its cross: turn on Adjust mode (T), pick the tag in the list, and Shift-click the cross on the floor (with the mouse locked, aim the middle of the screen at it). A gold ring on the floor shows where the tag stands. Check that the distance between them in the 3D room matches the tape within about 5 cm. If it doesn't, Shift-click again.
4. Save the tags to the site. Mark tags never show to visitors.
5. Build the site with AR switched on: `VITE_AR=1 scripts/build_site.sh <run>/publish/<scene_id> site`, then publish it as usual.
6. Open `ar.html?qr=1` on the laptop and print the sheet. Stick the codes near the door, or keep the sheet in hand for the demo.

**On the phone (about 3 min):**
1. Open the site online once and start AR, so the page is stored for offline use.
2. Pick a place, tap **AR** on the route card, tap **Start AR**, and move the phone slowly over the floor until the gold ring sits on it.
3. Tap cross 1A, then cross 1B, then check that the pins sit on their real objects and tap **Yes**. If everything is turned around, tap **Flip**.
4. Follow the arrows. If the pins drift, tap **Re-align** and tap the two crosses again. The route to the same place carries on.

**Good light and slow movement matter most.** If the phone loses tracking for more than a second, the pins hide and a message asks you to point at the floor and furniture. Record one good run on the phone as soon as it works at the venue, as a backup in case tracking fails in front of the judges.

## Version history

| Version | Date | Change |
|---|---|---|
| v1.8.0 | 26 Nov 2026 | Finale plan (15 to 20 min, any room) replaces the quick plan: start and end at the door, wide shots from both ends, sideways passes along long walls, inward arcs around POIs, slow look-up pass. Walk the venue first; texture on plain walls; door and furniture check distances; HDR video off and re-tap the exposure lock; no long looks out of doors or at backlit windows; say skip times out loud. Frame numbers match the room config (2 per second, 1,200 to 1,400 kept). Lessons from rooms 2 and 3 |
| v1.6.0 | 16 Nov 2026 | Floor-plan sketch before leaving the room (section 4, step 5); note on several rooms and floors |
| v1.5.0 | 15 Nov 2026 | New section 10: setting up the AR guide at a venue (marks, build, QR sheet, phone steps) |
| v1.4.0 | 15 Nov 2026 | Film the floor and wall behind movable furniture; check furniture boxes in tag mode after publishing |
| v1.3.0 | 29 Oct 2026 | Floor passes aimed 1 m ahead (operator out of shot), trouble-spot pass (high corners, shiny vents, curtains), close windows, lessons from the room_v2 reshoot |
| v1.2.0 | 27 Oct 2026 | Full 30 to 35 min plan for K-720 (4 passes per surface, 0.2 m/s); 12 to 15 min plan kept as the quick plan |
| v1.1.0 | 27 Oct 2026 | Distance, pass count and method for each part of the room; added ceiling pass and "looking across" laps, made room measurements required (scale source), tape pairs become backup and check, timings and lessons from the K-720 capture |
| v1.0.0 | 24 Oct 2026 | First SOP, from the Round 1 master guide |
