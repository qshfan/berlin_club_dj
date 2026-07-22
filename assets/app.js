// Client-side instant search over the prebuilt index. No framework, no network
// round trip after the first load.

// --- Nights page: club filter tabs ---
const tabs = document.querySelector('.tabs')
if (tabs) {
  const nights = document.getElementById('nights')
  const apply = (club) => {
    for (const section of nights.querySelectorAll('.year')) {
      let shown = 0
      for (const li of section.querySelectorAll('li[data-club]')) {
        const match = club === 'all' || li.dataset.club === club
        li.hidden = !match
        if (match) shown++
      }
      section.hidden = shown === 0
      const c = section.querySelector('.yr-count')
      if (c) c.textContent = shown
    }
    for (const t of tabs.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.club === club))
    history.replaceState(null, '', club === 'all' ? location.pathname : `?club=${club}`)
  }
  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab')
    if (tab) apply(tab.dataset.club)
  })
  const initial = new URLSearchParams(location.search).get('club')
  if (initial && tabs.querySelector(`.tab[data-club="${initial}"]`)) apply(initial)
}

const q = document.getElementById('q')
if (q) {
  const results = document.getElementById('results')
  const hint = document.getElementById('hint')
  const more = document.getElementById('more')
  const clubSel = document.getElementById('club')
  const fromSel = document.getElementById('from')
  const toSel = document.getElementById('to')
  const resetBtn = document.getElementById('reset')
  const PAGE_SIZE = 120
  let page = 0

  let artists = []
  let ready = false
  const minYear = fromSel ? Number(fromSel.options[0].value) : 0
  const maxYear = toSel ? Number(toSel.options[toSel.options.length - 1].value) : 9999

  const norm = (s) =>
    s
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()

  let clubSlugs = []
  let clubNames = {}

  fetch('search.json?v=' + (window.__V || ''))
    .then((r) => r.json())
    .then((d) => {
      clubSlugs = (d.clubs || []).map((c) => c[0])
      clubNames = Object.fromEntries(d.clubs || [])
      artists = d.artists.map(([name, slug, perf]) => ({ name, slug, perf, key: norm(name) }))
      ready = true
      applyUrl()
      render()
    })
    .catch(() => {
      hint.textContent = 'Could not load the search index.'
    })

  // Filters are reflected in the URL, so a filtered view is shareable and reloadable.
  function applyUrl() {
    const p = new URLSearchParams(location.search)
    if (clubSel && p.get('club') && clubSel.querySelector(`option[value="${p.get('club')}"]`)) clubSel.value = p.get('club')
    if (fromSel && p.get('from')) fromSel.value = p.get('from')
    if (toSel && p.get('to')) toSel.value = p.get('to')
    if (p.get('q')) q.value = p.get('q')
  }
  function syncUrl() {
    const p = new URLSearchParams()
    if (q.value.trim()) p.set('q', q.value.trim())
    if (clubSel && clubSel.value !== 'all') p.set('club', clubSel.value)
    if (fromSel && Number(fromSel.value) !== minYear) p.set('from', fromSel.value)
    if (toSel && Number(toSel.value) !== maxYear) p.set('to', toSel.value)
    const qs = p.toString()
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname)
  }

  // Re-aggregate a DJ's sets and active year-range for the current club/year filter.
  // Returns null if they have no sets under the filter (so they drop out of the list).
  function aggregate(a, club, from, to) {
    let sets = 0
    let first = Infinity
    let last = -Infinity
    for (let i = 0; i < a.perf.length; i++) {
      const e = a.perf[i] // [clubIdx, year, count]
      const y = e[1]
      if (y < from || y > to) continue
      if (club !== 'all' && clubSlugs[e[0]] !== club) continue
      sets += e[2]
      if (y < first) first = y
      if (y > last) last = y
    }
    return sets ? { sets, first, last } : null
  }

  const namePos = (a, needle) => (needle ? a.key.indexOf(needle) : 0)

  function render() {
    if (!ready) return
    const needle = norm(q.value.trim())
    const club = clubSel ? clubSel.value : 'all'
    const from = fromSel ? Number(fromSel.value) : minYear
    const to = toSel ? Number(toSel.value) : maxYear
    const filtersOn = club !== 'all' || from !== minYear || to !== maxYear
    if (resetBtn) resetBtn.hidden = !filtersOn && !needle

    // Each row's numbers are computed for the active filter, not the global totals.
    let list = []
    let maxSets = 1
    for (let i = 0; i < artists.length; i++) {
      const a = artists[i]
      if (needle && namePos(a, needle) === -1) continue
      const g = aggregate(a, club, from, to)
      if (!g) continue
      list.push({ a, g })
      if (g.sets > maxSets) maxSets = g.sets
    }

    list.sort((x, y) => {
      if (needle) {
        const px = namePos(x.a, needle) === 0 ? 0 : 1
        const py = namePos(y.a, needle) === 0 ? 0 : 1
        if (px !== py) return px - py
      }
      return y.g.sets - x.g.sets
    })

    const total = list.length
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    page = Math.min(Math.max(0, page), pages - 1)
    const startI = page * PAGE_SIZE
    const shown = list.slice(startI, startI + PAGE_SIZE)

    results.innerHTML = shown
      .map(
        ({ a, g }) => `<li style="--w:${Math.min(100, (g.sets / maxSets) * 100)}%"><a href="artist/${a.slug}.html">
      <span class="rname">${escapeHtml(a.name)}</span>
      <span class="rmeta">${g.first}${g.last !== g.first ? '–' + g.last : ''} · ${g.sets} set${g.sets === 1 ? '' : 's'}</span>
    </a></li>`
      )
      .join('')

    const n = total.toLocaleString('en')
    const where = club === 'all' ? 'DJs' : `DJs at ${clubNames[club] || club}`
    const when = filtersOn && (from !== minYear || to !== maxYear) ? ` · ${from}–${to}` : ''
    hint.textContent = `${n} ${where}${when}`

    // Pagination — lets you browse every DJ, not just the first page.
    if (total <= PAGE_SIZE) {
      more.innerHTML = ''
    } else {
      more.innerHTML =
        `<button class="pg" data-pg="prev"${page === 0 ? ' disabled' : ''}>‹ Prev</button>` +
        `<span class="pg-info">${(startI + 1).toLocaleString('en')}–${Math.min(startI + PAGE_SIZE, total).toLocaleString('en')} of ${n}</span>` +
        `<button class="pg" data-pg="next"${page >= pages - 1 ? ' disabled' : ''}>Next ›</button>`
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  }

  // Any filter/search change resets to the first page; pagination keeps it.
  const update = () => {
    page = 0
    syncUrl()
    render()
  }

  // Keep From ≤ To when either changes.
  function onYearChange(e) {
    if (fromSel && toSel && Number(fromSel.value) > Number(toSel.value)) {
      if (e.target === fromSel) toSel.value = fromSel.value
      else fromSel.value = toSel.value
    }
    update()
  }

  let t
  q.addEventListener('input', () => {
    clearTimeout(t)
    t = setTimeout(update, 60)
  })
  clubSel && clubSel.addEventListener('change', update)
  fromSel && fromSel.addEventListener('change', onYearChange)
  toSel && toSel.addEventListener('change', onYearChange)
  resetBtn &&
    resetBtn.addEventListener('click', () => {
      q.value = ''
      if (clubSel) clubSel.value = 'all'
      if (fromSel) fromSel.value = minYear
      if (toSel) toSel.value = maxYear
      update()
      q.focus()
    })

  // Pagination buttons.
  more.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pg]')
    if (!b || b.disabled) return
    page += b.dataset.pg === 'next' ? 1 : -1
    render()
    results.scrollIntoView({ block: 'start' })
  })

  // Enter jumps straight to the top hit.
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = results.querySelector('a')
      if (first) location.href = first.getAttribute('href')
    }
  })
}
