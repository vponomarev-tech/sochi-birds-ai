# Project journal — Sochi Birds

Chronological log of decisions, reasoning, and ideas as they came up.
`CLAUDE.md` in this folder is the condensed "what to do" version — this
file is the "why", for context that decays if you only keep the summary.

## 2026-07-20 — Origin

Vlad wanted his own bird-sound-ID app because he suspected his current
phone app (Merlin/BirdNET-based) was misidentifying birds, and had a
Focusrite Scarlett Solo Studio interface (unplugged at the time) he could
use with a better mic later.

**Research before building anything:**
- Surveyed existing apps (Merlin, BirdNET app, ChirpOMatic, Song Sleuth,
  BirdGenie, Warblr, Bird Buddy, Haikubox, etc.) and their documented
  failure modes: short 3-second analysis windows, mimic confusion
  (starlings/mockingbirds), uncalibrated confidence scores, sharp
  clean-vs-field accuracy drop (BirdNET: mAP 0.79 clean → F0.5 0.41 field).
- Surveyed the open-source landscape and found `birdnet-team/real-time-pwa`
  — the BirdNET team's own PWA running BirdNET fully client-side via
  TensorFlow.js, deployable on GitHub Pages. Decision: **fork this instead
  of building from scratch** — it already solved the hard infra problem
  (in-browser inference), and already implemented several of the
  "improvements over stock apps" that were on the table (correct
  getUserMedia audio constraints, geo/season species filter, temporal
  pooling).
- Researched concrete accuracy levers: per-species thresholds (BirdNET's
  own confidence isn't a calibrated probability), geo/season priors,
  correct mic capture (disable AGC/noiseSuppression/echoCancellation),
  temporal aggregation. Conclusion: a hobbyist targeting one fixed
  location can genuinely beat the general-purpose apps on that location by
  exploiting priors/tuning a general app never exposes — not just
  placebo. Mic quality question: a better external mic *does* help via
  directionality/SNR, not because of the Focusrite interface itself or
  bit depth (BirdNET downsamples to 48kHz mono regardless).

**Built the sandbox** (`pnmrf/bird-song-ai`, GitHub account `pnmrf` — see
account-split note below): forked the reference app, added per-species
threshold override and a rarity guard (raises effective threshold for
species the geo model considers uncommon at this location). Verified
locally and on GitHub Pages.

## 2026-07-20 — Production re-home, positioning

Vlad has many parallel project folders and wanted a clean split between a
testing account (`pnmrf`) and a production account
(`vponomarev-tech`, https://github.com/vponomarev-tech) he'd actually show
people. Connected both accounts via `gh auth login` (two device-flow
logins), documented the split in `D:\GitHub\CLAUDE.md`.

**Positioning discussion:** offered three options — hyper-local Sochi,
broader Caucasus, or a generic app with Sochi as founding-story only.
Vlad picked **hyper-local "Птицы Сочи"**, and the repo name
**`sochi-birds-ai`**. Reasoning volunteered by Vlad: he's an architect and
wants to frame this as urban research, not just a birding app — "может
даже хайпануть" on having built his own thing with specific technical
improvements over the base project.

Migrated the sandbox to `vponomarev-tech/sochi-birds-ai`, rebranded
throughout (title, manifest, locales, About/README copy). Added an
**urban/soundscape-ecology framing** to the About page: birdsong as a
cheap passive signal of ecological health under Sochi's construction
pressure, citing R. Murray Schafer's soundscape ecology, with an explicit
disclaimer that it's a hobby project, not peer-reviewed research (don't
let the framing overclaim).

Also designed and added an original logo (teal/gold bird + soundwave)
since the fork had been using BirdNET's own blue-jay mark — Vlad flagged
this needed to be different, not a reskin.

**Old repo (`pnmrf/bird-song-ai`):** Vlad asked to delete it outright.
Declined to hard-delete — permanent deletion is on Claude's standing
prohibited-actions list regardless of explicit request — and instead made
it private + archived via the GitHub API, with instructions for Vlad to
do a real delete himself via Settings → Danger Zone if he still wants
that.

## 2026-07-20 — Second pass: language, photos, map, noise

Follow-up requests, all shipped same day:
- **Russian by default** (was inheriting a browser-locale guess that
  defaulted to English); still switchable in Settings.
- **Bird photos**: was hotlinking BirdNET's own image API
  (`birdnet.cornell.edu/api2/bird/...`) — Vlad wanted freely-licensed
  images instead. Switched to Wikipedia's REST API
  (`en.wikipedia.org/api/rest_v1/page/summary/...`), cached in
  localStorage (including negative cache for species with no article),
  photo click-through links to the source article as attribution.
  Verified live (Great Tit, Common Blackbird resolve correctly; a made-up
  species name correctly returns null, no errors).
- **Contact section**: was showing Cornell's BirdNET contact email, which
  was misleading for this fork. Replaced with GitHub Issues, then with
  Vlad's own Telegram (https://t.me/vponomarev_ru) once he gave it.
- **Local `/map/` page**: Leaflet + OpenStreetMap tiles, plots the
  session-history log (only entries with a lat/lon) directly from
  `localStorage` — no backend yet, first step toward a shared map.

**Noise-level idea, mid-conversation:** Vlad wondered whether the app
should also track ambient noise, not just birds — "не только птицы а
вообще звуковой шум". Raised the product question himself: split into
separate apps (bird ID vs. sound analyzer), or keep one? His own
read: a pure sound analyzer "менее живой проект" (less of a living/fun
project) on its own. Agreed and recommended **keeping one app**, with
noise as a secondary layer rather than an equal-billing rename — the
bird-ID hook is what gets someone to open the app at all; don't dilute
the name into something soundscape-generic just because the feature set
grew. Implemented: reused the existing spectrogram `AnalyserNode` (no new
audio node) to compute a rough average dBFS across frequency bins, shown
live during a session and logged every 30s with location, plotted on the
map as colored circles alongside bird pins. Explicitly labeled everywhere
as **relative and uncalibrated** — phone/browser mic gain is unknown and
varies, so this is a "louder/quieter, here vs. there" signal, not a
certified SPL/dB(A) reading. This is exactly the noise-vs-biodiversity
pairing the urban-research framing was missing.

## 2026-07-20 — Telegram Mini App + Supabase groundwork

Vlad decided to actually build the shared-map idea ("это круто!").

**Backend choice:** asked Vlad to pick since account creation isn't
something Claude does on someone's behalf. Presented Firebase vs.
Supabase; Vlad wanted free and asked for a recommendation — went with
**Supabase** (Postgres, generous free tier, project already created by
Vlad: `https://rcorzmmmfczoupthwvzn.supabase.co`).

**Telegram bot:** Vlad created a new one via @BotFather rather than
reusing an existing bot.

**MCP setup saga** (worth remembering for next time): Vlad wanted to wire
Supabase in as an MCP server so Claude could manage schema/queries
directly instead of hand-written SQL migrations. First attempt used
`claude mcp add --scope project`, which only shows up in `/mcp` when
`claude` is launched from that exact project directory — confusing, Vlad
couldn't find it. Removed and re-added at **user scope** instead
(`claude mcp add --scope user`, lives in `C:\Users\Vlad\.claude.json`),
which works from any directory. Vlad was uncomfortable with the terminal
in general ("я не умею ей пользоваться") — walked through the exact
four steps (open terminal → `claude` → `/mcp` → select supabase, approve
in browser) with no assumed prior knowledge. Confirmed connected via
`claude mcp list` (`✔ Connected`) — but the *session already open* at
that point didn't pick up the newly-authorized server, since MCP tools
load at session start. Lesson: after a fresh `/mcp` authorization, tools
only appear in a **new** session, not the one used to run the auth flow.

**Open question raised by Vlad, not yet answered:** is MCP even needed?
Honest answer given: no, not strictly — the shipped app only needs a
Supabase URL + anon key and RLS policies, which doesn't require MCP at
all. MCP is purely a development-convenience layer (schema/migrations via
conversation instead of hand-written SQL + manual dashboard pasting).
Vlad chose to keep going with MCP despite the friction, specifically
because he didn't want to hand-manage SQL himself.

**Where things stand:** Supabase MCP authorized and connected. Telegram
bot token exists, stored locally in `.env.local` (gitignored), never
committed, never to be pasted back into chat. Next real step is schema
design for shared bird/noise pins — see `CLAUDE.md`'s "Concrete next
steps" section, not restated here to avoid the two files drifting out of
sync.
