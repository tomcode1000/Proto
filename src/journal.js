/**
 * Durable run journal.
 *
 * A roster sweep is a long sequence of network calls against two public
 * services. If it dies at subcontractor nine — the machine sleeps, the VPN
 * drops, someone closes the laptop — starting again from one is not merely
 * slow. It is thirty more requests at a government portal to re-learn what was
 * already known, and on a large roster it is the reason the check quietly stops
 * being run at all.
 *
 * So each verified subcontractor is committed to disk the moment it is known.
 * A resumed run reads the journal, skips what is already settled, and continues
 * from the first unsettled name. The record on disk is the source of truth
 * about progress, never a counter held in memory.
 */
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const DIR = '.proto-state'

/** A run is identified by what it is checking, so the same roster resumes itself. */
export function runIdFor(roster) {
  const key = JSON.stringify({
    project: roster.project,
    county: roster.county,
    subs: roster.subcontractors.map((s) => s.licenseNumber).sort(),
  })
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

export async function openJournal(roster, { fresh = false } = {}) {
  await mkdir(DIR, { recursive: true })
  const runId = runIdFor(roster)
  const path = join(DIR, `${runId}.json`)

  let state = { runId, project: roster.project, startedAt: null, completed: {} }

  if (fresh) {
    await unlink(path).catch(() => {})
  } else {
    const existing = await readFile(path, 'utf8').catch(() => null)
    if (existing) {
      try {
        state = JSON.parse(existing)
      } catch {
        // A half-written journal is worse than none: start clean rather than
        // resume from a record we cannot vouch for.
        state = { runId, project: roster.project, startedAt: null, completed: {} }
      }
    }
  }

  state.startedAt ??= new Date().toISOString()

  const flush = async () => {
    // Write to a temporary file and rename: a kill during the write leaves the
    // previous good journal intact rather than a truncated one.
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2))
    const { rename } = await import('node:fs/promises')
    await rename(tmp, path)
  }

  return {
    runId,
    path,
    isResumed: Object.keys(state.completed).length > 0,
    doneCount: () => Object.keys(state.completed).length,
    has: (licenseNumber) => licenseNumber in state.completed,
    get: (licenseNumber) => state.completed[licenseNumber],
    all: () => Object.values(state.completed),
    /** Commit one verified subcontractor. Returns once it is durable. */
    async commit(licenseNumber, entry) {
      state.completed[licenseNumber] = entry
      await flush()
    },
    async clear() {
      await unlink(path).catch(() => {})
    },
  }
}

/** Any unfinished runs lying around, for the operator to see. */
export async function listRuns() {
  await mkdir(DIR, { recursive: true })
  const files = await readdir(DIR)
  return files.filter((f) => f.endsWith('.json'))
}
