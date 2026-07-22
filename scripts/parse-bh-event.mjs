// Parse a berghain.berlin event page into a per-stage timetable.
//
// The official event pages carry what the CC BY archive API strips out: set times,
// the Garten/Säule stages, and each DJ's label/collective. The markup is stable:
//
//   <h2>Berghain</h2>
//   <ul>
//     <li>
//       <div><span>Jetzt</span><time>04:30</time></div>
//       <div><span>Kasper Marott<span>Axces</span></span> ...</div>
//     </li>
//     ...
//   </ul>
//
// Returns { date, title, stages: [{ stage, slots: [{ time, artist, collective }] }] }.
// A <li> with a <time> but no artist name is a TBA slot and is dropped.

const KNOWN_STAGES = /^(Berghain|Panorama Bar|Säule|Saeule|Halle(?: am Berghain)?|Kantine(?: am Berghain)?|Garten|Elsewhere|Globus)$/i

function decode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&#8217;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&auml;/g, 'ä')
    .replace(/&ouml;/g, 'ö')
    .replace(/&uuml;/g, 'ü')
    .replace(/&szlig;/g, 'ß')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim()
}

const stripTags = (html) => decode(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '))

// From a slot's artist <div>, pull the DJ name and (optional) nested collective.
// The name lives in the first top-level <span>; a label/collective, when present,
// is a <span> nested inside it. A trailing sibling span is a decorative countdown.
//   <span>ABS8LUTE</span>                              -> { ABS8LUTE, '' }
//   <span>Kasper Marott<span>Axces</span></span>       -> { Kasper Marott, Axces }
function parseArtistCell(cellHtml) {
  // First top-level span, allowing a single level of nested spans in its content.
  const firstSpan = /<span\b[^>]*>((?:[^<]|<span\b[^>]*>[\s\S]*?<\/span>)*)<\/span>/i.exec(cellHtml)
  const inner = firstSpan ? firstSpan[1] : cellHtml
  const nested = /<span\b[^>]*>([\s\S]*?)<\/span>/i.exec(inner)
  const collective = nested ? stripTags(nested[1]) : ''
  const artist = stripTags(inner.replace(/<span\b[^>]*>[\s\S]*?<\/span>/gi, ' '))
  return { artist, collective: collective && collective !== artist ? collective : '' }
}

export function parseBerghainEvent(html) {
  const dateM = /(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)\s*<[^>]*>\s*(\d{2})\.(\d{2})\.(\d{4})/i.exec(html)
  const isoDate = dateM ? `${dateM[4]}-${dateM[3]}-${dateM[2]}` : null

  // Locate each stage header, then scan the segment up to the next header for slots.
  // (Between </h2> and the <li>s there is intervening markup, so we don't couple them.)
  const headers = []
  const h2Re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi
  let h
  while ((h = h2Re.exec(html))) {
    const stage = stripTags(h[1])
    if (KNOWN_STAGES.test(stage)) headers.push({ stage, start: h.index, end: h2Re.lastIndex })
  }

  const stages = []
  for (let k = 0; k < headers.length; k++) {
    const segEnd = k + 1 < headers.length ? headers[k + 1].start : html.length
    const segment = html.slice(headers[k].end, segEnd)
    const slots = []
    const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi
    let li
    while ((li = liRe.exec(segment))) {
      const liHtml = li[1]
      const timeM = /<time\b[^>]*>\s*(\d{1,2}:\d{2})\s*<\/time>/i.exec(liHtml)
      if (!timeM) continue
      // The artist cell is the <div> that does NOT contain the <time>.
      const divs = [...liHtml.matchAll(/<div\b[^>]*>([\s\S]*?)<\/div>/gi)].map((d) => d[1])
      const artistCell = divs.find((d) => !/<time\b/i.test(d)) ?? ''
      const { artist, collective } = parseArtistCell(artistCell)
      if (!artist || /^jetzt$/i.test(artist)) continue // TBA / empty slot
      slots.push({ time: timeM[1].padStart(5, '0'), artist, collective })
    }
    if (slots.length) stages.push({ stage: normalizeStage(headers[k].stage), slots })
  }
  return { isoDate, stages }
}

export function normalizeStage(name) {
  const n = name.trim()
  if (/panorama/i.test(n)) return 'Panorama Bar'
  if (/^s(ä|ae)ule/i.test(n)) return 'Säule'
  if (/^halle/i.test(n)) return 'Halle'
  if (/^kantine/i.test(n)) return 'Kantine'
  if (/^garten/i.test(n)) return 'Garten'
  if (/^berghain/i.test(n)) return 'Berghain'
  return n
}
