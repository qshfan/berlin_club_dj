# Berlin Club DJ

A personal archive of who played at **Berghain Klubnacht** and **Sisyphos**.

The SQLite file is the point. The website is a viewer over it.

```
npm run dev      # http://localhost:4321
```

No dependencies. No `npm install`. Node ≥ 22 only — it uses the built-in
`node:sqlite` and `fetch`.

## What's in it

| | Nights | Sets | Set times |
| --- | --- | --- | --- |
| **Berghain** (Klubnacht, since opening night 18.12.2004) | 1,052 | 13,519 | none — see below |
| **Sisyphos** (since Dec 2023) | 89 | grows forward | yes, when published |

2,540 artists. Marcel Dettmann and Ben Klock lead at ~200 sets each, both from
opening night onward.

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
npm run ingest            # both sources
npm run ingest:berghain   # ~4 min cold, seconds when warm (incremental)
npm run ingest:sisyphos   # add --all-events to sweep past events too
npm run build             # → dist/
npm run dev               # build + serve + watch
npm run stats             # database summary in the terminal
```

`ingest:berghain` is incremental: an artist whose local set count already matches
upstream is skipped, so a re-run after a new Klubnacht touches only what changed.
Both ingesters are idempotent — re-running is always safe.

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

Sisyphos event data via [sisyduck.com](https://sisyduck.com) (unofficial; upstream
[sisy.fan](https://sisy.fan)) — undocumented and unlicensed, so treated as best-effort
and isolated behind one adapter.

Unofficial personal archive. Not affiliated with any club.
