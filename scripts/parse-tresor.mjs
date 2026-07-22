// Parse tresorberlin.com. Two shapes:
//   * the events listing — every upcoming event with floors + artists, but no times
//   * an individual event page — the same lineup WITH set-time ranges
//
// Tresor publishes no archive and no API (wp-json is 401), and pages roll off after the
// event, so this is a capture-forward source like Sisyphos. The markup is clean WordPress:
//   listing:  <article class="event-item"> .event-date .event-title .event-floor
//                (.floor-name, .floor-lineup > .floor-artist)
//   event:    .main-outer .lineup .floor (.floor-name, .floor-lineup >
//                .lineup-time "23:00-03:00" + .lineup-name)

function decode(s) {
  return s
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

const blocks = (html, cls) => {
  // Return inner HTML of each <tag class="cls ..."> ... </tag>, one nesting level deep.
  const out = []
  const re = new RegExp(`<(\\w+)[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, 'gi')
  let m
  while ((m = re.exec(html))) {
    const tag = m[1]
    let depth = 1
    const inner = new RegExp(`<${tag}\\b|</${tag}>`, 'gi')
    inner.lastIndex = re.lastIndex
    let start = re.lastIndex
    let mm
    while ((mm = inner.exec(html))) {
      depth += mm[0][1] === '/' ? -1 : 1
      if (depth === 0) {
        out.push(html.slice(start, mm.index))
        break
      }
    }
  }
  return out
}

function firstText(html, cls) {
  const b = blocks(html, cls)
  return b.length ? decode(b[0]) : ''
}

function parseFloors(eventHtml, { timed }) {
  const floors = []
  // Listing markup uses .event-floor; event-page markup uses .floor. Use whichever is
  // present (never both — \bfloor\b would otherwise also match inside "event-floor").
  const floorBlocks = blocks(eventHtml, 'event-floor')
  const source = floorBlocks.length ? floorBlocks : blocks(eventHtml, 'floor')
  for (const fl of source) {
    const name = firstText(fl, 'floor-name')
    if (!name) continue
    const lineup = blocks(fl, 'floor-lineup')[0] ?? fl
    const slots = []
    if (timed) {
      // Interleaved: <div class="lineup-time">RANGE</div><div class="lineup-name">NAME</div>
      const re = /class="[^"]*\blineup-(time|name)\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
      let m
      let pendingTime = null
      while ((m = re.exec(lineup))) {
        if (m[1] === 'time') pendingTime = decode(m[2])
        else {
          const name2 = decode(m[2])
          if (name2 && !isJunkName(name2)) slots.push({ clock: startOf(pendingTime), billing: name2 })
          pendingTime = null
        }
      }
    }
    if (!slots.length) {
      // Untimed: <div class="floor-artist"><span>NAME</span></div>
      for (const a of blocks(lineup, 'floor-artist')) {
        const name2 = decode(a)
        if (name2 && !isJunkName(name2)) slots.push({ clock: null, billing: name2 })
      }
    }
    if (slots.length) floors.push({ name: cleanFloor(name), slots })
  }
  return floors
}

// Some Tresor lineups (promoter-hosted "New Faces" nights) print structural labels in the
// artist slots. Drop the obvious non-DJ entries.
const isJunkName = (name) => /^(doors?( open)?|tba|line ?up|full line ?up|closing|opening|end|\d{1,2}h?)$/i.test(name.trim())

// "23:00-03:00" / "05:00-END" -> "23:00"
function startOf(range) {
  if (!range) return null
  const m = /(\d{1,2}:\d{2})/.exec(range)
  return m ? m[1].padStart(5, '0') : null
}

// "Globus x House of Paurro" -> keep; normalise the core rooms.
function cleanFloor(name) {
  const n = name.replace(/\s+/g, ' ').trim()
  if (/^tresor$/i.test(n)) return 'Tresor'
  if (/^globus$/i.test(n)) return 'Globus'
  if (/^\+?4\s*bar$/i.test(n)) return '+4Bar'
  return n
}

export function parseTresorListing(html) {
  const events = []
  for (const item of blocks(html, 'event-item')) {
    const hrefM = /<a[^>]*class="[^"]*event-title[^"]*"[^>]*href="([^"]+)"/i.exec(item) || /href="(https:\/\/tresorberlin\.com\/event\/[^"]+)"/i.exec(item)
    const url = hrefM ? hrefM[1] : null
    if (!url) continue
    const slug = url.replace(/\/$/, '').split('/').pop()
    const dateM = /^(\d{4})(\d{2})(\d{2})-/.exec(slug)
    if (!dateM) continue
    const title = firstText(item, 'event-title') || slug.replace(/^\d{8}-/, '').replace(/-/g, ' ')
    events.push({
      slug,
      url,
      isoDate: `${dateM[1]}-${dateM[2]}-${dateM[3]}`,
      title,
      floors: parseFloors(item, { timed: false }),
    })
  }
  return events
}

export function parseTresorEvent(html) {
  const mainM = /class="main-outer"([\s\S]*?)(?:<h2|class="event-item"|class="events-outer"|<footer)/i.exec(html)
  const main = mainM ? mainM[1] : html
  return { floors: parseFloors(main, { timed: true }) }
}
