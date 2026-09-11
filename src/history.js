/**
 * Sweep history.
 *
 * Proto re-checks a roster on a schedule, but a schedule only pays for itself if
 * somebody can see what moved. Current state answers "is this licence valid?" —
 * which a person could look up themselves. History answers the question they
 * cannot: "what changed since the last time anyone looked?"
 *
 * That is also the evidence. A licence that was current in January and delinquent
 * in September is the whole case, and it only exists if the January reading was
 * kept. So every completed sweep is recorded, and nothing is overwritten.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'

const PATH = 'data/history.json'

/** Enough runs to show a season of a project without the file becoming a burden. */
const KEEP = 60

const empty = { runs: [] }

export async function load() {
  const raw = await readFile(PATH, 'utf8').catch(() => null)
  if (!raw) return { ...empty }
  try {
    return JSON.parse(raw)
  } catch {
    // A corrupt history must not take the sweep down with it.
    return { ...empty }
  }
}

/**
 * Record one completed sweep.
 *
 * Only the fields a comparison needs are kept, not the whole finding: a run is a
 * reading, and readings should stay small enough to hold sixty of them.
 */
export async function recordRun(project, findings) {
  const history = await load()

  const run = {
    at: new Date().toISOString(),
    project,
    total: findings.length,
    needsAttention: findings.filter((f) => f.exposure.level !== 'NONE').length,
    states: Object.fromEntries(
      findings.map((f) => [
        f.licenseNumber,
        {
          name: f.name,
          trade: f.trade ?? null,
          status: f.license?.status ?? 'NOT_FOUND',
          statusRaw: f.license?.statusRaw ?? 'not found',
          licenseType: f.license?.licenseType ?? null,
          expirationDate: f.license?.expirationDate ?? null,
          level: f.exposure.level,
          score: f.exposure.score,
          permits: f.permits?.totalPermits ?? 0,
          lastPermit: f.permits?.mostRecentPermit ?? null,
        },
      ]),
    ),
  }

  history.runs.push(run)
  history.runs = history.runs.slice(-KEEP)

  await mkdir('data', { recursive: true })
  await writeFile(PATH, JSON.stringify(history, null, 2) + '\n')
  return run
}

/**
 * What moved between the last two runs.
 *
 * The interesting events are asymmetric on purpose. A licence that became a
 * finding is urgent. One that stopped being a finding is reassurance. A status
 * that changed without crossing into a finding is still worth saying, because it
 * is how a licence usually dies — quietly, one step at a time.
 */
export async function changes() {
  const { runs } = await load()
  if (runs.length === 0) return { ready: false, reason: 'no-runs' }
  if (runs.length === 1) {
    return { ready: false, reason: 'first-run', at: runs[0].at, total: runs[0].total }
  }

  const previous = runs.at(-2)
  const latest = runs.at(-1)

  const appeared = []
  const resolved = []
  const statusChanged = []
  const added = []
  const removed = []
  let unchanged = 0

  for (const [licence, now] of Object.entries(latest.states)) {
    const before = previous.states[licence]

    if (!before) {
      added.push({ licence, ...now })
      continue
    }

    const becameFinding = before.level === 'NONE' && now.level !== 'NONE'
    const stoppedBeingFinding = before.level !== 'NONE' && now.level === 'NONE'
    const movedStatus = before.status !== now.status

    if (becameFinding) appeared.push({ licence, ...now, was: before.status, wasLevel: before.level })
    else if (stoppedBeingFinding) resolved.push({ licence, ...now, was: before.status, wasLevel: before.level })
    else if (movedStatus) statusChanged.push({ licence, ...now, was: before.status, wasRaw: before.statusRaw })
    else unchanged += 1
  }

  for (const [licence, before] of Object.entries(previous.states)) {
    if (!latest.states[licence]) removed.push({ licence, ...before })
  }

  return {
    ready: true,
    since: previous.at,
    at: latest.at,
    total: latest.total,
    appeared,
    resolved,
    statusChanged,
    added,
    removed,
    unchanged,
    quiet: appeared.length + resolved.length + statusChanged.length + added.length + removed.length === 0,
  }
}

/**
 * One subcontractor's readings over time, collapsed to the moments it moved.
 *
 * Sixty identical readings tell nobody anything; the three dates where the status
 * changed are the entire story. The first reading is always kept, so the timeline
 * begins at "this is how we found it".
 */
export async function timelineFor(licenseNumber) {
  const { runs } = await load()
  const licence = String(licenseNumber).toUpperCase()

  const points = []
  let last = null

  for (const run of runs) {
    const state = run.states[licence]
    if (!state) continue

    const moved =
      last === null || state.status !== last.status || state.level !== last.level ||
      state.expirationDate !== last.expirationDate

    if (moved) {
      points.push({
        at: run.at,
        status: state.status,
        statusRaw: state.statusRaw,
        level: state.level,
        expirationDate: state.expirationDate,
        permits: state.permits,
        lastPermit: state.lastPermit,
        first: last === null,
      })
    }
    last = state
  }

  const latest = runs.at(-1)?.states?.[licence] ?? null

  return {
    licenseNumber: licence,
    name: latest?.name ?? points.at(-1)?.name ?? licence,
    licenseType: latest?.licenseType ?? null,
    trade: latest?.trade ?? null,
    readings: runs.filter((r) => r.states[licence]).length,
    firstSeen: runs.find((r) => r.states[licence])?.at ?? null,
    lastChecked: latest ? runs.at(-1).at : null,
    current: latest,
    points,
  }
}
