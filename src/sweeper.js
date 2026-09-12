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
import { verifySubcontractor } from './agent/verifier.js'

/**
 * Gather the facts about one subcontractor.
 *
 * The agent leads, because deciding how far to investigate is a judgement: a
 * licence valid for another two years does not need its permit history pulled,
 * and a suspended one does. That choice saves real requests against a public
 * service and is the part worth an agent.
 *
 * If the model is unavailable the direct path runs instead. Compliance work
 * cannot stop because an API is down, so the fallback asks every source about
 * everyone. It is wasteful and correct, which is the right way round.
 */
async function gather(sub, county, { direct = false, sources } = {}) {
  const readLicence = sources?.lookupLicense ?? lookupLicense
  const readPermits = sources?.getPermitActivity ?? getPermitActivity

  if (!direct) {
    try {
      const out = await verifySubcontractor(sub, { county })
      // A register failure inside a tool must surface, not be swallowed as "clear".
      if (!out.license && !out.notFound) throw new Error('agent returned no licence record')
      return { ...out, mode: 'agent' }
    } catch (err) {
      if (/DBPR|register|timeout|fetch failed|HTTP/i.test(err.message)) throw err
      // Anything else is the model's problem, not the register's.
    }
  }

  const license = await readLicence(sub.licenseNumber)
  const permits = await readPermits(sub.licenseNumber, { county }).catch(() => null)

  return {
    license,
    permits,
    toolsUsed: ['lookup_license', 'get_permit_activity'],
    rationale: null,
    mode: 'direct',
  }
}

/**
 * @param {object} roster
 * @param {object} [opts]
 * @param {boolean} [opts.fresh]    ignore any existing journal
 * @param {AbortSignal} [opts.signal] abort between subcontractors
 * @param {boolean} [opts.direct]   skip the agent and read every source
 * @param {object}  [opts.sources]  connector overrides, for tests
 * @yields {{type:string}} start | skip | checking | verified | aborted | complete
 */
export async function* runSweep(roster, { fresh = false, signal, direct = false, sources } = {}) {
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

    let gathered
    try {
      gathered = await gather(sub, roster.county, { direct, sources })
    } catch (err) {
      // "The register holds no such licence" and "the register did not answer"
      // are different facts, and only the first is a finding. Collapsing them
      // would accuse a real business because a public server was slow, so a
      // failure to reach the register is carried through as exactly that, and
      // deliberately not committed: nothing was established, so the next run
      // asks again rather than inheriting an answer that never arrived.
      unreachable.push({ ...sub, error: err.message })
      yield { type: 'unreachable', sub, error: err.message, verified: journal.doneCount(), total }
      continue
    }

    // Scoring never sees the model. It reads the facts the tools wrote.
    const exposure = scoreExposure({
      license: gathered.license,
      permits: gathered.permits,
      trade: sub.trade,
    })

    const entry = {
      ...sub,
      license: gathered.license,
      permits: gathered.permits,
      exposure,
      investigation: {
        mode: gathered.mode,
        toolsUsed: gathered.toolsUsed,
        rationale: gathered.rationale,
      },
    }

    await journal.commit(sub.licenseNumber, entry)
    yield { type: 'verified', entry, verified: journal.doneCount(), total }

    // A kill that arrived while this subcontractor was in flight has to be
    // honoured here too. Checking only at the top of the loop meant a kill
    // during the last one let the run reach complete, clear its journal, and
    // look as though nothing had been stopped at all. The finished entry is
    // kept, because it was established, and the run stops.
    if (signal?.aborted) {
      yield { type: 'aborted', verified: journal.doneCount(), total }
      return
    }
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
