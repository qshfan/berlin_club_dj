// Terminal summary of the database. `npm run stats`
import { openDb } from './db.mjs'

const db = openDb()
const one = (sql, ...p) => Object.values(db.prepare(sql).get(...p) ?? {})[0]

const pad = (s, n) => String(s).padEnd(n)
const num = (n) => Number(n).toLocaleString('en')

console.log('\n  BERLIN CLUB DJ — database summary')
console.log('  ' + '─'.repeat(46))
console.log(`  ${pad('artists', 16)} ${num(one('SELECT COUNT(*) FROM artists'))}`)
console.log(`  ${pad('events', 16)} ${num(one('SELECT COUNT(*) FROM events'))}`)
console.log(`  ${pad('performances', 16)} ${num(one('SELECT COUNT(*) FROM performances'))}`)
console.log(`  ${pad('with set times', 16)} ${num(one('SELECT COUNT(*) FROM performances WHERE start_time IS NOT NULL'))}`)
console.log(`  ${pad('date range', 16)} ${one('SELECT MIN(iso_date) FROM events')} → ${one('SELECT MAX(iso_date) FROM events')}`)

console.log('\n  by club')
for (const r of db
  .prepare(
    `SELECT c.name, COUNT(DISTINCT e.id) AS nights, COUNT(p.id) AS sets
     FROM clubs c
     LEFT JOIN events e ON e.club_id = c.id
     LEFT JOIN performances p ON p.event_id = e.id
     GROUP BY c.id ORDER BY sets DESC`
  )
  .all()) {
  console.log(`  ${pad(r.name, 16)} ${pad(num(r.nights) + ' nights', 14)} ${num(r.sets)} sets`)
}

console.log('\n  by source')
for (const r of db
  .prepare(`SELECT source, COUNT(*) AS n FROM performances GROUP BY source ORDER BY n DESC`)
  .all()) {
  console.log(`  ${pad(r.source, 26)} ${num(r.n)} sets`)
}

console.log('\n  most booked')
for (const [i, r] of db
  .prepare(
    `SELECT a.name, COUNT(*) AS n FROM performances p JOIN artists a ON a.id = p.artist_id
     GROUP BY a.id ORDER BY n DESC LIMIT 10`
  )
  .all()
  .entries()) {
  console.log(`  ${String(i + 1).padStart(3)}. ${pad(r.name, 26)} ${num(r.n)}`)
}
console.log()

db.close()
