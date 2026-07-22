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
  const LIMIT = 60

  let artists = []
  let ready = false

  const norm = (s) =>
    s
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()

  fetch('search.json')
    .then((r) => r.json())
    .then((d) => {
      artists = d.artists.map(([name, slug, sets, first, last]) => ({
        name,
        slug,
        sets,
        first,
        last,
        key: norm(name),
      }))
      ready = true
      render('')
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

  function render(term) {
    if (!ready) return
    const needle = norm(term.trim())
    let list = artists

    if (needle) {
      list = artists
        .map((a) => ({ a, s: score(a, needle) }))
        .filter((x) => x.s >= 0)
        .sort((x, y) => y.s - x.s)
        .map((x) => x.a)
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

    hint.textContent = needle
      ? `${list.length.toLocaleString('en')} artist${list.length === 1 ? '' : 's'} matching “${term.trim()}”`
      : 'Type to filter. Sorted by number of sets played.'
    more.textContent = list.length > LIMIT ? `Showing first ${LIMIT} of ${list.length.toLocaleString('en')} — keep typing to narrow.` : ''
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  }

  let t
  q.addEventListener('input', () => {
    clearTimeout(t)
    t = setTimeout(() => render(q.value), 60)
  })

  // Enter jumps straight to the top hit.
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = results.querySelector('a')
      if (first) location.href = first.getAttribute('href')
    }
  })
}
