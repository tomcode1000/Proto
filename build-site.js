/**
 * Build the static site.
 *
 * The landing page, the deck and the icon sheet are all static, so they can be
 * served from anywhere. The one thing they rely on that the server normally
 * provides is the icon sprite, which is injected at request time, so it is baked
 * into each page here instead.
 *
 * The control room is deliberately not included. It needs a live process for the
 * watch, a writable disk for the record, and minutes rather than seconds for a
 * sweep, none of which a static host or a serverless function provides.
 *
 *   node build-site.js   ->  site/
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'

const REPO = 'https://github.com/tomcode1000/Proto'

const sprite = await readFile('public/icons.html', 'utf8')
await mkdir('site', { recursive: true })

for (const [from, to] of [
  ['public/index.html', 'site/index.html'],
  ['public/slides.html', 'site/slides.html'],
]) {
  const page = (await readFile(from, 'utf8'))
    .replace('<body>', `<body>\n${sprite}`)
    // the application is not deployed here, so send people to the source
    .split('href="/app"')
    .join(`href="${REPO}"`)
  await writeFile(to, page)
  console.log(`  ${to}`)
}

const ids = [...sprite.matchAll(/symbol id="i-([a-z]+)"/g)].map((m) => m[1])
const cell = (id) =>
  `<div class=c><div class=row><svg class=lg><use href="#i-${id}"/></svg>` +
  `<svg class=sm><use href="#i-${id}"/></svg></div><code>${id}</code></div>`

await writeFile(
  'site/icons.html',
  `<!doctype html><meta charset="utf-8"><title>Proto icons</title><style>
body{font:13px system-ui;background:#f4f5f8;margin:0;padding:28px}
h2{font:600 11px ui-monospace;letter-spacing:.14em;color:#8a92a8;margin:26px 0 12px}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:12px}
.c{background:#fff;border:1px solid #e6e8ef;border-radius:14px;padding:16px 8px 10px;text-align:center}
.row{display:flex;align-items:flex-end;justify-content:center;gap:14px;margin-bottom:10px}
svg{fill:none;stroke:#151a2b;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.lg{width:40px;height:40px}.sm{width:14px;height:14px}
code{font:10.5px ui-monospace;color:#5c6577}
.violet{background:#6d4aff;padding:18px;border-radius:14px;display:flex;gap:16px;flex-wrap:wrap}
.violet svg{stroke:#fff;width:20px;height:20px}
</style>${sprite}
<h2>EVERY ICON AT 40PX AND 14PX</h2><div class=g>${ids.map(cell).join('')}</div>
<h2>ON THE VIOLET PANEL</h2><div class=violet>${ids
    .map((i) => `<svg><use href="#i-${i}"/></svg>`)
    .join('')}</div>`,
)
console.log(`  site/icons.html, ${ids.length} icons`)
console.log('\nDeploy the site/ directory. Nothing in it needs a server.\n')
