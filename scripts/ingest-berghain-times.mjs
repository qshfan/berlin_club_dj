// Enrich Berghain events with set times by scraping the official event pages.
//
// The CC BY archive API gives the lineup but strips the timetable. The official
// berghain.berlin event pages keep the full per-stage timetable — set times, the
// Garten/Säule stages, and each DJ's label/collective — and, crucially, keep it for
// PAST events too (verified back to 2012). So this backfills history, not just the
// upcoming night.
//
// Two things are written per scraped event:
//   * slots      — the verbatim printed timetable (billing string, clock, collective).
//                  This is what event pages render.
//   * start_time — matched onto the archive's performance rows so artist pages can show
//                  when each DJ played. B2B billings link to each artist.
//
// Idempotent and incremental: a past event that already has slots is skipped; recent
// and future events are always re-fetched (their timetable is still being filled in).

import { openDb, upsertFloor, upsertArtist, upsertSlot, upsertPerformance, slugify, splitBilling } from './db.mjs'
import { parseBerghainEvent } from './parse-bh-event.mjs'

const SOURCE = 'berghain.berlin'
const DELAY_MS = 1200 // polite: this is the club's own server
const RECENT_DAYS = 21 // re-fetch events newer than this even if already enriched

const args = new Set(process.argv.slice(2))
const FULL = args.has('--full')
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) ?? '').split('=')[1]) || Infinity

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getHtml(url, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (berlin-club-dj personal archive)', accept: 'text/html' },
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (err) {
      if (attempt === retries) throw err
      await sleep(800 * 2 ** attempt)
    }
  }
}

// Assign an absolute instant to each slot. A Klubnacht opens ~Sat 23:59 and runs into
// Monday, so within a stage the clock wraps past midnight; each time the printed clock
// drops below the previous one, we've crossed into the next day.
function resolveStageTimes(isoDate, slots) {
  let day = new Date(`${isoDate}T00:00:00+02:00`) // Berlin is UTC+1/+2; +02 is fine for ordering
  let prevMinutes = -1
  return slots.map((s) => {
    const [h, m] = s.time.split(':').map(Number)
    const minutes = h * 60 + m
    if (prevMinutes >= 0 && minutes <= prevMinutes) day = new Date(day.getTime() + 86400000)
    prevMinutes = minutes
    const dt = new Date(day)
    dt.setHours(h, m, 0, 0)
    return dt.toISOString()
  })
}

const db = openDb()
const clubId = db.prepare("SELECT id FROM clubs WHERE slug='berghain'").get()?.id
if (!clubId) {
  console.error('No Berghain club yet — run `npm run ingest:berghain` first.')
  process.exit(1)
}

console.log('Berghain set times → SQLite')
console.log('Source: https://berghain.berlin event pages\n')

// Candidate events: have a berghain.berlin URL. Order newest first so a capped/interrupted
// run still improves the pages people are most likely to open.
const events = db
  .prepare(
    `SELECT e.id, e.source_event_id, e.iso_date, e.url,
            (SELECT COUNT(*) FROM slots s WHERE s.event_id = e.id) AS have
     FROM events e
     WHERE e.club_id = ? AND e.url LIKE '%berghain.berlin%'
     ORDER BY e.iso_date DESC`
  )
  .all(clubId)

// Incremental default: only recent + upcoming events, whose timetables are still being
// posted or edited. Old events with no timetable (mostly 2004-2009) are NOT re-fetched
// every run — they were checked during the one-time `--full` backfill and won't gain one.
// Future events with no lineup yet are covered by iso_date >= cutoff. Use --full to
// re-crawl the whole history.
const cutoff = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString().slice(0, 10)
const todo = events
  .filter((e) => FULL || e.iso_date >= cutoff)
  .slice(0, LIMIT)

console.log(`${events.length} source pages · fetching ${todo.length} recent/upcoming${FULL ? ' (full re-crawl)' : ''}\n`)

const artistCache = new Map()
function linkArtist(name) {
  if (!artistCache.has(name)) artistCache.set(name, upsertArtist(db, { name, source: SOURCE }))
  return artistCache.get(name)
}

let done = 0
let nSlots = 0
let nLinks = 0
let nNew = 0
const failed = []

for (const ev of todo) {
  let parsed
  try {
    parsed = parseBerghainEvent(await getHtml(ev.url))
  } catch (err) {
    failed.push({ ev: ev.source_event_id, error: String(err.message || err) })
    await sleep(DELAY_MS)
    continue
  }

  // Berghain fills in and edits lineups for the next few weeks, so a re-fetched event may
  // have changed, not just grown. Clean-replace this event's set-time rows (only the ones
  // this scraper owns) so edits sync exactly instead of leaving stale slots behind. The
  // archive's own performance rows (a different source) are untouched; we only re-derive
  // their start_time via the upserts below.
  const freshCount = parsed.stages.reduce((n, s) => n + s.slots.length, 0)
  if (freshCount === 0) {
    // Lineup not posted yet (or pulled) — don't wipe a good earlier capture over an empty one.
    await sleep(DELAY_MS)
    continue
  }

  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM slots WHERE event_id = ? AND source = ?').run(ev.id, SOURCE)
    db.prepare('DELETE FROM performances WHERE event_id = ? AND source = ?').run(ev.id, SOURCE)
    for (const stage of parsed.stages) {
      const floorId = upsertFloor(db, clubId, stage.stage)
      const times = resolveStageTimes(ev.iso_date, stage.slots)
      stage.slots.forEach((slot, i) => {
        upsertSlot(db, {
          eventId: ev.id,
          floorId,
          clock: slot.time,
          startTime: times[i],
          billing: slot.artist,
          collective: slot.collective,
          position: i,
          source: SOURCE,
        })
        nSlots++

        // Link to artist page(s): whole billing if the archive knows it, else split.
        const whole = db.prepare('SELECT id FROM artists WHERE slug = ?').get(slugify(slot.artist))
        const names = whole ? [slot.artist] : splitBilling(slot.artist)
        for (const name of names) {
          const before = db.prepare('SELECT 1 FROM artists WHERE slug = ?').get(slugify(name)) ? 0 : 1
          const artistId = linkArtist(name)
          nNew += before
          upsertPerformance(db, { eventId: ev.id, artistId, floorId, startTime: times[i], source: SOURCE })
          nLinks++
        }
      })
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    failed.push({ ev: ev.source_event_id, error: String(err.message || err) })
  }

  done++
  if (done % 25 === 0 || done === todo.length) {
    process.stdout.write(`  ${String(done).padStart(4)}/${todo.length} events · ${nSlots} slots · ${nLinks} artist links\r`)
  }
  await sleep(DELAY_MS)
}

process.stdout.write('\n')
const totalSlots = db.prepare('SELECT COUNT(*) n FROM slots WHERE source = ?').get(SOURCE).n
const timedEvents = db.prepare('SELECT COUNT(DISTINCT event_id) n FROM slots').get().n
console.log(`\nslots:  ${totalSlots} across ${timedEvents} events`)
console.log(`links:  +${nLinks} performance times this run (${nNew} new artists discovered off the timetable)`)
if (failed.length) {
  console.log(`\n${failed.length} event(s) failed:`)
  for (const f of failed.slice(0, 8)) console.log(`  - ${f.ev}: ${f.error}`)
  console.log('Re-run to retry (idempotent).')
}
db.close()
console.log('\nDone.')
