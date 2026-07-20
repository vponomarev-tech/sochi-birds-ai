# Sochi Birds — project instructions for Claude Code

Read this before doing anything else in this repo. See `JOURNAL.md` in
this same folder for the full story/reasoning behind these decisions —
this file is the condensed, actionable version. `D:\GitHub\CLAUDE.md`
(parent folder) has the cross-project GitHub-account/infra notes.

## What this project is

A bird-sound-ID Progressive Web App, forked from
[birdnet-team/real-time-pwa](https://github.com/birdnet-team/real-time-pwa)
(MIT), positioned as a **hyper-local tool for Sochi / the Black Sea
coast** — not a generic global app, not broadened to the whole Caucasus.
The author is an architect and wants the project to also read as an
urban/soundscape-ecology research piece (see the About page), not just a
birding toy.

- Live: https://vponomarev-tech.github.io/sochi-birds-ai/
- Repo: https://github.com/vponomarev-tech/sochi-birds-ai (account:
  `vponomarev-tech`, the production account — see parent CLAUDE.md)
- Contact shown on the About page: https://t.me/vponomarev_ru + GitHub
  Issues. Don't add any other contact info without asking.

## What's already built — don't re-litigate these decisions

- Per-species confidence threshold override (per detection card, +/-,
  persisted locally).
- Rarity guard: raises the effective threshold for species the geo/season
  model considers uncommon here. Manual per-species override always wins
  over it.
- Session history log (timestamped detections, per-species cooldown).
- UI defaults to **Russian**, switchable in Settings.
- Bird photos load live from Wikipedia's REST API (cached in
  localStorage), not hardcoded — this replaced hotlinking BirdNET's own
  image endpoint.
- Local-only `/map/` page (Leaflet + OpenStreetMap tiles) plotting the
  session-history log from `localStorage` — nothing shared yet.
- Relative, **uncalibrated** noise-level tracking alongside bird
  detections (reuses the existing spectrogram analyser, no new audio
  node). Explicitly not a certified SPL/dB(A) reading — keep that caveat
  wherever it's shown.
- Original logo (teal/gold bird + soundwave) — do not reuse BirdNET's own
  blue-jay mark.
- Naming: stays **"Sochi Birds"**. Explicitly decided *not* to rename to
  something soundscape/noise-generic even though the app now does both —
  the bird-ID hook is what makes people open the app; noise is a
  secondary layer within the same brand, not equal billing in the name.

## In progress: shared map via Telegram Mini App

Goal: confirmed detections (and noise samples) get pinned on a **shared**
map across users, viewed inside a Telegram Mini App.

- **Backend: Supabase** (chosen over Firebase — free tier, Postgres).
  Project: `https://rcorzmmmfczoupthwvzn.supabase.co` (ref
  `rcorzmmmfczoupthwvzn`).
- **MCP is connected and authorized** (registered at user scope, so it
  loads in any Claude Code session — `claude mcp list` should show
  `supabase: ... - ✔ Connected`). Use the Supabase MCP tools directly for
  schema/migrations/queries — no need to hand-write SQL for the user to
  paste into the dashboard.
- **Telegram bot**: created via @BotFather. Token lives in
  `D:\GitHub\sochi-birds-ai\.env.local` (gitignored) as
  `TELEGRAM_BOT_TOKEN=...` — read it from there if needed, never ask the
  user to repaste it in chat, never commit it, never put it in this file
  or the journal.
- **Mini App plan**: reuse this same web app inside Telegram (detection
  code unchanged) via the Telegram Web App JS SDK. Telegram supplies a
  signed `initData` payload identifying the user — that replaces a
  custom login/auth flow entirely, don't build one.

### Concrete next steps (pick up here)

1. Design the Supabase schema: a table for bird-detection pins
   (species, confidence, lat/lon, timestamp, maybe a Telegram user id)
   and a table for noise samples (relative dB, lat/lon, timestamp).
   Decide Row Level Security: likely public read, but writes should be
   scoped/rate-limited somehow (open question — discuss before
   implementing, don't just make writes fully open).
2. Add the Telegram Web App SDK (`telegram-web-app.js`) to the app,
   detect when running inside Telegram, surface a "confirm & pin to map"
   action after a detection.
3. Wire the map page (already built, currently local-only) to also read
   shared pins from Supabase once the schema exists, in addition to the
   local history it already shows.
4. Register the Mini App URL with @BotFather (`/newapp` or via
   `/mybots`) once there's something worth showing inside Telegram.

## Working conventions for this repo

- Don't hard-delete anything (repos, data) — see the standing
  prohibited-actions policy. Archive/private/gitignore instead, and tell
  the user how to do a real delete themselves if they still want it.
- Bump `APP_VERSION` in `public/sw.js` whenever shipping asset changes
  (logo, new pages, etc.) so the service worker cache busts correctly —
  this bit twice during local testing (stale SW serving old `app.js`).
- Local dev testing gotcha: the dev server's service worker can serve a
  stale cached `app.js` across restarts. If something that should work
  doesn't, unregister service workers + clear caches
  (`navigator.serviceWorker.getRegistrations()` /
  `caches.keys()`) before concluding there's a real bug.
- New locale strings: only `en.json` and `ru.json` get real translations;
  other locales fall back to the `tt(key, fallbackText)` helper's English
  default. That's an accepted gap, not a bug to fix proactively.
