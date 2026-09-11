import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'

const PATH = 'data/history.json'

/** Run a case against a temporary history, restoring whatever was there. */
async function withHistory(runs, fn) {
  const saved = await readFile(PATH, 'utf8').catch(() => null)
  await mkdir('data', { recursive: true })
  await writeFile(PATH, JSON.stringify({ runs }))
  try {
    // imported fresh each time so the module reads the file we just wrote
    const mod = await import('../src/history.js?t=' + Date.now())
    await fn(mod)
  } finally {
    if (saved === null) await rm(PATH, { force: true })
    else await writeFile(PATH, saved)
  }
}

const state = (over = {}) => ({
  name: 'ACME ROOFING LLC',
  trade: 'roofing',
  status: 'ACTIVE',
  statusRaw: 'Current, Active',
  licenseType: 'Certified Roofing Contractor',
  expirationDate: '08/31/2028',
  level: 'NONE',
  score: 0,
  permits: 3,
  lastPermit: '2026-02-26',
  ...over,
})

const run = (at, states) => ({ at, project: 'Test', total: Object.keys(states).length, needsAttention: 0, states })

test('a single run is a baseline, not a comparison', async () => {
  await withHistory([run('2026-09-01T09:00:00Z', { CCC1: state() })], async (h) => {
    const c = await h.changes()
    assert.equal(c.ready, false)
    assert.equal(c.reason, 'first-run')
  })
})

test('a licence that goes bad is reported as appeared', async () => {
  await withHistory(
    [
      run('2026-09-01T09:00:00Z', { CCC1: state() }),
      run('2026-09-08T09:00:00Z', { CCC1: state({ status: 'SUSPENDED', statusRaw: 'Suspended, Active', level: 'CRITICAL', score: 90 }) }),
    ],
    async (h) => {
      const c = await h.changes()
      assert.equal(c.ready, true)
      assert.equal(c.quiet, false)
      assert.equal(c.appeared.length, 1)
      assert.equal(c.appeared[0].was, 'ACTIVE')
      assert.equal(c.appeared[0].status, 'SUSPENDED')
      assert.equal(c.resolved.length, 0)
    },
  )
})

test('a licence that recovers is reported as resolved', async () => {
  await withHistory(
    [
      run('2026-09-01T09:00:00Z', { CCC1: state({ status: 'DELINQUENT', level: 'CRITICAL' }) }),
      run('2026-09-08T09:00:00Z', { CCC1: state() }),
    ],
    async (h) => {
      const c = await h.changes()
      assert.equal(c.resolved.length, 1)
      assert.equal(c.appeared.length, 0)
    },
  )
})

test('a status change that stays clear is still reported', async () => {
  await withHistory(
    [
      run('2026-09-01T09:00:00Z', { CCC1: state({ status: 'ACTIVE', statusRaw: 'Current, Active' }) }),
      run('2026-09-08T09:00:00Z', { CCC1: state({ status: 'INACTIVE', statusRaw: 'Inactive' }) }),
    ],
    async (h) => {
      const c = await h.changes()
      assert.equal(c.statusChanged.length, 1)
      assert.equal(c.statusChanged[0].was, 'ACTIVE')
    },
  )
})

test('an unchanged roster reads as quiet, which is the point', async () => {
  await withHistory(
    [
      run('2026-09-01T09:00:00Z', { CCC1: state(), CAC2: state({ name: 'B AIR' }) }),
      run('2026-09-08T09:00:00Z', { CCC1: state(), CAC2: state({ name: 'B AIR' }) }),
    ],
    async (h) => {
      const c = await h.changes()
      assert.equal(c.quiet, true)
      assert.equal(c.unchanged, 2)
    },
  )
})

test('roster additions and removals are tracked separately', async () => {
  await withHistory(
    [
      run('2026-09-01T09:00:00Z', { CCC1: state(), OLD9: state({ name: 'GONE LLC' }) }),
      run('2026-09-08T09:00:00Z', { CCC1: state(), NEW7: state({ name: 'NEW LLC' }) }),
    ],
    async (h) => {
      const c = await h.changes()
      assert.equal(c.added.length, 1)
      assert.equal(c.added[0].licence, 'NEW7')
      assert.equal(c.removed.length, 1)
      assert.equal(c.removed[0].licence, 'OLD9')
    },
  )
})

test('a timeline keeps only the readings where something moved', async () => {
  await withHistory(
    [
      run('2026-09-01T09:00:00Z', { CCC1: state() }),
      run('2026-09-08T09:00:00Z', { CCC1: state() }),
      run('2026-09-15T09:00:00Z', { CCC1: state({ status: 'DELINQUENT', statusRaw: 'Delinquent', level: 'CRITICAL' }) }),
      run('2026-09-22T09:00:00Z', { CCC1: state({ status: 'DELINQUENT', statusRaw: 'Delinquent', level: 'CRITICAL' }) }),
    ],
    async (h) => {
      const t = await h.timelineFor('ccc1')
      assert.equal(t.readings, 4, 'all four readings are counted')
      assert.equal(t.points.length, 2, 'but only two are moments of change')
      assert.equal(t.points[0].first, true)
      assert.equal(t.points[1].status, 'DELINQUENT')
      assert.equal(t.current.status, 'DELINQUENT')
    },
  )
})
