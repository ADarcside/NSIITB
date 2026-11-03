# Namma Space multiplayer

Friends open one invite link and walk the same reconstructed scene together: cartoon avatars with
name tags, live movement, voice chat, pointing at spots, and the Round 2 path to a friend.

- **Relay** (`relay/`): a Cloudflare Worker with one Durable Object per room code. It passes small
  JSON messages between the people in a room and keeps nothing: no accounts, no logs, no storage.
- **Viewer** (`viewer/src/net/`, `viewer/src/avatars/`, `viewer/src/ui/mp_ui.ts`): loaded only on the
  multiplayer build (`VITE_MP_URL`) or with `?room=` / `?mpdemo=1`, so the normal viewer is unchanged.
- **Avatars**: `.glb` files in `viewer/src/avatars/models/` (see `AVATARS.md` there), built by
  `tools/avatars/build_avatars.py`, editable `.blend` files in `avatars-src/`.

## How a room works

1. Open the multiplayer page, type a name, pick a character, colours and a hat, press **Create room**.
   The invite link (`...?room=K7QX2M&scene=...`) is copied; send it to friends.
2. A friend opens the link, picks a character and presses **Join room**. Everyone loads the room's scene.
3. A room exists only while someone is in it. Joining a code nobody created fails, so the link is the
   only way in. The room size comes from the scene's walkable floor area: K-720's area / 4 is the space
   per person (5.35 m² walkable, so about 1.3 m² each; `viewer/src/net/capacity.ts`), at least 2 and at most 6.

In the room: **V** mutes the mic, **G** points at the spot in the middle of the screen (everyone sees a
marker, named after the nearest place), **Go** next to a friend draws the walking path to them (Take me
there works), **Character** changes your look live, **Leave** exits.

Voice is browser to browser (WebRTC); the relay only introduces the browsers. Mic is on when you enter
and everyone hears everyone. Networks that block direct connections (some college Wi-Fi) need a TURN
server for voice; walking still works without it.

## Local test (one machine)

```bash
cd multiplayer/relay && npm install --legacy-peer-deps && npx wrangler dev   # relay on ws://127.0.0.1:8787
cd viewer && npm run dev                                                      # viewer on http://localhost:5173
```

Open `http://localhost:5173/?mp=1`, create a room, open the copied link in a second tab (use headphones).
`?mpdemo=1` shows five fake walking players without any relay. `http://localhost:5173/avatars.html`
shows every character. Tests: `npm test` in `relay/` and in `viewer/`; `node scripts/smoke.mjs` in
`relay/` checks a running relay end to end.

## Deploy the relay (free Cloudflare account)

Needs Node.js 20 or newer (`node -v`).

```bash
cd multiplayer/relay
npm install --legacy-peer-deps
npx wrangler login       # opens the browser: sign in to Cloudflare and press Allow
npx wrangler deploy      # first time: it asks you to pick a workers.dev subdomain
```

The last command prints the relay's address, for example `https://namma-mp.yourname.workers.dev`.
Opening `https://namma-mp.yourname.workers.dev/health` should show `ok`. Only pages on
`https://adarcside.github.io` (and localhost) may connect; change `ALLOWED_ORIGINS` in
`relay/wrangler.toml` to allow other sites.

The free plan covers about 100,000 requests a day; an hour with six people moving is roughly
15,000 (WebSocket messages count 20 to a request).

## Build the multiplayer site

Same as the normal site build, plus the relay address (note `wss://`):

```bash
VITE_MP_URL=wss://namma-mp.yourname.workers.dev scripts/build_site.sh <run>/publish/scn_hostelroomac site-mp
```

Copy `site-mp/` to the `multiplayer/` folder of the namma-space Pages repo and push. More scenes:
copy each published scene folder next to the first one; the invite link carries `&scene=`.

To reuse the scene already published at `/round2/` instead of copying 50 MB again, build without a
scene folder and point the viewer there (this is how the live `/multiplayer/` page is built):

```bash
cd viewer
NS_SITE_BUILD=1 VITE_DEFAULT_SCENE=scn_hostelroomac \
VITE_PUBLIC_BASE_URL=https://adarcside.github.io/namma-space/round2 \
VITE_MP_URL=wss://namma-mp.adarck.workers.dev \
npx vite build --outDir ../site-mp --emptyOutDir
```

## Play with friends on the Round 2 page

The Round 2 page can carry multiplayer behind a **Play with friends** button instead of opening
the lobby straight away. Pressing it shows a warning first (mic turns on in a room, anyone with the
link can join), then the lobby. Close or Leave goes back to exploring alone. Invite links
(`/round2/?room=...`) show the same warning before joining. The multiplayer code (about 29 kB
gzipped) and the avatar files only download after Continue. With the button on, Reset and the
collision mode move into a **More** (`...`) menu so the top bar stays one row.

| `VITE_MP_BUTTON` | What the page does |
|---|---|
| `1` (needs `VITE_MP_URL`) | Round 2 page: the button, the warning, the More menu (no credit footer on the loading screen) |
| `0` | Kill switch: no button, no multiplayer, top bar exactly as before |
| unset | The `/multiplayer/` page: lobby opens on load (as before) |

Tag mode (`?tag=1`) never shows the button.

```bash
VITE_MP_URL=wss://namma-mp.adarck.workers.dev VITE_MP_BUTTON=1 \
  scripts/build_site.sh <run>/publish/scn_hostelroomac site-r2
```

To hide the button again, build the same way with `VITE_MP_BUTTON=0` and publish, or revert the
publish commit in the Pages repo.

## Later (not built yet)

Phones (on hold), push-to-talk or distance-based voice, a TURN server for strict networks, emotes,
follow mode.
