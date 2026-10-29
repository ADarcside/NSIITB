# Capture SOP (v1.3)

This is how one person with one phone captures an indoor space so the pipeline can turn it into a walkable 3D scene. It is written to be repeated on an unseen venue under time pressure, so every step is short and has a reason.

The goal is **one continuous video of one still, well-lit room**, plus **three tape-measured room dimensions**. Everything else is optional backup.

| | |
|---|---|
| Time on site | full plan: about 45 min (5 setup, 30 to 35 filming, 5 checks); quick plan: about 25 min |
| People | 1 operator (a second person helps keep the room clear and measures) |
| Kit | phone with at least 25 GB free and a full battery, tape measure (5 m or longer) or laser meter, masking tape and a marker, this SOP and the [field checklist](field-checklist.md) |
| Output | `room.mov` (original file, not converted) and `capture.json` |

Version history is at the bottom.

---

## 1. Before filming (5 min)

1. **Consent.** Get the space owner's permission and write down a short reference, for example `k720-own-room-2026-10-25`. It goes in `capture.json`.
2. **Clear the room.** No people or pets in shot. Close swinging doors and cupboards. Put away anything that will move (fans off, curtains still).
3. **Light it.** Turn every light on. Draw curtains on windows with direct sun, because bright glare and dark corners both reconstruct badly.
4. **Reduce trouble surfaces.** Mirrors, glass and screens confuse the reconstruction. Cover a mirror with a sheet if you can, and turn screens off.
5. **Tape marks (backup scale, 2 min).** Stick two pairs of masking-tape crosses on the floor where the walk path will see them:
   - A to B exactly **2.000 m** apart, along the main walking line.
   - C to D exactly **1.000 m** apart, roughly at right angles to A–B.

   Label the crosses A, B, C, D with a marker and take one photo of the tape measure along each pair. The pipeline currently takes scale from the room measurements (step 4.3), and the tape pairs are the fallback and a cross-check.
6. **Phone settings.**
   - Charge to 100 % (or carry a power bank), free at least 25 GB, turn on Do Not Disturb.
   - iPhone: Camera > Video, **4K, 30 fps**, 1x lens, no zoom. Action mode, Cinematic and Night mode off. Settings > Camera > Formats: "Most Compatible" is fine.
   - Android: rear main camera, 4K 30 fps, stabilisation on, no zoom, no beauty or AI scene modes.
   - Hold the phone in **landscape**. Before pressing record, touch and hold a mid-grey patch of wall until **AE/AF Lock** appears, so brightness and focus stay fixed.

## 2. Filming (one continuous video, 30 to 35 min)

Do not stop and restart the recording. Pausing is fine; cutting is not. A 35 min 4K video is 12 to 20 GB, so free at least **25 GB** on the phone and start with a full battery (or a power bank).

### 2.1 The four rules that matter most for Gaussian splatting

1. **Move your feet, not your wrist.** The reconstruction gets depth from the phone *changing position* between frames. Turning on the spot gives no depth and leaves floaters. Except for the start and end pans, always walk while you film.
2. **Slow and steady.** In the full plan walk at about **0.2 m/s (one small step every 1.5 s)** and turn no faster than **10° per second** (a full circle in at least 36 s). Each second of video should still show about three quarters of what the previous second showed.
3. **Every surface 4 times, from 4 different places** (heights or angles). More passes from *new positions* is what makes a long video worth it; repeating the same path at the same height adds little.
4. **Keep your distance.** Never get closer than **0.5 m** to anything (it goes out of focus and loses context), and don't film anything only from farther than about **5 m**.

Phone height names used below: **high** = arms up above your head, about 1.9 m; **chest** = about 1.3 m; **waist** = about 0.9 m; **low** = crouching, about 0.5 m.

### 2.2 Full plan: hostel room K-720 (6.4 × 3.9 m, bunks), 30 to 35 min

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

### 2.3 Quick plan (any room, 12 to 15 min)

For the live finale or a quick re-capture. Same rules, but walk at **0.3 m/s** and do **3 passes** per surface.

| # | Part | Distance | Passes | How | About |
|---|---|---|---|---|---|
| 1 | Start pan | on mark A | 1 | Full circle, chest height | 30 s |
| 2 | Whole room, looking across | far side 3 to 5 m away | 3 laps | Back to the walls, facing across: chest level, chest up 30°, waist down 30° | 3 to 4 min |
| 3 | Walls, close | 1.0 to 1.5 m | 2 laps | Facing the wall: chest level, waist down 30 to 45° | 2 to 3 min |
| 4 | Corners | 1.5 m back | 3 sweeps | Level, up, down, with side steps | 1 to 2 min |
| 5 | Ceiling | about 1.3 m | 2 lines | Straight up, then 45° toward the wall tops | 1 min |
| 6 | Floor | about 1 m ahead | 2 sets | Waist, aimed 1 m ahead (never at your feet), along then across | 1 min |
| 7 | Furniture | 1.0 to 1.5 m | 3 heights | Arcs at chest, high looking down, low looking up | 1 to 3 min |
| 8 | Inside and under things | 0.5 to 1.0 m | 1 or 2 | Crouch and slide past | 1 min |
| 9 | Doors and windows | 0.7 to 1.0 m | 1 arc | 60°, angled across bright windows | 30 s |
| 10 | Tape marks | 1 to 2 m | 2 angles | Usually covered by pass 3 | 15 s |
| 11 | End pan | on mark A | 1 | Same as the start | 30 s |

### 2.4 Throughout the video

- Hold the phone with **both hands**, elbows tucked in, in **landscape**. Use the **1x** lens only. Never zoom, never change settings, never cover the lens.
- When you change height or tilt between laps, do it slowly over two or three steps, not with a jerk.
- **Keep yourself out of shot.** Your feet, shoes and shadow move with you and turn into dark see-through blobs just above the floor. Never point the phone straight down at your feet, and keep the main light behind the phone.
- **Close windows** before filming so curtains and loose fabric stay still.
- In a long shoot, rest your arms between passes **by pausing, not by lowering the phone fast or stopping the recording**. Hold still for a few seconds, then carry on.
- If something moves (a person walks in, a curtain swings), say the time out loud on the video or note it, and film that area again before you finish.
- The room config samples 3 frames per second (about 6,300 from 35 min) and keeps the sharpest 1,000 to 1,200. Slower walking means more of those frames are sharp, which is why the long plan is slower, not just longer.

## 3. Optional second clip (3 to 5 min)

If the playback check in step 4 shows a weak area, film a short separate clip of just that area with the same settings. Keep it as a separate file; the pipeline takes one video per run, so it is a reshoot source, not an add-on.

## 4. Before leaving the room (5 min)

1. **Playback check.** Scrub through the video. Look for long blurry stretches, dark corners, and parts of the room that never appear (ceiling, behind furniture, the door wall). Reshoot those now. Coming back later costs far more.
2. **Back up the original.** Copy the file off the phone without converting it (see section 5). Keep the phone copy until the run passes S03.
3. **Measure the room.** These three numbers set the scale of the model, so measure carefully, wall to wall at floor level:
   - **length** (long axis), **width** (short axis), **height** (floor to ceiling).
   - Measure each twice. If the two readings differ by more than 2 cm, measure a third time.
4. **Write down** the device model and OS version, the time you started filming, the lighting ("all room lights on, curtains drawn"), and anything odd (a mirror, a person walked through at 6:40).

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
  "sop_version": "v1.3.0",
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
- The human steps are: consent, clearing the room, filming, measuring, the playback check, and the three visual checks at G3, G4 and G6. The rest is run by the pipeline.

## 9. Lessons from the first real capture (hostel room K-720, 25 Oct 2026)

- The 18 min walkthrough gave 800 usable frames, but parts of the room were seen from only one or two positions. v1.2 doubles the passes at a slower speed (30 to 35 min) for the reshoot.
- The **ceiling was under-filmed**, which showed up as gaps and floaters above head height. Straight-up ceiling passes were added in v1.1.
- Stray Gaussians outside the walls (floaters) threw off the first scale estimate, so the pipeline now takes scale from the measured room size. Measuring the room is therefore required, not optional.
- Cropping the splat at the walls opened black holes, because splat walls are partly see-through. The room config now keeps every Gaussian, and the viewer's room bounds and walkable grid keep visitors inside instead.

- Reshoot (room_v2, 28 Oct): floor passes aimed straight down caught the operator's feet and shadow, which became dark blobs above the floor. The ceiling corner above the cupboards by the door, the shiny AC vent and the curtain stayed soft. v1.3 aims floor passes 1 m ahead and adds a trouble-spot pass.

## Version history

| Version | Date | Change |
|---|---|---|
| v1.0.0 | 24 Oct 2026 | First SOP, from the Round 1 master guide |
| v1.3.0 | 29 Oct 2026 | Floor passes aimed 1 m ahead (operator out of shot), trouble-spot pass (high corners, shiny vents, curtains), close windows, lessons from the room_v2 reshoot |
| v1.2.0 | 27 Oct 2026 | Full 30 to 35 min plan for K-720 (4 passes per surface, 0.2 m/s); 12 to 15 min plan kept as the quick plan |
| v1.1.0 | 27 Oct 2026 | Distance, pass count and method for each part of the room; added ceiling pass and "looking across" laps, made room measurements required (scale source), tape pairs become backup and check, timings and lessons from the K-720 capture |
