# Berlin Club DJ Database — Spec

A personal, queryable archive of who played at **Berghain Klubnacht**, **Sisyphos**, and
**Tresor** — which DJ, which night, which floor, and (where published) at which hour.

## 1. Motivation

The goal is a database first, a website second. The site is a viewer over the data.
Everything is designed so the SQLite file is the artifact worth keeping — the HTML is
disposable and regenerable.

## 1a. What changed after v1 (per-stage timetables, a third club, a capture pipeline)

Three things were added once the first version worked, and each is reflected in the
sections below:

1. **Set times per stage.** The CC BY archive API has no set times — but the official
   berghain.berlin *event pages* carry the full per-stage timetable and keep it for past
   nights too (verified to 2012). A `slots` table now stores that printed timetable
   verbatim (billing string, clock, label), and the times are matched back onto the
   archive's performance rows so artist pages show when each DJ played. B2B billings link
   to each artist. This is richer data than the API exposes and is the source of the
   per-stage timetable on every event page.

2. **Tresor** as a third club. No API, no archive, no licence — the official listing
   shows upcoming events with per-floor lineups, and each event page adds set-time ranges.
   Capture-forward, like Sisyphos. It is an adapter, not a schema change, because the
   model was club-agnostic from the start.

3. **A capture orchestrator.** Sisyphos and Tresor lineups are human-maintained, appear
   late, and are removed after the party. `scripts/orchestrate.mjs` runs the ephemeral
   ingesters, logs a per-source delta, and is scheduled across the weekend so nothing is
   lost. See §5a.

## 2. Research findings (this drove every decision below)

### Berghain — a good dataset already exists. Adopt it.

[berghain.ravers.workers.dev](https://berghain.ravers.workers.dev) is a complete Klubnacht
archive since opening night (18 Dec 2004), built by JPHFA from official monthly flyers
(2004–2009, cross-checked against original PDFs) and berghain.berlin listings (2009+).

Verified live against the API:

| Metric | Count |
| --- | --- |
| Artists | 2,539 |
| Events | 1,052 |
| Performances | 13,571 |
| Berghain floor | 6,955 |
| Panorama Bar floor | 6,616 |

**It is CC BY 4.0 licensed**, CORS-enabled, needs no auth. Rebuilding this from scratch
would be months of flyer archaeology to arrive at a strictly worse copy. We ingest it and
attribute it.

Free endpoints confirmed working:

| Endpoint | Returns |
| --- | --- |
| `/api/stats` | totals + venue breakdown |
| `/api/artists?limit=5000` | all 2,539 artists |
| `/api/artists/ranking` | all artists, ranked by performance count |
| `/api/artists/:id` | one artist |
| `/api/artists/:id/performances` | **the join table** — every set, with venue + iso_date |
| `/api/shows` | all 1,052 events |
| `/api/residents/current` | current residents |

There is no free bulk export (that endpoint is x402-paywalled), so the full performance
table is reconstructed with 2,539 per-artist calls. That is a one-time ~4 minute crawl,
then it lives in local SQLite. Subsequent runs are incremental.

### Sisyphos — no comparable archive exists. This is the real gap.

This is worth stating plainly: **Sisyphos historical lineup data barely exists**, and not
by accident. Sisyphos deliberately does not announce lineups in advance — it's part of the
club's ethos. There is no flyer archive to mine.

What exists:

- **[sisyduck.com](https://sisyduck.com)** — unofficial. Has an *undocumented* JSON endpoint
  at `/api/events` returning past + upcoming events with dates and floors. No license, no
  terms, no stated ownership. Related to shallowbunny.com.
- **[sisy.fan](https://sisy.fan)** — unofficial (Laravel/Livewire). Upcoming timetable only,
  no archive, no API. Probably the site you were thinking of; the name is `sisy.fan`, not
  `sis.fan`.
- Resident Advisor lists Sisyphos events but lineups are sparse for the same reason.

**Consequence:** Berghain gets a deep historical archive on day one. Sisyphos gets an
event-level skeleton plus a *capture-forward* strategy — we poll and snapshot lineups as
they appear, and the archive accrues over time. This asymmetry is inherent to the subject,
not a shortcoming of the implementation. The schema treats it as normal.

**Caution:** sisyduck's endpoint is undocumented and unlicensed. We treat it as
best-effort, cache aggressively, crawl politely, and keep it isolated behind one adapter so
it can be swapped or dropped without touching anything else.

## 3. Technology

Chosen constraint: **zero runtime dependencies**. Node 23 ships `node:sqlite` and `fetch`,
which covers the whole job. No `npm install`, no `node_modules`, no supply chain, no
framework churn. This repo should still build unchanged in five years.

| Layer | Choice |
| --- | --- |
| Language | JavaScript (ESM), Node ≥ 22 |
| Store | SQLite via built-in `node:sqlite` → `data/berlin.db` |
| Ingest | Plain `fetch`, per-source adapter, polite rate limiting |
| Site | Custom static generator → `dist/` (HTML + JSON index) |
| Client | Vanilla JS, no framework. Instant client-side search. |
| Host | Any static host — Cloudflare Pages, Netlify, GitHub Pages, `rsync` to a VPS |

Rejected: Astro/Next/SvelteKit (needs installs and a build toolchain for what is ~600 lines
of generation); Postgres (nothing here needs a server); client-side SQLite/wasm (a 400 KB
JSON index is smaller than the wasm runtime).

## 4. Data model

Club-agnostic from the start, so a third venue is an adapter and not a migration.

```
clubs         id, slug, name
artists       id, slug, name, source, source_artist_id
events        id, club_id, source_event_id, title, iso_date, end_date, url, source
floors        id, club_id, name                  -- Berghain / Panorama Bar / Tresor / Hammahalle …
performances  id, event_id, artist_id, floor_id, start_time, end_time, source
slots         id, event_id, floor_id, clock, start_time, billing, collective, position, source
sources       id, name, url, license, attribution, fetched_at
```

Rules:

- `performances` is the grain for artist-centric views: one row = one artist on one floor
  at one event. `slots` is the grain for event-centric views: one row = one printed
  timetable line, keeping the billing verbatim ("Fiedel B2B DJ Pete") plus clock and label.
  A B2B billing is one `slots` row but links to several artists (whole-match against the
  archive first, split only when there is no whole match, so duos like "Blasha & Allatt"
  stay intact while true B2Bs split).
- Event pages render from `slots` when present, else fall back to the flat `performances`
  lineup. Nights with neither are treated as having no published lineup and are hidden.
- Every row carries `source`, so mixed-provenance data stays auditable and a bad source can
  be deleted with one `DELETE WHERE source = ?`.
- Ingest is **idempotent**: `UNIQUE(event_id, artist_id, floor_id)` + upsert. Re-running is
  always safe.
- **Known, verified discrepancy:** we store 13,519 performances against upstream's 13,571
  count (−52, ≈0.4%). This is not data loss from a bug. Upstream bills some artists twice
  on the same floor at the same event — e.g. Ben Klock at Klubnacht on 2014-09-27, 2013-05-11,
  2012-05-12 — and 34 of the 52 come from the top 40 artists alone. The API exposes no set
  times, so the duplicate rows are *identical and indistinguishable*; there is no way to tell
  a genuine second set from a double-billing. We collapse them and count distinct sets.
  Our per-artist totals therefore run slightly below the numbers shown on the upstream site
  (Ben Klock: 202 upstream, ~197 distinct here). This is a deliberate choice, documented so
  it is never mistaken for drift.
- Artist identity uses a normalized slug. Alias consolidation follows the upstream flyer
  billing; we do not attempt to be cleverer than the source.
- `iso_date` is stored as `YYYY-MM-DD` text (SQLite convention, sorts lexically).

## 5. Site

Design language: monochrome, brutalist, heavy type, concrete. It should look like the
subject matter, not like a SaaS dashboard.

Pages:

- `/` — instant search over every artist. Type-ahead, no server round trip.
- `/artist/:slug` — every set that artist played: date, club, floor. The core view.
- `/event/:id` — one Klubnacht's full lineup by floor.
- `/stats` — leaderboards, most-booked artists, activity over time, floor splits.

Search runs client-side over a prebuilt index (~400 KB gzipped for 2.5k artists), so the
whole site is static files and hosting is free.

## 6. Commands

```
npm run ingest:berghain    # crawl the CC BY 4.0 API → SQLite (incremental)
npm run ingest:sisyphos    # capture Sisyphos events → SQLite (best-effort)
npm run build              # SQLite → dist/
npm run dev                # build + serve on :4321 + watch
npm run stats              # print DB summary to the terminal
```

## 7. Hosting

`dist/` is pure static output. Deploy is a file copy:

- **Cloudflare Pages / Netlify** — point at repo, build `npm run build`, publish `dist/`
- **GitHub Pages** — push `dist/`
- **Own server** — `rsync -av dist/ user@host:/var/www/berlin-club-dj/`

Data refresh is a cron running the ingest + build and redeploying. Nothing needs a
runtime, a container, or a cluster.

## 5a. Capture orchestrator (the ephemeral sources)

Sisyphos and Tresor lineups are human-maintained, published late (Sisyphos typically
Friday night into Saturday), and removed after the party. Missing the window loses the
data permanently. `scripts/orchestrate.mjs` is the pipeline runner: it executes the
ingesters in order, snapshots per-source slot counts before and after, appends a
machine-readable record to `data/capture.log`, and never lets one failing source abort
the others. It is scheduled across the weekend by
[.github/workflows/capture.yml](.github/workflows/capture.yml), which commits whatever it
caught back to the repo. `npm run capture` locally does the same. Because every ingester
is idempotent, running it every 30 minutes through a weekend is safe and simply accretes.

## 8. Sources & attribution (required, not optional)

All sources are listed in the site footer and on the dedicated `/about` (Sources) page.

- **Berghain lineups** — [berghain.ravers.workers.dev](https://berghain.ravers.workers.dev),
  **CC BY 4.0**, and the attribution **must** be shown (footer, Sources page, `sources`
  table). It is the licence condition under which the data may be used at all.
- **Berghain set times** — official event pages at berghain.berlin.
- **Sisyphos** — sisyduck.com / sisy.fan (unofficial, unlicensed).
- **Tresor** — tresorberlin.com (official site, no licence).

The unofficial sources are scraped politely, cached, and each isolated behind a single
adapter so any one can be swapped or dropped without touching the rest.

## 9. Non-goals

- No ticketing, no live "who's playing now" — sisyduck already does that well.
- No tracklists — MixesDB has that covered.
- No scraping behind auth, and no attempt to defeat rate limits or bot protection.
