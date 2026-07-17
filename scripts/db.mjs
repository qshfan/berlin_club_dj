// SQLite access + schema. The DB file is the artifact worth keeping; dist/ is disposable.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DB_PATH = join(ROOT, 'data', 'berlin.db')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clubs (
  id    INTEGER PRIMARY KEY,
  slug  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  url        TEXT NOT NULL,
  license    TEXT,
  attribution TEXT,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS artists (
  id             INTEGER PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  source         TEXT NOT NULL,
  source_artist_id TEXT
);

CREATE TABLE IF NOT EXISTS floors (
  id      INTEGER PRIMARY KEY,
  club_id INTEGER NOT NULL REFERENCES clubs(id),
  name    TEXT NOT NULL,
  UNIQUE(club_id, name)
);

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY,
  club_id         INTEGER NOT NULL REFERENCES clubs(id),
  source_event_id TEXT,
  title           TEXT NOT NULL,
  iso_date        TEXT NOT NULL,
  end_date        TEXT,
  url             TEXT,
  source          TEXT NOT NULL,
  UNIQUE(club_id, source_event_id)
);

CREATE TABLE IF NOT EXISTS performances (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  artist_id  INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  floor_id   INTEGER REFERENCES floors(id),
  start_time TEXT,
  end_time   TEXT,
  source     TEXT NOT NULL,
  UNIQUE(event_id, artist_id, floor_id)
);

CREATE INDEX IF NOT EXISTS idx_perf_artist ON performances(artist_id);
CREATE INDEX IF NOT EXISTS idx_perf_event  ON performances(event_id);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(iso_date);
CREATE INDEX IF NOT EXISTS idx_events_club ON events(club_id);
CREATE INDEX IF NOT EXISTS idx_artists_slug ON artists(slug);
`

export function openDb() {
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}

// Unicode-aware: "Sønge Ø" and "DJ Ötzi" must not collapse to empty slugs.
export function slugify(name) {
  const s = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'artist-' + Buffer.from(name).toString('hex').slice(0, 12)
}

export function upsertClub(db, slug, name) {
  db.prepare('INSERT INTO clubs (slug, name) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET name = excluded.name').run(slug, name)
  return db.prepare('SELECT id FROM clubs WHERE slug = ?').get(slug).id
}

export function upsertSource(db, { name, url, license, attribution }) {
  db.prepare(
    `INSERT INTO sources (name, url, license, attribution, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET url=excluded.url, license=excluded.license,
       attribution=excluded.attribution, fetched_at=excluded.fetched_at`
  ).run(name, url, license ?? null, attribution ?? null, new Date().toISOString())
}

export function upsertFloor(db, clubId, name) {
  if (!name) return null
  db.prepare('INSERT INTO floors (club_id, name) VALUES (?, ?) ON CONFLICT(club_id, name) DO NOTHING').run(clubId, name)
  return db.prepare('SELECT id FROM floors WHERE club_id = ? AND name = ?').get(clubId, name).id
}

export function upsertArtist(db, { name, source, sourceArtistId }) {
  const slug = slugify(name)
  db.prepare(
    `INSERT INTO artists (slug, name, source, source_artist_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET name = excluded.name`
  ).run(slug, name, source, sourceArtistId != null ? String(sourceArtistId) : null)
  return db.prepare('SELECT id FROM artists WHERE slug = ?').get(slug).id
}

export function upsertEvent(db, { clubId, sourceEventId, title, isoDate, endDate, url, source }) {
  db.prepare(
    `INSERT INTO events (club_id, source_event_id, title, iso_date, end_date, url, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(club_id, source_event_id) DO UPDATE SET
       title=excluded.title, iso_date=excluded.iso_date, end_date=excluded.end_date, url=excluded.url`
  ).run(clubId, String(sourceEventId), title, isoDate, endDate ?? null, url ?? null, source)
  return db.prepare('SELECT id FROM events WHERE club_id = ? AND source_event_id = ?').get(clubId, String(sourceEventId)).id
}

export function upsertPerformance(db, { eventId, artistId, floorId, startTime, endTime, source }) {
  db.prepare(
    `INSERT INTO performances (event_id, artist_id, floor_id, start_time, end_time, source)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, artist_id, floor_id) DO UPDATE SET
       start_time=excluded.start_time, end_time=excluded.end_time`
  ).run(eventId, artistId, floorId ?? null, startTime ?? null, endTime ?? null, source)
}
