/**
 * The sweep, as a stream of events.
 *
 * Both the terminal and the control room consume this, so what you watch in the
 * browser is the same code path that runs headless, not a reimplementation that
 * can drift from it.
 */
import { lookupLicense } from './connectors/dbpr.js'
import { getPermitActivity } from './connectors/permits.js'
import { scoreExposure, rankByExposure } from './engine/exposure.js'
import { openJournal } from './journal.js'

/**
 * @param {object} roster
 * @param {object} [opts]
 * @param {boolean} [opts.fresh]    ignore any existing journal
 * @param {AbortSignal} [opts.signal] abort between subcontractors
 * @yields {{type:string}} start | skip | checking | verified | aborted | complete
 */
export async function* runSweep(roster, { fresh = false, signal } = {}) {
  const journal = await openJournal(roster, { fresh })
  const total = roster.subcontractors.length

  /** Subcontractors the registry would not answer for. Not findings, and not settled. */
  const unreachable = []

  yield {
    type: 'start',
    runId: journal.runId,
    project: roster.project,
    generalContractor: roster.generalContractor,
    county: roster.county,
    total,
    alreadyVerified: journal.doneCount(),
    resumed: journal.isResumed,
  }

  for (const sub of roster.subcontractors) {
    if (journal.has(sub.licenseNumber)) {
      yield { type: 'skip', sub, entry: journal.get(sub.licenseNumber) }
      continue
    }

    // Abort between subcontractors, never mid-commit: the journal must only
    // ever contain entries that were fully established.
    if (signal?.aborted) {
      yield { type: 'aborted', verified: journal.doneCount(), total }
      return
    }

    yield { type: 'checking', sub }

    // "The registry holds no such licence" and "the registry did not answer" are
    // different facts, and only the first is a finding. Collapsing them would
    // accuse a real business because a public server was slow, so a failure to
    // reach the registry is carried through as exactly that.
    let license = null
    try {
      license = await lookupLicense(sub.licenseNumber)
    } catch (err) {
      // Deliberately not committed: nothing was established, so the next run
      // asks again rather than inheriting an answer that never arrived.
      unreachable.push({ ...sub, error: err.message })
      yield { type: 'unreachable', sub, error: err.message, verified: journal.doneCount(), total }
      continue
    }

    const permits = await getPermitActivity(sub.licenseNumber, { county: roster.county }).catch(
      () => null,
    )
    const exposure = scoreExposure({ license, permits, trade: sub.trade })
    const entry = { ...sub, license, permits, exposure }

    await journal.commit(sub.licenseNumber, entry)
    yield { type: 'verified', entry, verified: journal.doneCount(), total }
  }

  const scored = roster.subcontractors.map((s) => journal.get(s.licenseNumber)).filter(Boolean)
  await journal.clear()

  yield {
    type: 'complete',
    findings: rankByExposure(scored),
    unreachable,
    needsAttention: scored.filter((s) => s.exposure.level !== 'NONE').length,
    total: scored.length,
  }
}
