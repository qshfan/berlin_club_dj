// Capture pipeline orchestrator.
//
// Why this exists: the Sisyphos (sisy.fan → sisyduck) and Tresor lineups are
// human-maintained, published late (Sisyphos typically Friday night into Saturday),
// and REMOVED after the party. If nobody captures them in the window they exist, they
// are gone. This runs the ingesters in order, records a per-source before/after delta,
// and appends a run log so a scheduler (cron / GitHub Actions) can call it repeatedly
// and you can see what each run actually caught.
//
// Modes:
//   node scripts/orchestrate.mjs            # capture-forward sources (Sisyphos, Tresor) + build
//   node scripts/orchestrate.mjs --full     # also refresh Berghain archive + set times
//   node scripts/orchestrate.mjs --no-build # ingest only, skip the site build
//
// Every step is idempotent, so a failed or partial run is safe to repeat. One source
// failing does not abort the others.

import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, ROOT } from './db.mjs'

const args = new Set(process.argv.slice(2))
const FULL = args.has('--full')
const BUILD = !args.has('--no-build')
const LOG = join(ROOT, 'data', 'capture.log')

function counts() {
  const db = openDb()
  const bySource = Object.fromEntries(
    db.prepare('SELECT source, COUNT(*) n FROM slots GROUP BY source').all().map((r) => [r.source, r.n])
  )
  const events = db.prepare('SELECT COUNT(*) n FROM events').get().n
  const perfs = db.prepare('SELECT COUNT(*) n FROM performances').get().n
  db.close()
  return { slots: bySource, events, perfs }
}

function run(label, cmd, cmdArgs) {
  process.stdout.write(`\n▶ ${label}\n`)
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', cmd), ...cmdArgs], {
    stdio: 'inherit',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  return r.status === 0
}

// UTC clock — Date.now is fine here (this is a script entrypoint, not a workflow step).
const startedAt = new Date().toISOString()
const before = counts()

console.log(`Capture pipeline — ${startedAt}`)
console.log(`mode: ${FULL ? 'full (incl. Berghain)' : 'capture-forward (Sisyphos + Tresor)'}\n`)

const steps = []
if (FULL) {
  steps.push(['Berghain archive', 'ingest-berghain.mjs', []])
  steps.push(['Berghain set times', 'ingest-berghain-times.mjs', []])
}
steps.push(['Sisyphos (ephemeral)', 'ingest-sisyphos.mjs', []])
steps.push(['Tresor (ephemeral)', 'ingest-tresor.mjs', []])

const results = {}
for (const [label, cmd, a] of steps) results[label] = run(label, cmd, a)

const after = counts()
const delta = (src) => (after.slots[src] ?? 0) - (before.slots[src] ?? 0)

console.log('\n─────────────────────────────────────────')
console.log('Capture summary')
console.log(`  events:        ${before.events} → ${after.events}  (+${after.events - before.events})`)
console.log(`  performances:  ${before.perfs} → ${after.perfs}  (+${after.perfs - before.perfs})`)
for (const src of new Set([...Object.keys(before.slots), ...Object.keys(after.slots)])) {
  const d = delta(src)
  console.log(`  slots ${src.padEnd(26)} ${after.slots[src] ?? 0}  (${d >= 0 ? '+' : ''}${d} this run)`)
}
for (const [label, ok] of Object.entries(results)) if (!ok) console.log(`  ⚠ step failed: ${label}`)

if (BUILD) {
  const built = run('Build site', 'build.mjs', [])
  if (!built) console.log('  ⚠ build failed')
}

// Append a one-line machine-readable record for the scheduler / audits.
const record = {
  at: startedAt,
  mode: FULL ? 'full' : 'capture',
  events: after.events,
  newEvents: after.events - before.events,
  newPerfs: after.perfs - before.perfs,
  slotDelta: Object.fromEntries([...new Set([...Object.keys(before.slots), ...Object.keys(after.slots)])].map((s) => [s, delta(s)])),
  failures: Object.entries(results).filter(([, ok]) => !ok).map(([l]) => l),
}
try {
  appendFileSync(LOG, JSON.stringify(record) + '\n')
  console.log(`\nlogged → data/capture.log`)
} catch {}

const anyFail = Object.values(results).some((ok) => !ok)
console.log('\nDone.')
process.exit(anyFail ? 1 : 0)
