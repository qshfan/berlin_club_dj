# Berlin Club DJ

A personal archive of who played at **Berghain Klubnacht**, **Sisyphos**, and
**Tresor** — which DJ, which night, which floor, and (where published) at which hour.

The SQLite file is the point. The website is a viewer over it.

```
npm run dev      # http://localhost:4321
```

No dependencies. No `npm install`. Node ≥ 22 only — it uses the built-in
`node:sqlite` and `fetch`.

## What's in it

| | Coverage | Set times |
| --- | --- | --- |
| **Berghain** (Klubnacht, since opening night 18.12.2004) | full archive, 1,052 nights | yes — backfilled from official event pages |
| **Sisyphos** (since Dec 2023) | events + capture-forward lineups | yes, when published (rare) |
| **Tresor** (upcoming) | capture-forward lineups | yes, time ranges |

2,500+ artists. On the **Nights** page you pick a club and open a night to see the
full per-stage timetable — Berghain / Panorama Bar / Garten, Tresor / Globus, and so
on — with each DJ's set time and label. Nights with no published lineup are not listed.

### Set times — the part that took real work

Berghain's public lineup API strips set times. But the **official event pages keep the
full per-stage timetable, and keep it for past nights too** (verified back to 2012). So
times are read straight from those pages and matched onto the archive — including B2B
billings, which link to each artist. This is genuinely richer data than the API exposes.

Where a night never had a published timetable, the hour is left blank rather than
invented.

## Read this before you trust a number

**Berghain has no set times, and never will.** The club bills a night's artists per
floor and publishes nothing else — no timetable, by design. No public source has them.
So this archive answers *which night* and *which floor*, and shows `—` for the hour
rather than inventing one.

**Sisyphos barely has lineups at all.** The club doesn't announce them in advance;
that's its ethos, not an oversight. sisyduck — the best public tracker — reports
missing ~96% of the lineup even for a party happening tonight. So Sisyphos events are
real history (89 of them), but lineups only accrue *forward* from whenever you start
polling. Run `ingest:sisyphos` on a cron through a party and it collects what appears.

**Counts run ~0.4% below the upstream Berghain site.** We store 13,519 sets against
their 13,571. Upstream bills some artists twice on the same floor at the same event
(Ben Klock at Klubnacht on 2014-09-27, 2013-05-11, 2012-05-12, …) with no set times to
tell the rows apart. They're identical and indistinguishable, so we collapse them and
count distinct sets. Deliberate, not drift. See [SPEC.md](SPEC.md).

## Commands

```
npm run ingest                 # all sources, in order
npm run ingest:berghain        # lineup archive — ~4 min cold, seconds when warm
npm run ingest:berghain:times  # set times from official event pages (~20 min cold)
npm run ingest:sisyphos        # capture-forward; --all-events to sweep past events
npm run ingest:tresor          # capture-forward, upcoming events with time ranges
npm run capture                # orchestrated capture of the ephemeral sources + build
npm run capture:full           # capture + refresh Berghain archive & times
npm run build                  # → dist/
npm run dev                    # build + serve + watch on :4321
npm run stats                  # database summary in the terminal
```

Everything is incremental and idempotent — re-running is always safe. `ingest:berghain`
skips artists already current; `ingest:berghain:times` skips past events already
enriched and re-fetches only recent/upcoming ones.

### The capture pipeline (for the ephemeral sources)

Sisyphos and Tresor lineups are human-maintained, appear late (Sisyphos typically Friday
night into Saturday), and are **removed after the party**. Miss the window and the data
is gone. `npm run capture` runs the ingesters, records a per-source before/after delta to
`data/capture.log`, and is safe to run on a timer.

[.github/workflows/capture.yml](.github/workflows/capture.yml) runs it automatically
across the weekend (Fri evening → Sun) and commits whatever it caught. To run it locally
instead, cron it — e.g. every 30 min through the weekend:

```
*/30 * * * 5,6,0  cd /path/to/berlin_club_dj && npm run capture --silent >> data/cron.log 2>&1
```

## Querying it directly

The database is the deliverable. Skip the website:

```sql
-- Who has played the most Klubnachts on the Berghain floor?
SELECT a.name, COUNT(*) n
FROM performances p
JOIN artists a ON a.id = p.artist_id
JOIN floors  f ON f.id = p.floor_id
WHERE f.name = 'Berghain'
GROUP BY a.id ORDER BY n DESC LIMIT 10;

-- Everyone who played on a given night
SELECT a.name, f.name AS floor
FROM performances p
JOIN artists a ON a.id = p.artist_id
JOIN events  e ON e.id = p.event_id
LEFT JOIN floors f ON f.id = p.floor_id
WHERE e.iso_date = '2024-12-28';
```

```
sqlite3 data/berlin.db
```

## Deploying

`dist/` is plain static files — no runtime, no container, no cluster.

**Cloudflare Pages / Netlify** — connect the repo, build `npm run build`, publish
`dist/`. Config for both is committed ([netlify.toml](netlify.toml)).

**GitHub Pages** — [.github/workflows/deploy.yml](.github/workflows/deploy.yml) builds
and publishes on push. Enable Pages → Source: GitHub Actions.

**Your own server**

```
npm run build && rsync -av --delete dist/ user@host:/var/www/berlin-club-dj/
```

To keep it fresh, cron the refresh (`npm run ingest && npm run build`) weekly —
Klubnacht is weekly. For Sisyphos set times, poll every ~30 min during a party.

## Attribution — required

Berghain data comes from
**[berghain.ravers.workers.dev](https://berghain.ravers.workers.dev)** by JPHFA,
licensed **CC BY 4.0**, built from official monthly flyers (2004–2009, cross-checked
against the original PDFs) and berghain.berlin listings (2009+). Rebuilding this from
scratch would be months of flyer archaeology to arrive at a worse copy.

The attribution in the site footer is the licence condition under which this data may
be used at all. Don't remove it.

Berghain **set times** come from the official event pages at
[berghain.berlin](https://www.berghain.berlin/en/program/).

Sisyphos event data via [sisyduck.com](https://sisyduck.com) (unofficial; upstream
[sisy.fan](https://sisy.fan)) and Tresor data from
[tresorberlin.com](https://tresorberlin.com/club/events/) — both undocumented and
unlicensed, so treated as best-effort and each isolated behind its own adapter.

The site's **Sources** page (and the footer on every page) list all of this. Unofficial
personal archive. Not affiliated with any club.
