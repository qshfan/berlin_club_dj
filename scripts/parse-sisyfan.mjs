// Parse the current event's full timetable from sisy.fan.
//
// sisy.fan (the human-maintained upstream) server-renders the whole weekend as five
// per-stage tables — Hammahalle, Wintergarten, Strand, Dampfer, Tunnel — each a
// <table> of "Day, HH:MM - HH:MM" + artist rows. sisyduck, which we use for the event
// list, is a client-only SPA whose event pages are empty, so the lineup has to come from
// here. This is capture-forward: sisy.fan shows one event at a time and drops it after.
//
// Returns { title, startDate, endDate, stages: [{ name, slots: [{ day, time, artist }] }] }
// or null if no timetable is present.

const STAGE = /\b(Hammahalle|Wintergarten|Strand|Dampfer|Tunnel)\b/g

function decode(s) {
  return html2txt(s)
}
function html2txt(h) {
  return h
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&#8217;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseSisyfan(html) {
  // Event title + date range, e.g. "GANS IM GLÜCK (17.07.2026 - 20.07.2026)".
  const head = /<h2[^>]*>\s*([^<(]+?)\s*\(\s*(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2})\.(\d{2})\.(\d{4})\s*\)/.exec(html)
  if (!head) return null
  const title = html2txt(head[1])
  const startDate = `${head[4]}-${head[3]}-${head[2]}`
  const endDate = `${head[7]}-${head[6]}-${head[5]}`

  // Stage names in tab order (dedup, keep first occurrence).
  const stageNames = []
  let sm
  while ((sm = STAGE.exec(html))) if (!stageNames.includes(sm[1])) stageNames.push(sm[1])

  // Each stage is a <tbody> of rows, in the same order as the tabs.
  const tbodies = [...html.matchAll(/<tbody[^>]*>([\s\S]*?)<\/tbody>/gi)].map((m) => m[1])
  const stages = []
  tbodies.forEach((tb, i) => {
    const name = stageNames[i] ?? `Floor ${i + 1}`
    const slots = []
    for (const row of tb.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const tds = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((t) => html2txt(t[1]))
      const timeslot = tds[0] ?? ''
      // "Sat, 00:00 - 03:00" → day + start time. Break rows have no such label.
      const tm = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s*([0-2]?\d:[0-5]\d)/i.exec(timeslot)
      if (!tm) continue
      const artist = (tds[1] ?? '').trim()
      if (!artist || /^break\b/i.test(artist) || /^break\b/i.test(timeslot)) continue
      slots.push({ day: tm[1], time: tm[2].padStart(5, '0'), artist })
    }
    if (slots.length) stages.push({ name, slots })
  })

  return { title, startDate, endDate, stages }
}
