// Ingest Tresor Berlin events + per-floor lineups.
//
// Source: https://tresorberlin.com/club/events/  (official site; no API, no licence).
//
// Like Sisyphos, Tresor publishes only upcoming events and removes pages after the night,
// so this is capture-forward: run it on a schedule to accrue history. The listing gives
// every upcoming event with floors + artists; each event page adds set-time ranges.

import { openDb, upsertClub, upsertSource, upsertFloor, upsertArtist, upsertSlot, upsertPerformance, slugify, splitBilling } from './db.mjs'
import { parseTresorListing, parseTresorEvent } from './parse-tresor.mjs'

const LISTING = 'https://tresorberlin.com/club/events/'
const SOURCE = 'tresorberlin.com'
const DELAY_MS = 1000
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 (berlin-club-dj personal archive)'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getHtml(url, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(30_000) })
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (err) {
      if (attempt === retries) throw err
      await sleep(800 * 2 ** attempt)
    }
  }
}

// Per floor, published order; Tresor opens ~23:00 and runs into the next day, so a clock
// that drops below the previous one has crossed midnight.
function resolveTimes(isoDate, slots) {
  let day = new Date(`${isoDate}T00:00:00+02:00`)
  let prev = -1
  return slots.map((s) => {
    if (!s.clock) return null
    const [h, m] = s.clock.split(':').map(Number)
    const mins = h * 60 + m
    if (prev >= 0 && mins <= prev) day = new Date(day.getTime() + 86400000)
    prev = mins
    const dt = new Date(day)
    dt.setHours(h, m, 0, 0)
    return dt.toISOString()
  })
}

const db = openDb()

console.log('Tresor → SQLite')
console.log('Source: https://tresorberlin.com (official, no licence — capture-forward)\n')

upsertSource(db, {
  name: SOURCE,
  url: 'https://tresorberlin.com/club/events/',
  license: 'unknown / official site',
  attribution: 'Event data from tresorberlin.com',
})
const clubId = upsertClub(db, 'tresor', 'Tresor')

const listing = parseTresorListing(await getHtml(LISTING))
console.log(`${listing.length} upcoming events on the listing\n`)

let nEvents = 0
let nSlots = 0
let withTimes = 0
let nNew = 0
const failed = []

for (const [i, ev] of listing.entries()) {
  // Prefer the timed event page; fall back to the listing's untimed floors.
  let floors = ev.floors
  try {
    const timed = parseTresorEvent(await getHtml(ev.url))
    if (timed.floors.length) floors = timed.floors
  } catch (err) {
    failed.push({ ev: ev.slug, error: String(err.message || err) })
  }

  const eventId = db
    .prepare(
      `INSERT INTO events (club_id, source_event_id, title, iso_date, url, source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(club_id, source_event_id) DO UPDATE SET title=excluded.title, iso_date=excluded.iso_date, url=excluded.url
       RETURNING id`
    )
    .get(clubId, ev.slug, ev.title, ev.isoDate, ev.url, SOURCE).id
  nEvents++

  // Capture-forward: a page can partially degrade before it rolls off, and a flaky event
  // fetch falls back to the untimed listing. So only replace this event's stored slots when
  // the fresh capture is at least as complete — never downgrade a richer earlier snapshot,
  // and never leave timed + untimed duplicates of the same set.
  const freshCount = floors.reduce((n, f) => n + f.slots.length, 0)
  const storedCount = db.prepare('SELECT COUNT(*) n FROM slots WHERE event_id = ? AND source = ?').get(eventId, SOURCE).n
  if (freshCount < storedCount) {
    process.stdout.write(`  ${String(i + 1).padStart(2)}/${listing.length} ${ev.slug.slice(0, 42).padEnd(42)} kept richer snapshot (${storedCount} ≥ ${freshCount})\r`)
    await sleep(DELAY_MS)
    continue
  }

  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM slots WHERE event_id = ? AND source = ?').run(eventId, SOURCE)
    for (const fl of floors) {
      const floorId = upsertFloor(db, clubId, fl.name)
      const times = resolveTimes(ev.isoDate, fl.slots)
      fl.slots.forEach((slot, k) => {
        upsertSlot(db, {
          eventId,
          floorId,
          clock: slot.clock,
          startTime: times[k],
          billing: slot.billing,
          collective: '',
          position: k,
          source: SOURCE,
        })
        nSlots++
        if (times[k]) withTimes++
        const whole = db.prepare('SELECT 1 FROM artists WHERE slug = ?').get(slugify(slot.billing))
        const names = whole ? [slot.billing] : splitBilling(slot.billing)
        for (const name of names) {
          const before = db.prepare('SELECT 1 FROM artists WHERE slug = ?').get(slugify(name)) ? 0 : 1
          const artistId = upsertArtist(db, { name, source: SOURCE })
          nNew += before
          upsertPerformance(db, { eventId, artistId, floorId, startTime: times[k], source: SOURCE })
        }
      })
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    failed.push({ ev: ev.slug, error: String(err.message || err) })
  }

  process.stdout.write(`  ${String(i + 1).padStart(2)}/${listing.length} ${ev.slug.slice(0, 42).padEnd(42)} ${fl_count(floors)} floors\r`)
  await sleep(DELAY_MS)
}

function fl_count(f) {
  return f.length
}

process.stdout.write('\n')
const totalSlots = db.prepare('SELECT COUNT(*) n FROM slots WHERE source = ?').get(SOURCE).n
console.log(`\nevents: ${nEvents}`)
console.log(`slots:  +${nSlots} this run (${withTimes} timed) · ${totalSlots} total · ${nNew} new artists`)
if (failed.length) {
  console.log(`\n${failed.length} event page(s) fell back to untimed listing or failed:`)
  for (const f of failed.slice(0, 6)) console.log(`  - ${f.ev}: ${f.error}`)
}
console.log('\nTresor removes pages after the event — run this on a schedule to keep history.')
db.close()
console.log('\nDone.')
