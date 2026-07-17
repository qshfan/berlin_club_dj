// SQLite → dist/ static site. No framework, no deps.
//
// The DB is the artifact; dist/ is disposable and regenerable. Everything here is
// plain string templating: ~2.5k artist pages + ~1.1k event pages + a search index.

import { openDb, ROOT } from './db.mjs'
import { mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DIST = join(ROOT, 'dist')
const db = openDb()
const t0 = Date.now()

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

// dd.mm.yyyy — German convention, matches the flyers.
const fmtDate = (iso) => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const weekday = (iso) => (iso ? WEEKDAY[new Date(iso + 'T12:00:00Z').getUTCDay()] : '')

// Set times are stored as UTC instants; display them in the club's timezone.
const fmtTime = (ts) =>
  ts
    ? new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Berlin',
        hour12: false,
      }).format(new Date(ts))
    : null

function layout({ title, body, active = '', depth = 0 }) {
  const root = depth === 0 ? '.' : '..'
  const nav = [
    ['', 'Index'],
    ['events', 'Nights'],
    ['stats', 'Stats'],
  ]
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${root}/style.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' fill='%23000'/><rect x='6' y='3' width='4' height='10' fill='%23fff'/></svg>">
</head>
<body>
<header class="top">
  <a class="wordmark" href="${root}/">BERLIN<br>CLUB<br>DJ</a>
  <nav>${nav
    .map(
      ([slug, label]) =>
        `<a href="${root}/${slug ? slug + '.html' : ''}"${active === (slug || 'index') ? ' aria-current="page"' : ''}>${label}</a>`
    )
    .join('')}</nav>
</header>
<main>${body}</main>
<footer>
  <p>Berghain data from <a href="https://berghain.ravers.workers.dev">berghain.ravers.workers.dev</a> by JPHFA — licensed <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. Built from official flyers (2004&ndash;2009) and berghain.berlin listings (2009+).</p>
  <p>Sisyphos event data via <a href="https://sisyduck.com">sisyduck.com</a> (unofficial; upstream <a href="https://sisy.fan">sisy.fan</a>).</p>
  <p>Unofficial personal archive. Not affiliated with any club.</p>
</footer>
<script src="${root}/app.js" defer></script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------
const clubs = db.prepare('SELECT * FROM clubs').all()
const clubById = new Map(clubs.map((c) => [c.id, c]))

const artists = db
  .prepare(
    `SELECT a.id, a.slug, a.name,
            COUNT(p.id)                                  AS sets,
            MIN(e.iso_date)                              AS first_night,
            MAX(e.iso_date)                              AS last_night,
            COUNT(DISTINCT e.club_id)                    AS clubs
     FROM artists a
     JOIN performances p ON p.artist_id = a.id
     JOIN events e       ON e.id = p.event_id
     GROUP BY a.id
     ORDER BY sets DESC, a.name`
  )
  .all()

const events = db
  .prepare(
    `SELECT e.id, e.club_id, e.title, e.iso_date, e.url, e.source_event_id,
            COUNT(p.id) AS sets
     FROM events e
     LEFT JOIN performances p ON p.event_id = e.id
     GROUP BY e.id
     ORDER BY e.iso_date DESC`
  )
  .all()

const perfByArtist = db
  .prepare(
    `SELECT p.artist_id, e.id AS event_id, e.title, e.iso_date, e.club_id, e.url,
            f.name AS floor, p.start_time
     FROM performances p
     JOIN events e ON e.id = p.event_id
     LEFT JOIN floors f ON f.id = p.floor_id
     ORDER BY e.iso_date DESC`
  )
  .all()

const byArtist = new Map()
for (const p of perfByArtist) {
  if (!byArtist.has(p.artist_id)) byArtist.set(p.artist_id, [])
  byArtist.get(p.artist_id).push(p)
}

const perfByEvent = new Map()
for (const p of perfByArtist) {
  if (!perfByEvent.has(p.event_id)) perfByEvent.set(p.event_id, [])
  perfByEvent.get(p.event_id).push(p)
}
const artistById = new Map(artists.map((a) => [a.id, a]))

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------
rmSync(DIST, { recursive: true, force: true })
mkdirSync(join(DIST, 'artist'), { recursive: true })
mkdirSync(join(DIST, 'event'), { recursive: true })

const clubTag = (id) => `<span class="club club--${clubById.get(id)?.slug ?? 'x'}">${esc(clubById.get(id)?.name ?? '?')}</span>`

// --- index -----------------------------------------------------------------
const totalSets = artists.reduce((n, a) => n + a.sets, 0)
writeFileSync(
  join(DIST, 'index.html'),
  layout({
    title: 'Berlin Club DJ — who played Berghain & Sisyphos',
    active: 'index',
    body: `
<section class="hero">
  <h1>Who played<br>in Berlin</h1>
  <p class="lede">A personal archive of every DJ billed at <strong>Berghain Klubnacht</strong> since opening night in 2004, and at <strong>Sisyphos</strong>.</p>
  <ul class="counts">
    <li><b>${artists.length.toLocaleString('en')}</b><span>artists</span></li>
    <li><b>${totalSets.toLocaleString('en')}</b><span>sets</span></li>
    <li><b>${events.length.toLocaleString('en')}</b><span>nights</span></li>
  </ul>
</section>

<section class="search">
  <label class="sr-only" for="q">Search artists</label>
  <input id="q" type="search" placeholder="Search 2,500+ artists…" autocomplete="off" autofocus spellcheck="false">
  <p class="hint" id="hint">Type to filter. Sorted by number of sets played.</p>
  <ol id="results" class="rows"></ol>
  <p id="more" class="more"></p>
</section>`,
  })
)

// --- artist pages ----------------------------------------------------------
for (const a of artists) {
  const sets = byArtist.get(a.id) ?? []
  const anyTime = sets.some((s) => s.start_time)
  const byYear = new Map()
  for (const s of sets) {
    const y = s.iso_date.slice(0, 4)
    if (!byYear.has(y)) byYear.set(y, [])
    byYear.get(y).push(s)
  }

  const rows = [...byYear.entries()]
    .map(
      ([year, list]) => `
    <section class="year">
      <h3>${year} <span class="muted">· ${list.length} set${list.length === 1 ? '' : 's'}</span></h3>
      <table class="sets">
        <thead><tr><th>Date</th><th>Day</th><th>Club</th><th>Floor</th><th>Time</th><th>Night</th></tr></thead>
        <tbody>
        ${list
          .map(
            (s) => `<tr>
            <td class="num">${fmtDate(s.iso_date)}</td>
            <td class="muted">${weekday(s.iso_date)}</td>
            <td>${clubTag(s.club_id)}</td>
            <td>${s.floor ? esc(s.floor) : '<span class="muted">—</span>'}</td>
            <td class="num">${fmtTime(s.start_time) ?? '<span class="muted" title="Not published">—</span>'}</td>
            <td><a href="../event/${s.event_id}.html">${esc(s.title)}</a></td>
          </tr>`
          )
          .join('')}
        </tbody>
      </table>
    </section>`
    )
    .join('')

  writeFileSync(
    join(DIST, 'artist', `${a.slug}.html`),
    layout({
      depth: 1,
      title: `${a.name} — Berlin Club DJ`,
      body: `
<article class="artist">
  <p class="crumb"><a href="../">← All artists</a></p>
  <h1>${esc(a.name)}</h1>
  <ul class="counts counts--sm">
    <li><b>${a.sets}</b><span>set${a.sets === 1 ? '' : 's'}</span></li>
    <li><b>${fmtDate(a.first_night)}</b><span>first</span></li>
    <li><b>${fmtDate(a.last_night)}</b><span>latest</span></li>
  </ul>
  ${
    anyTime
      ? ''
      : `<p class="note">No set times shown: Berghain does not publish a timetable — the archive records the night and the floor only. <a href="../stats.html#times">Why?</a></p>`
  }
  ${rows}
</article>`,
    })
  )
}

// --- event pages -----------------------------------------------------------
for (const ev of events) {
  const sets = perfByEvent.get(ev.id) ?? []
  const byFloor = new Map()
  for (const s of sets) {
    const f = s.floor ?? 'Unknown floor'
    if (!byFloor.has(f)) byFloor.set(f, [])
    byFloor.get(f).push(s)
  }
  const floors = [...byFloor.entries()]
    .map(
      ([floor, list]) => `
      <section class="floor">
        <h3>${esc(floor)} <span class="muted">· ${list.length}</span></h3>
        <ul class="lineup">
          ${list
            .sort((a, b) => (a.start_time ?? '').localeCompare(b.start_time ?? ''))
            .map((s) => {
              const artist = artistById.get(s.artist_id)
              const time = fmtTime(s.start_time)
              return `<li>${time ? `<span class="slot">${time}</span>` : ''}<a href="../artist/${artist?.slug}.html">${esc(artist?.name ?? '?')}</a></li>`
            })
            .join('')}
        </ul>
      </section>`
    )
    .join('')

  writeFileSync(
    join(DIST, 'event', `${ev.id}.html`),
    layout({
      depth: 1,
      title: `${ev.title} · ${fmtDate(ev.iso_date)} — Berlin Club DJ`,
      body: `
<article class="event">
  <p class="crumb"><a href="../events.html">← All nights</a></p>
  <h1>${esc(ev.title)}</h1>
  <p class="subhead">${clubTag(ev.club_id)} <span class="muted">${weekday(ev.iso_date)} ${fmtDate(ev.iso_date)} · ${ev.sets} set${ev.sets === 1 ? '' : 's'}</span></p>
  ${ev.url ? `<p><a class="ext" href="${esc(ev.url)}">Source listing ↗</a></p>` : ''}
  ${sets.length ? floors : '<p class="note">No lineup recorded for this night. Sisyphos rarely publishes one in advance.</p>'}
</article>`,
    })
  )
}

// --- nights index ----------------------------------------------------------
const eventsByYear = new Map()
for (const e of events) {
  const y = e.iso_date.slice(0, 4)
  if (!eventsByYear.has(y)) eventsByYear.set(y, [])
  eventsByYear.get(y).push(e)
}
writeFileSync(
  join(DIST, 'events.html'),
  layout({
    title: 'Nights — Berlin Club DJ',
    active: 'events',
    body: `
<h1>Nights</h1>
<p class="lede">${events.length.toLocaleString('en')} nights across ${clubs.length} clubs.</p>
${[...eventsByYear.entries()]
  .map(
    ([year, list]) => `
  <section class="year">
    <h3>${year} <span class="muted">· ${list.length}</span></h3>
    <ul class="rows">
      ${list
        .map(
          (e) => `<li><a href="event/${e.id}.html">
        <span class="num">${fmtDate(e.iso_date)}</span>
        <span class="name">${esc(e.title)}</span>
        ${clubTag(e.club_id)}
        <span class="count">${e.sets}</span>
      </a></li>`
        )
        .join('')}
    </ul>
  </section>`
  )
  .join('')}`,
  })
)

// --- stats -----------------------------------------------------------------
const perYear = db
  .prepare(
    `SELECT substr(e.iso_date,1,4) AS year, COUNT(p.id) AS sets, COUNT(DISTINCT p.artist_id) AS artists
     FROM performances p JOIN events e ON e.id = p.event_id
     GROUP BY year ORDER BY year`
  )
  .all()
const maxYear = Math.max(...perYear.map((r) => r.sets), 1)

const floorSplit = db
  .prepare(
    `SELECT f.name, COUNT(*) AS n FROM performances p JOIN floors f ON f.id = p.floor_id GROUP BY f.id ORDER BY n DESC`
  )
  .all()
const totalFloor = floorSplit.reduce((n, f) => n + f.n, 0)
const sources = db.prepare('SELECT * FROM sources').all()

writeFileSync(
  join(DIST, 'stats.html'),
  layout({
    title: 'Stats — Berlin Club DJ',
    active: 'stats',
    body: `
<h1>Stats</h1>

<section>
  <h2>Most booked</h2>
  <ol class="rows ranked">
    ${artists
      .slice(0, 25)
      .map(
        (a, i) => `<li><a href="artist/${a.slug}.html">
      <span class="rank">${i + 1}</span>
      <span class="name">${esc(a.name)}</span>
      <span class="bar" style="--w:${(a.sets / artists[0].sets) * 100}%"></span>
      <span class="count">${a.sets}</span>
    </a></li>`
      )
      .join('')}
  </ol>
</section>

<section>
  <h2>Sets per year</h2>
  <ol class="chart">
    ${perYear
      .map(
        (r) => `<li>
      <span class="y">${r.year}</span>
      <span class="b" style="--h:${(r.sets / maxYear) * 100}%" title="${r.sets} sets · ${r.artists} artists"></span>
      <span class="v">${r.sets}</span>
    </li>`
      )
      .join('')}
  </ol>
  <p class="hint">2020&ndash;2021 reflects the pandemic closure. Future-dated nights are already-announced lineups.</p>
</section>

<section>
  <h2>Floors</h2>
  <ul class="rows">
    ${floorSplit
      .map(
        (f) => `<li><span class="name">${esc(f.name)}</span>
      <span class="bar" style="--w:${(f.n / totalFloor) * 100}%"></span>
      <span class="count">${f.n.toLocaleString('en')}</span></li>`
      )
      .join('')}
  </ul>
</section>

<section id="times">
  <h2>Why are there no set times?</h2>
  <p class="prose">Because Berghain does not publish them. The club bills a night's artists per floor and nothing else &mdash; no timetable, by design. No public source has Berghain set times, so this archive records <strong>which night</strong> and <strong>which floor</strong>, and leaves the hour blank rather than invent it.</p>
  <p class="prose">Sisyphos <em>does</em> run a timetable, but announces it late and partially &mdash; sisyduck, the best public tracker, reports missing ~96% of it. Sisyphos set times here are captured live as they are published, so that archive grows forward from now rather than backwards.</p>
</section>

<section>
  <h2>Sources</h2>
  <ul class="rows">
    ${sources
      .map(
        (s) => `<li><span class="name"><a href="${esc(s.url)}">${esc(s.name)}</a></span>
      <span class="muted">${esc(s.license ?? 'unknown')}</span>
      <span class="muted">${s.fetched_at ? s.fetched_at.slice(0, 10) : ''}</span></li>`
      )
      .join('')}
  </ul>
</section>`,
  })
)

// --- search index ----------------------------------------------------------
// Compact positional array — [name, slug, sets, firstYear, lastYear, clubMask].
writeFileSync(
  join(DIST, 'search.json'),
  JSON.stringify({
    generated: new Date().toISOString(),
    artists: artists.map((a) => [a.name, a.slug, a.sets, Number(a.first_night.slice(0, 4)), Number(a.last_night.slice(0, 4))]),
  })
)

// --- static assets ---------------------------------------------------------
const assets = join(ROOT, 'assets')
if (existsSync(assets)) cpSync(assets, DIST, { recursive: true })

db.close()

const ms = Date.now() - t0
console.log(`built dist/ in ${(ms / 1000).toFixed(1)}s`)
console.log(`  ${artists.length} artist pages`)
console.log(`  ${events.length} event pages`)
console.log(`  ${totalSets.toLocaleString('en')} sets indexed`)
