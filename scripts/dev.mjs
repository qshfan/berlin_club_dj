// Local dev: build once, serve dist/, rebuild on change. Node's http server only.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { watch } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from './db.mjs'

const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.PORT ?? 4321)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function build() {
  const t = Date.now()
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  if (r.status !== 0) {
    console.error('\nbuild failed:\n' + (r.stderr?.toString() ?? ''))
    return false
  }
  console.log(`rebuilt in ${Date.now() - t}ms`)
  return true
}

build()

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    // normalize() + prefix check keeps ../.. out of the served tree
    let path = normalize(join(DIST, decodeURIComponent(url.pathname)))
    if (!path.startsWith(DIST)) {
      res.writeHead(403).end('Forbidden')
      return
    }
    try {
      if ((await stat(path)).isDirectory()) path = join(path, 'index.html')
    } catch {
      if (!extname(path)) path += '.html'
    }
    const body = await readFile(path)
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<h1>404</h1><p><a href="/">home</a></p>')
  }
})

server.listen(PORT, () => {
  console.log(`\n  Berlin Club DJ — http://localhost:${PORT}\n`)
})

// Rebuild when source changes. Debounced; ignores dist/.
let timer
for (const dir of ['scripts', 'assets']) {
  watch(join(ROOT, dir), { recursive: true }, (_e, file) => {
    if (!file || file.includes('dist')) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      console.log(`\nchanged: ${file}`)
      build()
    }, 120)
  })
}
