# Poka-Poka

Real-time, multiplayer **Texas Hold'em** for phones. Friends open the site in a
mobile browser, one player **hosts** a table and configures the rules, everyone
else **joins with a 4-letter code**, and the whole table stays in sync over a
live WebSocket connection. No accounts, no app install, no real money — just a
code and a browser.

The app is deployed as a single **web service on Render** that both serves the
static front-end and runs the authoritative game over WebSocket.

---

## Current status

**v1 is built and working end-to-end** — No-Limit Texas Hold'em with the full
lobby→table→results flow, redesigned betting bar, spectators, chat, emotes,
sound, card animations, and a hand-rankings guide. What exists:

- `server/` — Express + native `ws` server, room manager, poker engine.
  - `server/poker/` engine has unit tests: `npm test` (node:test) → 31/31 pass.
- `public/` — vanilla front-end: all screens + the redesigned bottom action bar,
  `sound.js` (synthesized SFX), serverless fixtures `/index.html?mock=lobby|turn|showdown|handover`.
- `assets/icons/` — the icon set, served at `/assets` and **inlined** into the page
  at boot (so gradient `<use>` fills resolve on iOS Safari).
- `package.json`, `render.yaml`, `.gitignore`.
- `Poker Web App Design/` — original mockups (reference only).

Run locally: `npm install` then `npm run dev` (or `npm start`), open
`http://localhost:3000` in several windows / phones on the LAN.

**Behaviours implemented & verified (live WebSocket + headless tests):**
- Full hand create→join→showdown with chips conserved; multiple players seat correctly.
- **Reconnection:** session `{code, playerId}` in **sessionStorage** (per-tab, so two
  tabs can't collide); `rejoin` restores the exact seat, chips, hole cards.
- **Disconnect / leave:** a dropped player (socket close OR pressing Home mid-game)
  is held as **disconnected** (dimmed seat + mark) for a **2-minute grace**; the game
  continues, their turns run the **normal turn clock** then auto check/fold on timeout.
  Reconnect within 2 min → active; otherwise **eliminated** and barred from rejoining.
- **Mid-game lock:** once started, new players can't take a seat — they fall back to
  spectating; only original players rejoin (via their saved session).
- **Spectators:** "Watch a table" joins instantly as a running-number guest
  (`Guest N`) — no name/avatar; can chat; never sees hole cards.
- **Avatars are unique per table** (server reassigns a free one if taken; the picker
  greys out taken avatars via a `peek` before joining).
- **Showdown reveal:** hole cards + winning hand name + best cards are shown ONLY at a
  true showdown (2+ players to the end). If everyone folds, the winner's hand stays
  secret. The winner banner shows the **pot amount won**.
- **Blinds (Increasing):** rise by *progress* — every `BLIND_LEVEL_HANDS` hands and on
  each knock-out — not a wall-clock timer.
- Host gating: **Start** is disabled until all non-host players are ready; host can
  **Finish** the game from the table; **host leaving the lobby closes the room**.

**Caching:** the server sends `Cache-Control: no-store` for all static files (no build
hashing), so edits always show on a normal reload — important for phones / Add-to-Home-Screen.

**Deferred (per plan):** hand-history log panel content; Pot-Limit & Fixed-Limit
betting modes; persistence/DB. The room `Map` in `rooms.js` is the seam for Redis.

---

## Architecture

```
Phone 1     Phone 2     Phone 3     Phone 4     Phone 5
 (browser)   (browser)   (browser)   (browser)   (browser)
    |           |           |           |           |
    +-----------+-----+-----+-----------+-----------+
                      |   live WebSocket connections
                      |   (cards, bets, turns flow both ways)
                      v
          +---------------------------+
          |     SERVER (Render)       |
          |                           |
          |  - WebSocket handler      |  keeps all phones in sync
          |  - Poker engine           |  rules, hand ranking, pot
          |  - Room manager           |  who's in which game
          |  - Game state (memory)    |  the single source of truth
          |  - Serves HTML/CSS        |  delivers the table to phones
          +---------------------------+
```

**Key principle:** the server holds the **single source of truth** in memory and
broadcasts authoritative state. Clients are dumb renderers — they send *intents*
(actions) and render whatever state the server sends back. Never trust the client
for game logic (whose turn it is, what cards exist, pot math, hand winner).

---

## Tech stack & decisions

| Area | Choice | Notes |
|------|--------|-------|
| Runtime | **Node.js + Express** | Serves `public/` and hosts the WebSocket upgrade. |
| Real-time | **Native `ws`** (`new WebSocketServer({ server })`) | No Socket.IO. We hand-roll rooms, reconnection, and ping/pong. |
| Front-end | **Vanilla HTML/CSS/JS** | No build step, no framework. Server serves static files from `public/`. |
| State | **In-memory only** | No database. Rooms live in a `Map`; they vanish on server restart (see Render gotcha). |
| Hosting | **Render** (single web service) | One service serves HTTP + WS on the same port. |
| Player tokens | **The icon set in `assets/icons/`** | Fruit-hat avatars (`avatar-01..09`) are the selectable player tokens; the action/lobby/feedback/chip/suit icons are used throughout the UI. |

Because we use **native `ws`**, anything Socket.IO would give for free is our
responsibility: room fan-out, heartbeats (ping/pong to detect dead phones), and
client reconnection. Keep that logic centralized in the room/connection layer.

---

## Planned project structure

```
poka-poka/
├── server/
│   ├── index.js          # Express app + HTTP server + ws upgrade; reads process.env.PORT
│   ├── rooms.js          # Room manager: create/join/leave, code generation, broadcast
│   ├── connection.js     # Per-socket lifecycle: parse messages, ping/pong, reconnection
│   └── poker/
│       ├── engine.js     # Hand lifecycle: deal, betting rounds, advance turn, showdown
│       ├── deck.js       # Shuffle/deal
│       ├── hand-rank.js  # 5-of-7 best hand evaluation + comparison
│       └── pot.js        # Pot + side-pot math
├── public/
│   ├── index.html        # Single page; screens toggled client-side
│   ├── styles.css        # Design tokens (see Design system) + screen styles
│   ├── app.js            # WS client, state store, render loop, action senders
│   └── assets/icons/...  # (symlink or copy of the icon sprite — see below)
├── assets/icons/         # Source icon set (already built)
├── Poker Web App Design/ # Mockups (reference only)
├── package.json
└── CLAUDE.md
```

> The front-end needs the icon sprite at a served path. Either serve the existing
> `assets/icons/` directory statically (e.g. `app.use('/assets', express.static('assets'))`)
> or copy the sprite into `public/`. Do **not** duplicate-and-diverge the sprite —
> keep `assets/icons/poker-icons.svg` the single source.

---

## Commands

> No `package.json` yet — these are the intended commands once the server is scaffolded.

```bash
npm install         # install express + ws
npm start           # node server/index.js  (production; what Render runs)
npm run dev         # nodemon server/index.js (local auto-reload)
```

Local dev runs on `http://localhost:<PORT>` (default 3000). Open multiple browser
windows / phones on the same LAN to test multiplayer. The server must bind
`process.env.PORT` and host `0.0.0.0` for Render.

---

## WebSocket protocol (conventions)

All messages are JSON with a `type` discriminator. Keep this contract stable and
documented here when it changes.

**Client → server (intents):**

| type | payload | when |
|------|---------|------|
| `create` | `{ settings, name, token }` | Host creates a table (with identity); server returns a room code. |
| `join` | `{ code, name, token }` | Player joins a room. **Blocked once the game has started → falls back to `spectate`.** |
| `rejoin` | `{ code, playerId }` | Reconnect after a dropped socket (id from **sessionStorage**). |
| `spectate` | `{ code }` | Watch a table instantly as a guest (no name/avatar). |
| `peek` | `{ code }` | Pre-join: ask which avatars are already taken (for the picker). |
| `ready` | `{}` | Toggle ready in the lobby. |
| `start` | `{}` | Host starts the game (needs 2+ players, all non-host ready). |
| `action` | `{ action: 'fold'\|'check'\|'call'\|'raise'\|'allin', amount? }` | A betting decision on your turn. |
| `chat` | `{ text }` | In-game chat message. |
| `react` | `{ emote }` | Emote/reaction. |
| `kick` | `{ playerId }` | Host removes a player. |
| `finish` | `{}` | Host ends the whole game → results. |
| `leave` | `{}` | Leave from the lobby/results (real leave). *Pressing Home mid-game is a soft disconnect, not a `leave`.* |

**Server → client (authoritative):**

| type | payload | meaning |
|------|---------|---------|
| `state` | full room/game snapshot | The single source of truth. Client re-renders from this. |
| `joined` | `{ playerId, code }` | Ack with the id the client should persist for `rejoin`. |
| `error` | `{ code, message }` | Rejected intent. Codes incl. `room_not_found`, `kicked`, `host_left`, `not_your_turn`, `player_not_found`. |
| `roomInfo` | `{ code, exists, takenTokens }` | Reply to `peek`. |
| `chat` / `react` | message to fan out | Append to chat/emote UI. |
| `handResult` | `{ winners, board, payouts }` | Showdown result (also carried inside `ClientState.result`). |

Rules of thumb:
- The server sends **per-player** state — never leak another player's hole cards.
  Each socket gets a snapshot where only *their* hole cards are populated, EXCEPT at a
  true showdown (hand-over with 2+ live players) where all non-folded cards are revealed.
- Validate every `action` server-side: is it this player's turn, is the amount legal
  for the betting mode, do they have the chips.
- Heartbeat: server pings each socket on an interval; terminate sockets that miss a pong.

---

## Game model & room lifecycle

- **Room code:** 4 uppercase letters (e.g. `POKR`). Generated on `create`, unique
  among active rooms, avoid ambiguous letters. Shown (tap-to-copy) in the lobby AND
  on the table top bar.
- **Roles:** one **host** (crown), seated **players**, and **spectators** (guests,
  watch-only). Host can start the game, kick players, and `finish` the game.
- **Lifecycle:** `lobby` → `in-hand` ⇄ `hand-over` (repeats per hand) → `game-over`.
- **Per hand:** post blinds → deal hole cards → preflop → flop → turn → river →
  showdown → award pot(s) → reveal (showdown only) → rotate button → next hand.
- **Two independent timers:**
  - **Turn timer** (host setting 15/30/60s, or Off): on timeout, auto-**check if
    possible else fold** — never auto-calls. Disconnected players use this SAME clock
    (with a 30s fallback when the table timer is Off) so play proceeds normally.
  - **Reconnect grace** (`DROP_GRACE_MS`, 2 min): a disconnected seat is held (shown
    disconnected) until reconnect; past the grace it's **eliminated** and added to the
    room's `kicked` set so `rejoin` is rejected. Cancelled on reconnect.
- **Avatars unique per table:** `seatPlayer` reassigns a free avatar if the requested
  one is taken; clients `peek` before joining to grey out taken avatars.

---

## Host-configurable table settings

These come straight from the **Host — game rules** screen
(`Poker Web App Design/Poka-Poka.dc.html`, panel 2). The config UI and the engine
must agree on these exact options:

| Setting | Options | Default (highlighted in mockup) |
|---------|---------|----------|
| Game | Texas Hold'em | (only mode) |
| Starting stack | 500 / 1,000 / **2,500** / 5,000 | 2,500 |
| Starting blinds | 1/2 / **5/10** / 25/50 / 50/100 | 5/10 |
| Blinds mode | **Increasing** / Fixed | Increasing — rises by *progress*: one level every `BLIND_LEVEL_HANDS` hands and on each knock-out (not a wall-clock timer) |
| Max seats | stepper, up to 8 | 8 |
| Betting | **No-Limit** / Pot / Fixed | No-Limit |
| Turn timer | 15s / **30s** / 60s / Off | 30s |
| Win condition | **Last chips standing** / Host ends | Last chips standing |

The lobby surfaces a subset as tags (e.g. `No-Limit`, `5/10 ↑`, `2.5k`, `30s`).

---

## Screen flow

```
Home ─┬─> Host (rules config) ─┐
      └─> Join (enter code) ───┴─> Identity (name + token) ─> Lobby ─> Table ─> Results
```

| # | Screen | Notes |
|---|--------|-------|
| 1 | Home | Wordmark, "Host a table", inline 4-letter join. |
| 2 | Host — game rules | The settings above; "Create table". |
| 3 | Join — enter code | 4-letter code entry. |
| 4 | Player identity | Display name + pick a token (the fruit-hat avatars). |
| 5 | Lobby | Room code (tap to copy), settings tags, player list, ready states, host "Start game", kick, spectator count. |
| 6 | Table (in-game) | Felt, pot, community cards, seats, dealer button, bets, your hole cards, action bar (Fold / Call / Raise + bet slider & presets). |
| 7 | Results | Winner + winning hand, final standings, "Play again" / home. |

**Table panels (overlays/drawers):** Chat, Emotes/Reactions, Hand history (action
log), Spectator view (no action bar).

---

## Design system

The app chrome uses the **Poka-Poka "Playful"** style (variant C). Phone is used in
**landscape**.

**Colors (app chrome):**

| Token | Hex | Use |
|-------|-----|-----|
| Ink | `#211D1A` | Primary text, dark surfaces, table/results bg. |
| Accent | `#E2613C` | Primary actions, highlights, active states. |
| Cream | `#FBF6EE` | App background. |
| Panel | `#F4EFE6` | Inset panels / segmented controls. |
| Card / surface | `#FFFFFF` | Cards, list rows. |
| Muted text | `#9a8f7d` / `#b3a896` | Secondary / hint text. |
| Border | `#E0D7C8` | Hairline borders. |
| Felt | `#E7DECB` (rim `#DCD1BB`) | The poker table oval. |
| Phone frame | `#16110e` | Mockup device bezel. |

**Player-token colors (mockup):** `#E2613C`, `#2C9C8F`, `#D69A2E`, `#5B6CC4`,
`#C85C8E`, `#4F9D5B`, `#6B7785`, `#8A5BB0`.

**Fonts (Google Fonts):**
- **Bricolage Grotesque** (700/800) — wordmark, headings, buttons.
- **Space Grotesk** (500–700) — numbers, codes, chip counts, labels.
- **Hanken Grotesk** (400–700) — body copy, list text.

**Shape language:** generous radii (cards ~12–22px, buttons ~12–16px), soft
shadows, flat fills, no gradients in the chrome.

> Note: the **icon sprite has its own brighter sticker palette** (mint/red/gold —
> see `assets/icons/palette.css`). That's intentional and stays as-is; the colorful
> icons sit on top of the warm Poka-Poka chrome. Don't recolor the chrome to match
> the icons or vice-versa.

---

## Icon set

Source of truth: **`assets/icons/poker-icons.svg`** — one SVG `<symbol>` per icon.
`assets/icons/manifest.json` lists every id by category; `assets/icons/preview.html`
renders them all.

Usage (icon-only buttons keep the label on the button for a11y):

```html
<button aria-label="Raise">
  <svg width="24" height="24" aria-hidden="true">
    <use href="/assets/icons/poker-icons.svg#action-raise-bet"></use>
  </svg>
</button>
```

Categories you'll wire up:

- **Avatars / player tokens:** `avatar-01` … `avatar-09` (the kawaii fruit-hat set:
  strawberry, orange, lemon, apple, grapes, watermelon, pineapple, cherries, blueberry).
  Shown in the Identity picker and on every seat/avatar.
- **Actions:** `action-fold`, `action-check`, `action-call`, `action-raise-bet`,
  `action-all-in` — the action bar.
- **Lobby:** `host-crown`, `dealer-button`, `copy-code`, `start-game`, `kick-player`,
  `ready-status`, `waiting-status`.
- **Feedback:** `timer-turn-clock`, `winner-trophy`, `connection` (online/offline),
  `sound-on`, `sound-off`, plus `app-logo-mark` (brand).
- **Cards / chips / suits / economy / social / nav:** see `manifest.json`.

---

## Render deployment

Single **Web Service** on Render:

- **Build command:** `npm install`
- **Start command:** `npm start` (`node server/index.js`)
- **Port:** read `process.env.PORT`, bind `0.0.0.0`. Render injects `PORT`.
- **WebSocket:** Render web services support WS on the same HTTP port — do the
  upgrade on the Express server (`server.on('upgrade', …)` or share the HTTP server
  with `WebSocketServer({ server })`). No separate service needed.
- **Health check:** expose a cheap `GET /healthz` returning 200.

**Gotcha — in-memory state + spin-down:** state lives only in process memory. On
the free tier the service spins down when idle and **cold-starts fresh — all active
rooms are lost**. Also any deploy/restart wipes rooms. This is acceptable for casual
games but: (a) build client **reconnection** (persist `{code, playerId}` in
localStorage, send `rejoin` on socket open), and (b) consider a paid instance (no
spin-down) if dropped games during idle become a problem. If durability is ever
needed, the room `Map` is the seam to back with Redis — keep it isolated in `rooms.js`.

---

## Conventions & guardrails

- **Server is authoritative.** All rules, randomness (shuffles), and money math run
  server-side. The client never decides outcomes.
- **Never leak hidden info.** Tailor each `state` snapshot per recipient; only the
  owner sees their hole cards. Spectators and folded players see only public info.
- **One sprite.** All icons via `<use href=".../poker-icons.svg#id">`. Don't inline
  copies or fork the sprite.
- **No build step on the front-end.** Plain HTML/CSS/JS in `public/`.
- **Mockups are reference, not runtime.** `Poker Web App Design/*.dc.html` use a
  proprietary `support.js` canvas; don't import them. Re-implement the same look in
  `public/` with the design tokens above.
- **Mobile landscape first.** Layouts target a phone held sideways.
