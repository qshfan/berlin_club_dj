// Ingest the Berghain Klubnacht archive.
//
// Source: https://berghain.ravers.workers.dev  (CC BY 4.0, by JPHFA)
// Built from official monthly flyers 2004-2009 + berghain.berlin listings 2009+.
//
// There is no free bulk export, so the performance table is reconstructed from
// /api/artists/:id/performances — one call per artist. We crawl politely and
// incrementally: an artist whose local set count already matches the upstream
// count is skipped, so a re-run after a new Klubnacht touches only what changed.

import { openDb, upsertClub, upsertSource, upsertArtist, upsertEvent, upsertFloor, upsertPerformance } from './db.mjs'

const API = 'https://berghain.ravers.workers.dev'
const SOURCE = 'berghain.ravers.workers.dev'
const CONCURRENCY = 4
const DELAY_MS = 80

const args = new Set(process.argv.slice(2))
const FULL = args.has('--full')

async function getJson(path, { retries = 4 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(API + path, {
        headers: {
          accept: 'application/json',
          'user-agent': 'berlin-club-dj/1.0 (personal archive; +https://github.com/)',
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`)
      return await res.json()
    } catch (err) {
      if (attempt === retries) throw new Error(`giving up on ${path}: ${err.message}`)
      const backoff = 500 * 2 ** attempt
      process.stderr.write(`  retry ${attempt + 1}/${retries} ${path} (${err.message}) in ${backoff}ms\n`)
      await new Promise((r) => setTimeout(r, backoff))
    }
  }
}

// Map upstream venue strings onto floors. Berghain and Panorama Bar are separate
// floors of the same building; the archive only distinguishes these two.
function floorName(venue) {
  if (!venue) return null
  const v = venue.trim()
  if (/panorama/i.test(v)) return 'Panorama Bar'
  if (/berghain/i.test(v)) return 'Berghain'
  return v
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i], i)
      if (DELAY_MS) await new Promise((r) => setTimeout(r, DELAY_MS))
    }
  })
  await Promise.all(workers)
  return results
}

const db = openDb()

console.log('Berghain Klubnacht archive → SQLite')
console.log('Source: https://berghain.ravers.workers.dev (CC BY 4.0, by JPHFA)\n')

upsertSource(db, {
  name: SOURCE,
  url: 'https://berghain.ravers.workers.dev',
  license: 'CC BY 4.0',
  attribution: 'Berghain Klubnacht Database by JPHFA — https://berghain.ravers.workers.dev',
})

const clubId = upsertClub(db, 'berghain', 'Berghain')

const stats = await getJson('/api/stats')
console.log(`upstream: ${stats.total_artists} artists · ${stats.total_events} events · ${stats.total_performances} performances`)

// --- events -----------------------------------------------------------------
// Performances reference `event_id` (the berghain.berlin id), not the archive's
// internal `id`, so events are keyed on event_id.
const shows = await getJson('/api/shows')
let eventCount = 0
db.exec('BEGIN')
for (const s of shows) {
  upsertEvent(db, {
    clubId,
    sourceEventId: s.event_id,
    title: s.title,
    isoDate: s.iso_date,
    url: s.url,
    source: SOURCE,
  })
  eventCount++
}
db.exec('COMMIT')
console.log(`events:   ${eventCount} stored`)

// --- artists ----------------------------------------------------------------
const artists = await getJson('/api/artists?limit=5000')
db.exec('BEGIN')
for (const a of artists) {
  upsertArtist(db, { name: a.name, source: SOURCE, sourceArtistId: a.id })
}
db.exec('COMMIT')
console.log(`artists:  ${artists.length} stored`)

// --- performances -----------------------------------------------------------
// Skip artists already complete locally unless --full.
const localCounts = new Map(
  db
    .prepare(
      `SELECT a.source_artist_id AS sid, COUNT(p.id) AS n
       FROM artists a LEFT JOIN performances p ON p.artist_id = a.id
       WHERE a.source = ? GROUP BY a.id`
    )
    .all(SOURCE)
    .map((r) => [String(r.sid), Number(r.n)])
)

const todo = FULL
  ? artists
  : artists.filter((a) => (localCounts.get(String(a.id)) ?? -1) !== a.total_performances)

console.log(`performances: ${artists.length - todo.length} artists already current, fetching ${todo.length}\n`)

let done = 0
let inserted = 0
let failed = []

const eventIdCache = new Map(
  db.prepare('SELECT source_event_id, id FROM events WHERE club_id = ?').all(clubId).map((r) => [String(r.source_event_id), r.id])
)
const artistIdCache = new Map(
  db.prepare('SELECT source_artist_id, id FROM artists WHERE source = ?').all(SOURCE).map((r) => [String(r.source_artist_id), r.id])
)
const floorCache = new Map()
function floorId(name) {
  const key = floorName(name)
  if (!key) return null
  if (!floorCache.has(key)) floorCache.set(key, upsertFloor(db, clubId, key))
  return floorCache.get(key)
}

await mapPool(todo, CONCURRENCY, async (a) => {
  let perfs
  try {
    perfs = await getJson(`/api/artists/${a.id}/performances`)
  } catch (err) {
    failed.push({ artist: a.name, error: err.message })
    return
  }

  const artistId = artistIdCache.get(String(a.id))
  db.exec('BEGIN')
  try {
    for (const p of perfs) {
      // An artist may appear at an event not present in /api/shows (e.g. a
      // non-Klubnacht event). Create it rather than dropping the performance.
      let eid = eventIdCache.get(String(p.event_id))
      if (!eid) {
        eid = upsertEvent(db, {
          clubId,
          sourceEventId: p.event_id,
          title: p.title ?? 'Unknown',
          isoDate: p.iso_date,
          url: p.url,
          source: SOURCE,
        })
        eventIdCache.set(String(p.event_id), eid)
      }
      upsertPerformance(db, {
        eventId: eid,
        artistId,
        floorId: floorId(p.venue),
        source: SOURCE,
      })
      inserted++
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    failed.push({ artist: a.name, error: err.message })
  }

  done++
  if (done % 100 === 0 || done === todo.length) {
    const pct = ((done / todo.length) * 100).toFixed(0)
    process.stdout.write(`  ${String(done).padStart(4)}/${todo.length} artists (${pct}%) · ${inserted} sets\r`)
  }
})

process.stdout.write('\n')

const final = db.prepare('SELECT COUNT(*) n FROM performances WHERE source = ?').get(SOURCE).n
const nEvents = db.prepare('SELECT COUNT(*) n FROM events WHERE source = ?').get(SOURCE).n
const nArtists = db.prepare('SELECT COUNT(*) n FROM artists WHERE source = ?').get(SOURCE).n

console.log(`\nlocal:    ${nArtists} artists · ${nEvents} events · ${final} performances`)
console.log(`upstream: ${stats.total_artists} artists · ${stats.total_events} events · ${stats.total_performances} performances`)

if (failed.length) {
  console.log(`\n${failed.length} artist(s) failed:`)
  for (const f of failed.slice(0, 10)) console.log(`  - ${f.artist}: ${f.error}`)
  if (failed.length > 10) console.log(`  ... and ${failed.length - 10} more`)
  console.log('Re-run to retry (ingest is idempotent).')
}

const drift = stats.total_performances - final
if (drift !== 0) {
  console.log(`\nNote: ${Math.abs(drift)} performance(s) ${drift > 0 ? 'missing vs' : 'extra vs'} upstream count.`)
  console.log('Some upstream rows collide on (event, artist, floor) — i.e. the same artist billed')
  console.log('twice on one floor at one event. Those are deduplicated by design.')
}

db.close()
console.log('\nDone.')
