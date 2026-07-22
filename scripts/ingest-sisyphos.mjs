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

import { openDb, upsertClub, upsertSource, upsertArtist, upsertEvent, upsertFloor, upsertPerformance, upsertSlot } from './db.mjs'

const BASE = 'https://sisyduck.com'
const SOURCE = 'sisyduck.com'
const DELAY_MS = 400 // gentle: this is someone's hobby server

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const args = new Set(process.argv.slice(2))
const LIVE_ONLY = !args.has('--all-events')

async function get(path, asJson = false) {
  const res = await fetch(BASE + path, {
    headers: { 'user-agent': 'berlin-club-dj/1.0 (personal archive)', accept: asJson ? 'application/json' : 'text/html' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`)
  return asJson ? res.json() : res.text()
}

function textLines(html) {
  const stripped = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, '\n')
  const lines = stripped
    .split('\n')
    .map((l) => l.replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').trim())
    .filter((l) => l && l.length < 140)
  const out = []
  for (const l of lines) if (!out.length || out[out.length - 1] !== l) out.push(l)
  return out
}

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

// "Sat at 16:00" is ambiguous on its own — a party spans Fri night to Mon morning.
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

// Only trust "<Floor> will open with <Artist>, <Day> at <HH:MM>" — an announcement that is
// unambiguously about THIS event. Everything else on the page is global chrome.
// The markup splits these across lines, e.g.:
//   ["Tunnel", "will open with Underslept, Sat at", "16:00"]
// so the floor is the nearest preceding non-decoration line.
function parseLiveSlots(lines) {
  const out = []
  const DECOR = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s·,]*$/u
  for (let i = 0; i < lines.length; i++) {
    const m = /^will open with\s+(.+?),\s*(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+)?at$/i.exec(lines[i])
    if (!m) continue
    const time = lines[i + 1]
    if (!/^[0-2]?\d:[0-5]\d$/.test(time ?? '')) continue
    let floor = null
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      if (lines[j] && !DECOR.test(lines[j])) { floor = lines[j].trim(); break }
    }
    if (!floor) continue
    out.push({ floor, artist: m[1].trim(), day: m[2] ?? null, time })
  }
  return out
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

// --- lineups: capture-forward only -------------------------------------------
// Past parties retain no timetable, so crawling all 89 is pure waste and pure risk.
// Default to events that are live or upcoming.
const now = Date.now()
const targets = LIVE_ONLY ? events.filter((e) => new Date(e.end).getTime() >= now) : events

console.log(`lineups: probing ${targets.length} live/upcoming event(s)${LIVE_ONLY ? '' : ' (--all-events)'}\n`)

const parsed = new Map()
for (const ev of targets) {
  try {
    const lines = textLines(await get(`/event/${ev.value}`))
    const missing = lines.find((l) => /Missing \d+% of/i.test(l))
    const slots = parseLiveSlots(lines)
    parsed.set(ev.value, { ev, slots })
    console.log(`  ${ev.value.padEnd(34)} ${String(slots.length).padStart(2)} slot(s)${missing ? `  [sisyduck: ${missing.replace(/\s+/g, ' ')}]` : ''}`)
  } catch (err) {
    console.log(`  ${ev.value.padEnd(34)} failed: ${err.message}`)
  }
  await sleep(DELAY_MS)
}

// --- fabrication guard -------------------------------------------------------
// If two different events yield an identical artist set, we are reading page chrome,
// not a lineup. Refuse the batch.
const sigs = new Map()
for (const [key, { slots }] of parsed) {
  if (!slots.length) continue
  const sig = slots.map((s) => s.artist).sort().join('|')
  if (!sigs.has(sig)) sigs.set(sig, [])
  sigs.get(sig).push(key)
}
const bogus = [...sigs.values()].filter((keys) => keys.length > 1).flat()
if (bogus.length) {
  console.log(`\nREJECTED: ${bogus.length} events share an identical artist list — that is page`)
  console.log('chrome, not a lineup. Storing nothing. (Parser needs updating.)')
  for (const k of bogus.slice(0, 4)) console.log(`  - ${k}`)
  db.close()
  process.exit(1)
}

let nPerfs = 0
let withTimes = 0
db.exec('BEGIN')
for (const [, { ev, slots }] of parsed) {
  if (!slots.length) continue
  const eventId = db.prepare('SELECT id FROM events WHERE club_id = ? AND source_event_id = ?').get(clubId, ev.value).id
  // Never downgrade a richer earlier capture; replace cleanly when this one is fuller.
  const stored = db.prepare('SELECT COUNT(*) n FROM slots WHERE event_id = ? AND source = ?').get(eventId, SOURCE).n
  if (slots.length < stored) continue
  db.prepare('DELETE FROM slots WHERE event_id = ? AND source = ?').run(eventId, SOURCE)
  slots.forEach((s, k) => {
    const artistId = upsertArtist(db, { name: s.artist, source: SOURCE })
    const floorId = upsertFloor(db, clubId, s.floor)
    const startTime = s.day ? resolveSlot(s.day, s.time, ev.start, ev.end) : null
    upsertPerformance(db, { eventId, artistId, floorId, startTime, source: SOURCE })
    // Also store as a timetable slot so event pages render Sisyphos like the others.
    upsertSlot(db, { eventId, floorId, clock: s.time, startTime, billing: s.artist, collective: '', position: k, source: SOURCE })
    nPerfs++
    if (startTime) withTimes++
  })
}
db.exec('COMMIT')

const totalPerfs = db.prepare('SELECT COUNT(*) n FROM performances WHERE source = ?').get(SOURCE).n
console.log(`\nlineups: +${nPerfs} this run (${withTimes} with a resolved timestamp) · ${totalPerfs} total`)
console.log('\nSisyphos lineups are published late and incompletely — sisyduck itself reports')
console.log('missing ~96%. Run this on a cron through each party to accrue what appears.')

db.close()
console.log('\nDone.')
