// Ingest Sisyphos events, and any lineup slot that can be *honestly* attributed.
//
// Source: https://sisyduck.com (unofficial; its footer credits sisy.fan upstream).
//
// WHAT IS ACTUALLY AVAILABLE — measured, not assumed
// ---------------------------------------------------
// Sisyphos does not announce lineups in advance. That is the club's ethos, not an
// oversight, and it means there is no Sisyphos equivalent of the Berghain flyer archive
// for anyone to mine. Measured on 2026-07-17:
//
//   * events   — 89 real events (name + date range) back to Dec 2023.  RELIABLE.
//   * lineups  — sisyduck's own live page says "Missing 96% of lineup data".
//                Past-event pages retain NO timetable at all; they show only a global
//                "latest released tracks" widget that is identical on every page.
//
// An earlier version of this parser walked that global widget and cheerfully attributed
// the same 8 artists to all 89 events — a March 2024 party and a July 2026 party came out
// with identical lineups. That is fabricated data, which is strictly worse than no data.
// Hence the guard below: if a parsed lineup repeats verbatim across events, we reject the
// whole batch rather than store a plausible lie.
//
// So: events are ingested as history; lineups are *capture-forward only*. Run this on a
// cron through a party and the archive accrues the slots that were genuinely published.
// It will stay sparse. That is the truth about this club, not a bug to fix.

import { openDb, upsertClub, upsertSource, upsertArtist, upsertEvent, upsertFloor, upsertPerformance, upsertSlot, splitBilling } from './db.mjs'
import { parseSisyfan } from './parse-sisyfan.mjs'

const BASE = 'https://sisyduck.com'
const SOURCE = 'sisyduck.com'

async function get(path, asJson = false) {
  const res = await fetch(BASE + path, {
    headers: { 'user-agent': 'berlin-club-dj/1.0 (personal archive)', accept: asJson ? 'application/json' : 'text/html' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`)
  return asJson ? res.json() : res.text()
}

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

// "Sat, 16:00" is ambiguous on its own — a party spans Fri night to Mon morning.
// Resolve it against the event's real date range so Sat 08:00 and Sun 08:00 stay distinct.
function resolveSlot(dayAbbr, hhmm, startISO, endISO) {
  const dow = DAYS[String(dayAbbr).toLowerCase().slice(0, 3)]
  if (dow === undefined) return null
  const [h, m] = hhmm.split(':').map(Number)
  const start = new Date(startISO)
  const end = new Date(endISO)
  for (let d = new Date(start); d <= new Date(end.getTime() + 86400000); d = new Date(d.getTime() + 86400000)) {
    if (d.getDay() !== dow) continue
    const slot = new Date(d)
    slot.setHours(h, m, 0, 0)
    if (slot >= new Date(start.getTime() - 6 * 3600000) && slot <= new Date(end.getTime() + 6 * 3600000)) {
      return slot.toISOString()
    }
  }
  return null
}

const db = openDb()

console.log('Sisyphos → SQLite')
console.log('Source: https://sisyduck.com (unofficial, no licence — best-effort)\n')

upsertSource(db, {
  name: SOURCE,
  url: 'https://sisyduck.com',
  license: 'unknown / unofficial',
  attribution: 'Sisyphos event data via sisyduck.com (upstream: sisy.fan)',
})

const clubId = upsertClub(db, 'sisyphos', 'Sisyphos')

const payload = await get('/api/events', true)
const events = (payload.events ?? []).filter((e) => e.clubCode === 'sisy')
console.log(`${events.length} Sisyphos events found\n`)

// --- events: real, reliable, always ingested ---------------------------------
db.exec('BEGIN')
for (const ev of events) {
  upsertEvent(db, {
    clubId,
    sourceEventId: ev.value,
    title: ev.key.replace(/\s*\/\s*Sisy$/i, '').trim(),
    isoDate: ev.start.slice(0, 10),
    endDate: ev.end ? ev.end.slice(0, 10) : null,
    url: `${BASE}/event/${ev.value}`,
    source: SOURCE,
  })
}
db.exec('COMMIT')
console.log(`events:  ${events.length} stored`)

// --- lineup: from sisy.fan (the human-maintained upstream) --------------------
// sisyduck's event pages are an empty client-only SPA, so the actual timetable comes
// from sisy.fan, which server-renders the whole weekend as five per-stage tables. It
// shows one event at a time and drops it after the party — hence capture-forward.
console.log('\nlineup:  reading sisy.fan current timetable…')
let tt = null
try {
  const res = await fetch('https://sisy.fan/', {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 (berlin-club-dj personal archive)', accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  tt = parseSisyfan(await res.text())
} catch (err) {
  console.log(`  sisy.fan fetch/parse failed: ${err.message}`)
}

if (!tt || !tt.stages.length) {
  console.log('  sisy.fan shows no current timetable — nothing to capture this run.')
} else {
  const nSlots = tt.stages.reduce((n, s) => n + s.slots.length, 0)
  console.log(`  "${tt.title}" ${tt.startDate}→${tt.endDate}: ${tt.stages.length} stages, ${nSlots} slots`)

  // Match to the event list by start date; if sisy.fan is ahead of sisyduck, store it anyway.
  const match = events.find((e) => e.start.slice(0, 10) === tt.startDate)
  const startISO = match ? match.start : `${tt.startDate}T22:00:00+02:00`
  const endISO = match ? match.end : `${tt.endDate}T10:00:00+02:00`
  const eventId = match
    ? db.prepare('SELECT id FROM events WHERE club_id = ? AND source_event_id = ?').get(clubId, match.value).id
    : upsertEvent(db, { clubId, sourceEventId: `sisyfan-${tt.startDate}`, title: tt.title, isoDate: tt.startDate, endDate: tt.endDate, url: 'https://sisy.fan/', source: SOURCE })

  // Never downgrade a richer earlier capture; replace cleanly when this one is at least as full.
  const stored = db.prepare('SELECT COUNT(*) n FROM slots WHERE event_id = ? AND source = ?').get(eventId, SOURCE).n
  if (nSlots < stored) {
    console.log(`  kept richer earlier capture (${stored} ≥ ${nSlots} slots) — nothing changed.`)
  } else {
    let stored2 = 0
    let withTimes = 0
    db.exec('BEGIN')
    db.prepare('DELETE FROM slots WHERE event_id = ? AND source = ?').run(eventId, SOURCE)
    db.prepare('DELETE FROM performances WHERE event_id = ? AND source = ?').run(eventId, SOURCE)
    for (const stage of tt.stages) {
      const floorId = upsertFloor(db, clubId, stage.name)
      stage.slots.forEach((slot, k) => {
        const startTime = resolveSlot(slot.day, slot.time, startISO, endISO)
        upsertSlot(db, { eventId, floorId, clock: slot.time, startTime, billing: slot.artist, collective: '', position: k, source: SOURCE })
        // Link each named DJ (splits "SPF 50 b2b Albert") to their page.
        for (const name of splitBilling(slot.artist)) {
          const artistId = upsertArtist(db, { name, source: SOURCE })
          upsertPerformance(db, { eventId, artistId, floorId, startTime, source: SOURCE })
        }
        stored2++
        if (startTime) withTimes++
      })
    }
    db.exec('COMMIT')
    console.log(`  stored ${stored2} slots (${withTimes} timed) across ${tt.stages.length} stages.`)
  }
}

const totalSlots = db.prepare('SELECT COUNT(*) n FROM slots WHERE source = ?').get(SOURCE).n
console.log(`\nSisyphos slots total: ${totalSlots}`)
console.log('sisy.fan shows one event at a time and removes it after the party — run this on a')
console.log('schedule through each weekend to accrue the archive.')

db.close()
console.log('\nDone.')
