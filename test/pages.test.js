import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * The pages themselves, checked the way a browser would find fault with them.
 *
 * Every one of these exists because the corresponding bug shipped. A view closed
 * one tag early and the other four fell outside the layout. A helper collapsed
 * and the first line to run threw, so nothing after it ever bound. A block
 * landed above the doctype and rendered as text. None of that is visible by
 * reading the file, and all of it is obvious the moment the page is executed.
 */

const sprite = await readFile('public/icons.html', 'utf8')
const SYMBOLS = new Set([...sprite.matchAll(/symbol id="i-([a-z]+)"/g)].map((m) => m[1]))
const PAGES = ['public/app.html', 'public/index.html', 'public/slides.html']

/** A DOM thin enough to run against, honest enough to catch a missing element. */
function stubDom(ids) {
  const bound = []
  const navs = []
  const present = new Set(ids)

  const make = (id) => ({
    id,
    addEventListener: (ev) => bound.push(ev),
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {}, prepend() {}, remove() {}, setAttribute() {}, focus() {},
    style: {}, dataset: {}, children: [], getAttribute: () => null, closest: () => null,
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    scrollTop: 0, scrollHeight: 0,
  })

  globalThis.document = {
    querySelector: (s) =>
      s.startsWith('#') ? (present.has(s.slice(1)) ? make(s.slice(1)) : null) : make(s),
    querySelectorAll: (s) =>
      s === '[data-view]'
        ? ['dash', 'roster', 'findings', 'notices', 'settings'].map((v) => {
            const el = make('nav-' + v)
            el.dataset = { view: v }
            el.addEventListener = () => navs.push(v)
            return el
          })
        : [],
    getElementById: (id) => (present.has(id) ? make(id) : null),
    addEventListener() {},
    createElement: () => make('made'),
    body: make('body'),
    documentElement: make('html'),
  }
  globalThis.window = { addEventListener() {}, innerWidth: 1400 }
  globalThis.EventSource = function () { return { close() {} } }
  globalThis.alert = () => {}
  globalThis.URL = { createObjectURL: () => 'blob', revokeObjectURL() {} }
  globalThis.location = { reload() {}, hash: '', href: '' }
  globalThis.fetch = async (url) => ({
    ok: true,
    blob: async () => ({}),
    json: async () =>
      String(url).includes('/api/runs')
        ? []
        : {
            active: 'p', projects: [], subcontractors: [], findings: [],
            schedule: { cadence: 'weekly', nextDue: new Date(Date.now() + 6e8).toISOString() },
            notify: { telegram: {} },
          },
  })

  return { bound, navs }
}

for (const page of PAGES) {
  const html = await readFile(page, 'utf8')
  const markup = html.split('<script>')[0]
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1])

  test(`${page} closes every tag it opens`, () => {
    let depth = 0
    for (const tag of markup.matchAll(/<(\/?)(div|main|aside|section|header)\b[^>]*>/g)) {
      depth += tag[1] === '/' ? -1 : 1
      assert.ok(depth >= 0, 'a closing tag appears before anything opened it')
    }
    assert.equal(depth, 0, 'unclosed or over-closed elements')
  })

  test(`${page} has no duplicate ids`, () => {
    const dupes = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))]
    assert.deepEqual(dupes, [], 'a duplicate id means only the first ever updates')
  })

  test(`${page} references only icons that exist`, () => {
    const used = [...new Set([...html.matchAll(/#i-([a-z]+)/g)].map((m) => m[1]))]
    const missing = used.filter((u) => !SYMBOLS.has(u))
    assert.deepEqual(missing, [], 'a missing symbol renders as an empty box')
  })

  if (!html.includes('<script>')) continue

  test(`${page} runs to the end and binds its handlers`, async () => {
    const js = html.split('<script>')[1].split('</script>')[0]
    const { bound, navs } = stubDom(ids)

    let failed = null
    const onReject = (e) => (failed = e?.message ?? String(e))
    process.on('unhandledRejection', onReject)
    try {
      new Function(js)()
    } catch (e) {
      assert.fail(`the script threw while loading, so nothing after it bound: ${e.message}`)
    }
    await new Promise((r) => setTimeout(r, 300))
    process.off('unhandledRejection', onReject)

    assert.equal(failed, null, 'first render rejected')

    if (page.endsWith('app.html')) {
      assert.equal(navs.length, 5, 'every navigation item is wired')
      assert.ok(bound.filter((b) => b === 'click').length >= 14, 'controls are wired')
    }
  })
}
