// SQLite → dist/ static site. No framework, no deps.
//
// The DB is the artifact; dist/ is disposable and regenerable. Everything here is
// plain string templating: artist pages + event pages (per-stage timetables) + a
// client search index.

import { openDb, ROOT, slugify, splitBilling } from './db.mjs'
import { mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DIST = join(ROOT, 'dist')
const db = openDb()
const t0 = Date.now()

// Cache-busting token. Static hosts (and browsers) cache style.css / app.js / search.json
// aggressively; without a version query, an updated site keeps serving stale assets. This
// changes every build, so each deploy forces fresh assets.
const BUILD = t0.toString(36)

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
    ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin', hour12: false }).format(
        new Date(ts)
      )
    : null
// Weekday (Berlin) — parties span several days, so a bare clock is ambiguous.
const fmtDay = (ts) => (ts ? new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'Europe/Berlin' }).format(new Date(ts)) : '')
const berlinDayKey = (ts) => (ts ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts)) : '')

// Canonical stage order per club; unknown stages sort last, alphabetically.
const FLOOR_ORDER = [
  'Berghain', 'Panorama Bar', 'Säule', 'Halle', 'Kantine', 'Garten', 'Elsewhere',
  'Tresor', 'Globus', '+4Bar', 'Vault', 'Aurora Bar',
  'Hammahalle', 'Wintergarten', 'Strand', 'Dampfer', 'Tunnel',
]
const floorRank = (name) => {
  const i = FLOOR_ORDER.indexOf(name)
  return i === -1 ? [1, name] : [0, i]
}

function layout({ title, body, active = '', depth = 0, description = '' }) {
  const root = depth === 0 ? '.' : '..'
  const nav = [
    ['', 'Nights'],
    ['artists', 'DJs'],
    ['stats', 'Stats'],
  ]
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ''}
<link rel="stylesheet" href="${root}/style.css?v=${BUILD}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' fill='%23000'/><rect x='6' y='3' width='4' height='10' fill='%23fff'/></svg>">
<script>window.__V=${JSON.stringify(BUILD)}</script>
</head>
<body>
<header class="top">
  <a class="wordmark" href="${root}/">BERLIN<br>CLUB<br>DJ</a>
  <nav>${nav
    .map(([slug, label]) => `<a href="${root}/${slug ? slug + '.html' : ''}"${active === (slug || 'index') ? ' aria-current="page"' : ''}>${label}</a>`)
    .join('')}</nav>
</header>
<main>${body}</main>
<footer>
  ${
    active === 'index'
      ? `<p class="foot-title">Sources</p>
  <ul class="foot-src">
    <li><strong>Berghain lineups</strong> — <a href="https://berghain.ravers.workers.dev">berghain.ravers.workers.dev</a> by JPHFA, licensed <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. Built from official monthly flyers (2004&ndash;2009) and berghain.berlin listings (2009+).</li>
    <li><strong>Berghain set times</strong> — official event pages at <a href="https://www.berghain.berlin/en/program/">berghain.berlin</a>.</li>
    <li><strong>Sisyphos</strong> — <a href="https://sisy.fan">sisy.fan</a> (unofficial), event list via <a href="https://sisyduck.com">sisyduck.com</a>.</li>
    <li><strong>Tresor</strong> — official listing at <a href="https://tresorberlin.com/club/events/">tresorberlin.com</a>.</li>
  </ul>`
      : ''
  }
  <p class="foot-note">Unofficial personal archive. Not affiliated with any club.</p>
</footer>
<script src="${root}/app.js?v=${BUILD}" defer></script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------
const clubs = db.prepare('SELECT * FROM clubs').all()
const clubById = new Map(clubs.map((c) => [c.id, c]))
const clubTag = (id) => `<span class="club club--${clubById.get(id)?.slug ?? 'x'}">${esc(clubById.get(id)?.name ?? '?')}</span>`

const artists = db
  .prepare(
    `SELECT a.id, a.slug, a.name,
            COUNT(p.id)               AS sets,
            MIN(e.iso_date)           AS first_night,
            MAX(e.iso_date)           AS last_night
     FROM artists a
     JOIN performances p ON p.artist_id = a.id
     JOIN events e       ON e.id = p.event_id
     GROUP BY a.id
     ORDER BY sets DESC, a.name`
  )
  .all()
const artistById = new Map(artists.map((a) => [a.id, a]))
const artistSlugs = new Set(artists.map((a) => a.slug))

const events = db
  .prepare(
    `SELECT e.id, e.club_id, e.title, e.iso_date, e.url, e.source_event_id,
            (SELECT COUNT(*) FROM performances p WHERE p.event_id = e.id) AS sets,
            (SELECT COUNT(*) FROM slots s WHERE s.event_id = e.id)        AS slot_count
     FROM events e
     ORDER BY e.iso_date DESC`
  )
  .all()

const slotsByEvent = new Map()
for (const s of db
  .prepare(`SELECT s.event_id, f.name AS floor, s.clock, s.start_time, s.billing, s.collective, s.position FROM slots s LEFT JOIN floors f ON f.id = s.floor_id`)
  .all()) {
  if (!slotsByEvent.has(s.event_id)) slotsByEvent.set(s.event_id, [])
  slotsByEvent.get(s.event_id).push(s)
}

const perfByEvent = new Map()
for (const p of db
  .prepare(`SELECT p.event_id, p.artist_id, p.start_time, f.name AS floor FROM performances p LEFT JOIN floors f ON f.id = p.floor_id`)
  .all()) {
  if (!perfByEvent.has(p.event_id)) perfByEvent.set(p.event_id, [])
  perfByEvent.get(p.event_id).push(p)
}

const perfByArtist = new Map()
for (const p of db
  .prepare(
    `SELECT p.artist_id, e.id AS event_id, e.title, e.iso_date, e.club_id, p.start_time, f.name AS floor
     FROM performances p JOIN events e ON e.id = p.event_id LEFT JOIN floors f ON f.id = p.floor_id
     ORDER BY e.iso_date DESC`
  )
  .all()) {
  if (!perfByArtist.has(p.artist_id)) perfByArtist.set(p.artist_id, [])
  perfByArtist.get(p.artist_id).push(p)
}

// Which clubs each artist has played — powers the club filter on the DJs page.
const clubsByArtist = new Map()
for (const [artistId, perfs] of perfByArtist) {
  clubsByArtist.set(artistId, [...new Set(perfs.map((p) => clubById.get(p.club_id)?.slug).filter(Boolean))])
}

// Link a billing string to artist page(s): whole if the archive knows it, else split.
function linkBilling(billing) {
  const wholeSlug = slugify(billing)
  const names = artistSlugs.has(wholeSlug) ? [billing] : splitBilling(billing)
  return names
    .map((n) => {
      const slug = slugify(n)
      return artistSlugs.has(slug) ? `<a href="../artist/${slug}.html">${esc(n)}</a>` : esc(n)
    })
    .join(' <span class="b2b">b2b</span> ')
}

// A night's timetable as ordered stage groups. Prefer the printed slots; fall back to
// the flat archive lineup (artist + floor, no time) when no timetable was captured.
function stageGroups(ev) {
  const slots = slotsByEvent.get(ev.id)
  const groups = new Map()
  if (slots && slots.length) {
    for (const s of slots) {
      const f = s.floor ?? 'Floor'
      if (!groups.has(f)) groups.set(f, [])
      groups.get(f).push({ clock: s.clock, start: s.start_time, billing: s.billing, collective: s.collective, pos: s.position ?? 999 })
    }
  } else {
    const perfs = perfByEvent.get(ev.id)
    if (!perfs || !perfs.length) return []
    for (const p of perfs) {
      const f = p.floor ?? 'Floor'
      if (!groups.has(f)) groups.set(f, [])
      const a = artistById.get(p.artist_id)
      groups.get(f).push({ clock: fmtTime(p.start_time), start: p.start_time, billing: a?.name ?? '?', collective: '', pos: 999 })
    }
  }
  return [...groups.entries()]
    .sort((a, b) => {
      const [ra, va] = floorRank(a[0])
      const [rb, vb] = floorRank(b[0])
      return ra - rb || (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb)))
    })
    .map(([floor, rows]) => ({
      floor,
      rows: rows.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? '') || a.pos - b.pos),
    }))
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------
rmSync(DIST, { recursive: true, force: true })
mkdirSync(join(DIST, 'artist'), { recursive: true })
mkdirSync(join(DIST, 'event'), { recursive: true })

const totalSets = artists.reduce((n, a) => n + a.sets, 0)

// --- DJs (search + filters) ------------------------------------------------
const djMinYear = Math.min(...artists.map((a) => Number(a.first_night.slice(0, 4))))
const djMaxYear = Math.max(...artists.map((a) => Number(a.last_night.slice(0, 4))))
const yearOptions = (sel) =>
  Array.from({ length: djMaxYear - djMinYear + 1 }, (_, i) => djMinYear + i)
    .map((y) => `<option value="${y}"${y === sel ? ' selected' : ''}>${y}</option>`)
    .join('')

writeFileSync(
  join(DIST, 'artists.html'),
  layout({
    title: 'The DJs — Berlin Club DJ',
    active: 'artists',
    description: 'Search every DJ billed at Berghain Klubnacht, Sisyphos, and Tresor — filter by club and year.',
    body: `
<section class="hero">
  <h1>The DJs</h1>
  <p class="lede">Every DJ billed at <strong>Berghain Klubnacht</strong> since opening night in 2004, at <strong>Sisyphos</strong>, and at <strong>Tresor</strong> — ${artists.length.toLocaleString('en')} names across ${totalSets.toLocaleString('en')} sets. Search a name, or filter by club and years.</p>
</section>
<section class="search">
  <div class="filters">
    <div class="filter filter--grow">
      <label class="sr-only" for="q">Search DJs</label>
      <input id="q" type="search" placeholder="Search ${artists.length.toLocaleString('en')} DJs…" autocomplete="off" autofocus spellcheck="false">
    </div>
    <div class="filter">
      <label for="club">Club</label>
      <select id="club">
        <option value="all">All clubs</option>
        ${clubs.map((c) => `<option value="${c.slug}">${esc(c.name)}</option>`).join('')}
      </select>
    </div>
    <div class="filter">
      <label for="from">From</label>
      <select id="from">${yearOptions(djMinYear)}</select>
    </div>
    <div class="filter">
      <label for="to">To</label>
      <select id="to">${yearOptions(djMaxYear)}</select>
    </div>
    <button id="reset" type="button" class="reset" hidden>Reset</button>
  </div>
  <p class="hint" id="hint">Sorted by number of sets played.</p>
  <ol id="results"></ol>
  <div id="more"></div>
</section>`,
  })
)

// --- artist pages ----------------------------------------------------------
for (const a of artists) {
  const sets = perfByArtist.get(a.id) ?? []
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
      description: `Every set ${a.name} played at Berghain and Sisyphos.`,
      body: `
<article class="artist">
  <p class="crumb"><a href="../artists.html">← All DJs</a></p>
  <h1>${esc(a.name)}</h1>
  <ul class="counts counts--sm">
    <li><b>${a.sets}</b><span>set${a.sets === 1 ? '' : 's'}</span></li>
    <li><b>${fmtDate(a.first_night)}</b><span>first</span></li>
    <li><b>${fmtDate(a.last_night)}</b><span>latest</span></li>
  </ul>
  ${anyTime ? '' : `<p class="note">Some nights show no set time: it depends on whether a timetable was published for that night.</p>`}
  ${rows}
</article>`,
    })
  )
}

// --- event pages -----------------------------------------------------------
for (const ev of events) {
  const groups = stageGroups(ev)
  const hasTimes = groups.some((g) => g.rows.some((r) => r.clock))
  // Show the weekday when the night spans more than one calendar day (all of them do,
  // but especially Sisyphos, which runs Fri→Mon), so "16:00" isn't ambiguous.
  const showDay = new Set(groups.flatMap((g) => g.rows).map((r) => berlinDayKey(r.start)).filter(Boolean)).size > 1
  const timetable = groups
    .map(
      (g) => `
      <section class="floor">
        <h3>${esc(g.floor)} <span class="muted">· ${g.rows.length}</span></h3>
        <ol class="tt">
          ${g.rows
            .map(
              (r) => `<li>
            <span class="tt-time">${r.clock ? `${showDay && r.start ? `<span class="tt-day">${fmtDay(r.start)}</span> ` : ''}${esc(r.clock)}` : '<span class="muted">—</span>'}</span>
            <span class="tt-act">${linkBilling(r.billing)}</span>
          </li>`
            )
            .join('')}
        </ol>
      </section>`
    )
    .join('')
  writeFileSync(
    join(DIST, 'event', `${ev.id}.html`),
    layout({
      depth: 1,
      title: `${ev.title} · ${fmtDate(ev.iso_date)} — Berlin Club DJ`,
      description: `Lineup for ${ev.title} at ${clubById.get(ev.club_id)?.name} on ${fmtDate(ev.iso_date)}.`,
      body: `
<article class="event">
  <p class="crumb"><a href="../">← All nights</a></p>
  <h1>${esc(ev.title)}</h1>
  <p class="subhead">${clubTag(ev.club_id)} <span class="muted">${weekday(ev.iso_date)} ${fmtDate(ev.iso_date)}${groups.length ? ` · ${groups.reduce((n, g) => n + g.rows.length, 0)} sets across ${groups.length} floor${groups.length === 1 ? '' : 's'}` : ''}</span></p>
  ${ev.url ? `<p><a class="ext" href="${esc(ev.url)}">Source listing ↗</a></p>` : ''}
  ${groups.length ? `<div class="timetable${hasTimes ? '' : ' timetable--notime'}">${timetable}</div>` : '<p class="note">No lineup was published for this night.</p>'}
</article>`,
    })
  )
}

// --- nights index (club filter + hides no-lineup nights) --------------------
const listed = events.filter((e) => e.sets > 0 || e.slot_count > 0)
const hidden = events.length - listed.length
const eventsByYear = new Map()
for (const e of listed) {
  const y = e.iso_date.slice(0, 4)
  if (!eventsByYear.has(y)) eventsByYear.set(y, [])
  eventsByYear.get(y).push(e)
}
const perClubCount = clubs
  .map((c) => `${clubById.get(c.id).name}: ${listed.filter((e) => e.club_id === c.id).length}`)
  .join(' · ')

writeFileSync(
  join(DIST, 'index.html'),
  layout({
    title: 'Berlin Club Nights',
    active: 'index',
    description: 'Every night at Berghain Klubnacht, Sisyphos, and Tresor — pick a club and open a night for the full per-stage lineup.',
    body: `
<section class="hero hero--tight">
  <h1>Berlin Club<br>Nights</h1>
  <p class="lede">${listed.length.toLocaleString('en')} nights with a published lineup at <strong>Berghain</strong>, <strong>Sisyphos</strong>, and <strong>Tresor</strong>. Pick a club, open a night for the full per-stage lineup. <span class="muted">${perClubCount}</span></p>
</section>

<div class="tabs" role="tablist" aria-label="Filter nights by club">
  <button class="tab" data-club="all" aria-selected="true">All</button>
  ${clubs.map((c) => `<button class="tab" data-club="${c.slug}" aria-selected="false">${esc(c.name)}</button>`).join('')}
</div>

<div id="nights">
${[...eventsByYear.entries()]
  .map(
    ([year, list]) => `
  <section class="year" data-year="${year}">
    <h3>${year} <span class="muted">· <span class="yr-count">${list.length}</span></span></h3>
    <ul class="rows">
      ${list
        .map(
          (e) => `<li data-club="${clubById.get(e.club_id).slug}"><a href="event/${e.id}.html">
        <span class="num">${fmtDate(e.iso_date)}</span>
        <span class="name">${esc(e.title)}</span>
        ${clubTag(e.club_id)}
        <span class="count">${e.slot_count > 0 ? e.slot_count : e.sets}</span>
      </a></li>`
        )
        .join('')}
    </ul>
  </section>`
  )
  .join('')}
</div>`,
  })
)

// --- stats -----------------------------------------------------------------
const perYear = db
  .prepare(
    `SELECT substr(e.iso_date,1,4) AS year, COUNT(p.id) AS sets, COUNT(DISTINCT p.artist_id) AS artists
     FROM performances p JOIN events e ON e.id = p.event_id GROUP BY year ORDER BY year`
  )
  .all()
const maxYear = Math.max(...perYear.map((r) => r.sets), 1)
const timedEvents = db.prepare('SELECT COUNT(DISTINCT event_id) n FROM slots').get().n

writeFileSync(
  join(DIST, 'stats.html'),
  layout({
    title: 'Stats — Berlin Club DJ',
    active: 'stats',
    body: `
<h1>Stats</h1>
<section>
  <h2>Most booked</h2>
  <ol class="ranklist">
    ${artists
      .slice(0, 25)
      .map(
        (a, i) => `<li style="--w:${(a.sets / artists[0].sets) * 100}%"><a href="artist/${a.slug}.html">
      <span class="rrank">${i + 1}</span>
      <span class="rname">${esc(a.name)}</span>
      <span class="rcount">${a.sets}</span></a></li>`
      )
      .join('')}
  </ol>
</section>
<section>
  <h2>Sets per year</h2>
  <ol class="chart">
    ${perYear
      .map((r) => `<li><span class="y">${r.year}</span><span class="b" style="--h:${(r.sets / maxYear) * 100}%" title="${r.sets} sets · ${r.artists} artists"></span><span class="v">${r.sets}</span></li>`)
      .join('')}
  </ol>
  <p class="hint">2020&ndash;2021 reflects the pandemic closure. Future-dated nights are already-announced lineups.</p>
</section>`,
  })
)

// --- search index ----------------------------------------------------------
writeFileSync(
  join(DIST, 'search.json'),
  JSON.stringify({
    generated: new Date().toISOString(),
    clubs: clubs.map((c) => [c.slug, c.name]),
    // [name, slug, sets, firstYear, lastYear, clubSlugs[]]
    artists: artists.map((a) => [
      a.name,
      a.slug,
      a.sets,
      Number(a.first_night.slice(0, 4)),
      Number(a.last_night.slice(0, 4)),
      clubsByArtist.get(a.id) ?? [],
    ]),
  })
)

// --- static assets ---------------------------------------------------------
const assets = join(ROOT, 'assets')
if (existsSync(assets)) cpSync(assets, DIST, { recursive: true })

db.close()
const ms = Date.now() - t0
console.log(`built dist/ in ${(ms / 1000).toFixed(1)}s`)
console.log(`  ${artists.length} artist pages · ${events.length} event pages`)
console.log(`  ${totalSets.toLocaleString('en')} sets · ${timedEvents} nights with set times`)
console.log(`  ${listed.length} nights listed · ${events.length - listed.length} hidden (no lineup)`)
