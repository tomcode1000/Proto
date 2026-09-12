import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm, mkdir, readdir } from 'node:fs/promises'
// Isolate this run: a server may be up with a watch that writes journals.
process.env.PROTO_STATE_DIR = '.proto-state-test'
const STATE = process.env.PROTO_STATE_DIR

const { runSweep } = await import('../src/sweeper.js')

/**
 * These cover the two claims the whole pitch rests on: that a killed run
 * continues rather than restarts, and that a register which will not answer is
 * never recorded as a licence that does not exist.
 *
 * The connectors are injected, so nothing here touches a government service, and
 * the direct path is used so no model is required to run the suite.
 */
const roster = (n) => ({
  project: 'Test project',
  generalContractor: 'Test GC',
  county: 'MIAMI-DADE',
  subcontractors: Array.from({ length: n }, (_, i) => ({
    name: `SUB ${i + 1}`,
    licenseNumber: `CCC100000${i + 1}`,
    trade: 'roofing',
  })),
})

/** Stand in registers. One answers, one never does. */
const answers = {
  lookupLicense: async (licenseNumber) => ({
    licenseNumber,
    licenseType: "Certified Roofing Contractor",
    businessName: "STUB ROOFING LLC",
    qualifierName: "STUB, A",
    status: "ACTIVE",
    statusRaw: "Current, Active",
    expirationDate: "08/31/2028",
    sourceUrl: "https://example.invalid/" + licenseNumber,
    checkedAt: new Date().toISOString(),
  }),
  getPermitActivity: async (licenseNumber) => ({
    licenseNumber, county: "Miami-Dade", byYear: {}, totalPermits: 0,
    currentYearPermits: 0, mostRecentPermit: null, monthsSinceLastPermit: null,
  }),
};

const silent = {
  lookupLicense: async () => { throw new Error("DBPR returned HTTP 503"); },
  getPermitActivity: answers.getPermitActivity,
};

const collect = async (gen) => {
  const events = []
  for await (const e of gen) events.push(e)
  return events
}

test('a killed sweep keeps what it verified and resumes from there', async () => {
  await rm(STATE, { recursive: true, force: true })
  const book = roster(8)

  // Stop after three have been committed, the way a closed laptop would.
  const controller = new AbortController()
  let verified = 0
  const first = []
  for await (const e of runSweep(book, { fresh: true, direct: true, sources: answers, signal: controller.signal })) {
    first.push(e)
    if (e.type === 'verified' && ++verified === 3) controller.abort()
  }

  const aborted = first.find((e) => e.type === 'aborted')
  assert.ok(aborted, 'the run reports that it was killed')
  assert.equal(aborted.verified, 3, 'exactly the three that were established are banked')
  assert.equal(first.filter((e) => e.type === 'verified').length, 3)

  // A journal survives the kill, which is what makes the next run a resume.
  await mkdir(STATE, { recursive: true })
  assert.ok((await readdir(STATE)).some((f) => f.endsWith('.json')), 'journal is on disk')

  // Second run: the first three are skipped, not asked about again.
  const second = await collect(runSweep(book, { direct: true, sources: answers }))
  const skipped = second.filter((e) => e.type === 'skip')
  const checked = second.filter((e) => e.type === 'verified')

  assert.equal(skipped.length, 3, 'the banked three are skipped')
  assert.equal(checked.length, 5, 'only the remaining five are checked')

  const complete = second.at(-1)
  assert.equal(complete.type, 'complete')
  assert.equal(complete.total, 8, 'the finished run still reports all eight')

  // A completed run clears its own journal, so the next one starts clean.
  assert.ok(!(await readdir(STATE)).length, 'journal is cleared on completion')
})

test('a register that will not answer is never recorded as a missing licence', async () => {
  await rm(STATE, { recursive: true, force: true })
  const book = roster(3)

  const events = await collect(runSweep(book, { fresh: true, direct: true, sources: silent }))
  const unreachable = events.filter((e) => e.type === 'unreachable')
  const verified = events.filter((e) => e.type === 'verified')
  const complete = events.at(-1)

  assert.equal(unreachable.length, 3, 'all three are reported unreachable')
  assert.equal(verified.length, 0, 'none is recorded as verified')
  assert.equal(complete.needsAttention, 0, 'an unanswered register produces no findings')
  assert.equal(complete.unreachable.length, 3, 'the run says which it could not reach')
  assert.equal(complete.total, 0, 'nothing unestablished is counted as checked')
})

test('a kill during the last subcontractor stops the run, it does not complete', async () => {
  await rm(STATE, { recursive: true, force: true })
  const book = roster(2)

  // Abort while the final subcontractor is in flight, which is what pressing
  // Kill near the end of a short roster actually does.
  const controller = new AbortController()
  const events = []
  let seen = 0
  for await (const e of runSweep(book, { fresh: true, direct: true, sources: answers, signal: controller.signal })) {
    events.push(e)
    if (e.type === 'checking' && ++seen === 2) controller.abort()
  }

  const types = events.map((e) => e.type)
  assert.ok(types.includes('aborted'), 'the run reports that it was killed')
  assert.ok(!types.includes('complete'), 'a killed run never reports completion')

  // The journal survives, which is what makes the next run a resume.
  assert.ok((await readdir(STATE)).some((f) => f.endsWith('.json')), 'journal is kept')

  await rm(STATE, { recursive: true, force: true })
})
