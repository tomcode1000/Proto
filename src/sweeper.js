/**
 * The sweep, as a stream of events.
 *
 * Both the terminal and the control room consume this, so what you watch in the
 * browser is the same code path that runs headless — not a reimplementation that
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

    const license = await lookupLicense(sub.licenseNumber).catch(() => null)
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
    needsAttention: scored.filter((s) => s.exposure.level !== 'NONE').length,
    total: scored.length,
  }
}
