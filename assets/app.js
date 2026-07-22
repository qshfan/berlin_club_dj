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
  const LIMIT = 60

  let artists = []
  let ready = false
  const minYear = fromSel ? Number(fromSel.options[0].value) : 0
  const maxYear = toSel ? Number(toSel.options[toSel.options.length - 1].value) : 9999

  const norm = (s) =>
    s
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()

  fetch('search.json')
    .then((r) => r.json())
    .then((d) => {
      artists = d.artists.map(([name, slug, sets, first, last, clubs]) => ({
        name,
        slug,
        sets,
        first,
        last,
        clubs: clubs || [],
        key: norm(name),
      }))
      ready = true
      render()
    })
    .catch(() => {
      hint.textContent = 'Could not load the search index.'
    })

  function score(a, needle) {
    const i = a.key.indexOf(needle)
    if (i === -1) return -1
    // Prefix match beats mid-string; ties broken by how much they played.
    return (i === 0 ? 1e6 : 1e3 - i) + a.sets
  }

  function render() {
    if (!ready) return
    const needle = norm(q.value.trim())
    const club = clubSel ? clubSel.value : 'all'
    const from = fromSel ? Number(fromSel.value) : minYear
    const to = toSel ? Number(toSel.value) : maxYear
    const filtersOn = club !== 'all' || from !== minYear || to !== maxYear
    if (resetBtn) resetBtn.hidden = !filtersOn && !needle

    let list = artists.filter(
      (a) =>
        (club === 'all' || a.clubs.includes(club)) &&
        // year-range overlap: active somewhere within [from, to]
        a.last >= from &&
        a.first <= to
    )

    if (needle) {
      list = list
        .map((a) => ({ a, s: score(a, needle) }))
        .filter((x) => x.s >= 0)
        .sort((x, y) => y.s - x.s)
        .map((x) => x.a)
    } else {
      list = list.slice().sort((x, y) => y.sets - x.sets)
    }

    const shown = list.slice(0, LIMIT)
    results.innerHTML = shown
      .map(
        (a) => `<li><a href="artist/${a.slug}.html">
      <span class="name">${escapeHtml(a.name)}</span>
      <span class="yrs">${a.first}${a.last !== a.first ? '–' + a.last : ''}</span>
      <span class="bar" style="--w:${Math.min(100, (a.sets / artists[0].sets) * 100)}%"></span>
      <span class="count">${a.sets}</span>
    </a></li>`
      )
      .join('')

    const n = list.length.toLocaleString('en')
    hint.textContent = list.length === artists.length ? `${n} DJs · sorted by sets played` : `${n} DJ${list.length === 1 ? '' : 's'}`
    more.textContent = list.length > LIMIT ? `Showing first ${LIMIT} of ${n} — narrow with search or filters.` : ''
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  }

  // Keep From ≤ To when either changes, then re-render.
  function onYearChange(e) {
    if (fromSel && toSel && Number(fromSel.value) > Number(toSel.value)) {
      if (e.target === fromSel) toSel.value = fromSel.value
      else fromSel.value = toSel.value
    }
    render()
  }

  let t
  q.addEventListener('input', () => {
    clearTimeout(t)
    t = setTimeout(render, 60)
  })
  clubSel && clubSel.addEventListener('change', render)
  fromSel && fromSel.addEventListener('change', onYearChange)
  toSel && toSel.addEventListener('change', onYearChange)
  resetBtn &&
    resetBtn.addEventListener('click', () => {
      q.value = ''
      if (clubSel) clubSel.value = 'all'
      if (fromSel) fromSel.value = minYear
      if (toSel) toSel.value = maxYear
      render()
      q.focus()
    })

  // Enter jumps straight to the top hit.
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = results.querySelector('a')
      if (first) location.href = first.getAttribute('href')
    }
  })
}
